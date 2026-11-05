/**
 * 无界面验证。
 *
 * 这个沙箱里 Chromium 起不来（虚拟内存上限 4GB，Electron 一启动就 SIGTRAP），
 * 所以没法截图。改为：
 *   1. 记忆层 / 块解析 / 提示拼装的纯逻辑测试（真写盘、真读回）
 *   2. 用 Vue SSR 渲染整个 App，验证组件树能编译、能渲染、不抛错
 *
 *   node scripts/test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import { parse, compileScript } from '@vue/compiler-sfc'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, '.dev/test-life')
const require = createRequire(import.meta.url)

let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''))
  }
}

/* ---------------- 1. 记忆层 ---------------- */

console.log('\n[1] 记忆层：初始化与提示拼装')
fs.rmSync(TMP, { recursive: true, force: true })
process.env.HUNDUN_LIFE_DIR = TMP

const life = require(path.join(ROOT, 'src/main/life.js'))
const { parseBlocks, groupNotes } = require(path.join(ROOT, 'src/main/blocks.js'))

life.ensureLife()

// 记忆目录带着身份，不再是根的直下：users/<用户>/agents/<agent>/
const LIFE = life.lifeDir()
ok(LIFE === path.join(TMP, 'users', 'local', 'agents', 'hundun'), '记忆目录按身份分层', LIFE)

