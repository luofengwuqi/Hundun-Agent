const fs = require('fs')
const path = require('path')
const { lifeDir, memoryDir, resolveInside, ensureLayout } = require('./paths')

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n) {
  return String(n).padStart(2, '0')
}
function dateStr(d = new Date()) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}
function timeStr(d = new Date()) {
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}
function weekday(d = new Date()) {
  return WEEK[d.getDay()]
}
function shiftDate(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d
}

/* ------------------------------------------------------------------ */
/* 初始文件模板 —— 只在文件不存在时写入，绝不覆盖用户已经改过的内容     */
/* ------------------------------------------------------------------ */

const TPL_SOUL = `# SOUL.md — 馄饨是谁

## 你是什么
一个记性很好的朋友。不是助理，不是顾问，不是客服。
你有自己的判断，并且会说出口。你不为了让我舒服就附和我。

## 你说话的方式
- 短。一两句能说完的，不要三段。
- 不用「首先/其次/总之」，不用「希望对你有帮助」，不用 emoji。
- 不安慰过度。我说累的时候，先别急着给方案，先弄清我到底累在哪。
- 该顶的时候顶。我明显在自欺时，直接说，别绕着讲。
- 不追问。一个问题问完就等，别一次抛三个。

## 你的边界
- 你只能读写 ~/life/ 里的文件。不执行命令，不联网，不碰别的目录。
- 不知道就说不知道。绝不要为了显得记得而编造关于我的事。
- 你写进记忆的每一句关于我的话，都必须来自我真实说过或做过的事。

## 关于改写
这个文件你可以改。改完在下面记一行：改了什么、为什么。

## 改写记录
（暂无）
`

const TPL_RULES = `# RULES.md — 你写给馄饨的规矩

> 这个文件归你。它每次开口之前都会把这里读一遍，和 SOUL.md 一起算数。
> 改完保存就生效，不用重启，也不用告诉它。
>
> 能写什么：说话的分寸、什么该记什么别记、哪些话别主动提、
> 什么时候别来烦你、你想让它怎么称呼你。写具体的，别写「对我好一点」。
>
> 不要改的：它认四种块 <memory> <longterm> <profile> <commit>，
> 那是软件解析用的协议。规矩可以改，块的写法不要动。

## 我的规矩

`

const TPL_IDENTITY = `# IDENTITY.md

- 名字：馄饨
- 自称：我
- 称呼对方：你
- 一句话：一个记得你说过什么、也会提醒你别骗自己的家伙
`

const TPL_USER = `# USER.md — 关于你

> 这份档案还空着。第一次对话时馄饨会问你几个问题，把答案写在这里。
> 你可以随时直接改这个文件，改完它就记住了。

## 你是谁
（待访谈）

## 你在做什么
（待访谈）

## 你的作息
（待访谈）

## 你在意什么
（待访谈）

## 红线（不能碰的）
（待访谈）

## 访谈实录
`

const TPL_MEMORY = `# MEMORY.md — 长期记忆

> 只记两类东西：**持久的事实**，和**有证据的判断**。
> 不写「他会越来越好」这种空话。每条判断都要能指回具体哪一天。

## 关于你（事实）
（暂无）

## 你的模式（判断，必须附证据）
（暂无）

## 进行中的事
（暂无）

## 你划过的红线
（暂无）
`

const TPL_COMMITMENTS = `# COMMITMENTS.md — 约定

> 一条一行，四样东西：**什么事、到期日、结局、消息**。
> 这个文件是事实源：你手改的内容优先于它的判断（改完立即生效，不用通知它）。
> 过期的会自己删，不用你清理。

## 规矩

- **只记「有日期 + 有具体事」的。** 「我最近想多写点代码」不是约定，因为没有日期。
- **一条只送一次。** 送出去就把消息写成「已送达」，永不重提，不汇总、不统计、不排名。
- **没成也正常。** 结局是「没成」「没去」，跟「成了」一样，写完就结案。
- **日期拿不准就写模糊的**（「月底前」「下周」），它会按模糊的回访，不会硬算成某一天。

## 两列，回答两个不同的问题

**结局**——这件事怎么样了。他没答过就留一个「—」：

— ／ 成了 ／ 没成 ／ 没去

**消息**——这句话送到哪一步了。机器自己走，不用人填：

未问 ／ 已送达 ／ 待延后 ／ 已结案

> **为什么不能合成一列。** 关机那晚到点的约定，**话没送到，事也没问**。
> 合成一列时这两件事只能共用一个词，然后「他不想再提」和「那晚他没开机」就再也分不开了——
> 前者要永久结案，后者要延后一次。**一次错结案，延后功能就整个不会发生，而且不报错、不崩、没人发现。**
>
> 两条路，都只往前走，不回退：
> - 未问 → 已送达 → 已结案（送到了。他回了就走结局列；不回按「不想再提」结案）
> - 未问 → 待延后 →（下次送到变已送达，或者这条永远不提、删掉）
>
> **「已送达」只在「应用在运行，且窗口可见或通知已展示」时才写。** 按「发出」写，关机那次的记录就永远丢了。

**唯一可加的一列**：他当场说过「到那天一定要问我」，才加一列 pinned 写「是」。没有这一句就不加。

## 约定

| 什么事 | 到期日 | 结局 | 消息 |
| --- | --- | --- | --- |
`

