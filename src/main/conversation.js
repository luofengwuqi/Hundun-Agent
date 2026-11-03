const life = require('./life')
const store = require('./store')
const llm = require('./llm')
const { parseBlocks, groupNotes } = require('./blocks')

/**
 * 会话引擎。
 *
 * 设计要点：历史存在主进程，渲染进程只是视图。
 * 因为"压缩前先落盘记忆"必须能看到完整历史，放在渲染层会拿不到。
 */

const KEEP_AFTER_COMPACT = 6

let history = []
let summary = ''
let busy = false

function reset() {
  history = []
  summary = ''
}

function state() {
  return { history: history.map((m) => ({ role: m.role, content: m.content })), summary, busy }
}

function persistNotes(notes) {
  const bucket = groupNotes(notes)
  const written = []
  try {
    if (bucket.memory.length) written.push(life.appendJournal(bucket.memory))
    if (bucket.longterm.length) written.push(life.appendLongterm(bucket.longterm))
    if (bucket.profile.length) written.push(life.appendProfile(bucket.profile))
  } catch (e) {
    written.push('写入失败: ' + e.message)
  }
  return written
}

function totalTokens() {
  const sys = life.buildSystemPrompt({ summary })
  let n = life.estimateTokens(sys)
  for (const m of history) n += life.estimateTokens(m.content)
  return n
}

/**
 * 上下文接近上限时：先静默让模型把该记的记下来，再压缩历史。
 * 这是 OpenClaw 的 memoryFlush，在 Electron 里能真正实现（WorkBuddy 里做不到）。
 */
async function maybeCompact() {
  const cfg = store.read()
  const limit = Math.floor((cfg.contextWindow || 32000) * 0.6)
  const used = totalTokens()
  if (used < limit || history.length < 8) return null

  const digest = history
    .map((m) => (m.role === 'user' ? '他：' : '我：') + m.content)
    .join('\n')
    .slice(-24000)

  const { text } = await llm.chat({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          '你在压缩一段对话，同时抢救记忆。只输出两部分，不要任何额外说明：\n' +
          '第一部分：如果有值得长期保留的内容，输出 <memory>、<longterm> 或 <profile> 块（规则同对话中）。\n' +
          '第二部分：以「摘要：」开头，200 字以内，保留未完成的事、他的状态、他的原话要点。'
      },
      { role: 'user', content: digest }
    ]
  })

  const { clean, notes } = parseBlocks(text)
  persistNotes(notes)
  const body = clean.replace(/^摘要[:：]\s*/, '').trim()
  summary = (summary ? summary + '\n' : '') + body
  const dropped = history.length - KEEP_AFTER_COMPACT
  history = history.slice(-KEEP_AFTER_COMPACT)
  return { dropped, used, limit, summary: body }
}

/**
 * 跑一轮对话。
 * @param {string} text 用户输入（或检查点的内部指令）
 * @param {object} hooks { onDelta, onCompact }
 */
async function send(text, hooks = {}) {
  const cfg = store.read()
  if (!cfg.apiKey || !String(cfg.apiKey).trim()) {
    throw new Error('还没有填 API Key。点右上角设置，填上再聊。')
  }

  busy = true
  try {
    const compacted = await maybeCompact()
    if (compacted && hooks.onCompact) hooks.onCompact(compacted)

    // internal = 检查点/开场白这类"它自己开口"的指令，只进本次请求，不进历史
    if (!hooks.internal) history.push({ role: 'user', content: text })

    const messages = [
      { role: 'system', content: life.buildSystemPrompt({ summary }) },
      ...history.slice(-48)
    ]
    if (hooks.internal) messages.push({ role: 'user', content: text })

    let acc = ''
    const streamed = await llm.streamChat(
      {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        messages
      },
      (d) => {
        acc += d
        hooks.onDelta && hooks.onDelta(d)
      }
    )

    const raw = streamed || acc
    const { clean, notes } = parseBlocks(raw)
    const written = persistNotes(notes)
    const finalText = clean || '（这一轮我只记了点东西，没别的话。）'

    history.push({ role: 'assistant', content: finalText })
    if (history.length > 80) history = history.slice(-60)

    return { text: finalText, raw, notes: notes.length, written }
  } finally {
    busy = false
  }
}

module.exports = { send, reset, state, parseBlocks, persistNotes, checkpointSection: life.checkpointSection }
