const life = require('./life')
const store = require('./store')
const llm = require('./llm')
const search = require('./search')
const session = require('./session')
const { parseBlocks, groupNotes } = require('./blocks')

/**
 * 会话引擎。
 *
 * 设计要点：历史存在主进程，渲染进程只是视图。
 * 因为"压缩前先落盘记忆"必须能看到完整历史，放在渲染层会拿不到。
 *
 * 注意：这里的 history / summary / busy 是**进程级单值**，不分身份。
 * 切换身份时必须调 resetSession()（清空 + 代次 +1），
 * 否则两个身份的对话会接在一起（F13-06）。
 */

const KEEP_AFTER_COMPACT = 6

let history = []
let summary = ''
let busy = false

/** 手动清空当前身份的会话（不动代次：身份没变） */
function reset() {
  history = []
  summary = ''
}

/**
 * 切身份时调这个。三样都要清，并且把代次推一格——
 * 已经在飞的请求回来时会发现代次变了，于是整个丢弃（见 session.js）。
 */
function resetSession() {
  history = []
  summary = ''
  busy = false
  session.bump()
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

  // 约定单独走：它坏掉不能连累上面三个文件，反过来也一样。
  // 这里不插任何确认、不显示「已记录」（D049）——他聊到兴头上，软件插一句就把聊天变成流程。
  if (bucket.commit.length) {
    try {
      const r = life.ingestCommits(bucket.commit)
      if (r.length) written.push('COMMITMENTS.md（' + r.join('；') + '）')
    } catch (e) {
      written.push('约定写入失败: ' + e.message)
    }
  }

  if (written.length) search.rebuild().catch(() => {})
  return written
}

/**
 * 从旧日记里捞和这句话相关的记忆。
 * 昨天和今天的记录已经在 prompt 里了，不用重复捞。
 */
async function recall(text) {
  try {
    const today = life.dateStr()
    const yesterday = life.dateStr(new Date(Date.now() - 86400000))
    const hits = await search.search(text, 8)
    return hits.filter((h) => h.day !== today && h.day !== yesterday).slice(0, 3)
  } catch {
    return []
  }
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
async function maybeCompact(myEpoch) {
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
  // 压缩期间可能被切了身份：这份摘要和这批记忆属于旧身份，不能落到新身份头上
  if (session.isStale(myEpoch)) return null
  persistNotes(notes)
  const body = clean.replace(/^摘要[:：]\s*/, '').trim()
  summary = (summary ? summary + '\n' : '') + body
  const dropped = history.length - KEEP_AFTER_COMPACT
  history = history.slice(-KEEP_AFTER_COMPACT)
  return { dropped, used, limit, summary: body }
}

/**
 * 跑一轮对话。
 * @param {string} text 用户输入（或"它自己开口"的内部指令）
 * @param {object} hooks { onDelta, onCompact, internal }
 */
async function send(text, hooks = {}) {
  const cfg = store.read()
  if (!cfg.apiKey || !String(cfg.apiKey).trim()) {
    throw new Error('还没有填 API Key。点右上角设置，填上再聊。')
  }

  // 出发时的身份。这一轮结束前若身份变了，结果一律丢弃——
  // 不 push 历史、不写记忆、不回显（F13-06）。
  const myEpoch = session.current()
  busy = true
  try {
    const compacted = await maybeCompact(myEpoch)
    if (session.isStale(myEpoch)) return { dropped: true, text: '' }
    if (compacted && hooks.onCompact) hooks.onCompact(compacted)

    // internal = 开场白这类"它自己开口"的指令，只进本次请求，不进历史
    if (!hooks.internal) {
      history.push({ role: 'user', content: text })
      // 原话落盘（P-07／D028）：只写不读，永远不进上下文，只供回查和检索。
      // internal 的指令不是他说的话，所以这里也不写「你」那一行。
      life.appendChat('user', text)
      search.rebuild().catch(() => {})
    }

    // 内部指令不检索——它不是在问某件事
    const recalled = hooks.internal ? [] : await recall(text)
    if (session.isStale(myEpoch)) return { dropped: true, text: '' }

    const messages = [
      { role: 'system', content: life.buildSystemPrompt({ summary, recalled }) },
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
        // 身份变了就别再往界面上推字：那些字属于上一个身份
        if (!session.isStale(myEpoch)) hooks.onDelta && hooks.onDelta(d)
      }
    )

    const raw = streamed || acc
    const { clean, notes } = parseBlocks(raw)

    // 落盘之前再问一次。这一句是整个 P-25 的核心：
    // 少了它，上一个身份的话会写进现在的 MEMORY.md，而且永远发现不了。
    if (session.isStale(myEpoch)) return { dropped: true, text: '' }

    const written = persistNotes(notes)
    const finalText = clean || '（这一轮我只记了点东西，没别的话。）'

    // 它说的那句也落盘。上面那句兜底不算——原话的承诺里包含「没说就是没说」。
    if (clean) {
      life.appendChat('assistant', clean)
      search.rebuild().catch(() => {})
    }

    history.push({ role: 'assistant', content: finalText })
    if (history.length > 80) history = history.slice(-60)

    return { text: finalText, raw, notes: notes.length, written }
  } finally {
    // 只清自己那一代的锁。身份已经换过的话，这把锁现在属于下一个请求，
    // 在这里清掉会让两个请求同时跑（同一个「不报错只是行为错」的坑）。
    if (!session.isStale(myEpoch)) busy = false
  }
}

module.exports = { send, reset, resetSession, state, parseBlocks, persistNotes }
