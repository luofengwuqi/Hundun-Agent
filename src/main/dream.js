/**
 * 记忆折叠（搬迁台账 P1，照 openclaw 的 dreaming 只搬了「目的」）
 *
 * 问题很简单：日记只增不减，`MEMORY.md` 也只增不减。
 * 跑三个月，`MEMORY.md` 会变成第二份日记 —— 于是它每一轮都要读一大堆
 * 「今天很累」「今天卡住了」，真话被埋在流水账里。
 *
 * openclaw 的 dreaming 是三阶段（light 暂存 → REM 反思 → deep 晋升）+ SQLite
 * 召回计数 + embedding 聚类。那些都是 gateway 侧的常驻服务，这边搬不动也不需要。
 * 搬过来的是它的三个判断，一个都没省：
 *
 *   1. **晋升要有门禁。** 不是「日记里出现过就升」，是「值得长期留着的才升」。
 *      openclaw 的门禁是 minScore / minRecallCount / minUniqueQueries（同一件事
 *      被反复提到、被不同问题问到才算数）。这边没有召回计数，用更笨但更稳的办法：
 *      一次喂好几天的日记，让它在**跨天**的尺度上判断，单天的情绪自然就落选了。
 *   2. **模型只做语言判断，门禁是代码。** 哪些话值得留，模型判断；
 *      喂多少天、一次最多几条、和已有记忆重不重复，代码管。
 *   3. **失败就退回保守路径。** 调不通、返回空、解析失败 —— 什么都不写，
 *      进度不推进，明天再来。绝不「尽力而为」地写半截。
 *
 * **它绝不开口。** 这个模块不碰窗口、不推事件、不弹通知，做完只写一行日志。
 * 借机说一句「我把你的记忆整理好了」就是把它变成流程 —— 那正是 D049 否掉的东西。
 */

const fs = require('fs')
const path = require('path')
const life = require('./life')
const { parseBlocks } = require('./blocks')

const STATE_FILE = '.dream.json'

const LIMITS = {
  MIN_DAYS: 3, // 攒够三天才折。少于这个数，几乎全是当天情绪，挑不出持久的
  MAX_DAYS: 7, // 一次最多折七天：第一次跑时别把三个月一口气嚼了
  MAX_CHARS: 12000, // 喂给模型的材料上限
  MAX_MEMORY: 4000, // 附带「已有记忆」的长度（只是让它别重复，不要求它背下来）
  CHECK_MS: 60 * 60 * 1000, // 每小时看一次
  RETRY_MS: 6 * 60 * 60 * 1000 // 失败后歇六小时，别在网络断的时候反复撞
}

const pad = (n) => String(n).padStart(2, '0')

function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function shiftDay(dateStr, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''))
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * 86400000
  const d = new Date(t)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/* ------------------------------------------------------------------ */
/* 判定（纯函数）                                                       */
/* ------------------------------------------------------------------ */

/**
 * 挑出这次该折哪几天。
 *
 * - **今天和昨天不折**：它们本来就在上下文里（`buildSystemPrompt` 会注入），
 *   模型看得见，提炼一遍只是把同样的东西抄进 MEMORY.md。
 * - **只折上次之后的日子**：`lastDay` 是「已经折到哪」，不按它走会反复嚼同一段。
 * - 一次最多 `MAX_DAYS` 天：第一次跑时前面可能堆了半个月，一口气喂进去
 *   既超长又容易挑花眼。
 *
 * @returns {{days:string[], from:string, to:string}|null} 不够数就返回 null
 */
