/**
 * 打扰调度（P-10／P-12，F06-3 第 2、4 步）
 *
 * 这里原来是一套「检查点」：每天 08:30／21:30 到点开口。已作废（D039／D047／O11），
 * 因为它的判据是「时间到了」；产品要的判据是「你有一句还没合上的话」。
 *
 * 现在的结构分两半：
 *   1. **判定**（judge / dueDate / timeliness）——纯函数，不碰 Electron、不写盘。
 *      这样它能脱开窗口和网络单独测，也才能在测试里把「今天是哪天」捏成固定值。
 *   2. **ticker**（start）——60 秒一次，取配置、取约定、判一次，该说就说。
 *
 * 五条全部满足才开口（F06-3 第 2 步，一期只做这五条）：
 *   有到期／待延后的事 · 在允许时段内 · 今日已发 < 上限 · 今天没被作废 · 总开关开着
 *
 * **还没接的两条（不是忘了）**：
 *   - 「今天不是缺席回归日」→ P-15（F06-9），要做在「好久不见」那句之前，
 *     顺序反了会变成：回来第一天先接一句寒暄，紧接着被催收。
 *   - 「这条约定属于当前 agent」→ 一期只有一个 agent，目录本身就是隔离（D062／D071）。
 *     二期加人时它必须补，且要和「切走即过期」一起改（D067）。
 */

const store = require('./store')
const life = require('./life')

/* ------------------------------------------------------------------ */
/* 日期                                                                */
/* ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0')

/** 只取本地日历日。用 UTC 拼日期是为了躲开夏令时——同一时刻在当地可能算两天。 */
function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function todayOf(now) {
  return ymd(now instanceof Date ? now : new Date())
}

/** 'YYYY-MM-DD' → 自 1970 起的天数（只用来做加减和比较，不用于显示） */
function dayNum(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000)
}

function fromDayNum(n) {
  const d = new Date(n * 86400000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function addDays(dateStr, n) {
  const d = dayNum(dateStr)
  return d == null ? null : fromDayNum(d + n)
}

/** 1=周一 … 7=周日 */
function isoWeekday(dateStr) {
  const d = dayNum(dateStr)
  if (d == null) return null
  const w = new Date(d * 86400000).getUTCDay()
  return w === 0 ? 7 : w
}

function lastDayOfMonth(dateStr) {
  const m = /^(\d{4})-(\d{2})-/.exec(dateStr)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  return ymd(new Date(y, mo, 0)) // 下个月第 0 天 = 这个月最后一天
}

const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 七: 7 }
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/**
 * 「到期日」那一格 -> 绝对日期。
 *
 * 两种写法（F06-1）：
 *   - 已经是绝对日期：`2026-11-08`
 *   - 相对表达 + 当天锚点：`下周三@2026-11-05`——立约那天不猜绝对日期，
 *     把「下周三」和那天一起存下来，这里再换算。猜早了就会记错。
 *
 * 认不出来返回 null。**不猜**：宁可这一条不触发，也不能凭感觉编一个日子，
 * 编错的那天它会在毫不相干的早上提一件早就过去的事。
 */
function dueDate(due, today = todayOf(new Date())) {
  const raw = String(due == null ? '' : due).trim()
  if (!raw) return null
  if (dayNum(raw) != null) return raw

  const at = raw.indexOf('@')
  const expr = (at >= 0 ? raw.slice(0, at) : raw).trim()
  const anchorRaw = at >= 0 ? raw.slice(at + 1).trim() : today
  const anchor = dayNum(anchorRaw) != null ? anchorRaw : today
  if (!expr) return null

  if (/^(今天|今日|当天|当天晚上|当晚)$/.test(expr)) return anchor
  if (/^(明天|明日|明儿|明早|明晚)$/.test(expr)) return addDays(anchor, 1)
  if (/^(后天)$/.test(expr)) return addDays(anchor, 2)
  if (/^(大后天)$/.test(expr)) return addDays(anchor, 3)
  if (/^(昨天|昨日)$/.test(expr)) return addDays(anchor, -1)

  // 「3 天后」「三天以后」「过两天」
  const mDay = /^(\d+|[一二两三四五六七八九十])\s*天(?:之?后|以后)$/.exec(expr) ||
    /^过\s*(\d+|[一二两三四五六七八九十])\s*天$/.exec(expr)
  if (mDay) {
    const n = /^\d+$/.test(mDay[1]) ? Number(mDay[1]) : CN_NUM[mDay[1]]
    if (n != null) return addDays(anchor, n)
  }

  // 「下周X」「下下周X」「这周X／本周X／周X／星期X／礼拜X」
  const mWeek = /^(下下|下|这|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天七])$/.exec(expr)
  if (mWeek) {
    const target = WEEKDAY[mWeek[2]]
    const wd = isoWeekday(anchor)
    if (target && wd) {
      const prefix = mWeek[1] || ''
      if (prefix === '下下') {
        // 下周之后再一周的同一个星期几
        const toNextWeek = 8 - wd
        return addDays(anchor, toNextWeek + 7 + (target - 1))
      }
      if (prefix === '下') {
        const toNextWeek = 8 - wd
        return addDays(anchor, toNextWeek + (target - 1))
      }
      // 这周／本周／光写「周三」：都按「还没到的那一个」算，今天就是周三则算今天
      const delta = (target - wd + 7) % 7
      return addDays(anchor, delta)
    }
  }

  if (/^(月底|这个月底|本月底|月末)$/.test(expr)) return lastDayOfMonth(anchor)
  if (/^(下月初|下个月初)$/.test(expr)) {
    const last = lastDayOfMonth(anchor)
    return last ? addDays(last, 1) : null
  }

  // 「11月8日／11月8号」——只在这一年内找；已经过了就是明年，这是人说话的习惯
  const mMD = /^(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]$/.exec(expr)
  if (mMD) {
    const mo = Number(mMD[1])
    const dd = Number(mMD[2])
    if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) {
      const y = Number(anchor.slice(0, 4))
      const thisYear = `${y}-${pad(mo)}-${pad(dd)}`
      return dayNum(thisYear) < dayNum(anchor) ? `${y + 1}-${pad(mo)}-${pad(dd)}` : thisYear
    }
  }

  return null
}

