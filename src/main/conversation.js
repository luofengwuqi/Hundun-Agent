const fs = require('fs')
const path = require('path')
const paths = require('./paths')
const life = require('./life')
const store = require('./store')
const llm = require('./llm')
const search = require('./search')
const session = require('./session')
const memgate = require('./memgate')
const { parseBlocks, groupNotes, diagnose, BLOCK_RE } = require('./blocks')

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
// 上一批放进 prompt 的旧事。只为看「话题换没换」，不是缓存搜索结果（D107）。
let memoryQuilt = null
/**
 * 仪式期那几轮（D115）。**和 history 分开存**，只在仪式内部给判定当上文用。
 *
 * 为什么不合在一起：仪式走完那一刻它就是另一个人了，前面那些「■■ 待录入 ■■」
 * 不该进馄饨的上下文 —— 它会学着自己上一轮也在打乱码。他答过的东西在 USER.md 里，
 * 原话在 chat 日志里，这一段丢掉不损失任何东西。它也不落盘：重启后仪式要么还在
 * （重问一遍，反正档案里有的一格不会再问），要么已经结束（这段本来就该忘）。
 */
let ritualHistory = []

/**
 * D120：仪式期间他答了什么（key+原话），fill 时攒着，走完那一刻打包成交接摘要。
 * 和 ritualHistory 一样不落盘——答过的东西在 USER.md 里，这里只是「刚发生的事」
 * 的原件，给模型当轮上下文用一次就扔。setRitualHandoff 之后由 life 持有。
 */
const ritualFilled = []

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
  memoryQuilt = null
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
  memoryQuilt = null
  // 交接摘要跟着会话走：切身份就是另一段人生，旧的摘要必须扔（D120）。
  life.takeRitualHandoff()
  session.bump()
  return loadSession()
}

