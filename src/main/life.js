const fs = require('fs')
const path = require('path')
const { lifeDir, memoryDir, resolveInside } = require('./paths')

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

const TPL_CHECKPOINTS = `# CHECKPOINTS.md — 检查点

> 这里是馄饨主动开口时说的话。你可以直接改，改完立即生效。

## 早间
先看一眼 USER.md 和昨天的记录。用两三句话问我：今天最重要的一件事是什么。
如果昨天有明确说了要做却没做的，先提那件，别问新的。
不要列清单，不要给建议，只问一个问题。

## 晚间
让我用一句话说今天过得怎么样。
然后你自己判断今天有什么值得留下的，写进记忆里。
如果我一句都不想多说，就别追问，只留一行。

## 通用规则
- 每天最多两次主动开口，别更多。
- 一次只问一个问题。
- 静音日（今天别烦我）完全不出现。
`

const TPL_COMMITMENTS = `# COMMITMENTS.md — 约定

> 一条一行，三样东西：**什么事、到期日、结局**。
> 这个文件是事实源：你手改的内容优先于它的判断（改完立即生效，不用通知它）。
> 过期的会自己删，不用你清理。

## 规矩

- **只记「有日期 + 有具体事」的。** 「我最近想多写点代码」不是约定，因为没有日期。
- **一条只问一次。** 问过就写进结局，永不重提，不汇总、不统计、不排名。
- **没成也正常。** 结局是「没成」「没去」，跟「成了」一样，写完就结案。
- **日期拿不准就写模糊的**（「月底前」「下周」），它会按模糊的回访，不会硬算成某一天。

## 结局只有四种

未问 / 成了 / 没成 / 没去

## 约定

| 什么事 | 到期日 | 结局 |
| --- | --- | --- |
`

const SEEDS = {
  'SOUL.md': TPL_SOUL,
  'IDENTITY.md': TPL_IDENTITY,
  'USER.md': TPL_USER,
  'MEMORY.md': TPL_MEMORY,
  'CHECKPOINTS.md': TPL_CHECKPOINTS,
  'COMMITMENTS.md': TPL_COMMITMENTS
}

function ensureLife() {
  fs.mkdirSync(memoryDir(), { recursive: true })
  for (const [name, tpl] of Object.entries(SEEDS)) {
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

function estimateTokens(text) {
  // 中文约 1 字 1 token，英文约 4 字符 1 token；取 /2 作为保守中值
  return Math.ceil(text.length / 2)
}

/**
 * 按 OpenClaw 的加载顺序拼 system prompt：
 * 规则 → SOUL → IDENTITY → USER → MEMORY → 昨天 → 今天
 * 顺序有讲究：越靠前越"是身份"，越靠后越"是刚发生的事"。
 */
function buildSystemPrompt(opts = {}) {
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

  parts.push(
    [
      '=== 记忆规则 ===',
      '当本轮出现了值得留下的东西，在你回复正文的最后加一个块（不要放进正文正文里，也不要解释它）：',
      '',
      '<memory>',
      '- 一句话，事实或情绪或决定',
      '</memory>',
      '',
      '三种块，按内容选一个，可以都不写：',
      '1. <memory> → 写进今天的日记。日常、当下的状态、零星的事。',
      '2. <longterm> → 写进 MEMORY.md。只放持久的事实，或有证据的判断（判断必须能指到某天）。',
      '3. <profile> → 写进 USER.md。关于他是谁、做什么、作息、在意什么、红线。',
      '',
      '铁律：',
      '- 没有值得记的就不要输出任何块。空着比凑数好。',
      '- 只记他真实说过的事，一个字都不许自己编。',
      '- 每个块最多 3 条，每条不超过 40 字。',
      '- 这些块不会显示给他看，所以别在正文里重复。'
    ].join('\n')
  )

  if (profileEmpty) {
    parts.push(
      [
        '=== 你现在要做的：把 USER.md 填起来 ===',
        'USER.md 基本是空的，你还不认识他。',
        '第一次开口：简单打个招呼（一句，别客套），然后只问一个问题——他现在主要在做什么。',
        '每轮只问一个问题，问到了就立刻用 <profile> 记下，然后问下一个。',
        '需要问清的五件事，按顺序：是谁（怎么称呼）→ 在做什么 → 作息（几点起、几点睡、什么时候效率高）→ 在意什么 → 红线。',
        '五件事都问到了，就停下来，别再追问。不要一次问三个。'
      ].join('\n')
    )
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

/** 取 CHECKPOINTS.md 里某一节的正文（用户可直接改这个文件来调它开口的方式） */
function checkpointSection(label) {
  const txt = readSafe('CHECKPOINTS.md', 8000)
  const out = []
  let on = false
  for (const line of txt.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) {
      on = h[1].trim() === label
      continue
    }
    if (on) out.push(line)
  }
  const body = out.join('\n').trim()
  return body || '按惯例开口：先看一眼昨天的记录，再问他今天最重要的一件事。'
}

module.exports = {
  checkpointSection,
  ensureLife,
  ensureJournal,
  readSafe,
  writeSafe,
  appendSafe,
  appendJournal,
  appendLongterm,
  appendProfile,
  buildSystemPrompt,
  estimateTokens,
  isProfileEmpty,
  dateStr,
  journalPath,
  lifeDir,
  timeStr
}