/* ------------------------------------------------------------------ */
/* 时段                                                                */
/* ------------------------------------------------------------------ */

/** '9:30' / '09:30' / '930' -> 570。认不出返回 null。 */
function parseHm(s) {
  const t = String(s == null ? '' : s).trim()
  if (!t) return null
  const m = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(t)
  if (m) {
    const h = Number(m[1])
    const mi = Number(m[2])
    return h >= 0 && h < 24 && mi >= 0 && mi < 60 ? h * 60 + mi : null
  }
  if (/^\d{3,4}$/.test(t)) {
    const h = Number(t.slice(0, t.length - 2))
    const mi = Number(t.slice(-2))
    return h >= 0 && h < 24 && mi >= 0 && mi < 60 ? h * 60 + mi : null
  }
  return null
}

function minutesOf(now) {
  return now.getHours() * 60 + now.getMinutes()
}

/**
 * 落在任意一个允许时段内。
 *
 * **不做跨零点区间**（F06-4）：23:00–01:00 要他自己拆成两段。
 * 支持跨零点就得决定「哪一天算今天」，而「今天」同时是配额和作废的计数器——
 * 一个含糊的今天会让上限算错，错得还不响。
 * from >= to 的段直接作废（等于没设），不猜他想说什么。
 */
function inWindows(now, windows) {
  const m = minutesOf(now)
  for (const w of windows || []) {
    const a = parseHm(w && w.from)
    const b = parseHm(w && w.to)
    if (a == null || b == null || a >= b) continue
    if (m >= a && m < b) return true
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 时效（P-13 的第一版）                                                */
/* ------------------------------------------------------------------ */

/**
 * 这件事过时了还成不成立。
 *
 * 判据不是「重不重要」，是**「这句话现在说还对不对味」**（F06-5）：
 *   - strong：有明确时点，过了就变味——谈项目、开会、面试、交稿。
 *     「谈得怎么样啦」过了那天就从「陪你等」变成「来收账」。
 *   - weak：持续中的事——写开源、学嵌入式、健身。三天后问「后来呢」是真的想知道。
 *
 * **默认 strong**：认不出来的一律按时效强处理，也就是过时即删、不问。
 * 这个默认方向是刻意的——多问一句是打扰，少问一句只是少一句，
 * 而 D058 已经把「不确定就问」判死过一次了。
 *
 * 这一版是关键词初判（`[助手默认]`），P-13 会把它换成真正的判断。
 * 换的时候要保住两件事：**默认 strong**，以及**「谈项目」不会被「项目」拖进 weak**。
 */
const STRONG_WORDS = [
  '谈', '开会', '会议', '面试', '面谈', '见面', '约好', '约了', '交稿', '截止',
  '去医院', '看病', '挂号', '体检', '报名', '考试', '答辩', '汇报', '出差',
  '签', '付款', '还款', '交货', '发货', '上台', '演讲', '婚礼', '生日', '搬家',
  '开庭', '过户', '入职', '离职', '值班', '接人', '送机', '接机'
]
const WEAK_WORDS = [
  '写', '学', '练', '读', '看', '整理', '准备', '调研', '推进', '健身', '跑',
  '研究', '搭', '设计', '做', '搞', '复习', '背', '项目', '减', '攒'
]

function timeliness(what) {
  const s = String(what == null ? '' : what)
  // 强词优先：「跟客户谈项目细节」里有「项目」，但它是一件事，不是一个长期项目
  if (STRONG_WORDS.some((w) => s.includes(w))) return 'strong'
  if (WEAK_WORDS.some((w) => s.includes(w))) return 'weak'
  return 'strong'
}

/* ------------------------------------------------------------------ */
/* 判定                                                                */
/* ------------------------------------------------------------------ */

const REASONS = {
  off: '打扰总开关关着',
  noWindow: '没有允许时段',
  quiet: '今天别烦我',
  noLimit: '每日上限是 0',
  overLimit: '今天已经到上限了',
  outside: '不在允许时段',
  nothing: '没有到期的事'
}

/**
 * 挑一条现在该说的事。
 *
 * 一次只挑一条：三条同时到期 ≠ 一条「你有三件事」，那是缺席审判（F06-5 硬上限 2）。
 * 剩下的下一轮再说，两条之间由 ticker 隔开（不是一分钟一条）。
 *
 * 顺手返回 drop：**过时且时效强**的那些要删行，不是结案。
 * 「已结案」的意思是「问过了，他不回」，而这些是「根本没问、也不该问了」——
 * 写成一个词，两件事就再也分不开（D061 的教训）。
 */
function choose({ today, items = [] }) {
  const drop = []
  const cands = []

  for (const it of items) {
    if (!it || !it.what) continue
    if (it.delivery === '已送达' || it.delivery === '已结案') continue
    const d = dueDate(it.due, today)
    if (!d) continue // 日期读不出来：不猜，等他自己改

    if (it.delivery === '待延后') {
      // 待延后只给一次，且它当初能被标成待延后，就说明时效判过是弱的
      cands.push({ item: it, kind: 'deferred', due: d })
      continue
    }

    if (d > today) continue // 还没到期

    if (d < today && timeliness(it.what) === 'strong') {
      // 关着机跨过了到期日，而这句话现在已经变味 —— 永远不说（F06-27）
      drop.push(it.index)
      continue
    }

    cands.push({ item: it, kind: d < today ? 'late' : 'due', due: d })
  }

  if (!cands.length) return { fire: false, reason: 'nothing', drop }

  cands.sort((a, b) => {
    // pinned 先：他亲口说过「到那天一定要问我」（D053／X-11）
    const pa = a.item.pinned ? 0 : 1
    const pb = b.item.pinned ? 0 : 1
    if (pa !== pb) return pa - pb
    if (a.due !== b.due) return a.due < b.due ? -1 : 1
    return (a.item.index || 0) - (b.item.index || 0)
  })

  return { fire: true, kind: cands[0].kind, item: cands[0].item, drop }
}

/**
 * 判一次。
 * @param {object} input
 * @param {Date} input.now
 * @param {object} input.cfg 整份配置（里面有 disturb 和 quietDate）
 * @param {object[]} input.items life.listCommitments() 的结果
 * @param {number} input.sentToday 今天已经送达几条
 * @returns {{fire:boolean, reason?:string, item?:object, kind?:string, drop:number[]}}
 */
function judge({ now = new Date(), cfg = {}, items = [], sentToday = 0 } = {}) {
  const disturb = (cfg && cfg.disturb) || {}

  // 顺序不是随便排的：总开关和时段是最容易被他自己关掉的，先判它们，
  // 关着的时候连约定都不去读——读出来又不能用，只会让后面的误判有机会发生。
  if (!disturb.on) return { fire: false, reason: 'off', drop: [] }

  const windows = Array.isArray(disturb.windows) ? disturb.windows : []
  if (!windows.length) return { fire: false, reason: 'noWindow', drop: [] }

  if (String(cfg.quietDate || '') === todayOf(now)) return { fire: false, reason: 'quiet', drop: [] }

  const limit = Number(disturb.dailyLimit) || 0
  if (limit <= 0) return { fire: false, reason: 'noLimit', drop: [] }
  if (Number(sentToday) >= limit) return { fire: false, reason: 'overLimit', drop: [] }

  if (!inWindows(now, windows)) return { fire: false, reason: 'outside', drop: [] }

  return choose({ today: todayOf(now), items })
}

/**
 * 这一轮该跟它说什么。**不是给用户看的文案**，是内部指令。
 *
 * 三处措辞很要紧：
 *   - 不许提「到期」「到点」「提醒」：一提就变成闹钟，而 SWL 里它应该只是记得。
 *   - 一次只说一件事：这条指令本身就是唯一的话题，不能顺手带别的。
 *   - 延后／过期的那条必须重写措辞（F06-28）：照搬那句「后天那个谈完了吗」，
 *     在两天后听起来就是另一个人说的话。
 */
function promptFor(d) {
  const what = d && d.item ? d.item.what : ''
  const due = d && d.item ? d.item.due : ''
  if (!what) return ''
  if (d.kind === 'deferred') {
    return `（这件到期那天没送到他跟前，现在补上：${what}，原定 ${due}。按现在的时点把话重说一遍，不要照搬当时想好的那句；不要提「延期」「补发」「上次」。只说这一件事，一两句话，说完就停。）`
  }
  if (d.kind === 'late') {
    return `（这件事已经过了日子才说：${what}，原定 ${due}。按现在的时点说，不要提「前几天」「本来」「怎么现在才」。只说这一件事，一两句话，说完就停。）`
  }
  return `（现在该你开口了。你记得一件事：${what}，到期日 ${due}。只说这一件事，一两句话，说完就停。把「到期」「到点」「提醒」「检查」这些词留在心里，别说出口；也不要顺带问别的事。）`
}

/* ------------------------------------------------------------------ */
/* ticker                                                              */
/* ------------------------------------------------------------------ */

const TICK_MS = 60 * 1000
// 两条之间至少隔这么久（`[助手默认]`）。一次只说一件事，不等于一分钟说一件——
// 三条同时到期连着弹三次，读起来就是催收（F06-5 硬上限 2 要防的正是这个）。
const GAP_MS = 10 * 60 * 1000
// 生成失败（没 key、网络不通）后压这么久。这不是「没送到」，是压根没说出这句话，
// 不该标待延后；但也不能每分钟撞一次。
const COOLDOWN_MS = 10 * 60 * 1000
// 启动后等一会儿再判第一次：ready-to-show 之前窗口还不可见，
// 那时候判成「送达」是靠通知，他会先看到一条通知、点开才看到窗口里已经有一句话。
const FIRST_DELAY_MS = 20 * 1000

/** 通知正文取前 90 字（F06-3 第 3 步）。太长的通知在系统托盘里会被截断成一串省略号。 */
function brief(text, n = 90) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * 按「送达」标记，不按「发出」（D057，P-12）。
 *
 * 这是整个 M2 的地基：按发出标记，关机那晚的那句就永远算「问过了」，
 * 延后从此不会发生——不报错、不崩，只是有一天你发现它再也没提过那件事。
 *
 * 四种走法：
 *   送达          → 未问→已送达（或 待延后→已送达），并计一次配额
 *   没送到·待延后 → 删行（延后只给一次）
 *   没送到·时效弱 → 未问→待延后，下次他在的时候再说
 *   没送到·时效强 → 删行（过时了就别说了，F06-27）
 */
function mark(d, delivered) {
  const it = d.item
  try {
    if (delivered) {
      if (it.delivery === '未问') store.bumpDisturb(1)
      life.updateCommitment(it.index, { delivery: '已送达' }, { expectWhat: it.what })
      return 'delivered'
    }
    if (it.delivery === '待延后') {
      life.removeCommitment(it.index)
      return 'dropped'
    }
    if (timeliness(it.what) === 'weak') {
      life.updateCommitment(it.index, { delivery: '待延后' }, { expectWhat: it.what })
      return 'deferred'
    }
    life.removeCommitment(it.index)
    return 'dropped'
  } catch {
    // 行在他手里被改过（挪了位置、删了）—— 什么都不动，下一轮从头读一遍。
    // 改错行的代价比这一轮不发大得多。
    return 'skipped'
  }
}

/** 删除按倒序来：删第 2 行之后，原来的第 5 行就变成第 4 行，正序删会删错。 */
function dropRows(drop) {
  const list = (drop || []).slice().sort((a, b) => b - a)
  const done = []
  for (const i of list) {
    try {
      if (life.removeCommitment(i)) done.push(i)
    } catch {}
  }
  return done
}

/**
 * 起一个调度器。
 *
 * 依赖全部注入，是为了这一层能测：
 *   getWindow  —— 判窗口可见（送达的一半判据）
 *   isBusy     —— 正在跟他说话时不插嘴
 *   send       —— 往渲染进程推事件
 *   notify     —— 系统通知，返回 Promise<boolean>（真的展示出来了吗）
 */
function start(opts = {}) {
  const {
    getWindow = () => null,
    isBusy = () => false,
    send = () => {},
    notify = async () => false,
    intervalMs = TICK_MS,
    gapMs = GAP_MS
  } = opts

  let timer = null
  let firstTimer = null
  let running = false
  let lastFireAt = 0
  let cooldownUntil = 0
  let stopped = false
  const log = opts.log || (() => {})

  async function deliver(d, win, visible) {
    const sendTurn = opts.sendTurn || (async () => ({ text: '' }))
    let text = ''
    try {
      const r = await sendTurn(promptFor(d), {
        internal: true,
        onDelta: (t) => send('chat:delta', t)
      })
      if (r && r.dropped) return { delivery: 'skipped' } // 身份换了：这轮不算送达，也不算没说
      text = (r && r.text) || ''
    } catch (e) {
      cooldownUntil = Date.now() + COOLDOWN_MS
      log('生成失败，先不说：' + e.message)
      return { delivery: 'error', error: e.message }
    }

    let delivered = visible && !!text
    let notified = false
    if (!delivered && text) {
      notified = await notify({ title: '馄饨', body: brief(text) })
      delivered = !!notified
    }

    // 界面上要收尾：这轮不是他点的发送，没有 chat:send 的返回值可以 finalize，
    // 不推这一条的话那个光标会一直闪，而且这一句永远「正在输入」。
    send('chat:turn', { text })

    const delivery = mark(d, delivered)
    log(`开口了（${d.kind}）：${d.item.what} → ${delivery}${notified ? '（通知）' : ''}`)
    return { delivery, text }
  }

  async function tick() {
    if (stopped || running) return
    const now = new Date()
    if (now.getTime() < cooldownUntil) return

    let cfg
    try {
      cfg = store.read()
    } catch {
      return
    }

    let items = []
    try {
      items = life.listCommitments()
    } catch {
      return
    }

    const d = judge({ now, cfg, items, sentToday: store.disturbSentToday() })
    if (d.drop && d.drop.length) dropRows(d.drop)
    if (!d.fire) return

    // 「一次只说一件事」不等于一分钟说一件
    if (lastFireAt && now.getTime() - lastFireAt < gapMs) return
    if (isBusy()) return

    const win = getWindow()
    const visible = !!(win && !win.isDestroyed() && win.isVisible())
    running = true
    try {
      const r = await deliver(d, win, visible)
      // 生成失败不推进时间：否则一次网络抖动会把这条压 10 分钟
      if (r.delivery !== 'error') lastFireAt = Date.now()
    } catch (e) {
      log('调度出错：' + e.message)
    } finally {
      running = false
    }
  }

  function scheduleFirst() {
    firstTimer = setTimeout(() => {
      tick()
      timer = setInterval(tick, intervalMs)
    }, Math.min(FIRST_DELAY_MS, intervalMs))
  }

  scheduleFirst()

  return {
    tick,
    /** 正在自己开口（生成中）。外面用它做互斥，别让两轮对话同时跑。 */
    isBusy: () => running,
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      if (firstTimer) clearTimeout(firstTimer)
      timer = null
      firstTimer = null
    },
    /** 测试用：把「上次开口」「冷却到什么时候」清掉 */
    _reset() {
      lastFireAt = 0
      cooldownUntil = 0
    }
  }
}

module.exports = {
  judge,
  choose,
  dueDate,
  timeliness,
  inWindows,
  parseHm,
  promptFor,
  brief,
  mark,
  start,
  REASONS,
  TICK_MS,
  GAP_MS,
  // 测试用：把「今天」定死
  _todayOf: todayOf,
  _addDays: addDays
}
