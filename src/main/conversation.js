const fs = require('fs')
const path = require('path')
const paths = require('./paths')
const life = require('./life')
const store = require('./store')
const llm = require('./llm')
const search = require('./search')
const session = require('./session')
const memgate = require('./memgate')
const { parseBlocks, groupNotes, diagnose } = require('./blocks')

/**
 * 会话引擎。
 *
 * 设计要点：历史存在主进程，渲染进程只是视图。
 * 因为"压缩前先落盘记忆"必须能看到完整历史，放在渲染层会拿不到。
 *
 * 会话会落盘（D074）：`<身份目录>/.session.json`，存 history + 压缩摘要。
 * 它和 `chat/*.md` 是两件事，别混：
 *   - chat/ 留"他说过的原话"，只写不读（D028），给以后回查和检索；
 *   - .session.json 存"这一轮要接着聊的上下文"，给重启之后接得上。
 *
 * 内存里 history / summary / busy 仍然是单值，不分身份。
 * 切换身份必须走 resetSession()：清空 + 代次 +1 + 按新身份重新加载，
 * 否则两个身份的对话会接在一起（F13-06）。
 */

const KEEP_AFTER_COMPACT = 6
const SESSION_FILE = '.session.json'
// 恢复上限：文件里最多留 80 条，读回来最多 60 条。正常聊天根本到不了，
// 能到就是文件被人塞过东西，宁可少接一段也不要一次把上下文撑爆。
const RESTORE_LIMIT = 60
const SUMMARY_MAX = 12000

let history = []
let summary = ''
let busy = false

function sessionFile() {
  return path.join(life.lifeDir(), SESSION_FILE)
}

/**
 * 落盘。先写 .tmp 再 rename —— rename 是原子的，进程被 kill 也只会
 * 留一个 .tmp，不会留下半截 JSON 让下次启动把整段会话丢掉。
 *
 * 写失败一律吞掉：落盘只决定"下次还接不接得上"，不能因为它失败就没收这一轮的回复。
 */