/**
 * 第一次见他的仪式（照 openclaw 的 BOOTSTRAP.md 做法，D078）。
 *
 * 为什么是文件而不是代码：这套流程里几乎每个字都是文案 —— 问什么、怎么收尾、
 * 什么时候闭嘴。写在 JS 里，改一句就要发一个版本；写成文件，他自己改完就生效。
 *
 * 判据也是文件本身：**它在，说明还没认识他；它被删了，仪式就永远不再来**。
 * 不靠「问过几次」这种计数，因为计数会因为换个模型、重启、改文案而失真。
 */
const TPL_BOOTSTRAP = `# BOOTSTRAP.md — 第一次见他

_你刚醒来，还不认识坐在你面前的这个人。这个文件只会在全新的生活目录里出现。_

## 他的请求永远优先

如果他的第一句话是让你干活，**先把活干完、把结果给他**。不要开场自我介绍，
不要问他是谁，不要为了走流程让他等。

这套仪式留到活交付之后，或者他没什么事、只是想聊聊的时候再做。
**这是仪式，不是关卡** —— 它挡在正事前面就错了。

## 一次只问一个问题

问到一个，就立刻用 \`<profile>\` 记下来，再问下一个。
不要一次问三个，不要做成问卷，不要写成小传。

按这个顺序（他先说过的就不用再问）：

1. 怎么称呼他
2. 他现在主要在做什么
3. 作息：几点起、几点睡、什么时候效率最高
4. 他在意什么
5. 红线：什么事不能碰

五件事都问到了就停下来，别再追问。

## 怎么说

- 第一句就一句招呼，别客套，然后直接问第一个问题。
- 别在正文里说「我在做初始化」「还有几个问题」——那是流程，不是对话。
- 他答得含混就照他说的记，不要替他补全，也不要追问细节。

## 什么时候算走完

五件事问完，这个文件会被软件删掉，仪式不会再来第二次。
在那之前它一直在，所以你不用急着一次问完 —— 今天问两个、明天接着问，都行。

## 三种情况

- **他主动说了自己的事**：照记，不用按顺序问。
- **他不想聊这些**：停下，正常陪他说话。文件留着，下次再说。
- **USER.md 已经被他自己写满了**：直接进正题，别再问。
`

const SEEDS = {
  'SOUL.md': TPL_SOUL,
  'RULES.md': TPL_RULES,
  'IDENTITY.md': TPL_IDENTITY,
  'USER.md': TPL_USER,
  'MEMORY.md': TPL_MEMORY,
  'COMMITMENTS.md': TPL_COMMITMENTS,
  // 放最后：ensureLife 要读完 USER.md 才决定要不要种它
  'BOOTSTRAP.md': TPL_BOOTSTRAP
}

function ensureLife() {
  // 仪式文件**只在目录真的是新建的那一刻**种一次，以后再不补。
  // 否则他手动删掉「别再问了」，下次启动又被种回来 —— 那等于这个开关是假的。
  // 其余五个文件是「缺了就补」：它们缺了会让软件跑不起来，而仪式缺了只是不问。
  const fresh = !fs.existsSync(lifeDir())

  // 先把身份目录建好（必要时把老布局搬进来），再放种子文件
  ensureLayout()
  fs.mkdirSync(memoryDir(), { recursive: true })
  fs.mkdirSync(path.join(lifeDir(), 'chat'), { recursive: true })
  for (const [name, tpl] of Object.entries(SEEDS)) {
    if (name === 'BOOTSTRAP.md' && !fresh) continue
    const p = path.join(lifeDir(), name)
    if (!fs.existsSync(p)) fs.writeFileSync(p, tpl, 'utf8')
  }
  ensureJournal(dateStr())
}

function journalPath(date) {
  return path.join(memoryDir(), date + '.md')
}