function state() {
  return {
    history: history.map((m) => ({ role: m.role, content: m.content })),
    summary,
    busy,
    // D112：界面靠它判断「仪式刚走完」——上一轮 pending 为 true、这一轮 false 就放过场。
    // 放在 state 里而不是单独开一条通道：界面本来每轮都要问一次状态，多一个字段不算事。
    ritual: life.ritualState()
  }
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

// D123：日记补写的节流窗口。见 repairIfNeeded 里的说明。
const DAILY_REPAIR_GAP_MS = 30 * 60 * 1000
let lastDailyRepairAt = 0

/**
 * 判据命中就补写。**不 await**：这一轮的话已经说出口了，
 * 补写失败不该让他多等，也不该把已经正常的那轮变成报错。
 * 代次在这里守一道 —— 补写期间换了身份，这批记忆属于上一个人。
 */
function repairIfNeeded({ userText, assistantText, notes, provenance, myEpoch }) {
  // D123：日记补写的节流。真机探针（3 轮）显示模型只在**对话收尾**那轮写日记，
  // 一天聊十轮、他说了十件事，日记里只有最后两条。这条兜底半小时最多跑一次，
  // 能把当天补到十来条，又不至于每轮都多花一次模型调用。
  // 进程重启归零：重启后第一次会补一次，正好。
  const now = Date.now()
  const dailyDue = now - lastDailyRepairAt >= DAILY_REPAIR_GAP_MS
  let verdict = null
  try {
    verdict = memgate.needsRepair({
      userText,
      assistantText,
      notes,
      bootstrapPending: life.bootstrapPending(),
      provenance,
      dailyDue
    })
  } catch {
    return
  }
  if (!verdict) return
  if (session.isStale(myEpoch)) return
  if (verdict.reason === 'daily-unwritten') lastDailyRepairAt = now

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
 *
 * **同一段对话里不重查**（D107）。原来每轮都拿新话重查一次，话题稍微一偏，
 * 翻出来的旧事就换一批 —— 他会觉得这东西忽而记得、忽而不记得，
 * 而问题不在检索准不准，在它每句话都在换答案。
 * 判据很便宜：上一批里还有一条对得上，就算同一个话题，沿用；一条都不剩才换。
 * 代价是不追话题漂移，所以压缩之后要清一次（那里是真的换了语境）。
 */
async function recall(text) {
  try {
    const today = life.dateStr()
    const hits = await search.search(text, 8)
    // 只排除今天（今天的原话都在 history 里，再捞一遍是重复）。
    // 昨天不排除：昨天的日记常常是空的，昨天说过的话只能从 chat 记录里捞回来（D096）。
    const fresh = hits.filter((h) => h.day !== today).slice(0, 3)
    const keyOf = (h) => h.file + ':' + h.line

    if (memoryQuilt && memoryQuilt.length) {
      const same = fresh.some((f) => memoryQuilt.some((c) => keyOf(c) === keyOf(f)))
      if (same) return memoryQuilt
    }
    memoryQuilt = fresh
    return fresh
  } catch {
    return []
  }
}

function totalTokens() {
  const sys = life.buildPrompt({ summary })
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
  // 压缩之后语境真的换了：清掉上一批旧事，下一轮按新上下文重新找
  memoryQuilt = null
  return { dropped, used, limit, summary: body }
}

/**
 * 仪式期的一轮（D115）。
 *
 * 他和我们最后定下来的分工：**可见的每一句都是现成的**，模型只回答「这一格填上了没有」。
 * 它没有说话的出口 —— 这里只取它输出里的 `<slot>` 标记，其余字符一律丢弃。
 *
 * 两个理由，第二个更重要：
 * 1. 语气稳定。上一版让模型自己造句，它写的是「我这边还是空的，先问一件最简单的」——
 *    人味就是从这类句子漏进来的，无论加多少条禁令都会漏。
 * 2. 仪式期的对话**不进主 history**。走完那一刻它就是另一个人了，
 *    「我上一轮在打乱码」不该出现在馄饨的上下文里。他答过的东西已经进了 USER.md，
 *    原话进了 chat 日志和当天日记，所以丢掉这一段不损失任何东西。
 */
async function ritualTurn({ text, internal, myEpoch }) {
  const cfg = store.read()
  const slot = life.ritualSlot()

  // 理论上到不了这里：所有格都有了或都跳过了，BOOTSTRAP.md 还没删——
  // 直接收尾，别把人卡在一个没有下一格的协议里。
  if (!slot && life.bootstrapPending()) {
    life.endRitual()
    life.setRitualHandoff(ritualFilled.splice(0))
    const reply = life.ritualReply({ kind: 'fill', prev: null, slot: null })
    ritualHistory.push({ role: 'assistant', content: reply })
    return { text: reply, raw: reply, notes: 0, written: [], ritual: life.ritualState() }
  }

  if (!internal) {
    // 原话照旧落盘（P-07／D028）——「他到底说过什么」不能因为这是仪式就少一份。
    life.appendChat('user', text)
    try {
      life.appendDiary(text)
    } catch {}
    search.rebuild().catch(() => {})
  }

  // 它自己开口那一轮：没有可判定的内容，直接给第一格。
  if (internal) {
    const reply = life.ritualReply({ kind: 'boot', slot })
    ritualHistory.push({ role: 'assistant', content: reply })
    return { text: reply, raw: reply, notes: 0, written: [], ritual: life.ritualState() }
  }

  // 「跳过」是协议词，主进程字面认，不走判定模型（D122）。
  // 理由同 D115 的分工：可见的每个字都来自表，那么**判定哪些词是命令**也该在代码里——
  // 让模型去认「跳过」，它就可能把「我想跳过这首歌」也当成跳格。
  if (slot && /^\s*(跳过|skip)\s*$/i.test(text)) {
    const next = life.skipSlot(slot.key)
    const done = !next
    if (done) {
      life.endRitual()
      life.setRitualHandoff(ritualFilled.splice(0))
    }
    const reply = life.ritualReply({ kind: 'skipped', prev: slot, slot: next })
    ritualHistory.push({ role: 'assistant', content: reply })
    return { text: reply, raw: reply, notes: 0, written: [], ritual: life.ritualState() }
  }

  // 判定。任何失败（没配 key、网络、模型乱写）都当成 skip ——
  // 代价是同一格再问一遍，收益是**永远不会把编的话写进他的档案**。
  let verdict = { kind: 'skip' }
  if (slot && cfg.apiKey && String(cfg.apiKey).trim()) {
    try {
      const { text: raw } = await llm.chat({
        chain: cfg.modelChain,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        // 温度 0：这一格填没填上是事实判断，不是创作。
        temperature: 0,
        maxTokens: 80,
        messages: [
          { role: 'system', content: life.buildRitualPrompt() },
          ...ritualHistory.slice(-4),
          { role: 'user', content: text }
        ]
      })
      verdict = life.parseVerdict(raw, slot.key)
    } catch {
      verdict = { kind: 'skip' }
    }
  }

  // 这一轮作废了，但仪式状态还是要带回去（D121）。
  // 原来这里只回 `{ dropped, text }`，界面拿不到 ritual 就不知道仪式已经走完——
  // 于是屏幕上那些安装程序的话只能一直留着，界面也没有理由把它清掉。
  if (session.isStale(myEpoch)) return { dropped: true, text: '', ritual: life.ritualState() }

  if (verdict.kind === 'fill') {
    ritualFilled.push({ key: verdict.key, value: verdict.value })
    try {
      life.ingestProfile([verdict.key + '｜' + verdict.value])
    } catch {}
  }

  let done = false
  let kind = 'fill'
  let prev = slot
  let next = null
  if (verdict.kind === 'end') {
    life.endRitual()
    done = true
    kind = 'end'
  } else if (life.retireBootstrapIfDone()) {
    // 够格了（三个主题、且必须有「称呼」）—— 软件自己收尾，不问他。
    // prev 置空：这一轮可能什么都没录进来（档案早就够了），不报 RECORDED，直接给收尾块。
    done = true
    prev = null
  } else if (verdict.kind === 'skip') {
    // 他没答上：按「未检测到有效输入」打回重试。同一格三遍都空，才按跳过走——
    // 跳过是**他说的**「跳过」，不是我们替他决定的。
    if (slot && life.noteSkip(slot.key) >= 3) {
      life.skipSlot(slot.key)
      kind = 'skipped'
      next = life.ritualSlot()
      if (!next) {
        life.endRitual()
        done = true
      }
    } else {
      kind = 'missing'
      next = slot
      prev = null
    }
  } else if (verdict.kind === 'fill') {
    // 最后一格填完、后面的格都被跳过时，ritualSlot() 会返回 null——
    // 这时也得收尾。原来只靠 retireBootstrapIfDone 的主题数判，
    // 「称呼已填、其余全跳过」那条路走不到它，BOOTSTRAP.md 会永远留着。
    next = life.ritualSlot()
    if (!next) {
      life.endRitual()
      done = true
    }
  }

  // 仪式走完的那一刻，把攒下的答话打包成交接摘要交给 life（D120）。
  // splice 是取走：之后 ritualFilled 清空，就算 reset 也拿不到第二次。
  // 没走完就不动它——下一格接着攒。
  if (done) life.setRitualHandoff(ritualFilled.splice(0))

  const reply = life.ritualReply({ kind, prev, slot: next })
  ritualHistory.push({ role: 'assistant', content: reply })

  return {
    text: reply,
    raw: reply,
    notes: 0,
    written: [],
    ritual: life.ritualState()
  }
}

/**
 * 跑一轮对话。
 * @param {string} text 用户输入（或"它自己开口"的内部指令）
 * @param {object} hooks { onDelta, onCompact, internal }
 */
async function send(text, hooks = {}) {
  const cfg = store.read()

  // 出发时的身份。这一轮结束前若身份变了，结果一律丢弃——
  // 不 push 历史、不写记忆、不回显（F13-06）。
  const myEpoch = session.current()
  busy = true
  try {
    // D115：仪式期整条走另一套（固定话术 + 判定），连 API Key 都不强求 ——
    // 第一句「系统初始化」是现成的字，不该因为没填 key 就开不了机。
    life.retireBootstrapIfDone()
    if (life.bootstrapPending()) {
      return await ritualTurn({ text, internal: !!hooks.internal, myEpoch })
    }

    if (!cfg.apiKey || !String(cfg.apiKey).trim()) {
      throw new Error('还没有填 API Key。点右上角设置，填上再聊。')
    }

    const compacted = await maybeCompact(myEpoch)
    if (session.isStale(myEpoch)) return { dropped: true, text: '' }
    if (compacted && hooks.onCompact) hooks.onCompact(compacted)

    // internal = 开场白这类"它自己开口"的指令，只进本次请求，不进历史
    if (!hooks.internal) {
      history.push({ role: 'user', content: text })
      // 原话落盘（P-07／D028）：只写不读，永远不进上下文，只供回查和检索。
      // internal 的指令不是他说的话，所以这里也不写「你」那一行。
      life.appendChat('user', text)
      // 他的原话同时进当天日记（D097）：chat 只写不读，日记才是会被注入回去的那份。
      // 机械兜底 —— 模型不写块，这条通道不能也等它。
      try {
        life.appendDiary(text)
      } catch {}
      search.rebuild().catch(() => {})
    }

    // 内部指令不检索——它不是在问某件事
    const recalled = hooks.internal ? [] : await recall(text)
    if (session.isStale(myEpoch)) return { dropped: true, text: '' }

    // 块是写入协议，不是对话内容：他界面上看不到，喂回模型的历史里也要剥掉。
    // 不剥的话，模型看到的「自己上一轮」结尾是 </profile> ——「看上一轮怎么收尾」
    // 这类判据就被块标签遮住了（真机问卷感的一个来源）。memgate 判定用原始文本，不受影响。
    const stripBlocks = (c) => String(c || '').replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim()
    // D120：交接摘要只在仪式刚结束后的第一轮取走，且只在主对话轮（非 internal）。
    // bootstrapPending 说明仪式还在，摘要没打包，别取；totalTokens 那条 buildPrompt
    // 调用不传 handoff，就是怕在那儿把摘要误消耗掉。
    const handoff = hooks.internal || life.bootstrapPending() ? null : life.takeRitualHandoff()
    const messages = [
      { role: 'system', content: life.buildPrompt({ summary, recalled, handoff }) },
      ...history.slice(-48).map((m) => ({ role: m.role, content: m.role === 'assistant' ? stripBlocks(m.content) : m.content }))
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

    // ritual：这一轮说完之后仪式还在不在。界面拿它和上一轮比，
    // true→false 就是「刚走完」，放那一屏过场（D112）。
    return { text: finalText, raw, notes: notes.length, written, ritual: life.ritualState() }
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
  recall,
  parseBlocks,
  persistNotes,
  repairIfNeeded,
  saveSession,
  loadSession,
  sessionFile
}