function saveSession() {
  const ctx = paths.context()
  const body = {
    version: 1,
    user: ctx.userId,
    agent: ctx.agentId,
    updatedAt: new Date().toISOString(),
    summary,
    history: history.slice(-80)
  }
  try {
    const file = sessionFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 读回来。三种情况一律当"没有会话"：文件不在、JSON 坏了、身份对不上。
 *
 * 第三条是重点。目录本来就按身份分，理论上串不了；但迁移、手动拷贝、
 * 从别人机器上搬一整个 ~/life 过来，都能让一个 .session.json 出现在错误的目录里。
 * 宁可丢一段上下文，也不能让 A 的话进 B 的上下文 —— F13-06 只是换了个入口。
 */
function loadSession() {
  let data
  try {
    data = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'))
  } catch {
    return { loaded: false }
  }
  if (!data || typeof data !== 'object') return { loaded: false }

  const ctx = paths.context()
  if (data.user && data.user !== ctx.userId) return { loaded: false, mismatch: true }
  if (data.agent && data.agent !== ctx.agentId) return { loaded: false, mismatch: true }

  const rows = Array.isArray(data.history) ? data.history : []
  history = rows
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
    .slice(-RESTORE_LIMIT)
    .map((m) => ({ role: m.role, content: m.content }))
  summary = typeof data.summary === 'string' ? data.summary.slice(-SUMMARY_MAX) : ''
  return { loaded: true, count: history.length, hasSummary: Boolean(summary) }
}

function clearSessionFile() {
  try {
    fs.rmSync(sessionFile(), { force: true })
  } catch {}
}

/** 手动清空当前身份的会话（不动代次：身份没变）。磁盘上那份也要删，否则重启就复活了。 */
function reset() {
  history = []
  summary = ''
  clearSessionFile()
}

/**
 * 切身份时调这个。四样都要做，并且把代次推一格——
 * 已经在飞的请求回来时会发现代次变了，于是整个丢弃（见 session.js）。
 *
 * 复位之后立刻按新身份加载：重启接得上、切回来也接得上，
 * 而"接得上"和"串味"只隔着一个 setContext 的先后顺序，所以顺序写死在这里。
 */
function resetSession() {
  history = []
  summary = ''
  busy = false
  session.bump()
  return loadSession()
}

function state() {
  return { history: history.map((m) => ({ role: m.role, content: m.content })), summary, busy }
}

/**
 * @param {Array} notes 从回复里抠出来的记忆块
 * @param {object} opts { provenance }
 */
function persistNotes(notes, opts = {}) {
  // 它自己开口那一轮，什么都不记（照 openclaw 的 session-kind gating）。
  //
  // 理由不是洁癖：那一轮里的话**全是它生成的**，他一个字都没说。
  // 记进日记，明天它就会读到「我说过他最近在忙 X」——而 X 是它自己编的，
  // 从此当成事实用下去。这种污染不报错、不崩，只是越陪越不对劲。
  //
  // 定时任务、压缩摘要这类「不是他说的」轮次都走这条。
  if (opts.provenance && opts.provenance !== 'user') return []

  const bucket = groupNotes(notes)
  const written = []
  try {
    if (bucket.memory.length) written.push(life.appendJournal(bucket.memory))
    if (bucket.longterm.length) written.push(life.appendLongterm(bucket.longterm))
  } catch (e) {
    written.push('写入失败: ' + e.message)
  }

  // 档案单独走：它是覆盖写，还可能一条都不落（重复的会被跳过），
  // 所以返回值要逐条说清楚，不能只报一个文件名。
  if (bucket.profile.length) {
    try {
      const r = life.ingestProfile(bucket.profile)
      if (r.length) written.push('USER.md（' + r.join('；') + '）')
    } catch (e) {
      written.push('档案写入失败: ' + e.message)
    }
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

  // 没合上的话（P-14）。同样单独走，坏一个不连累别人。
  if (bucket.open.length) {
    try {
      const r = life.ingestOpens(bucket.open)
      if (r.length) written.push('OPEN.md（' + r.join('；') + '）')
    } catch (e) {
      written.push('未闭合写入失败: ' + e.message)
    }
  }

  // 仪式收尾（D089）。它是第六种块，但不是记忆 —— 是「我实在问不动了」这句话。
  //
  // 为什么需要它：完成判据是「档案里五条活的话」，而仪式允许他答「不知道」、
  // 也允许他不想聊就停。两条并排，仪式可能永远结束不了，于是他每次打开
  // 都被从「怎么称呼你」重问一遍。**判据不可达，和不一致一样坏。**
  // 判断「问不动了」归模型，删文件归这里 —— 与 D086 的分工一致。
  if (bucket.bootstrap.length) {
    try {
      const r = life.retireBootstrap(bucket.bootstrap)
      if (r) written.push(r)
    } catch (e) {
      written.push('仪式收尾失败: ' + e.message)
    }
  }

  if (written.length) search.rebuild().catch(() => {})
  return written
}

/**
 * 写入回执（D086）。
 *
 * 它写记忆是「回复正文里塞一个块」，而正文和块之间没有任何强制关系 ——
 * 模型可以嘴上说「记住了」而磁盘上什么都不发生。实测就发生过一次。
 *
 * 这里给它补一趟独立的抽取：只在**判据命中**时跑（说了记却没块、
 * 或仪式期间答了话却没进档案），写完还走上面那条 `persistNotes`，
 * 保证「块怎么落盘」永远只有一份实现。
 */
const gate = memgate.create({
  chat: async ({ messages, temperature }) => {
    const cfg = store.read()
    if (!cfg.apiKey || !String(cfg.apiKey).trim()) throw new Error('还没有填 API Key')
    const { text } = await llm.chat({
      chain: cfg.modelChain,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      temperature,
      maxTokens: 600,
      messages
    })
    return text
  },
  write: (notes) => persistNotes(notes, { provenance: 'user' }),
  log: (msg) => console.log('[memgate] ' + msg)
})

/**
 * 判据命中就补写。**不 await**：这一轮的话已经说出口了，
 * 补写失败不该让他多等，也不该把已经正常的那轮变成报错。
 * 代次在这里守一道 —— 补写期间换了身份，这批记忆属于上一个人。
 */
function repairIfNeeded({ userText, assistantText, notes, provenance, myEpoch }) {
  let verdict = null
  try {
    verdict = memgate.needsRepair({
      userText,
      assistantText,
      notes,
      bootstrapPending: life.bootstrapPending(),
      provenance
    })
  } catch {
    return
  }
  if (!verdict) return
  if (session.isStale(myEpoch)) return

  gate
    .repair({
      userText,
      assistantText,
      reason: verdict.reason,
      guard: () => !session.isStale(myEpoch)
    })
    .catch(() => {})
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
    // 只排除今天（今天的原话都在 history 里，再捞一遍是重复）。
    // 昨天不排除：昨天的日记常常是空的，昨天说过的话只能从 chat 记录里捞回来（D096）。
    return hits.filter((h) => h.day !== today).slice(0, 3)
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
        // 按设置里排好的顺序试。只有一个模型时它就是单元素，行为和以前一样。
        chain: cfg.modelChain,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        messages,
        // 换过模型要说一声：不然他会以为这句话还是原来那个说的
        onFallback: (info) => {
          if (!session.isStale(myEpoch) && hooks.onFallback) hooks.onFallback(info)
        }
      },
      (d) => {
        acc += d
        // 身份变了就别再往界面上推字：那些字属于上一个身份
        if (!session.isStale(myEpoch)) hooks.onDelta && hooks.onDelta(d)
      }
    )

    const raw = streamed || acc
    const { clean, notes } = parseBlocks(raw)

    // 一个块都没出来时，记一句为什么。「没写」和「写了没闭合」结果一样、修法不同，
    // 不留这一行的话，下次还得靠猜。只记判据，不倒正文（那是他的原话）。
    if (!notes.length && !hooks.internal) {
      const why = diagnose(raw)
      if (why) console.log('[blocks] 这轮的块没解析出来：' + why)
    }

    // 落盘之前再问一次。这一句是整个 P-25 的核心：
    // 少了它，上一个身份的话会写进现在的 MEMORY.md，而且永远发现不了。
    if (session.isStale(myEpoch)) return { dropped: true, text: '' }

    const written = persistNotes(notes, { provenance: hooks.provenance || 'user' })
    const finalText = clean || '（这一轮我只记了点东西，没别的话。）'

    // 回执：判据命中就补一趟抽取（D086）。放在落盘之后、返回之前触发，
    // 但不 await —— 话已经说出口了，补写慢不该让他等。
    if (!hooks.internal && clean) {
      repairIfNeeded({
        userText: text,
        assistantText: clean,
        notes,
        provenance: hooks.provenance || 'user',
        myEpoch
      })
    }

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
    //
    // 落盘也守同一道代次：正在飞的请求切了身份，这份 history 属于上一个身份，
    // 写下去就是把人 A 的话存进 B 的会话文件——比丢一段上下文糟得多。
    if (!session.isStale(myEpoch)) {
      busy = false
      saveSession()
    }
  }
}

module.exports = {
  send,
  reset,
  resetSession,
  state,
  parseBlocks,
  persistNotes,
  repairIfNeeded,
  saveSession,
  loadSession,
  sessionFile
}