function plan(days, lastDay, now = new Date()) {
  const today = ymd(now)
  const yesterday = shiftDay(today, -1)
  const sorted = [...new Set((days || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort()
  const cand = sorted.filter((d) => d < yesterday && (!lastDay || d > lastDay))
  if (cand.length < LIMITS.MIN_DAYS) return null
  const batch = cand.slice(0, LIMITS.MAX_DAYS)
  return { days: batch, from: batch[0], to: batch[batch.length - 1], pending: cand.length }
}

/** 把几天的日记拼成一段材料，超长就从头砍（保留离现在近的）。 */
function digest(entries, max = LIMITS.MAX_CHARS) {
  const parts = []
  for (const e of entries || []) {
    const body = String(e.text || '').trim()
    if (!body) continue
    parts.push('=== ' + e.day + ' ===\n' + body)
  }
  const all = parts.join('\n\n')
  if (all.length <= max) return { text: all, truncated: false }
  // 从后往前保留：越近的越重要
  return { text: '（前面几天的记录太长，已经截掉了，下面是离现在最近的）\n' + all.slice(-max), truncated: true }
}

function buildPrompt(material, memory) {
  return [
    '你在整理一个人的长期记忆。下面是几天的日记，都是真实记下来的。',
    '',
    '把里面**值得长期留着的**挑出来，最多 6 条：',
    '- 持久的事实：他在做什么事、跟谁的关系、长期的状态',
    '- 有证据的判断：某件事反复出现，或某个模式被多次验证过',
    '- 已经定了的决定、改过的方向',
    '',
    '不要挑：',
    '- 当天的情绪和临时状态（「今天很累」「今天卡住了」）—— 那是日记的事，不是记忆的事',
    '- 已经在「已有记忆」里出现过的（重复记一遍等于把它埋得更深）',
    '- 没有具体指向的空话（「他在努力」「他状态不错」）',
    '',
    '每条都要能指回具体是哪天的事。写陈述句，不写建议。',
    '',
    '只输出下面这个格式，不要任何解释、不要开头结尾：',
    '<longterm>',
    '- 一句话',
    '</longterm>',
    '',
    '这几天里没什么值得长期留的，就什么都不输出。空着比凑数好。',
    '',
    '=== 已有记忆（别重复） ===',
    memory || '（还没有）',
    '',
    '=== 这几天的日记 ===',
    material
  ].join('\n')
}

/** 从模型回复里取条目。只认 <longterm>，正文一个字都不要。 */
function pick(text, max = LIMITS.MAX_ITEMS) {
  const { notes } = parseBlocks(text)
  const out = []
  for (const n of notes) {
    if (n.target !== 'longterm') continue
    for (const raw of n.lines) {
      const line = String(raw).replace(/^[-*]\s*/, '').trim()
      if (line) out.push(line)
    }
  }
  return out.slice(0, max)
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

function statePath() {
  return path.join(life.lifeDir(), STATE_FILE)
}

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {}
  } catch {
    // 读不出来就当没跑过。宁可多折一次（去重会拦住），也不能因为一个坏 JSON 停摆。
    return {}
  }
}

function writeState(s) {
  const file = statePath()
  try {
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    // 状态写不进去不影响这次的结果：下次会重折同一段，appendLongterm 会去重。
    // 反过来为了写状态把已经提炼出来的东西丢掉，才是真的亏。
  }
}

/* ------------------------------------------------------------------ */
/* 跑                                                                  */
/* ------------------------------------------------------------------ */

/**
 * @param {object} opts
 * @param {Function} opts.chat 必需。({messages, temperature, maxTokens}) → {text}
 * @param {Function} [opts.isBusy] 有对话在生成时别插队
 * @param {Function} [opts.log]
 * @param {Function} [opts.notify] 可选，**只用于出错时记一笔**，不能用来跟他说话
 */
function create(opts = {}) {
  const chat = opts.chat
  const isBusy = opts.isBusy || (() => false)
  const log = opts.log || (() => {})
  const now = opts.now || (() => new Date())

  let timer = null
  let running = false
  let retryAfter = 0

  async function run(force = false) {
    if (!chat) return { skipped: 'no-chat' }
    if (running) return { skipped: 'already-running' }
    if (!force && Date.now() < retryAfter) return { skipped: 'cooling' }
    // 他正在等一句话，别在这时候抢网络。折叠不急，晚一小时没人知道。
    if (!force && isBusy()) return { skipped: 'chatting' }

    const st = readState()
    const days = life.listJournalDays()
    const p = plan(days, st.lastDay, now())
    if (!p) return { skipped: 'not-enough' }

    running = true
    try {
      const entries = []
      for (const d of p.days) {
        entries.push({ day: d, text: life.readSafe('memory/' + d + '.md', 8000) })
      }
      const { text: material, truncated } = digest(entries)
      if (!material.trim()) {
        // 这几天全是空文件：推进进度，别反复看它
        writeState({ ...st, lastDay: p.to, at: now().toISOString(), empty: true })
        return { advanced: p.to, items: [] }
      }

      const memory = life.readSafe('MEMORY.md', LIMITS.MAX_MEMORY)
      const res = await chat({
        temperature: 0.2,
        messages: [
          { role: 'system', content: '你在做记忆整理。只输出指定的块，不聊天。' },
          { role: 'user', content: buildPrompt(material, memory) }
        ]
      })

      const raw = (res && (res.text || res)) || ''
      if (!String(raw).trim()) {
        // 空回复**不能当失败**，否则进度会永远卡在这一天。
        //
        // 模型对「这几天没啥可留的」有两种反应：不输出块，或者干脆一个字不说。
        // 前者我们会推进、后者如果卡住，那一天的日记就成了路障 ——
        // 后面所有新日记都堆在它后面永远折不到。
        //
        // 真正的失败（网络、鉴权、超时）在下面 catch 里，那些是抛错的，
        // 一条都跑不掉。这里只是「它没话可说」。
        writeState({ ...st, lastDay: p.to, at: now().toISOString(), empty: (st.empty || 0) + 1 })
        log('折叠 ' + p.from + '~' + p.to + '：模型没说话，当作没有值得留的')
        return { from: p.from, to: p.to, items: [], empty: true }
      }

      const items = pick(raw)
      const written = items.length ? life.appendLongterm(items) : 'MEMORY.md'
      writeState({
        ...st,
        lastDay: p.to,
        at: now().toISOString(),
        runs: (st.runs || 0) + 1,
        lastItems: items.length
      })
      log(
        '折叠 ' + p.from + '~' + p.to + '：挑出 ' + items.length + ' 条' +
          (items.length ? '，写进 ' + written : '，没有值得留的') +
          (truncated ? '（材料太长，已截断）' : '')
      )
      return { from: p.from, to: p.to, items, written }
    } catch (e) {
      retryAfter = Date.now() + LIMITS.RETRY_MS
      log('折叠失败：' + e.message + '，' + p.from + '~' + p.to + ' 留到下次')
      return { error: e.message, from: p.from, to: p.to }
    } finally {
      running = false
    }
  }

  function start() {
    if (timer) return
    // 启动先等一会儿：开机那几分钟事多，别在这时候挤一个模型请求。
    // 之后每小时看一次，`run` 自己会判「够不够数、忙不忙、要不要退避」。
    setTimeout(() => {
      run().catch(() => {})
    }, 90 * 1000)
    timer = setInterval(() => {
      run().catch(() => {})
    }, LIMITS.CHECK_MS)
    if (timer.unref) timer.unref()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { run, start, stop }
}

module.exports = { create, plan, digest, pick, buildPrompt, readState, writeState, LIMITS, STATE_FILE }