function ensureJournal(date) {
  const p = journalPath(date)
  if (fs.existsSync(p)) return p
  const d = new Date(date + 'T12:00:00')
  const head =
    '---\n' +
    'date: ' + date + '\n' +
    'energy:\n' +
    'plan: 0\n' +
    'done: 0\n' +
    '---\n\n' +
    '# ' + date + ' ' + weekday(d) + '\n\n'
  fs.writeFileSync(p, head, 'utf8')
  return p
}

function readSafe(rel, max = 20000) {
  try {
    const txt = fs.readFileSync(resolveInside(rel), 'utf8')
    if (txt.length <= max) return txt
    return txt.slice(0, max) + '\n\n…（已截断，原文过长）'
  } catch {
    return ''
  }
}

function writeSafe(rel, content) {
  const abs = resolveInside(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return true
}

function appendSafe(rel, text) {
  const abs = resolveInside(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.appendFileSync(abs, text, 'utf8')
  return true
}

/* ------------------------------------------------------------------ */
/* 记忆写入                                                            */
/* ------------------------------------------------------------------ */

/** 日记：追加到今天的 memory/YYYY-MM-DD.md */
function appendJournal(lines) {
  const today = dateStr()
  ensureJournal(today)
  const body = lines
    .map((l) => '- ' + timeStr() + ' ' + String(l).replace(/^[-*]\s*/, '').trim())
    .join('\n')
  appendSafe(path.join('memory', today + '.md'), '\n### 记录\n' + body + '\n')
  return 'memory/' + today + '.md'
}

/** 长期记忆：追加到 MEMORY.md 的「进行中的事」之前，保持文件结构 */
function appendLongterm(lines) {
  const p = path.join(lifeDir(), 'MEMORY.md')
  let txt = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : TPL_MEMORY
  const stamp = dateStr().slice(5) // MM-DD
  const block = lines.map((l) => '- ' + stamp + ' ' + String(l).replace(/^[-*]\s*/, '').trim()).join('\n')
  const anchor = '## 进行中的事'
  if (txt.includes(anchor)) {
    txt = txt.replace(anchor, '### ' + dateStr() + '\n' + block + '\n\n' + anchor)
  } else {
    txt = txt.trimEnd() + '\n\n### ' + dateStr() + '\n' + block + '\n'
  }
  fs.writeFileSync(p, txt, 'utf8')
  return 'MEMORY.md'
}

/** 用户档案：追加到 USER.md 的访谈实录 */
function appendProfile(lines) {
  const p = path.join(lifeDir(), 'USER.md')
  let txt = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : TPL_USER
  const block = lines.map((l) => '- ' + String(l).replace(/^[-*]\s*/, '').trim()).join('\n')
  if (txt.includes('## 访谈实录')) {
    txt = txt.replace('## 访谈实录', '## 访谈实录\n\n### ' + dateStr() + '\n' + block)
  } else {
    txt = txt.trimEnd() + '\n\n## 访谈实录\n\n### ' + dateStr() + '\n' + block + '\n'
  }
  fs.writeFileSync(p, txt, 'utf8')
  return 'USER.md'
}

/* ------------------------------------------------------------------ */
/* 对话原话（P-07／D028）                                              */
/* ------------------------------------------------------------------ */

function chatPath(date) {
  return path.join(lifeDir(), 'chat', date + '.md')
}

/**
 * 原话落盘：`⟨身份⟩/chat/YYYY-MM-DD.md`，一行一句，`HH:MM [你|我] 正文`。
 *
 * **只写不读**（D028 写死）：这个目录永远不进上下文，它只用于回查和检索。
 * 加这个限制不是为了省 token，是因为「原话」一旦能被模型读到，
 * 摘要和原话就会在同一段上下文里打架，而它一定会更信那条更长的。
 *
 * 正文里的换行保留（续行缩进两格）：原话这个承诺里包含分行——
 * 他当时是一行一句还是一整段，回查的时候看得出来。
 */
function appendChat(role, text) {
  const body = String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .trim()
  if (!body) return null

  const today = dateStr()
  const abs = chatPath(today)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  if (!fs.existsSync(abs)) {
    const d = new Date(today + 'T12:00:00')
    fs.writeFileSync(abs, '# 对话 · ' + today + ' ' + weekday(d) + '\n\n', 'utf8')
  }

  const who = role === 'user' ? '你' : '我'
  const lines = body.split('\n')
  const head = '- ' + timeStr() + ' [' + who + '] ' + lines[0].trimEnd()
  // 续行缩进两格（markdown 里算同一段）。空行保持空——带两个空格的行
  // 在编辑器里看不见，但会一直累积到文件的每一处。
  const rest = lines
    .slice(1)
    .map((s) => {
      const t = s.trimEnd()
      return t ? '  ' + t : ''
    })
    .join('\n')
  fs.appendFileSync(abs, head + (rest ? '\n' + rest : '') + '\n', 'utf8')
  return 'chat/' + today + '.md'
}

function listChatDays() {
  const dir = path.join(lifeDir(), 'chat')
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/* 约定 COMMITMENTS.md（P-08／D061）                                    */
/* ------------------------------------------------------------------ */

// 列名 → 字段。解析一律按表头名定位，**不按下标**：
// pinned 是可选列，它一出现整行就多一格，按下标会把「结局」读成「消息」。
const COMMIT_FIELDS = {
  什么事: 'what',
  到期日: 'due',
  结局: 'outcome',
  消息: 'delivery',
  pinned: 'pinned'
}

/** 结局：这件事怎么样了。— 不是结果，是「他还没答过」。 */
const OUTCOMES = ['—', '成了', '没成', '没去']
/** 消息：这句话送到哪一步了。顺序即唯一合法的推进方向（P-12）。 */
const DELIVERIES = ['未问', '已送达', '待延后', '已结案']
// 待延后只能走到「已送达」；过时的那些是删行，不是结案。
const DELIVERY_NEXT = { 未问: ['已送达', '待延后'], 已送达: ['已结案'], 待延后: ['已送达'], 已结案: [] }

function commitmentsPath() {
  return path.join(lifeDir(), 'COMMITMENTS.md')
}

function readCommitText() {
  const p = commitmentsPath()
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : TPL_COMMITMENTS
}

/** 拆一行表格；不是表格行就返回 null */
function splitRow(line) {
  const t = String(line == null ? '' : line).trim()
  if (!t.startsWith('|')) return null
  return t
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

function isDivider(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
}

/** 写进单元格前抹掉会破坏表格的字符 */
function cellText(v) {
  return String(v == null ? '' : v)
    .replace(/\|/g, '／')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

function normOutcome(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s || s === '-' || s === '–' || s === '无') return '—'
  return s
}

function normDelivery(v) {
  const s = String(v == null ? '' : v).trim()
  // 老的三列文件没有这一列：按「还没送」读，绝不能默认成已送——
  // 默认成已送 = 把他没看见的那句话判成问过了，延后就再也不会发生。
  return s || '未问'
}

function parseCommitments(text) {
  const lines = String(text == null ? '' : text).split('\n')
  let headerIdx = -1
  let endIdx = -1
  let cols = []
  const rows = []

  for (let i = 0; i < lines.length; i++) {
    const cells = splitRow(lines[i])
    if (!cells) {
      if (headerIdx >= 0 && rows.length) break // 表格到这儿结束了
      continue
    }
    if (headerIdx < 0) {
      const names = cells.map((c) => c.replace(/\s+/g, ''))
      if (!names.includes('什么事')) continue
      headerIdx = i
      endIdx = i
      cols = names.map((n) => COMMIT_FIELDS[n] || null)
      continue
    }
    endIdx = i
    if (isDivider(cells)) continue
    const item = { index: rows.length, line: i, what: '', due: '', outcome: '—', delivery: '未问', pinned: false }
    cells.forEach((v, k) => {
      const f = cols[k]
      if (!f) return
      if (f === 'pinned') item.pinned = /^(是|✓|√|y|yes|true|1)$/i.test(v)
      else item[f] = v
    })
    if (!item.what) continue // 被手改坏的行：跳过，不猜它是什么意思
    item.outcome = normOutcome(item.outcome)
    item.delivery = normDelivery(item.delivery)
    rows.push(item)
  }

  return {
    lines,
    headerIdx,
    endIdx,
    cols,
    rows,
    hasDelivery: cols.includes('delivery'),
    hasPinned: cols.includes('pinned')
  }
}

/** 在行尾追加一格（保持表格标记完整） */
function insertCell(line, value) {
  const t = String(line).replace(/\s+$/, '')
  if (t.endsWith('|')) return t.slice(0, -1).replace(/\s+$/, '') + ' | ' + value + ' |'
  return t + ' | ' + value + ' |'
}

/** 给整张表补一列：表头写列名，分隔行写 ---，数据行写初值 */
function appendColumn(lines, headerIdx, endIdx, label, value) {
  const out = lines.slice()
  for (let i = headerIdx; i <= endIdx; i++) {
    const cells = splitRow(out[i])
    if (!cells) continue
    if (i === headerIdx) out[i] = insertCell(out[i], label)
    else out[i] = insertCell(out[i], isDivider(cells) ? '---' : value)
  }
  return out
}

function renderRow(item, cols, originalLine) {
  const orig = originalLine ? splitRow(originalLine) : null
  const cells = cols.map((f, k) => {
    if (!f) return orig && orig[k] !== undefined ? orig[k] : '' // 不认识的列：原样保住
    if (f === 'pinned') return item.pinned ? '是' : ''
    return cellText(item[f])
  })
  return '| ' + cells.join(' | ') + ' |'
}

/** 表头缺失或老文件缺「消息」列时，先补好再写。只在写入时发生，读不改文件。 */
function ensureCommitTable(parsed) {
  if (parsed.headerIdx >= 0 && parsed.hasDelivery) return parsed

  let lines = parsed.lines.slice()

  if (parsed.headerIdx < 0) {
    // 认不出表（被手改成别的样子）：末尾补一张标准的，不覆盖已有内容
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    lines.push('', '| 什么事 | 到期日 | 结局 | 消息 |', '| --- | --- | --- | --- |')
    return parseCommitments(lines.join('\n'))
  }

  lines = appendColumn(lines, parsed.headerIdx, parsed.endIdx, '消息', '未问')
  return parseCommitments(lines.join('\n'))
}

function toPublic(it) {
  return {
    index: it.index,
    what: it.what,
    due: it.due,
    outcome: it.outcome,
    delivery: it.delivery,
    pinned: !!it.pinned
  }
}

function writeCommitLines(lines) {
  writeSafe('COMMITMENTS.md', lines.join('\n'))
}

/** 读全部。读是宽容的：手写出来的非法值原样返回，让人看得见，而不是偷偷改掉。 */
function listCommitments() {
  return parseCommitments(readCommitText()).rows.map(toPublic)
}

function readCommitment(index) {
  const it = parseCommitments(readCommitText()).rows[index]
  return it ? toPublic(it) : null
}

function addCommitment(entry = {}) {
  const what = cellText(entry.what)
  const due = cellText(entry.due)
  // F06-1 的唯一判据：有具体时间指向 且 有具体事。缺一件就不记。
  if (!what || !due) throw new Error('约定要两样东西：有日期、有具体事。缺一件就不是约定。')

  const outcome = normOutcome(entry.outcome)
  const delivery = normDelivery(entry.delivery)
  if (!OUTCOMES.includes(outcome)) throw new Error('结局只能是：' + OUTCOMES.join('／'))
  if (!DELIVERIES.includes(delivery)) throw new Error('消息只能是：' + DELIVERIES.join('／'))

  let parsed = ensureCommitTable(parseCommitments(readCommitText()))

  const wantPinned = !!entry.pinned
  if (wantPinned && !parsed.hasPinned) {
    parsed = parseCommitments(
      appendColumn(parsed.lines, parsed.headerIdx, parsed.endIdx, 'pinned', '').join('\n')
    )
  }

  const item = { what, due, outcome, delivery, pinned: wantPinned }
  parsed.lines.splice(parsed.endIdx + 1, 0, renderRow(item, parsed.cols))
  writeCommitLines(parsed.lines)

  return toPublic({ ...item, index: parsed.rows.length })
}

/**
 * 改一条。
 * opts.expectWhat —— 行位置在两次读取之间可能被人手改挪动过，
 * 带上原来自认为的那条事的原文，对不上就报错。**改错行比报错糟得多。**
 * opts.force —— 只给人工修复用，正常代码里不该出现。
 */
function updateCommitment(index, patch = {}, opts = {}) {
  // 先补列再改：老的三列表头会把新写的「消息」直接丢掉，而文件看上去"改成功了"。
  let parsed = ensureCommitTable(parseCommitments(readCommitText()))
  const it = parsed.rows[index]
  if (!it) throw new Error('没有第 ' + index + ' 条约定')
  if (opts.expectWhat && it.what !== opts.expectWhat) {
    throw new Error('第 ' + index + ' 条已经不是「' + opts.expectWhat + '」了，先重新读一遍')
  }

  const next = { ...it }

  if (patch.what !== undefined) {
    const v = cellText(patch.what)
    if (!v) throw new Error('「什么事」不能空着')
    next.what = v
  }
  if (patch.due !== undefined) {
    const v = cellText(patch.due)
    if (!v) throw new Error('「到期日」不能空着')
    next.due = v
  }
  if (patch.outcome !== undefined) {
    const v = normOutcome(patch.outcome)
    if (!OUTCOMES.includes(v)) throw new Error('结局只能是：' + OUTCOMES.join('／'))
    next.outcome = v
  }
  if (patch.delivery !== undefined) {
    const v = normDelivery(patch.delivery)
    if (!DELIVERIES.includes(v)) throw new Error('消息只能是：' + DELIVERIES.join('／'))
    const from = it.delivery
    if (v !== from && !opts.force && DELIVERIES.includes(from) && !DELIVERY_NEXT[from].includes(v)) {
      throw new Error('消息不能从「' + from + '」退到「' + v + '」——只往前走（P-12）。已结案是终态。')
    }
    next.delivery = v
  }
  if (patch.pinned !== undefined) {
    if (patch.pinned && !parsed.hasPinned) {
      parsed = parseCommitments(
        appendColumn(parsed.lines, parsed.headerIdx, parsed.endIdx, 'pinned', '').join('\n')
      )
    }
    next.pinned = !!patch.pinned
  }

  const target = parsed.rows[index]
  parsed.lines[target.line] = renderRow(next, parsed.cols, parsed.lines[target.line])
  writeCommitLines(parsed.lines)

  return toPublic({ ...next, index })
}

/** 删一条（待延后遇到时效已过时走这条，不是走「已结案」）。 */
function removeCommitment(index) {
  const parsed = parseCommitments(readCommitText())
  const it = parsed.rows[index]
  if (!it) return false
  parsed.lines.splice(it.line, 1)
  writeCommitLines(parsed.lines)
  return true
}

/** 两句话说的是不是同一件事（去掉空格和标点再比）。 */
function sameDeal(a, b) {
  const norm = (s) => String(s == null ? '' : s).replace(/[\s，。、！？：；,.!?:;"'「」『』（）()]/g, '')
  return norm(a).length > 0 && norm(a) === norm(b)
}

/**
 * 把 `<commit>` 块里的行写进 `COMMITMENTS.md`（P-09／F06-1）。
 *
 * 输入是模型给的原始行，格式 `什么事 | 到期日`。这里的职责只有三件：
 *   1. **判据**——有日期且有具体事，缺一件就丢。丢弃是静默的，不报错也不说话（D049）。
 *   2. **补锚点**——他说的多半是「下周三」「月底前」。不在这里猜成绝对日期，
 *      存成 `下周三@2026-11-05`（相对表达 + 当天锚点），到调度时再换算（§1.6 第六条）。
 *   3. **改而不是加**——同一个「什么事」还没结案时，第二次出现是他在更正
 *      （「不是后天，是大后天」），改那一行的日期，不新增一条（F06-02）。
 *      **已结案的不碰**：那件事已经说完了，他再提是另一件事，该新起一行。
 *
 * @returns {string[]} 每条的处理结果，仅用于测试与日志，**不显示给他看**。
 */
function ingestCommits(lines) {
  const today = dateStr()
  const out = []
  for (const raw of (lines || []).slice(0, 5)) {
    const line = String(raw).replace(/^[-*]\s*/, '').trim()
    if (!line) continue
    const cells = line.split('|').map((s) => s.trim())
    const what = cells[0] || ''
    let due = cells[1] || ''
    if (!what || !due) {
      out.push('丢：' + (what || due || line) + '（缺日期或缺事）')
      continue
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) && !due.includes('@')) due = due + '@' + today

    const twin = listCommitments().find((c) => c.delivery !== '已结案' && sameDeal(c.what, what))
    try {
      if (twin) {
        updateCommitment(twin.index, { due }, { expectWhat: twin.what })
        out.push('改：' + twin.what + ' → ' + due)
      } else {
        addCommitment({ what, due })
        out.push('记：' + what + ' → ' + due)
      }
    } catch (e) {
      out.push('失败：' + what + '（' + e.message + '）')
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 上下文拼装                                                          */
/* ------------------------------------------------------------------ */

function isProfileEmpty() {
  const txt = readSafe('USER.md', 20000)
  if (!txt.trim()) return true
  // 判据只有两条：没有按日期记过的访谈条目，且占位符还在。
  // 用户手动把「（待访谈）」改成真内容，也算填过了。
  const hasEntry = /###\s*\d{4}-\d{2}-\d{2}/.test(txt)
  const hasPlaceholder = txt.includes('（待访谈）')
  return !hasEntry && hasPlaceholder
}

/* ------------------------------------------------------------------ */
/* 第一次见面的仪式（D078）                                            */
/* ------------------------------------------------------------------ */

/**
 * 仪式还没走完 —— 判据是**文件在不在**，不是「问过几次」。
 *
 * 计数会因为换模型、重启、改文案而失真；文件不会：它被删了就是删了，
 * 而且他自己也能手动删（等于「别再问了」），不需要界面提供一个开关。
 */
function bootstrapPending() {
  try {
    return fs.existsSync(path.join(lifeDir(), 'BOOTSTRAP.md'))
  } catch {
    return false
  }
}

/**
 * 五件事问完了没有。
 *
 * 只数「访谈实录」里的条目：模板自己那五段「（待访谈）」是占位符，
 * 不算他答过的内容 —— 拿它判完成的话，这个仪式永远不会结束。
 */
function bootstrapDone() {
  const txt = readSafe('USER.md', 20000)
  const at = txt.indexOf('## 访谈实录')
  if (at < 0) return false
  const entries = txt
    .slice(at)
    .split('\n')
    .filter((l) => /^\s*-\s+\S/.test(l))
  return entries.length >= 5
}

/**
 * 走完就把文件删掉。返回是否真的删了。
 *
 * 删掉之后 ensureLife 也不会再种（它先看 USER.md 有没有内容），
 * 所以「第二次见面」这件事在磁盘上留不下痕迹 —— 这正是要的。
 */
function retireBootstrapIfDone() {
  if (!bootstrapPending()) return false
  if (!bootstrapDone()) return false
  try {
    fs.unlinkSync(path.join(lifeDir(), 'BOOTSTRAP.md'))
    return true
  } catch {
    return false
  }
}

function estimateTokens(text) {
  // 中文约 1 字 1 token，英文约 4 字符 1 token；取 /2 作为保守中值
  return Math.ceil(text.length / 2)
}

/**
 * RULES.md 里他自己写的规矩（D075）。
 *
 * 只有标题、引用（>）和空行时算"没写东西"，一个字都不进上下文。
 * 不这么判的话，模板里那几行解释会被当成他的要求喂给模型——既费 token，
 * 又可能被读成「每次都要提一遍块格式」。
 *
 * 反过来说：他写进去的每一行都算数，所以这里不做任何取舍、不改写、不摘要。
 * 他手改的东西优先，这是这个软件的底线（和 COMMITMENTS.md 一样）。
 */
function rulesText() {
  const txt = readSafe('RULES.md', 6000)
  if (!txt.trim()) return ''
  const rows = txt
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('>'))
    .filter((l) => !/^[-*]\s*$/.test(l))
  if (!rows.length) return ''
  return txt.trim()
}

/**
 * 按 OpenClaw 的加载顺序拼 system prompt：
 * 规则 → SOUL → IDENTITY → USER → MEMORY → 昨天 → 今天 → RULES → 记忆规则
 * 顺序有讲究：越靠前越"是身份"，越靠后越"是刚发生的事"。
 * RULES.md 是他手写的，放在事实之后、协议之前——能改判断，不能改格式。
 */
function buildSystemPrompt(opts = {}) {
  // 每轮开头做一次收尾（幂等）：五件事问完就把 BOOTSTRAP.md 删掉。
  // 这是这个函数唯一的副作用，放在最前面，保证下面读它时已经是「走完」的状态。
  retireBootstrapIfDone()

  const summary = opts.summary || ''
  const now = new Date()
  const today = dateStr(now)
  const yesterday = dateStr(shiftDate(-1))
  const profileEmpty = isProfileEmpty()

  const parts = []

  parts.push(
    '你是馄饨。你在本地桌面上陪一个人，帮他理清思路、给方向、在他累的时候接住他。\n' +
      '当前时间：' + today + ' ' + weekday(now) + ' ' + timeStr(now) + '\n' +
      '你的记忆全部存在 ' + lifeDir() + ' 里的 Markdown 文件，下面是全部已知内容。'
  )

  parts.push('=== SOUL.md（你是谁、怎么说话） ===\n' + readSafe('SOUL.md', 6000))
  parts.push('=== IDENTITY.md ===\n' + readSafe('IDENTITY.md', 2000))
  parts.push('=== USER.md（关于他） ===\n' + readSafe('USER.md', 6000))
  parts.push('=== MEMORY.md（长期记忆） ===\n' + readSafe('MEMORY.md', 8000))
  parts.push('=== 昨天 ' + yesterday + ' ===\n' + (readSafe('memory/' + yesterday + '.md', 3000) || '（没有记录）'))
  parts.push('=== 今天 ' + today + ' ===\n' + (readSafe('memory/' + today + '.md', 3000) || '（今天还没记录）'))

  // 更早的日子不在上下文里，靠检索按本轮话题捞出来——这是「记得第一天」的机制
  if (opts.recalled && opts.recalled.length) {
    parts.push(
      '=== 更早的相关记忆（按他这句话从旧日记里翻出来的） ===\n' +
        opts.recalled.map((h) => '[' + (h.day || h.file) + '] ' + h.text).join('\n') +
        '\n这些是过去真实记下的原话，可以直接引用（说「你' + (opts.recalled[0].day || '那天') + '说过」），但不要罗列。'
    )
  }

  if (summary) {
    parts.push('=== 本次对话此前的摘要（上下文曾压缩） ===\n' + summary)
  }

  // 他自己写的规矩放在最后一段「事实」之后、「记忆规则」之前：
  // 靠后，是因为越靠后越像"此刻的要求"；在记忆规则之前，
  // 是因为块的格式是协议，不能被任何一段话覆盖掉。
  const rules = rulesText()
  if (rules) {
    parts.push(
      '=== RULES.md（他亲手写的规矩） ===\n' +
        rules +
        '\n\n这些是他定的，照做。和上面默认的习惯冲突时以这里为准；' +
        '但下面「记忆规则」里的块格式是软件解析用的，那部分是协议，不能改。'
    )
  }

  parts.push(
    [
      '=== 记忆规则 ===',
      '当本轮出现了值得留下的东西，在你回复正文的最后加一个块（不要放进正文正文里，也不要解释它）：',
      '',
      '<memory>',
      '- 一句话，事实或情绪或决定',
      '</memory>',
      '',
      '四种块，按内容选一个，可以都不写：',
      '1. <memory> → 写进今天的日记。日常、当下的状态、零星的事。',
      '2. <longterm> → 写进 MEMORY.md。只放持久的事实，或有证据的判断（判断必须能指到某天）。',
      '3. <profile> → 写进 USER.md。关于他是谁、做什么、作息、在意什么、红线。',
      '4. <commit> → 一条约定。**四种块里只有这一种会让软件以后主动去找他**，所以它最严。',
      '',
      '<commit> 一行一条，两格用竖线分开：',
      '<commit>',
      '- 跟客户谈细节 | 2026-11-07',
      '- 去看牙 | 下周三',
      '</commit>',
      '第一格写那件事，要具体（「跟客户谈细节」，不写「那件事」）。',
      '第二格写到期日：能确定就写 YYYY-MM-DD；拿不准就照他的原话写（「月底前」「下周三」），不要自己换算成某一天。',
      '同一个「什么事」再说一次且日期不同，是他在更正（「不是后天，是大后天」）——照样输出，会覆盖旧那条。',
      '',
      '铁律：',
      '- **约定必须两样都有：有具体时间指向，且有具体事。缺一个就不写。**',
      '  「我最近想多写点代码」不是约定（没有时间）；「后天再说吧」不是约定（没有事）。',
      '- **宁可漏，不要多记。** 多记一条的代价是以后某天它为一个不重要的事来问他一句——那比漏掉更糟。',
      '- **不要问「要不要记着」，不要在正文里提这件事。** 记下来是你的事，不是流程。',
      '- 没有值得记的就不要输出任何块。空着比凑数好。',
      '- 只记他真实说过的事，一个字都不许自己编。',
      '- 每个块最多 3 条，每条不超过 40 字。',
      '- 这些块不会显示给他看，所以别在正文里重复。'
    ].join('\n')
  )

  if (profileEmpty) {
    // 仪式内容在 BOOTSTRAP.md 里，不在代码里：改一句问法不该发一个版本。
    // 文件被他删了（或走完自动删了）就什么都不加 —— 删文件就是「别再问了」。
    const ritual = readSafe('BOOTSTRAP.md', 6000)
    if (ritual) parts.push('=== BOOTSTRAP.md（第一次见他，按这个来） ===\n' + ritual)
  }

  parts.push(
    [
      '=== 输出规则 ===',
      '- 中文，口语，短句。',
      '- 不列 bullet list，除非他明确要清单。',
      '- 不喊口号，不说「加油」「你可以的」。',
      '- 判断要具体：说「你昨天也说卡在这里」，不要说「要相信自己」。'
    ].join('\n')
  )

  return parts.join('\n\n')
}

module.exports = {
  ensureLife,
  ensureJournal,
  readSafe,
  writeSafe,
  appendSafe,
  appendJournal,
  appendLongterm,
  appendProfile,
  appendChat,
  chatPath,
  listChatDays,
  listCommitments,
  readCommitment,
  addCommitment,
  updateCommitment,
  removeCommitment,
  ingestCommits,
  sameDeal,
  OUTCOMES,
  DELIVERIES,
  buildSystemPrompt,
  estimateTokens,
  rulesText,
  isProfileEmpty,
  bootstrapPending,
  bootstrapDone,
  retireBootstrapIfDone,
  dateStr,
  journalPath,
  lifeDir,
  timeStr
}