for (const f of ['SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'COMMITMENTS.md']) {
  ok(fs.existsSync(path.join(LIFE, f)), '初始化生成 ' + f)
}
ok(fs.existsSync(path.join(LIFE, 'RULES.md')), '初始化生成 RULES.md（他自己写的规矩）')
ok(fs.existsSync(path.join(LIFE, 'memory')), '初始化生成 memory/ 目录')
const todayFile = path.join(LIFE, 'memory', life.dateStr() + '.md')
ok(fs.existsSync(todayFile), '生成今天的日记文件')

const userSeed = fs.readFileSync(path.join(LIFE, 'USER.md'), 'utf8')
ok(userSeed.includes('待访谈'), 'USER.md 是空白档案（会触发访谈）')
ok(life.isProfileEmpty(), '识别出档案为空')

let prompt = life.buildSystemPrompt({})
ok(prompt.includes('SOUL.md'), '提示里包含 SOUL')
ok(prompt.includes('MEMORY.md'), '提示里包含 MEMORY')
ok(prompt.includes('记忆规则'), '提示里包含记忆规则')
ok(prompt.includes('<longterm>'), '提示声明了 longterm 块')
ok(prompt.includes('把 USER.md 填起来'), '档案为空时注入访谈指令')
ok(prompt.includes(life.dateStr()), '提示里带上了今天日期')

/* ---------------- 1a. RULES.md：他自己写的规矩 ---------------- */

console.log('\n[1a] RULES.md：能改判断，改不了协议')

const rulesPath = path.join(LIFE, 'RULES.md')
const rulesSeed = fs.readFileSync(rulesPath, 'utf8')

ok(!prompt.includes('他亲手写的规矩'), 'RULES.md 空着时一个字都不占上下文')
ok(life.rulesText() === '', '只有标题和引用的模板算「没写东西」')

fs.writeFileSync(rulesPath, '# RULES.md\n\n> 一段说明\n\n## 我的规矩\n\n', 'utf8')
ok(life.rulesText() === '', '只留标题和引用时仍然算空，不把说明当规矩喂进去')

fs.writeFileSync(rulesPath, '# RULES.md\n\n## 我的规矩\n\n- 别叫我老板，叫名字\n', 'utf8')
const pRules = life.buildSystemPrompt({})
ok(pRules.includes('别叫我老板'), 'RULES.md 写了就进上下文')
ok(
  pRules.indexOf('别叫我老板') < pRules.indexOf('=== 记忆规则 ==='),
  'RULES 排在记忆规则之前——能改判断，改不了块格式',
  String(pRules.indexOf('别叫我老板')) + ' / ' + String(pRules.indexOf('=== 记忆规则 ==='))
)
ok(pRules.includes('<commit>'), '协议部分照旧在，没有被 RULES 挤掉')

fs.writeFileSync(rulesPath, rulesSeed, 'utf8')

/* ---------------- 1b. 约定表 ---------------- */

console.log('\n[1b] 约定表：四列、状态机、老文件迁移')

const CTMP = path.join(ROOT, '.dev/test-commit')
const cfile = () => path.join(life.lifeDir(), 'COMMITMENTS.md')
const readC = () => fs.readFileSync(cfile(), 'utf8')

fs.rmSync(CTMP, { recursive: true, force: true })
fs.mkdirSync(CTMP, { recursive: true })
process.env.HUNDUN_LIFE_DIR = CTMP
life.ensureLife()

ok(readC().includes('| 什么事 | 到期日 | 结局 | 消息 |'), '种子是四列表头')
ok(life.listCommitments().length === 0, '新文件里没有约定')

const added = life.addCommitment({ what: '跟客户谈细节', due: '后天' })
ok(added.delivery === '未问' && added.outcome === '—', '新约定：消息未问、结局留空（还没答）')
ok(readC().includes('| 跟客户谈细节 | 后天 | — | 未问 |'), '两列的值各写各的，没有合并成一格')

let threw = false
try {
  life.addCommitment({ what: '我最近想多写点代码' })
} catch {
  threw = true
}
ok(threw, '没有日期的不是约定（F06-01）')

life.updateCommitment(0, { delivery: '已送达' })
ok(readC().includes('| 跟客户谈细节 | 后天 | — | 已送达 |'), '改消息列真的落盘，不是只改内存')
ok(life.readCommitment(0).outcome === '—', '送达之后结局仍是空的——他没答过')

threw = false
try {
  life.updateCommitment(0, { delivery: '待延后' })
} catch {
  threw = true
}
ok(threw, '拒绝 已送达 → 待延后（只往前走）')

life.updateCommitment(0, { delivery: '已结案', outcome: '成了' })
threw = false
try {
  life.updateCommitment(0, { delivery: '已送达' })
} catch {
  threw = true
}
ok(threw, '已结案是终态，改不回去')

life.addCommitment({ what: '交稿', due: '下周三', pinned: true })
const withPinned = life.listCommitments()
ok(withPinned.length === 2 && withPinned[1].pinned === true, 'pinned 出现时单独占一格')
ok(
  withPinned[1].due === '下周三' && withPinned[1].delivery === '未问' && withPinned[0].delivery === '已结案',
  'pinned 一出现，其余列没有错位（按表头名定位，不按下标）'
)

// 老的三列文件：读不改，写时补列
fs.rmSync(CTMP, { recursive: true, force: true })
fs.mkdirSync(path.dirname(cfile()), { recursive: true })
fs.writeFileSync(cfile(), '| 什么事 | 到期日 | 结局 |\n| --- | --- | --- |\n| 学嵌入式 | 月底前 | 未问 |\n', 'utf8')
const before = readC()
const old = life.listCommitments()
ok(before === readC(), '读老文件不动它')
ok(old.length === 1 && old[0].delivery === '未问', '老文件缺消息列 → 按未问读（绝不默认成已送）')

life.updateCommitment(0, { delivery: '待延后' })
ok(readC().includes('| 消息 |'), '写的时候把缺的列补上')
ok(readC().includes('待延后'), '补列那一次改动的值也真的写进去了')

threw = false
try {
  life.updateCommitment(0, { delivery: '已送达' }, { expectWhat: '别的事' })
} catch {
  threw = true
}
ok(threw, '行位置对不上就报错，绝不改错行')

ok(life.removeCommitment(0) === true && life.listCommitments().length === 0, '删一条')

process.env.HUNDUN_LIFE_DIR = TMP

/* ---------------- 1c. 身份：隔离、防穿越、老布局迁移 ---------------- */

console.log('\n[1c] 身份：隔离、防穿越、老布局迁移')

const paths = require(path.join(ROOT, 'src/main/paths.js'))
const ITMP = path.join(ROOT, '.dev/test-identity')
fs.rmSync(ITMP, { recursive: true, force: true })
process.env.HUNDUN_LIFE_DIR = ITMP

// 两个人各写一句，谁都不该看到对方的
paths.setContext({ userId: '111', agentId: 'hundun' })
life.ensureLife()
life.appendJournal(['111 的私事'])
const aDir = life.lifeDir()

paths.setContext({ userId: '222', agentId: 'hundun' })
life.ensureLife()
const bDir = life.lifeDir()
const bJournal = fs.readFileSync(path.join(bDir, 'memory', life.dateStr() + '.md'), 'utf8')

ok(aDir !== bDir, '两个人的记忆目录不同')
ok(!bJournal.includes('111 的私事'), '222 的日记里读不到 111 写的东西')
ok(!bDir.startsWith(aDir), '一个人的目录不在另一个人下面')

// 同一个人换 agent：记的东西也不共享（D062：完全不共享）
paths.setContext({ userId: '111', agentId: 'another' })
life.ensureLife()
const otherAgentDir = life.lifeDir()
const otherJournal = fs.readFileSync(path.join(otherAgentDir, 'memory', life.dateStr() + '.md'), 'utf8')
ok(!otherJournal.includes('111 的私事'), '同一个人换个 agent，也读不到上一个 agent 记的')

// 身份会进路径，必须挡住穿越
let blocked = false
try {
  paths.setContext({ userId: '../etc' })
} catch {
  blocked = true
}
ok(blocked, '身份里带路径分隔符直接拒绝')
ok(!String(paths.context().userId).includes('..'), '拒绝之后上下文没有被污染')

// 老布局：*.md 直接摊在根上
const LTMP = path.join(ROOT, '.dev/test-legacy')
fs.rmSync(LTMP, { recursive: true, force: true })
fs.mkdirSync(path.join(LTMP, 'memory'), { recursive: true })
fs.mkdirSync(path.join(LTMP, '.index'), { recursive: true })
fs.writeFileSync(path.join(LTMP, 'SOUL.md'), '# 老灵魂\n', 'utf8')
fs.writeFileSync(path.join(LTMP, 'memory', '2026-01-01.md'), '- 老日记，不能丢\n', 'utf8')
fs.writeFileSync(path.join(LTMP, '.index', 'memory.sqlite'), 'stale')

process.env.HUNDUN_LIFE_DIR = LTMP
paths.setContext({ userId: 'local', agentId: 'hundun' })
life.ensureLife()
const migratedDir = life.lifeDir()

ok(migratedDir === path.join(LTMP, 'users', 'local', 'agents', 'hundun'), '老布局被收进身份目录', migratedDir)
ok(fs.existsSync(path.join(migratedDir, 'SOUL.md')), '老的人格文件跟着搬过去')
ok(
  fs.readFileSync(path.join(migratedDir, 'memory', '2026-01-01.md'), 'utf8').includes('老日记，不能丢'),
  '老的日记没丢'
)
ok(!fs.existsSync(path.join(LTMP, 'SOUL.md')), '根上不再残留旧文件')
ok(!fs.existsSync(path.join(LTMP, '.index')), '旧索引被扔掉（里面记的是旧路径）')

process.env.HUNDUN_LIFE_DIR = TMP
paths.setContext({ userId: 'local', agentId: 'hundun' })

/* ---------------- 1d. 对话原话 ---------------- */

console.log('\n[1d] 对话原话：一行一句、只写不读、进得了索引')

const CHTMP = path.join(ROOT, '.dev/test-chat')
fs.rmSync(CHTMP, { recursive: true, force: true })
process.env.HUNDUN_LIFE_DIR = CHTMP
paths.setContext({ userId: 'local', agentId: 'hundun' })
life.ensureLife()

ok(fs.existsSync(path.join(life.lifeDir(), 'chat')), '初始化生成 chat/ 目录')

const r1 = life.appendChat('user', '今天想把登录页改完')
const r2 = life.appendChat('assistant', '先别急着动样式。\n登录那块错在哪，你能说清楚吗？')
ok(r1 === 'chat/' + life.dateStr() + '.md', '写到今天的 chat 文件', String(r1))
ok(r2 === r1, '同一轮的两句话落在同一个文件里')

const chatTxt = fs.readFileSync(life.chatPath(life.dateStr()), 'utf8')
ok(chatTxt.includes('[你] 今天想把登录页改完'), '他说的那句带「你」标记')
ok(chatTxt.includes('[我] 先别急着动样式。'), '它说的那句带「我」标记')
ok(/^- \d{2}:\d{2} \[你\]/m.test(chatTxt), '行首是 HH:MM，不是别的格式')
ok(chatTxt.includes('\n  登录那块错在哪'), '多行原话保留分行（续行缩进）')
ok(life.appendChat('user', '   ') === null, '空话不落盘（不留空行）')

// D028 写死的一件事：chat 永远不进上下文。进了就说明有人把它读回来了。
const promptNow = life.buildSystemPrompt({})
ok(!promptNow.includes('今天想把登录页改完'), 'chat 的内容不进上下文（D028）')

// 索引范围：collectRows 只认 lifeDir 下的 .md，chat/ 在它下面所以天然在内
const chatRows = require(path.join(ROOT, 'src/main/search.js')).collectRows()
ok(chatRows.some((r) => r.file.startsWith('chat/')), 'chat/ 进了索引范围（D023 的语料变厚）')
ok(life.listChatDays().length === 1, '能列出原话存了哪几天', String(life.listChatDays().length))

/* ---------------- 1e. 约定提取 ---------------- */

console.log('\n[1e] 约定提取：判据、相对日期锚点、更正覆盖')

const due1 = life.dateStr(new Date(Date.now() + 2 * 86400000))
const due2 = life.dateStr(new Date(Date.now() + 3 * 86400000))

const commitRaw =
  '好，记着了。\n' +
  '<commit>\n' +
  '- 后天跟客户谈细节 | ' + due1 + '\n' +
  '- 去看牙 | 下周三\n' +
  '- 我最近想多写点代码\n' +
  '</commit>'
const commitParsed = parseBlocks(commitRaw)
ok(!commitParsed.clean.includes('<commit>'), 'commit 块从正文里剥掉（不显示给他看）')
ok(commitParsed.clean.includes('好，记着了。'), '正文本身留下来')

const commitBucket = groupNotes(commitParsed.notes)
ok(commitBucket.commit.length === 3, 'commit 落到自己的桶里', String(commitBucket.commit.length))
ok(commitBucket.memory.length === 0, '不会被当成日记条目（混进去就永远没人问起）')

const ingested = life.ingestCommits(commitBucket.commit)
const rows = life.listCommitments()
ok(rows.length === 2, '两件事记下，缺日期的那条丢掉', JSON.stringify(ingested))
ok(ingested.some((r) => r.startsWith('丢：')), '丢弃是明确的，不是悄悄跳过')
ok(rows[0].what === '后天跟客户谈细节' && rows[0].due === due1, '有绝对日期就照写', JSON.stringify(rows[0]))
ok(rows[0].outcome === '—' && rows[0].delivery === '未问', '新约定：结局 —、消息 未问')
ok(rows[1].due === '下周三@' + life.dateStr(), '模糊日期存相对表达 + 当天锚点（§1.6 第六条）', rows[1].due)
ok(rows[1].due.includes('@'), '锚点在单元格里，到 M2 才换算成绝对日期')

// 更正：同一件事改日期，不新增一行（F06-02）
life.ingestCommits(['- 后天跟客户谈细节 | ' + due2])
const rows2 = life.listCommitments()
ok(rows2.length === 2, '同一个「什么事」再说一次不新增一行', String(rows2.length))
ok(rows2[0].due === due2, '到期日被改成新的那个')

// 已送达的还能改日期（它已经不问了），已结案的不能——那是另一件事
life.updateCommitment(0, { delivery: '已送达' }, { expectWhat: rows2[0].what })
life.ingestCommits(['- 后天跟客户谈细节 | ' + due1])
ok(life.listCommitments()[0].due === due1, '已送达的约定仍可改期，且不会重问')
life.updateCommitment(0, { delivery: '已结案' }, { expectWhat: life.listCommitments()[0].what })
const closedBefore = life.listCommitments().length
life.ingestCommits(['- 后天跟客户谈细节 | ' + due2])
ok(life.listCommitments().length === closedBefore + 1, '已结案后再提，是新的一件事（新起一行）')

// 判据必须真的写进提示词。写在这里，是因为「模型会不会滥用 commit 通道」
// 只靠一句话约束——那句话要是不在提示里，后面所有防线都是空的。
const sp = life.buildSystemPrompt({})
ok(sp.includes('<commit>'), '提示词里给了 commit 的写法')
ok(sp.includes('缺一个就'), '提示词里写死了「有日期且有具体事」的判据')
ok(sp.includes('宁可漏'), '提示词里给了反向偏好：宁可漏，不要多记')
ok(sp.includes('不要问「要不要记着」'), '提示词里封死了当场确认（D049）')

process.env.HUNDUN_LIFE_DIR = TMP
paths.setContext({ userId: 'local', agentId: 'hundun' })

/* ---------------- 2. 块的解析与落盘 ---------------- */

console.log('\n[2] 记忆块：解析与落盘')

const sample =
  '嗯，写代码的。\n\n' +
  '那你一天里最长的那段不被打断的时间，大概是几点到几点？\n' +
  '<memory>\n- 主要做开发\n- 晚上效率高\n</memory>\n' +
  '<longterm>\n- 每天 22 点后进入状态\n</longterm>\n' +
  '<profile>\n- 做后端，主要写 Java\n</profile>'

const { clean, notes } = parseBlocks(sample)
ok(notes.length === 3, '解析出三个块', '实际 ' + notes.length)
ok(!clean.includes('<memory>'), '正文里不再残留标签')
ok(clean.includes('写代码的'), '正文内容保留完整')
ok(groupNotes(notes).memory.length === 2, 'memory 块归并出 2 条')

const journalRel = life.appendJournal(['测试：今天卡在登录页'])
ok(journalRel === 'memory/' + life.dateStr() + '.md', '日记写到今天的文件')
const journal = fs.readFileSync(todayFile, 'utf8')
ok(journal.includes('测试：今天卡在登录页'), '日记内容已落盘')

life.appendLongterm(['连续三天周三下午效率低'])
const mem = fs.readFileSync(path.join(LIFE, 'MEMORY.md'), 'utf8')
ok(mem.includes('连续三天周三下午效率低'), '长期记忆已落盘')
ok(mem.indexOf('连续三天') < mem.indexOf('## 进行中的事'), '长期记忆插在锚点之前，结构没被破坏')

life.appendProfile(['做后端，主要写 Java'])
const usr = fs.readFileSync(path.join(LIFE, 'USER.md'), 'utf8')
ok(usr.includes('做后端，主要写 Java'), '用户档案已落盘')
ok(/## 访谈实录[\s\S]*### \d{4}-/.test(usr), '档案按日期分节记录')

ok(!life.isProfileEmpty(), '档案写入后不再判定为空')

/* ---------------- 3. 会话复位与串味防线（F13-06 / P-25） ---------------- */

console.log('\n[3] 会话复位：切身份之后旧回复不得落进新身份')

// store 要读配置：给一个临时配置目录，别碰真的 ~/.config
process.env.HUNDUN_CONFIG_DIR = path.join(TMP, 'config')

const session = require(path.join(ROOT, 'src/main/session.js'))
const store = require(path.join(ROOT, 'src/main/store.js'))
const llm = require(path.join(ROOT, 'src/main/llm.js'))
const searchMod = require(path.join(ROOT, 'src/main/search.js'))
const conversation = require(path.join(ROOT, 'src/main/conversation.js'))

const e0 = session.current()
session.bump()
ok(session.isStale(e0), '代次推进后，出发时的代次被判定为过期')
ok(!session.isStale(session.current()), '当前代次不算过期')

// 会话级复位：三样都清
conversation.resetSession()
const st0 = conversation.state()
ok(st0.history.length === 0 && st0.summary === '' && st0.busy === false, 'resetSession 清空 history / summary / busy')

// 造一次「请求还在飞的时候被切了身份」
store.write({ apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1/v1', model: 'test' })
const realStream = llm.streamChat
const realSearch = searchMod.search
llm.streamChat = async (opts, onDelta) => {
  await new Promise((r) => setTimeout(r, 40))
  const text = '<memory>紫色犀牛</memory>这句话属于上一个人。'
  onDelta && onDelta(text)
  return text
}
searchMod.search = async () => []

paths.setContext({ userId: '111', agentId: 'hundun' })
life.ensureLife()
const dirA = life.lifeDir()
const pending = conversation.send('我是上一个人')

// 请求在飞的时候切走
paths.setContext({ userId: '222', agentId: 'hundun' })
life.ensureLife()
conversation.resetSession()
const dirB = life.lifeDir()

const res = await pending

ok(res && res.dropped === true, '切身份后旧请求被丢弃（返回 dropped）', JSON.stringify(res))
ok(conversation.state().history.length === 0, '被丢弃的回复没有进新身份的历史')

// 最要紧的一条：那句话绝不能出现在 B 的记忆里
const memB = fs.existsSync(path.join(dirB, 'memory', life.dateStr() + '.md'))
  ? fs.readFileSync(path.join(dirB, 'memory', life.dateStr() + '.md'), 'utf8')
  : ''
ok(!memB.includes('紫色犀牛'), '旧身份的回复没有写进新身份的记忆文件', memB.slice(-120))
ok(dirA !== dirB, '两个身份的目录确实不同', dirA + ' / ' + dirB)

// 原话文件也得守同一条线。用户那句是他当时真的说的，落在 A；
// 回复属于上一个身份，一个字都不该出现在 B 的 chat 里。
const chatBPath = life.chatPath(life.dateStr())
const chatB = fs.existsSync(chatBPath) ? fs.readFileSync(chatBPath, 'utf8') : ''
ok(!chatB.includes('紫色犀牛'), '旧身份的回复没有写进新身份的原话文件', chatB.slice(-120))
ok(!chatB.includes('我是上一个人'), '上一个身份的话也不在新身份的原话里')

// 正常路径不受影响：没切身份时，记忆照常落盘
life.ensureLife()
const p2 = await conversation.send('我是当前这个人')
ok(p2 && !p2.dropped && p2.text.length > 0, '没有切换时请求正常完成')
const memNow = fs.readFileSync(path.join(life.lifeDir(), 'memory', life.dateStr() + '.md'), 'utf8')
ok(memNow.includes('紫色犀牛'), '没有切换时记忆照常写入')

llm.streamChat = realStream
searchMod.search = realSearch

// 收尾：切回本节开始时的身份，否则后面检索那节会在 222 的目录里找 111 的东西
paths.setContext({ userId: 'local', agentId: 'hundun' })
life.ensureLife()
conversation.resetSession()

/* ---------------- 3d. 会话落盘（D074） ---------------- */

console.log('\n[3d] 会话落盘：重启接得上，身份不串味')

const STMP = path.join(ROOT, '.dev/test-session')
fs.rmSync(STMP, { recursive: true, force: true })
process.env.HUNDUN_CONFIG_DIR = path.join(STMP, 'config')
store._reset()
store.write({ apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1/v1', model: 'test' })

llm.streamChat = async (opts, onDelta) => {
  const text = '记下了。'
  onDelta && onDelta(text)
  return text
}
searchMod.search = async () => []

paths.setContext({ userId: 'local', agentId: 'hundun' })
life.ensureLife()
conversation.resetSession()

await conversation.send('第一句')
ok(conversation.state().history.length === 2, '一轮对话两条：他一句、它一句', String(conversation.state().history.length))
ok(fs.existsSync(conversation.sessionFile()), '会话落盘到 .session.json')

// 重启 = 内存清空 + 按同一身份重新加载（启动走的就是这一条）
const restored = conversation.resetSession()
ok(restored && restored.loaded === true, '重启时能读回会话文件')
ok(
  conversation.state().history.length === 2 && conversation.state().history[0].content === '第一句',
  '重启后历史接得上',
  JSON.stringify(conversation.state().history)
)

// 压缩摘要是会话的一部分，不是记忆的一部分，必须一起回来
fs.writeFileSync(
  conversation.sessionFile(),
  JSON.stringify({
    version: 1,
    user: 'local',
    agent: 'hundun',
    summary: '他在做后端，卡在部署',
    history: [
      { role: 'user', content: '嗯' },
      { role: 'assistant', content: '嗯。' }
    ]
  }),
  'utf8'
)
conversation.resetSession()
ok(conversation.state().summary === '他在做后端，卡在部署', '压缩摘要也恢复')
ok(conversation.state().history.length === 2, '摘要对应的历史一起回来')

// 身份隔离：换个身份，读不到上一个人的会话
paths.setContext({ userId: 'other', agentId: 'hundun' })
life.ensureLife()
const otherLoad = conversation.resetSession()
ok(otherLoad.loaded === false && conversation.state().history.length === 0, '切到另一个身份，读不到上一个身份的会话')

// 文件里写的身份对不上就整份不认（迁移、手动拷贝都能造成这种局面）
paths.setContext({ userId: 'local', agentId: 'hundun' })
life.ensureLife()
fs.writeFileSync(
  conversation.sessionFile(),
  JSON.stringify({ version: 1, user: 'stranger', agent: 'hundun', history: [{ role: 'user', content: '别人的话' }] }),
  'utf8'
)
const mismatch = conversation.resetSession()
ok(mismatch.mismatch === true && conversation.state().history.length === 0, '会话文件里的身份对不上就整份不认')

// 坏文件不许崩：手改过、写到一半断电都会造成这种局面
fs.writeFileSync(conversation.sessionFile(), '{ 这不是 JSON', 'utf8')
let threwLoad = false
let brokenLoad = null
try {
  brokenLoad = conversation.resetSession()
} catch {
  threwLoad = true
}
ok(!threwLoad && brokenLoad.loaded === false && conversation.state().history.length === 0, '会话文件坏了不崩，当没有会话')

// 手动清空要连磁盘一起清，否则重启就复活
fs.writeFileSync(conversation.sessionFile(), '{}', 'utf8')
conversation.reset()
ok(!fs.existsSync(conversation.sessionFile()), '手动清空会话时磁盘那份也删掉')

// 最要紧的一条：正在飞的请求被切了身份，会话不能落到新身份头上
paths.setContext({ userId: 'local', agentId: 'hundun' })
life.ensureLife()
conversation.resetSession()
llm.streamChat = async (opts, onDelta) => {
  await new Promise((r) => setTimeout(r, 40))
  const text = '这句话属于上一个人'
  onDelta && onDelta(text)
  return text
}
const pendingSession = conversation.send('属于 A 的话')
paths.setContext({ userId: 'other', agentId: 'hundun' })
life.ensureLife()
conversation.resetSession()
const droppedSession = await pendingSession
ok(droppedSession && droppedSession.dropped === true, '切身份后旧请求被丢弃')
ok(!fs.existsSync(conversation.sessionFile()), '旧身份的会话没有写进新身份的 .session.json')

llm.streamChat = realStream
searchMod.search = realSearch
paths.setContext({ userId: 'local', agentId: 'hundun' })
life.ensureLife()
conversation.resetSession()

// 恢复配置目录，后面的用例还要用它
process.env.HUNDUN_CONFIG_DIR = path.join(TMP, 'config')
store._reset()

/* ---------------- 3e. 配置文件位置（D073） ---------------- */

console.log('\n[3e] 配置：和记忆放在同一个文件夹')

const CFGHOME = path.join(ROOT, '.dev/test-config-home')
fs.rmSync(CFGHOME, { recursive: true, force: true })
process.env.HUNDUN_LIFE_DIR = CFGHOME
delete process.env.HUNDUN_CONFIG_DIR
store._reset()
store.write({ quietDate: '2026-01-01' })
ok(fs.existsSync(path.join(CFGHOME, 'config.json')), 'config.json 默认落在 ~/life 根上，不在 userData 里')
ok(!fs.existsSync(path.join(CFGHOME, 'users')), '写配置不会顺手建身份目录')

// 老位置的配置要自己搬过来（升级的用户不能丢 key）
const LEGACY = path.join(ROOT, '.dev/test-legacy-cfg', 'HundunAgent')
fs.rmSync(path.dirname(LEGACY), { recursive: true, force: true })
fs.mkdirSync(LEGACY, { recursive: true })
fs.writeFileSync(path.join(LEGACY, 'config.json'), JSON.stringify({ quietDate: '2026-02-02' }), 'utf8')

const ep = require.resolve('electron')
const prevElectron = require.cache[ep]
require.cache[ep] = { id: ep, filename: ep, loaded: true, exports: { app: { getPath: () => LEGACY } } }

const MIG = path.join(ROOT, '.dev/test-config-migrate')
fs.rmSync(MIG, { recursive: true, force: true })
process.env.HUNDUN_LIFE_DIR = MIG
store._reset()
const migrated = store.read()
ok(fs.existsSync(path.join(MIG, 'config.json')), '老配置自动搬进 ~/life/config.json')
ok(migrated.quietDate === '2026-02-02', '搬过来的内容没丢')
ok(
  (fs.statSync(path.join(MIG, 'config.json')).mode & 0o777) === 0o600,
  '搬家后权限仍是 0600（里面有 key）',
  (fs.statSync(path.join(MIG, 'config.json')).mode & 0o777).toString(8)
)
ok(fs.existsSync(path.join(LEGACY, 'config.json.migrated')), '老文件改名留档，不是直接删')

if (prevElectron) require.cache[ep] = prevElectron
else delete require.cache[ep]

// 已经有了就不许再搬：新配置是准的，老文件是旧的
store.write({ quietDate: '2026-03-03' })
store._reset()
ok(store.read().quietDate === '2026-03-03', '新配置存在时不会被老文件覆盖')

process.env.HUNDUN_LIFE_DIR = TMP
process.env.HUNDUN_CONFIG_DIR = path.join(TMP, 'config')
store._reset()

/* ---------------- 3b. 打扰参数落库（P-11 / F06-16） ---------------- */

console.log('\n[3b] 打扰参数：写进 config.json，不是只活在界面里')

const cfgDir = process.env.HUNDUN_CONFIG_DIR
const cfgFile = path.join(cfgDir, 'config.json')

ok(store.read().disturb && store.read().disturb.on === false, '默认是关的（D047）')
ok(Array.isArray(store.read().disturb.windows), '默认时段是空数组，不是 null')
ok(store.read().disturb.dailyLimit === 0, '默认上限 0，等于关掉')

// 界面上的四个动作，落到 store 就是这几下
store.write({ disturb: { on: true, windows: [{ from: '13:00', to: '14:30' }], dailyLimit: 2 } })

const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
ok(onDisk.disturb && onDisk.disturb.on === true, '总开关真的写进了文件（刷新后还在，F06-16）')
ok(onDisk.disturb.windows.length === 1 && onDisk.disturb.windows[0].from === '13:00', '时段写进了文件')
ok(onDisk.disturb.dailyLimit === 2, '每日上限写进了文件')
ok(store.publicConfig().disturb.dailyLimit === 2, '渲染层通过 cfg:get 拿到的也是新值')

// 老配置没有 disturb 字段时不能炸：read() 要能把它当默认值补上
const legacy = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
delete legacy.disturb
fs.writeFileSync(cfgFile, JSON.stringify(legacy, null, 2))
store._reset() // 丢掉缓存，模拟重启后第一次读盘
const afterLegacy = store.read()
ok(
  afterLegacy.disturb && afterLegacy.disturb.on === false && afterLegacy.disturb.dailyLimit === 0,
  '老配置缺 disturb 时补成完整默认结构，不留半截',
  JSON.stringify(afterLegacy.disturb)
)

// 「今天别烦我」仍是当天作废，不是配置（D045 的第四个参数）
ok(typeof store.isQuietToday() === 'boolean', '今天静音是独立状态，不混进 disturb')

/* ---------------- 4. 界面 SSR ---------------- */

console.log('\n[3c] 模型配置：opencode 格式，JSON 是唯一的源')

const mm = require(path.join(ROOT, 'src/main/models.js'))
process.env.HUNDUN_TEST_KEY = 'sk-from-env'

const MODEL_OK = {
  provider: {
    deepseek: {
      npm: '@ai-sdk/openai-compatible',
      name: 'DeepSeek',
      options: { baseURL: 'https://api.deepseek.com/v1', apiKey: '{env:HUNDUN_TEST_KEY}' },
      models: {
        'deepseek-chat': { name: 'DeepSeek Chat', limit: { context: 64000, output: 8000 } },
        'deepseek-reasoner': { name: 'R1', limit: { context: 64000 } }
      }
    }
  },
  model: 'deepseek/deepseek-chat'
}

const nv = mm.normalize(MODEL_OK)
ok(nv.ok, '一份合法配置能解析', nv.errors.join('；'))
ok(nv.selected && nv.selected.modelId === 'deepseek-chat', '选中的模型是 JSON 里 model 指向的那个')
ok(nv.selected.apiKey === 'sk-from-env', '{env:} 换成了真实的 key，而不是把占位符当 key 发出去')
ok(nv.selected.contextWindow === 64000, 'limit.context 落到了 contextWindow 上')

const noUrl = mm.normalize({ provider: { a: { models: { x: {} } } }, model: 'a/x' })
ok(!noUrl.ok && noUrl.errors.some((e) => e.includes('baseURL')), '缺 baseURL 会被拦下，并指名道姓')

const noModel = mm.normalize({ provider: { a: { options: { baseURL: 'https://x/v1' }, models: { x: {} } } }, model: 'a/nope' })
ok(!noModel.ok && noModel.errors.some((e) => e.includes('nope')), 'model 指到不存在的模型，报出是哪一个')

const dash = mm.normalize({ provider: { 'a/b': { options: { baseURL: 'https://x/v1' }, models: { x: {} } } }, model: 'a/b/x' })
ok(!dash.ok, 'provider id 带斜杠会被拦：引用是 provider/model，带斜杠就切不开')

const noRef = mm.normalize({ provider: { a: { options: { baseURL: 'https://x/v1' }, models: { x: {} } } } })
ok(noRef.ok && noRef.warnings.some((w) => w.includes('没写 model')), '顶层没写 model 时自动挑第一个，并且说出来')

delete process.env.HUNDUN_MISSING
const missEnv = mm.normalize({
  provider: { a: { options: { baseURL: 'https://x/v1', apiKey: '{env:HUNDUN_MISSING}' }, models: { x: {} } } },
  model: 'a/x'
})
ok(missEnv.ok && missEnv.warnings.some((w) => w.includes('HUNDUN_MISSING')), '变量没设时说清楚是哪个变量，而不是给个空 key 让他猜')

// {file:} 相对配置文件目录解析
const keyFile = path.join(cfgDir, 'key.txt')
fs.writeFileSync(keyFile, 'sk-from-file\n', 'utf8')
const fromFile = mm.normalize(
  { provider: { a: { options: { baseURL: 'https://x/v1', apiKey: '{file:key.txt}' }, models: { x: {} } } }, model: 'a/x' },
  { baseDir: cfgDir }
)
ok(fromFile.selected.apiKey === 'sk-from-file', '{file:} 读到了文件内容，并去掉了尾换行')

// --- store 层：JSON 是源，其它都是派生物 ---
store.write({ modelConfig: MODEL_OK })
const mcC1 = store.read()
ok(mcC1.baseUrl === 'https://api.deepseek.com/v1', 'baseUrl 由 JSON 派生')
ok(mcC1.apiKey === 'sk-from-env', 'apiKey 由 JSON 派生（占位符在这一层展开）')
ok(mcC1.model === 'deepseek-chat', 'model 由 JSON 派生')

// 派生值不落盘：否则 {env:} 就白写了，key 又躺回文件里
const mcDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
ok(mcDisk.modelConfig && mcDisk.modelConfig.model === 'deepseek/deepseek-chat', 'JSON 本身落盘了（它才是源）')
ok(!('apiKey' in mcDisk) && !('baseUrl' in mcDisk) && !('model' in mcDisk), '派生的三个值不落盘，key 不进文件', JSON.stringify(mcDisk).slice(0, 120))

// 换模型 = 改 JSON 里的 model 字段
const mcSwapped = JSON.parse(JSON.stringify(MODEL_OK))
mcSwapped.model = 'deepseek/deepseek-reasoner'
store.write({ modelConfig: mcSwapped })
ok(store.read().model === 'deepseek-reasoner', '改 model 字段就换了模型，不用再动别的')

// 不合法 → 抛，而且一个字节都不写（半写是最坏的结果）
const mcBefore = fs.readFileSync(cfgFile, 'utf8')
let mcThrew = false
try {
  store.write({ modelConfig: { provider: { x: { models: { m: {} } } }, model: 'x/m' } })
} catch {
  mcThrew = true
}
ok(mcThrew, '不合法的配置会抛，不会静默接受')
ok(fs.readFileSync(cfgFile, 'utf8') === mcBefore, '抛了就是真的没写：文件一个字节都没变')
ok(store.read().model === 'deepseek-reasoner', '内存里的当前模型也没被带着改')

// 文件被手改坏：要显式标记，并且绝不退回默认地址
fs.writeFileSync(cfgFile, JSON.stringify({ modelConfig: { provider: { x: { models: { m: {} } } }, model: 'x/m' } }, null, 2))
store._reset()
const mcBroken = store.read()
ok(mcBroken.modelBroken === true, '配置坏了要能看出来，而不是装作没事')
ok(mcBroken.baseUrl === '' && mcBroken.model === '', '坏了就空着：空地址会当场报错，默认地址会带着错模型乱说话')

// 老配置（只有手填三字段）→ 给一份等价的 JSON，但不落盘
fs.writeFileSync(cfgFile, JSON.stringify({ baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-old', model: 'kimi-k2', temperature: 0.7, contextWindow: 32000 }, null, 2))
store._reset()
const legacyCfg = store.read()
ok(legacyCfg.modelConfig === null, '老配置没有 modelConfig，先用着原来那三个字段')
ok(legacyCfg.baseUrl === 'https://api.moonshot.cn/v1', '老配置照常能用，不因为升级就断了')
const mcSeed = store.publicConfig().modelSeed
ok(mcSeed && mcSeed.provider && mcSeed.provider.moonshot, '界面能拿到一份等价的 JSON 做起点', JSON.stringify(mcSeed).slice(0, 100))
ok(mcSeed.model === 'moonshot/kimi-k2', 'seed 里的 model 指向老配置那个模型')
ok(mcSeed.provider.moonshot.options.apiKey === 'sk-old', 'seed 把老 key 带过来了，他不用重填')

// 收尾：留一份能用的配置，别把坏状态带给后面的界面测试
store.write({ modelConfig: MODEL_OK })

console.log('\n[3d] 多个模型：一条链，按顺序试')

const CHAIN_CFG = {
  provider: {
    main: {
      name: '主服务商',
      options: { baseURL: 'https://a.example/v1', apiKey: 'ka' },
      models: {
        big: { name: 'Big', limit: { context: 64000 } },
        small: { name: 'Small' }
      }
    },
    backup: {
      name: '备用',
      options: { baseURL: 'https://b.example/v1', apiKey: 'kb' },
      models: {
        mid: { name: 'Mid', limit: { context: 32000 } },
        lite: { name: 'Lite' }
      }
    }
  },
  model: 'main/big',
  'x-hundun': { modelOrder: ['main/big', 'backup/mid', 'main/small'] }
}

const c3 = mm.normalize(CHAIN_CFG)
ok(c3.ok, '多模型配置能解析', c3.errors.join('；'))
ok(c3.chain.length === 3, '链上三个模型')
ok(
  c3.chain.map((m) => m.modelId).join(',') === 'big,mid,small',
  '顺序与 modelOrder 完全一致',
  c3.chain.map((m) => m.modelId).join(',')
)
ok(c3.chain[1].baseUrl === 'https://b.example/v1', '每个模型带着自己的地址（跨服务商也能排）')
ok(c3.chain[1].apiKey === 'kb', '每个模型带着自己的 key')
ok(c3.selected.modelId === 'big', '第一个就是当前用的那个')

// 手改顶层 model 必须立刻生效，不能被顺序里的旧值压住 ——
// 否则就是「改了没反应」，而且没有任何报错。
const c4 = mm.normalize({ ...CHAIN_CFG, model: 'backup/mid' })
ok(c4.chain[0].modelId === 'mid', '手改顶层 model 就换了首选')
ok(c4.chain.length === 3, '其余备用一个不少')

// 引用不到的那一项只丢自己，不连坐整份配置
const c5 = mm.normalize({
  ...CHAIN_CFG,
  'x-hundun': { modelOrder: ['main/big', 'ghost/x', 'backup/mid'] }
})
ok(c5.ok, '顺序里有找不到的模型时，配置照样可用')
ok(c5.chain.length === 2, '那一项被跳过')
ok(
  c5.warnings.some((w) => w.includes('ghost/x')),
  '跳过了要说出是哪一个',
  c5.warnings.join('；')
)

const c6 = mm.normalize({ ...CHAIN_CFG, 'x-hundun': { modelOrder: ['main/big', 'main/big', 'backup/mid'] } })
ok(c6.chain.length === 2, '顺序里重复的只留一个')

// 没有 x-hundun 的老配置：就是单元素链，行为与以前完全一样
const c7 = mm.normalize({
  provider: { solo: { options: { baseURL: 'https://s.example/v1' }, models: { one: { name: 'One' } } } },
  model: 'solo/one'
})
ok(c7.chain.length === 1, '只有 model 没有顺序时，链上就一个')

// ---- 排序／增删（纯函数，不碰磁盘）----

const movedTop = mm.moveModel(CHAIN_CFG, 'main/small', 0)
ok(movedTop.ok && mm.orderOf(movedTop.config)[0] === 'main/small', '移到第一位就是设为首选')
ok(movedTop.config.model === 'main/small', '顶层 model 跟着改（opencode 那边也认）')
ok(movedTop.config['x-hundun'].modelOrder.length === 3, '数量不变，只是换了位置')

const movedDown = mm.moveModel(CHAIN_CFG, 'main/big', 1)
ok(movedDown.ok && mm.orderOf(movedDown.config).join(',') === 'backup/mid,main/big,main/small', '下移一格')

const clamped = mm.moveModel(CHAIN_CFG, 'backup/mid', 99)
ok(clamped.ok && mm.orderOf(clamped.config).length === 3, '拖到列表外面不会越界或丢东西')

const mcAdded = mm.addModel(CHAIN_CFG, 'backup/lite')
ok(mcAdded.ok, '加一个还没进链的模型')
ok(mm.orderOf(mcAdded.config).slice(-1)[0] === 'backup/lite', '加进来的排在最后（先试原来的）')
ok(mcAdded.config.model === 'main/big', '加备用不会抢走首选')

ok(!mm.addModel(CHAIN_CFG, 'main/big').ok, '已经在链里的不会重复加')

const mcRemoved = mm.removeModel(CHAIN_CFG, 'main/small')
ok(mcRemoved.ok && mm.orderOf(mcRemoved.config).length === 2, '移除一个')
ok(!mm.removeModel(CHAIN_CFG, 'nope/x').ok, '移除不存在的会说不行')

const mcOnlyOne = {
  provider: { solo: { options: { baseURL: 'https://s.example/v1' }, models: { one: {} } } },
  model: 'solo/one'
}
ok(!mm.removeModel(mcOnlyOne, 'solo/one').ok, '删到最后一个会被拦下（留一个用来说话）')

// orderOf 与 normalize 必须同源，否则卡片上看到的顺序和实际请求的顺序会不一样
ok(mm.orderOf(CHAIN_CFG).join(',') === c3.chain.map((m) => m.providerId + '/' + m.modelId).join(','), '卡片顺序 = 解析出来的链顺序')

// ---- store：链是派生的，不落盘 ----

store.write({ modelConfig: CHAIN_CFG })
ok(store.read().model === 'big', 'baseUrl 之外，model 也还是从 JSON 派生')
ok(store.read().modelChain.length === 3, 'store 派生出整条链')
ok(store.read().modelChain[1].modelId === 'mid', '第二条是备用那个')
const diskChain = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
ok(!('modelChain' in diskChain), '链不落盘：它是派生值，写进文件就成了第二份事实', Object.keys(diskChain).join(','))
ok(
  diskChain.modelConfig['x-hundun'].modelOrder.length === 3,
  '但顺序本身在 JSON 里（那才是源）'
)

// ---- llm：什么时候允许换下一个 ----

const ch2 = llm.chainOf({ chain: store.read().modelChain })
ok(ch2.length === 3, 'llm 拿到的是整条链')
ok(ch2[0].model === 'big' && ch2[0].label === 'Big', '模型 id 用真名，显示用 name')
ok(ch2[1].baseUrl === 'https://b.example/v1', '第二个用的是自己的地址')
// 单卡测试靠这条：显式给空链时退化成「就测这一个」，不会顺着备用往下走
ok(
  llm.chainOf({ chain: [], baseUrl: 'https://x/v1', model: 'only-one' }).length === 1,
  '显式给空链时只测一个模型'
)

const fakeChain = [
  { model: 'big', label: 'Big' },
  { model: 'mid', label: 'Mid' }
]

const triedOrder = []
let fbInfo = null
const mcGot = await llm.runChain(
  fakeChain,
  async (one, markStarted) => {
    triedOrder.push(one.model)
    if (one.model === 'big') throw new Error('503 服务不可用')
    markStarted()
    return '备用回的'
  },
  (info) => (fbInfo = info)
)
ok(mcGot === '备用回的', '第一个失败时用第二个，返回第二个的话')
ok(triedOrder.join(',') === 'big,mid', '试的顺序就是排的顺序')
ok(
  fbInfo && fbInfo.used.model === 'mid' && fbInfo.failed.length === 1,
  '换过要说清楚：谁失败了、用的是谁',
  JSON.stringify(fbInfo)
)

// 这条是整个链最要紧的一条：推过字就不能再换。
// 换了会显示成两个模型的话拼一段，而接缝在哪没人看得出来。
let attempts = 0
let threwAfterStart = false
try {
  await llm.runChain(fakeChain, async (one, markStarted) => {
    attempts++
    markStarted()
    throw new Error('说到一半断了')
  })
} catch {
  threwAfterStart = true
}
ok(threwAfterStart, '推过字之后出错会直接抛，不吞掉')
ok(attempts === 1, '推过字之后不再换模型', '实际尝试了 ' + attempts + ' 次')

let allFailMsg = ''
try {
  await llm.runChain(fakeChain, async () => {
    throw new Error('连不上')
  })
} catch (e) {
  allFailMsg = e.message
}
ok(allFailMsg.includes('2 个模型'), '全都没成时说清楚试了几个', allFailMsg)

let timeoutTries = 0
try {
  await llm.runChain(fakeChain, async () => {
    timeoutTries++
    const e = new Error('请求超时')
    e.timeout = true
    throw e
  })
} catch {}
ok(timeoutTries === 1, '超时不再往下试（换地址大概率一样超时，只会更久）')

// 只有一个模型时，整条链退化成老行为：一次尝试、一份错误
let soloTries = 0
let soloMsg = ''
try {
  await llm.runChain([{ model: 'only', label: 'Only' }], async () => {
    soloTries++
    throw new Error('401 没权限')
  })
} catch (e) {
  soloMsg = e.message
}
ok(soloTries === 1 && soloMsg === '401 没权限', '单模型时错误原样抛出，不再包一层「试了几个」', soloMsg)

// 收尾：留一份能用的单模型配置
store.write({ modelConfig: MODEL_OK })

console.log('\n[3f] 简单模式：选一家、填个 key，落盘仍是同一份 JSON')

// 目录：只放真能说 OpenAI 兼容协议的。列一个说不了的服务商，只会让他在 404 里找原因。
const sPresets = mm.presets()
ok(sPresets.length >= 4, '目录里有几家可选的')
ok(sPresets.every((p) => p.baseUrl.startsWith('http') || p.custom), '每一家的地址都是写死的常量，不靠他手填')
ok(!sPresets.some((p) => /anthropic|gemini/i.test(p.id)), '不说 OpenAI 兼容协议的服务商不进目录')
ok(sPresets.some((p) => p.noKey), '本地模型那一档标了「不用 key」，不该逼他填一个假的')

const sCfg = mm.simpleToConfig(
  { preset: 'deepseek', apiKey: 'sk-simple', model: 'deepseek-reasoner' },
  { baseDir: cfgDir }
)
const sNorm = mm.normalize(sCfg, { baseDir: cfgDir })
ok(sNorm.ok && sNorm.selected.modelId === 'deepseek-reasoner', '简单配置生成出来就能用：不用再过一遍手工填地址')
ok(sNorm.selected.baseUrl === 'https://api.deepseek.com/v1', '地址来自目录，不是他手填的那个字符串')
ok(sNorm.simple === true, '认得出现在是简单模式（不认出来，下次打开就退回 JSON 编辑器了）')

const sBack = mm.configToSimple(sCfg)
ok(sBack && sBack.preset === 'deepseek' && sBack.model === 'deepseek-reasoner', '简单配置能反推回界面上的选项')
ok(mm.configToSimple(MODEL_OK) === null, '手写的 JSON（没有 x-hundun.simple）不会被硬认成简单模式')

// 换一家：地址跟着换，旧家的 key 不带过去（那是别人的 key）
const sSwitch = mm.simpleToConfig({ preset: 'moonshot', apiKey: 'sk-simple', model: '' }, { baseDir: cfgDir })
ok(sSwitch.provider.moonshot.options.baseURL === 'https://api.moonshot.cn/v1', '换一家，地址自动换成那家的')
ok(!Object.keys(sSwitch.provider).includes('deepseek'), '旧的服务商不留在配置里：留着的话 key 该填在哪就说不清了')
ok(sSwitch.model === 'moonshot/kimi-k2-0905-preview', '没选模型时用目录里第一个')

// 手填目录外的模型名：允许，但不编一个上下文长度出来
const sExtra = mm.simpleToConfig({ preset: 'deepseek', apiKey: 'k', model: 'deepseek-chat-v9' }, { baseDir: cfgDir })
const sExtraNorm = mm.normalize(sExtra, { baseDir: cfgDir })
ok(sExtraNorm.ok && sExtraNorm.selected.modelId === 'deepseek-chat-v9', '目录里没有的模型名也能用（它们新发的模型不该等我们更新）')
ok(sExtraNorm.selected.contextWindow === 0, '不知道上下文长度就空着，不编一个数')

// 自定义：地址必须他说，不然没法发请求
const sCustom = mm.simpleToConfig(
  { preset: 'custom', baseUrl: 'https://api.example.cn/v1', apiKey: 'k', model: 'my-model' },
  { baseDir: cfgDir }
)
const sCustomNorm = mm.normalize(sCustom, { baseDir: cfgDir })
ok(sCustomNorm.ok && sCustomNorm.selected.baseUrl === 'https://api.example.cn/v1', '自定义服务商用他填的地址')
const sCustomBad = mm.normalize(mm.simpleToConfig({ preset: 'custom', apiKey: 'k', model: 'm' }, { baseDir: cfgDir }))
ok(!sCustomBad.ok, '自定义但没填地址 → 当场报错，而不是用个默认地址乱说话')

// key 里带占位符就原样写进去：展开再落盘等于把 key 又抄成明文
const sEnv = mm.simpleToConfig({ preset: 'deepseek', apiKey: '{env:HUNDUN_TEST_KEY}', model: 'deepseek-chat' }, { baseDir: cfgDir })
ok(sEnv.provider.deepseek.options.apiKey === '{env:HUNDUN_TEST_KEY}', '简单模式填的 {env:} 原样留在 JSON 里')
process.env.HUNDUN_TEST_KEY = 'sk-from-env-2'
ok(mm.normalize(sEnv).selected.apiKey === 'sk-from-env-2', '到解析那一层才展开成真的 key')

// store 层：走 / 不走 简单模式，落盘的都是同一份 JSON
const sApply = store.applySimple({ preset: 'qwen', apiKey: 'sk-q', model: 'qwen-plus' })
ok(sApply.ok && store.read().model === 'qwen-plus', '简单模式直接能用')
const sDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
ok(sDisk.modelConfig && sDisk.modelConfig.model === 'qwen/qwen-plus', '落盘的仍是那个 JSON，不是另一份简单配置')
ok(store.publicConfig().modelSimple.preset === 'qwen', '界面下次打开还是简单模式那一栏')
ok(!('baseUrl' in sDisk) && !('apiKey' in sDisk), '派生值照旧不落盘')

// 只改 key：不能把备用链的顺序一起冲掉
const sChainCfg = JSON.parse(JSON.stringify(sEnv))
sChainCfg['x-hundun'].modelOrder = ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner']
sChainCfg.model = 'deepseek/deepseek-chat'
store.write({ modelConfig: sChainCfg })
store.setApiKey('sk-new')
ok(store.read().modelChain.length === 2, '换 key 不动备用链（冲掉的话，主模型一挂就没人接）')
ok(store.read().apiKey === 'sk-new', 'key 换过来了')
store.setApiKey('')
ok(store.publicConfig().hasApiKey === false, '清空 key 也算数，界面据此把他送回设置页')

// 收尾：留一份能用的单模型配置
store.write({ modelConfig: MODEL_OK })

console.log('\n[4] 界面：SSR 渲染')

const vuePlugin = {
  name: 'vue-sfc',
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, 'utf8')
      const id = crypto.createHash('md5').update(args.path).digest('hex').slice(0, 8)
      const { descriptor, errors } = parse(source, { filename: args.path })
      if (errors?.length) return { errors: errors.map((e) => ({ text: String(e.message || e) })) }
      return {
        contents: compileScript(descriptor, { id, inlineTemplate: true }).content,
        loader: 'js',
        resolveDir: path.dirname(args.path)
      }
    })
  }
}

const entry = path.join(ROOT, '.dev/ssr-entry.js')
fs.mkdirSync(path.dirname(entry), { recursive: true })
fs.writeFileSync(
  entry,
  `import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import App from ${JSON.stringify(path.join(ROOT, 'src/renderer/src/App.vue'))}
export const render = () => renderToString(createSSRApp(App))
`
)

let html = ''
try {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    external: ['vue', 'vue/server-renderer'],
    outfile: path.join(ROOT, '.dev/ssr.mjs'),
    plugins: [vuePlugin],
    logLevel: 'silent'
  })
  const mod = await import(path.join(ROOT, '.dev/ssr.mjs') + '?t=' + Date.now())
  html = await mod.render()
  ok(html.length > 200, 'App.vue 渲染成功（' + html.length + ' 字节）')
  ok(html.includes('馄饨'), '标题区渲染出「馄饨」')
  ok(html.includes('今天别烦我'), '静音按钮渲染出来了')
  ok(html.includes('说点什么'), '输入区渲染出来了')
  ok(html.includes('还没开始'), '空状态提示渲染出来了')
} catch (e) {
  ok(false, 'App.vue 渲染失败', e.message)
}

/* ---------------- 5. 产物完整性 ---------------- */

console.log('\n[5] 构建产物')

const idx = path.join(ROOT, 'out/renderer/index.html')
ok(fs.existsSync(idx), 'out/renderer/index.html 存在')
const idxHtml = fs.readFileSync(idx, 'utf8')
const refs = [...idxHtml.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1])
// 不断言「正好 2 个」：页面引用的东西会变多（favicon、logo…），
// 真正要守的是 js 和 css 都在，而且每个引用都落到了产物里。
ok(refs.includes('assets/app.js'), '页面引用了 js', refs.join(', '))
ok(refs.includes('assets/app.css'), '页面引用了 css', refs.join(', '))
for (const r of refs) {
  ok(fs.existsSync(path.join(ROOT, 'out/renderer', r)), '产物存在：' + r)
}

/* logo：唯一源是 build/logo.svg，其余图标/图片都从它派生。
   这里守三件事：源在、产物在、界面真的引了它（而不是又画了一个字）。 */
const logoSvg = path.join(ROOT, 'build/logo.svg')
ok(fs.existsSync(logoSvg), 'build/logo.svg 存在（logo 的唯一源）')
const logoText = fs.existsSync(logoSvg) ? fs.readFileSync(logoSvg, 'utf8') : ''
// viewBox 按图形包围盒收紧过（221×141 左右）。不写成定值：
// 以后微调留白会让数字变，真正要守的是「有 viewBox、且是横宽的」——
// 横宽才说明裁掉了上下的大片空白，竖长的原始 256×256 画布会让界面里图标看着只有一点点大。
const vb = (logoText.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/) || []).slice(1).map(Number)
ok(vb.length === 4, 'logo.svg 带 viewBox')
ok(vb.length === 4 && vb[2] / vb[3] > 1.3 && vb[2] / vb[3] < 1.9, 'logo viewBox 已按图形收紧（横宽）', vb.join(' '))
ok((logoText.match(/<path/g) || []).length === 2, 'logo.svg 是两条 path（轮廓 + A）')
ok(
  fs.existsSync(path.join(ROOT, 'out/renderer/logo.svg')),
  '构建把 logo.svg 拷进了 out/renderer（file:// 下相对路径才解析得到）'
)
const appJs = fs.readFileSync(path.join(ROOT, 'out/renderer/assets/app.js'), 'utf8')
ok(appJs.includes('./logo.svg'), '界面引用了 logo.svg')
// 打包图标齐全：Windows 认 .ico，macOS 认 .icns，Linux 认 png 集
ok(fs.existsSync(path.join(ROOT, 'build/icon.ico')), 'build/icon.ico 存在（Windows 打包）')
ok(fs.existsSync(path.join(ROOT, 'build/icon.icns')), 'build/icon.icns 存在（macOS 打包）')
for (const s of [16, 32, 256, 512]) {
  ok(fs.existsSync(path.join(ROOT, `build/icons/${s}x${s}.png`)), `图标集有 ${s}px`)
}
ok(fs.existsSync(path.join(ROOT, 'resources/tray.png')), '托盘图标存在')
ok(!idxHtml.includes('<!--BUNDLE-->'), '占位符已被替换')

/* ---------------- 6. 检索层 ---------------- */

console.log('\n[6] 检索层：切词、索引、检索、SQL 语义')

const search = require(path.join(ROOT, 'src/main/search.js'))
const SQLS = require(path.join(ROOT, 'src/main/search-sql.js'))

// 造几天的旧记录，其中一天必须能被「登录页」翻出来
const older = life.dateStr(new Date(Date.now() - 12 * 86400000))
const older2 = life.dateStr(new Date(Date.now() - 40 * 86400000))
fs.mkdirSync(path.join(LIFE, 'memory'), { recursive: true })
fs.writeFileSync(
  path.join(LIFE, 'memory', older + '.md'),
  '# ' + older + '\n\n- 主要做后端开发，晚上效率最高\n- 那天卡在登录页，token 过期\n'
)
fs.writeFileSync(
  path.join(LIFE, 'memory', older2 + '.md'),
  '# ' + older2 + '\n\n- 说想把作息挪到早上，试了三天没成\n'
)

const terms = search.tokenize('主要做开发')
ok(terms.includes('开发'), '中文按双字切词', terms.join('/'))
ok(search.tokenize('debug the login flow').includes('login'), '英文按整词切', '')
ok(search.tokenize('').length === 0, '空查询不切出词')

const indexed = await search.rebuild()
ok(indexed > 3, '索引重建有内容', '行数 ' + indexed)

const info = await search.info()
ok(info.kind === 'memory' || info.kind === 'sqlite', '检索后端可用：' + info.kind, info.error)

const hit = await search.search('登录页')
ok(hit.length >= 1, '搜到了旧记录', JSON.stringify(hit[0] || {}))
ok(hit.some((h) => h.day === older), '命中正确的那一天', hit.map((h) => h.day).join(','))
ok(hit.every((h) => h.text && h.file), '结果带来源文件与原文')

const none = await search.search('量子色动力学')
ok(none.length === 0, '搜不到时返回空数组')

const recalledPrompt = life.buildSystemPrompt({
  recalled: [{ day: older, file: 'memory/x.md', text: '那天卡在登录页' }]
})
ok(recalledPrompt.includes('更早的相关记忆'), '提示里注入「更早的相关记忆」')
ok(recalledPrompt.includes('登录页'), '注入内容带着原话')

// SQL 语义交给原生 sqlite3 验（本机 WASM 起不来，sql.js 分支跑不了）
try {
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync('/usr/bin/python3', [path.join(ROOT, 'scripts/test-sql.py')], {
    input: JSON.stringify(SQLS),
    encoding: 'utf8'
  })
  const okCount = (out.match(/✓/g) || []).length
  const badCount = (out.match(/✗/g) || []).length
  ok(badCount === 0 && okCount >= 8, 'SQL 语句语义正确（原生 sqlite3，' + okCount + ' 项）', out.trim().split('\n').slice(-3).join(' | '))
} catch (e) {
  ok(false, 'SQL 语义验证失败', (e.stdout || '') + (e.message || ''))
}

/* ---------------- 汇总 ---------------- */

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 通过 / ' + fail + ' 失败\n')
process.exit(fail === 0 ? 0 : 1)
