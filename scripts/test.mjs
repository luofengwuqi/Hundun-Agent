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
import { fileURLToPath, pathToFileURL } from 'node:url'
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
ok(userSeed.includes('## 关于他') && userSeed.includes('## 要求'), 'USER.md 是空白档案（事实／要求两节）')
ok(life.isProfileEmpty(), '识别出档案为空')

let prompt = life.buildSystemPrompt({})
ok(prompt.includes('SOUL.md'), '提示里包含 SOUL')
ok(prompt.includes('MEMORY.md'), '提示里包含 MEMORY')
ok(prompt.includes('记忆规则'), '提示里包含记忆规则')
ok(prompt.includes('<longterm>'), '提示声明了 longterm 块')
ok(
  life.buildPrompt({}).includes('判定器') && life.buildPrompt({}).includes('<slot>skip</slot>'),
  '档案为空时 buildPrompt 走仪式那份（D115：模型只做判定，话是现成的）'
)
ok(prompt.includes(life.dateStr()), '提示里带上了今天日期')

/* ---------------- 1a. RULES.md：他自己写的规矩 ---------------- */

console.log('\n[1a] RULES.md：能改判断，改不了协议')

const rulesPath = path.join(LIFE, 'RULES.md')
const rulesSeed = fs.readFileSync(rulesPath, 'utf8')

// 空着就连文件块都不出（Project Context 的说明行里那句「RULES.md：他亲手写的规矩」
// 是固定的目录说明，不算注入内容）
ok(!prompt.includes('## RULES.md（他亲手写的规矩）'), 'RULES.md 空着时不起文件块，一个字都不占上下文')
ok(life.rulesText() === '', '只有标题和引用的模板算「没写东西」')

fs.writeFileSync(rulesPath, '# RULES.md\n\n> 一段说明\n\n## 我的规矩\n\n', 'utf8')
ok(life.rulesText() === '', '只留标题和引用时仍然算空，不把说明当规矩喂进去')

fs.writeFileSync(rulesPath, '# RULES.md\n\n## 我的规矩\n\n- 别叫我老板，叫名字\n', 'utf8')
const pRules = life.buildSystemPrompt({})
ok(pRules.includes('别叫我老板'), 'RULES.md 写了就进上下文')
ok(
  pRules.indexOf('别叫我老板') < pRules.indexOf('## Memory（记忆规则）'),
  'RULES 排在记忆规则之前——能改判断，改不了块格式',
  String(pRules.indexOf('别叫我老板')) + ' / ' + String(pRules.indexOf('## Memory（记忆规则）'))
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
// D123：反向偏好没删，但**范围收窄**了。原来那句「多数日子应该是零条」罩着全部五种块，
// 连日记一起压死了（真机一天 95 字节）。现在只管那四种「会变成你去问他的话」的记忆。
ok(sp.includes('日记写密，别的写稀'), '反向偏好还在，但收窄成「日记写密、别的写稀」（D123）')
ok(sp.includes('其余四种多数日子是零条'), '四种稀缺记忆仍然写着「多数日子零条」')
ok(sp.includes('别问「要不要记着」'), '提示词里封死了当场确认（D049）')

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
// D106：原来插在「## 进行中的事」之前，文件于是往上挤，
// 超预算时被截掉的正好是最新的事。改成追加到末尾，顺着时间往下长。
ok(mem.trimEnd().endsWith('连续三天周三下午效率低'), '长期记忆追加在文件末尾，不是插在锚点前')
ok(mem.indexOf('## 进行中的事') < mem.indexOf('连续三天'), '结构节还在前面，没被后面的记录穿过')

life.ingestProfile(['职业｜做后端，主要写 Java'])
const usr = fs.readFileSync(path.join(LIFE, 'USER.md'), 'utf8')
ok(usr.includes('做后端，主要写 Java'), '用户档案已落盘')
ok(/<!--\s*observed: \d{4}-\d{2}-\d{2} \| status: active -->/.test(usr), '条目带观察日期和存活状态')
ok(/## 关于他[\s\S]*做后端/.test(usr), '事实类主题进了「关于他」')

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
// D115：仪式期整条走固定话术，这里验的是会话与身份隔离，先把仪式收掉。
life.endRitual()
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
life.endRitual()
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

/* ---------------- 3c2. D120：交接摘要 ---------------- */

console.log('\n[3c2] D120：交接摘要 —— 仪式刚走完的那一轮，模型知道自己刚「不在场」时发生了什么')

// life 层：renderHandoff
ok(life.renderHandoff(null) === null && life.renderHandoff([]) === null, '没有答话就不渲染交接段')
const hf = life.renderHandoff([
  { key: '称呼', value: '芜柒' },
  { key: '在做', value: '在摆烂' },
  { key: '红线', value: '别提家里的事' }
])
ok(hf.includes('## 交接') && hf.includes('从这一句起，才是你和他'), '交接段有头有尾')
ok(hf.includes('「芜柒」') && hf.includes('「在摆烂」') && hf.includes('「别提家里的事」'), '答话原文一字不差地进去')

// take 语义：取走一次就没了，不会重复注入
life.setRitualHandoff([{ key: '称呼', value: '老吴' }])
const takenOnce = life.takeRitualHandoff()
ok(Array.isArray(takenOnce) && takenOnce.length === 1 && life.takeRitualHandoff() === null, '交接摘要取走一次就消失')

// buildSystemPrompt：handoff 只在被交给的那一轮存在（传原始数组，渲染在内部做）
const HF_RAW = [
  { key: '称呼', value: '芜柒' },
  { key: '在做', value: '在摆烂' },
  { key: '红线', value: '别提家里的事' }
]
const sysWithHf = life.buildSystemPrompt({ handoff: HF_RAW })
const sysWithoutHf = life.buildSystemPrompt()
ok(sysWithHf.includes('## 交接') && sysWithHf.includes('「芜柒」'), 'buildSystemPrompt 会把交接段注入')
ok(!sysWithoutHf.includes('## 交接'), '不传就没有——不是常驻段落')

// conversation 层：send 是唯一消费者。mock 掉模型，抓每一轮的 system prompt 来看。
const realStreamC2 = llm.streamChat
const realChatC2 = llm.chat
const realSearchC2 = searchMod.search
const seenSystem = []
llm.streamChat = async (opts, onDelta) => {
  seenSystem.push(opts.messages[0].content)
  const text = '嗯。'
  onDelta && onDelta(text)
  return text
}
llm.chat = async () => ({ text: '<slot>skip</slot>' })
searchMod.search = async () => []
life.endRitual()
conversation.resetSession()

life.setRitualHandoff([{ key: '称呼', value: '芜柒' }, { key: '在做', value: '在摆烂' }])
await conversation.send('你好呀')
ok(seenSystem[0].includes('## 交接') && seenSystem[0].includes('在摆烂'), '仪式刚结束的第一轮：模型收到交接摘要')
await conversation.send('接着聊')
ok(!seenSystem[1].includes('## 交接'), '第二轮就没有了——交接只在交出去的那一轮存在')

// 切身份丢掉没交出去的摘要：另一段人生不该继承这一段的「刚发生的事」
life.setRitualHandoff([{ key: '称呼', value: '老吴' }])
conversation.resetSession()
await conversation.send('在吗')
ok(!seenSystem[2].includes('## 交接'), 'resetSession 把没交出去的摘要也丢了')

llm.streamChat = realStreamC2
llm.chat = realChatC2
searchMod.search = realSearchC2
// 这一段为了抓 system prompt 真跑了三轮 send，会话文件里留了 6 条历史。
// 3d 节的断言建立在「干净会话」上——reset 把磁盘那份也删掉，别让它们漏过去。
conversation.reset()

/* ---------------- 3c3. D123：日记改成每天都写 ---------------- */

console.log('\n[3c3] D123：日记 —— 模型自己写看法，代码只兜底原话')

const jSys = life.buildSystemPrompt()
ok(jSys.includes('日记（<memory>）：每天都该有东西'), '日记被单独拎出来讲（不再混在「五种块挑一个」里）')
ok(jSys.includes('待办：问一句那个客户结没结账'), '给了「待办」的示例句')
ok(jSys.includes('原话不用你抄'), '写明原话由系统另存，模型写的是看法')
ok(jSys.includes('只有 <memory> 例外'), '「多数日子零条」收窄到另外四种，没再压着日记')

// 标题去重：一天写三次只能有一个「### 记录」
const D123 = path.join(ROOT, '.dev/test-d123')
fs.rmSync(D123, { recursive: true, force: true })
const prevLifeDir = process.env.HUNDUN_LIFE_DIR || TMP
process.env.HUNDUN_LIFE_DIR = D123
life.ensureLife()
const d123File = path.join(life.lifeDir(), 'memory', life.dateStr() + '.md')
life.appendJournal(['他今天在赶外包'])
life.appendJournal(['待办：问一句结账没有'])
life.appendJournal(['他说在摆烂，但今天第三次主动提外包'])
const jtxt = fs.readFileSync(d123File, 'utf8')
ok((jtxt.match(/### 记录/g) || []).length === 1, '一天写三次只有一个「### 记录」', '实际 ' + (jtxt.match(/### 记录/g) || []).length)
ok(jtxt.includes('待办：问一句结账没有'), '模型写的待办落盘了')

life.appendDiary('今天不想说话')
ok(/- \d{2}:\d{2} 他说：今天不想说话/.test(fs.readFileSync(d123File, 'utf8')), '代码兜底的原话带「他说：」前缀')
life.appendDiary('今天不想说话')
ok((fs.readFileSync(d123File, 'utf8').match(/今天不想说话/g) || []).length === 1, '加前缀之后去重仍然生效')

ok(life.buildSystemPrompt().includes('待办：问一句结账没有'), '模型写的待办会进下一轮的提示词（它明天读得到）')

process.env.HUNDUN_LIFE_DIR = prevLifeDir
fs.rmSync(D123, { recursive: true, force: true })

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
life.endRitual()
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

console.log('\n[3i] 多个模型：一条链，按顺序试')

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
ok(sSwitch.model === 'moonshot/kimi-k3.1-pro', '没选模型时用目录里第一个')

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
// 两个模型名显式写进 models 字典，不借目录里的：目录会过期，上游下架一个模型
// 就会让这条断言红掉 —— 而红的并不是它要测的东西（key 改动伤不伤备用链）。
const sChainCfg = JSON.parse(JSON.stringify(sEnv))
sChainCfg.provider.deepseek.models = {
  'chain-a': { name: 'A', limit: { context: 128000 } },
  'chain-b': { name: 'B', limit: { context: 128000 } }
}
sChainCfg['x-hundun'].modelOrder = ['deepseek/chain-a', 'deepseek/chain-b']
sChainCfg.model = 'deepseek/chain-a'
store.write({ modelConfig: sChainCfg })
store.setApiKey('sk-new')
ok(store.read().modelChain.length === 2, '换 key 不动备用链（冲掉的话，主模型一挂就没人接）')
ok(store.read().apiKey === 'sk-new', 'key 换过来了')
store.setApiKey('')
ok(store.publicConfig().hasApiKey === false, '清空 key 也算数，界面据此把他送回设置页')

// 收尾：留一份能用的单模型配置
store.write({ modelConfig: MODEL_OK })

console.log('\n[3g] 调度：五条判定、时效、送达标记')

const sched = require(path.join(ROOT, 'src/main/schedule.js'))

// 到期日换算：绝对日期原样，相对表达按锚点算
const ANCHOR = '2026-11-05' // 周四
ok(sched.dueDate('2026-11-08', ANCHOR) === '2026-11-08', '绝对日期原样返回')
ok(sched.dueDate('明天@' + ANCHOR, ANCHOR) === '2026-11-06', '明天 = 锚点 +1')
ok(sched.dueDate('后天@' + ANCHOR, ANCHOR) === '2026-11-07', '后天 = 锚点 +2')
ok(sched.dueDate('大后天@' + ANCHOR, ANCHOR) === '2026-11-08', '大后天 = 锚点 +3')
ok(sched.dueDate('下周三@' + ANCHOR, ANCHOR) === '2026-11-11', '下周三 = 下一周的周三')
ok(sched.dueDate('周三@' + ANCHOR, ANCHOR) === '2026-11-11', '光写「周三」= 还没到的那个周三')
ok(sched.dueDate('周五@' + ANCHOR, ANCHOR) === '2026-11-06', '周五 = 明天')
ok(sched.dueDate('月底@' + ANCHOR, ANCHOR) === '2026-11-30', '月底 = 这个月最后一天')
ok(sched.dueDate('3天后@' + ANCHOR, ANCHOR) === '2026-11-08', '3 天后 = 锚点 +3')
ok(sched.dueDate('改天@' + ANCHOR, ANCHOR) === null, '认不出来的日期不猜（返回 null）')

// 时段：区间判断，不是等值比对
const at = (h, m) => new Date(2026, 10, 5, h, m, 0)
const WIN = [{ from: '09:00', to: '12:00' }]
ok(sched.inWindows(at(10, 30), WIN) === true, '10:30 在 09:00–12:00 内')
ok(sched.inWindows(at(12, 0), WIN) === false, '12:00 已经出界（右开）')
ok(sched.inWindows(at(8, 59), WIN) === false, '8:59 还没到')
ok(sched.inWindows(at(23, 30), [{ from: '23:00', to: '01:00' }]) === false, '跨零点的段不猜，直接作废')
ok(sched.parseHm('930') === 570 && sched.parseHm('9:30') === 570, '时段写法两种都认')

// 时效：默认强（少问一句是安全的方向）
ok(sched.timeliness('跟客户谈项目细节') === 'strong', '「谈项目」是强时效')
ok(sched.timeliness('把开源项目的 README 写了') === 'weak', '持续在写的事是弱时效')
ok(sched.timeliness('随便什么') === 'strong', '认不出来按强时效（默认不问）')

// 五条全部满足才开口
const SC = {
  disturb: { on: true, windows: WIN, dailyLimit: 3 },
  quietDate: ''
}
const dueToday = { index: 0, what: '跟客户谈细节', due: '2026-11-05', delivery: '未问', pinned: false }
const j1 = sched.judge({ now: at(10, 0), cfg: { ...SC, disturb: { ...SC.disturb, on: false } }, items: [dueToday] })
ok(j1.fire === false && j1.reason === 'off', '总开关关着 → 不开口')
const j2 = sched.judge({ now: at(10, 0), cfg: { ...SC, disturb: { ...SC.disturb, windows: [] } }, items: [dueToday] })
ok(j2.fire === false && j2.reason === 'noWindow', '没有允许时段 → 不开口')
const j3 = sched.judge({ now: at(10, 0), cfg: { ...SC, quietDate: '2026-11-05' }, items: [dueToday] })
ok(j3.fire === false && j3.reason === 'quiet', '今天别烦我 → 不开口')
const j4 = sched.judge({ now: at(10, 0), cfg: { ...SC, disturb: { ...SC.disturb, dailyLimit: 0 } }, items: [dueToday] })
ok(j4.fire === false && j4.reason === 'noLimit', '上限 0 等同关闭')
const j5 = sched.judge({ now: at(10, 0), cfg: SC, items: [dueToday], sentToday: 3 })
ok(j5.fire === false && j5.reason === 'overLimit', '今天已经到上限 → 不开口')
const j6 = sched.judge({ now: at(8, 0), cfg: SC, items: [dueToday] })
ok(j6.fire === false && j6.reason === 'outside', '不在时段内 → 不开口')
const j7 = sched.judge({ now: at(10, 0), cfg: SC, items: [] })
ok(j7.fire === false && j7.reason === 'nothing', '没有到期的事 → 闭嘴')
const j8 = sched.judge({ now: at(10, 0), cfg: SC, items: [dueToday] })
ok(j8.fire === true && j8.kind === 'due', '到期当天 → 开口')
const j9 = sched.judge({
  now: at(10, 0), cfg: SC,
  items: [{ index: 0, what: '跟客户谈细节', due: '2026-11-08', delivery: '未问' }]
})
ok(j9.fire === false, '还没到期 → 不开口')
const j10 = sched.judge({
  now: at(10, 0), cfg: SC,
  items: [{ index: 0, what: '跟客户谈细节', due: '2026-11-05', delivery: '已送达' }]
})
ok(j10.fire === false, '已经送达过 → 再不提（X-10 红线 1）')
const j11 = sched.judge({
  now: at(10, 0), cfg: SC,
  items: [{ index: 0, what: '把 README 写了', due: '2026-11-05', delivery: '待延后' }]
})
ok(j11.fire === true && j11.kind === 'deferred', '待延后 → 下次他在的时候再送')
const j12 = sched.judge({
  now: at(10, 0), cfg: SC,
  items: [{ index: 0, what: '跟客户谈细节', due: '2026-11-03', delivery: '未问' }]
})
ok(j12.fire === false && j12.drop.includes(0), '过期且时效强 → 删行，不补问（F06-27）')
const j13 = sched.judge({
  now: at(10, 0), cfg: SC,
  items: [{ index: 0, what: '把 README 写了', due: '2026-11-03', delivery: '未问' }]
})
ok(j13.fire === true && j13.kind === 'late', '过期但时效弱 → 允许问一次（F06-28）')
const j14 = sched.judge({
  now: at(10, 0), cfg: SC,
  items: [
    { index: 0, what: '跟客户谈细节', due: '2026-11-05', delivery: '未问', pinned: false },
    { index: 1, what: '交稿', due: '2026-11-05', delivery: '未问', pinned: true }
  ]
})
ok(j14.fire === true && j14.item.index === 1, 'pinned 排在前面（D053／X-11）')

// 送达标记：状态机只走「消息」列（P-12）
const CMT = path.join(life.lifeDir(), 'COMMITMENTS.md')
function writeCommits(rows) {
  const body = rows.map((r) => '| ' + r.join(' | ') + ' |').join('\n')
  fs.writeFileSync(CMT, '\n| 什么事 | 到期日 | 结局 | 消息 |\n| --- | --- | --- | --- |\n' + body + '\n')
}
writeCommits([
  ['把 README 写了', '2026-11-05', '—', '未问'],
  ['跟客户谈细节', '2026-11-05', '—', '未问'],
  ['练琴', '2026-11-05', '—', '待延后']
])
store.write({ disturbLog: { date: '', count: 0 } })
const weakItem = life.listCommitments().find((c) => c.what === '把 README 写了')
const strongItem = life.listCommitments().find((c) => c.what === '跟客户谈细节')
const deferredItem = life.listCommitments().find((c) => c.what === '练琴')

ok(sched.mark({ kind: 'due', item: weakItem }, false) === 'deferred', '没送到·时效弱 → 待延后')
ok(life.readCommitment(weakItem.index).delivery === '待延后', '待延后真的写进文件了')
ok(sched.mark({ kind: 'due', item: strongItem }, false) === 'dropped', '没送到·时效强 → 删行')
ok(life.listCommitments().every((c) => c.what !== '跟客户谈细节'), '那条过时的真的没了')
ok(sched.mark({ kind: 'deferred', item: deferredItem }, false) === 'dropped', '延后只给一次，第二次没送到就删')
const readmeNow = life.listCommitments().find((c) => c.what === '把 README 写了')
ok(sched.mark({ kind: 'deferred', item: readmeNow }, true) === 'delivered', '延后补送成功 → 已送达')
ok(life.listCommitments().find((c) => c.what === '把 README 写了').delivery === '已送达', '已送达落盘')
ok(store.disturbSentToday() === 0, '补送不额外占配额（F06-5 硬上限 3）')

writeCommits([['跟客户谈细节', '2026-11-05', '—', '未问']])
const firstItem = life.listCommitments()[0]
ok(sched.mark({ kind: 'due', item: firstItem }, true) === 'delivered', '送达 → 已送达')
ok(store.disturbSentToday() === 1, '第一次送达记一次配额')

// ticker：判定之外的那半（窗口可见 / 通知 / 推事件）也要跑通
writeCommits([['把 README 写了', '2026-11-05', '—', '未问']])
store.write({
  disturb: { on: true, windows: [{ from: '00:00', to: '23:59' }], dailyLimit: 5 },
  quietDate: ''
})
const events = []
let turnCalls = 0
const s = sched.start({
  getWindow: () => null, // 窗口不在 → 走通知那条路
  isBusy: () => false,
  send: (ch, payload) => events.push([ch, payload]),
  sendTurn: async (text, hooks) => {
    turnCalls++
    hooks.onDelta('那个 README')
    hooks.onDelta('后来写了吗')
    return { text: '那个 README 后来写了吗' }
  },
  notify: async () => true,
  intervalMs: 3600000,
  gapMs: 0
})
s._reset()
await s.tick()
s.stop()
ok(turnCalls === 1, '到点了就去生成一句话')
ok(events.some((e) => e[0] === 'chat:delta') && events.some((e) => e[0] === 'chat:turn'), '推送了流式字和收尾事件')
ok(life.listCommitments()[0].delivery === '已送达', '通知真的弹出来才算送达')

// 窗口开着：不弹通知也算送到（判据是「他看得见」，不是「通知弹过」）
writeCommits([['把 README 写了', '2026-11-05', '—', '未问']])
let notified = 0
const s2 = sched.start({
  getWindow: () => ({ isDestroyed: () => false, isVisible: () => true }),
  send: () => {},
  sendTurn: async () => ({ text: '那个 README 写了吗' }),
  notify: async () => {
    notified++
    return true
  },
  intervalMs: 3600000,
  gapMs: 0
})
s2._reset()
await s2.tick()
s2.stop()
ok(notified === 0 && life.listCommitments()[0].delivery === '已送达', '窗口开着 → 不弹通知也算送达')

// 生成失败（没 key／网络不通）：不标记。那不是「没送到」，是这句话根本没说出来
writeCommits([['把 README 写了', '2026-11-05', '—', '未问']])
const ev2 = []
const s3 = sched.start({
  getWindow: () => null,
  send: (ch) => ev2.push(ch),
  sendTurn: async () => {
    throw new Error('还没有填 API Key')
  },
  notify: async () => true,
  intervalMs: 3600000,
  gapMs: 0
})
s3._reset()
await s3.tick()
s3.stop()
ok(
  life.listCommitments()[0].delivery === '未问' && !ev2.includes('chat:turn'),
  '生成失败不标记（否则下次会重说一遍，而他从没听过第一遍）'
)

console.log('\n[3h] 第一次见面：仪式在文件里，删掉即完成')

{
  const bsPrev = process.env.HUNDUN_LIFE_DIR
  const bsRoot = path.join(TMP, 'bs-new')
  fs.rmSync(bsRoot, { recursive: true, force: true })
  process.env.HUNDUN_LIFE_DIR = bsRoot

  life.ensureLife()
  ok(life.bootstrapPending(), '全新的生活目录会种一份 BOOTSTRAP.md')

  // D112：仪式走的是**另一个程序**，所以这一节分两份拿：
  // bsFirst = 主程序（馄饨），bsRitual = 仪式期那个安装程序。
  // D115 之后仪式那份已经**不含任何可显示的字**了：可见的话全在 RITUAL_SLOTS 里，
  // 模型只回一个判定标记。所以这里验的是话术和判定协议，不是提示词段落顺序。
  const bsFirst = life.buildSystemPrompt()
  const bsRitual = life.buildPrompt()

  const boot = life.ritualReply({ kind: 'boot', slot: life.RITUAL_SLOTS[0] })
  ok(boot.includes('[INPUT-REQ] 等待录入参数：称呼'), '开场是录入协议的第一条请求（不经模型造句，D122）')
  ok(boot.includes('怎么称呼你'), '开场直接问第一格，不寒暄')
  ok(!boot.includes('我'), '开场里没有「我」—— 装程序不自称（D115 要的人机感就靠这条）')

  ok(bsRitual.includes('判定器'), '仪式期模型拿到的是一份判定器提示词')
  ok(bsRitual.includes('不会显示给人看'), '写死「你说的字不会显示」，否则它会开始说话')
  ok(bsRitual.includes('<slot>skip</slot>') && bsRitual.includes('<slot>end</slot>'), '三种判定都给了')
  ok(!bsRitual.includes('Interaction Style') && !bsRitual.includes('SOUL'), '判定器不带人格层')

  // D096：关于他的条目单独成段，放在 Project Context **之前**
  // —— openclaw 的 USER.md 是「session 开始时单独加载、独立小预算」，不跟别的文件挤在一起。
  {
    const iHim = bsFirst.indexOf('## 他（你手上关于他的全部）')
    const iRun = bsFirst.indexOf('## Runtime Context')
    ok(iHim > iRun, '「他」那节在 Runtime Context 之后')
    ok(iHim > 0 && iHim < bsFirst.indexOf('# Project Context'), '「他」那节在 Project Context 之前（注意力更强的一端）')
    ok(bsFirst.includes('还什么都不知道'), '新档案时明说「还什么都不知道」，不是空着一片')
    // 全新目录的日记是空模板，不该被当成「有记录」注进去
    ok(!bsFirst.includes('## ' + life.dateStr()), '空日记不注入（只有 frontmatter 和标题）')
    ok(bsFirst.includes('日记是空的'), '没有日记时明说一句，免得它以为被截断')
    ok(bsFirst.includes('扫一眼开头那节「他」'), '输出规则最后一段要求先扫一遍关于他的信息')
    ok(bsFirst.includes('不能整轮一句都没沾到'), '用不用都行，但整轮不许一句都没沾到记忆')
  }

  // D097：日记机械兜底。openclaw 的 daily notes 有内容靠「模型有工具随时写」，
  // 我们的模型没有工具也不写块（真机十几轮零写入），所以由代码把他的原话落进日记。
  {
    const before = fs.readFileSync(path.join(life.lifeDir(), 'memory', life.dateStr() + '.md'), 'utf8')
    life.appendDiary('晚上十二点就倒下了 下午干活')
    const after = fs.readFileSync(path.join(life.lifeDir(), 'memory', life.dateStr() + '.md'), 'utf8')
    ok(after.includes('晚上十二点就倒下了'), '他的原话进当天日记')
    ok(!before.includes('晚上十二点就倒下了'), '之前日记确实是空的（这个测试目录才建的）')

    life.appendDiary('晚上十二点就倒下了 下午干活')
    const dup = fs.readFileSync(path.join(life.lifeDir(), 'memory', life.dateStr() + '.md'), 'utf8')
    ok((dup.match(/晚上十二点就倒下了/g) || []).length === 1, '同一句当天只记一份（召回回环挡在这）')

    const short = life.appendDiary('嗯')
    ok(short === null, '四字以内的应答不记')
    const long = life.appendDiary('第一行的话\n第二行的话')
    ok(long && long.includes('第一行的话') && long.includes('第二行的话'), '多行压成一行')
    ok(!life.appendDiary(''), '空串不记')

    // 注入：日记有正文之后，提示词里应该能看到（标题带「今天/昨天」前缀）
    const p2 = life.buildSystemPrompt()
    ok(p2.includes('今天 ' + life.dateStr()), '日记注入段带着「今天/昨天」前缀（D096 修掉过丢前缀的回归）')
    ok(p2.includes('晚上十二点就倒下了'), '日记正文出现在提示词里 —— 它这一轮就知道他刚说过什么')
  }
  ok(
    bsFirst.indexOf('## AGENTS.md（这个窗口是干什么的）') <
      bsFirst.indexOf('## SOUL.md（你是谁、怎么说话）'),
    'AGENTS.md 排在 SOUL 之前（agents=10 < soul=20，先有目的再有人格）'
  )
  ok(bsRitual.includes('<slot>' + life.RITUAL_SLOTS[0].key + '|'), '判定标记里带着当前格的主题（写错栏位就落错地方）')
  ok(bsFirst.includes('## Care'), '有 Care 段（行为合同，不放在他改得动的 SOUL 里）')
  ok(
    bsFirst.includes('不许推断') && bsFirst.includes('那是查档案，不是聊天'),
    '带着「不许编、不许背档案」两条'
  )
  ok(bsFirst.includes('不复述他刚说过的话'), '输出规则里禁止复述过场')
  // 「冷、短」是三个地方一起造成的：Interaction Style 写「短」、SOUL 写「短。一两句」、
  // BOOTSTRAP 写「一次只问一个问题」。三处都在压长度，没有一处说要接住他。
  ok(bsFirst.includes('固定骨架') && bsFirst.includes('例行公事'), '长度跟内容走，禁三段式公式（D105 例行公事治理）')
  ok(bsFirst.includes('这是聊天不是回执'), '写死「整轮只有一个问句」是错的（D103 重写后判据句）')
  ok(bsFirst.includes('别只剩一个问号'), 'SOUL 的说话方式也改了，三处口径一致')
  // 第五轮实测（2026-11-06）：长度够了，话还是冷。这次的问题不在长短，在**主语**——
  // 「这个词有点重」「这作息挺说明问题的」「这话不轻」主语全是他的话，
  // 它在旁边做记录，不在他旁边。上几轮一直在改形容词和句数，没触及这一层。
  // 改法是给**正反例对照**（示例比规则有力量），不是再换一个形容词。
  ok(bsFirst.includes('接那件事，不接他的用词'), '风格段保留了「评价 vs 接住」的判据（对照表已删，D095）')
  ok(bsFirst.includes('这个词有点重'), '反例的关键词仍在判据句里，不是编的')
  ok(bsFirst.includes('这挺说明问题') && bsFirst.includes('站在外面评价'), '禁掉记录员口吻（归档不是安慰，D103 判据句）')
  ok(bsFirst.includes('不接他的用词'), '禁掉「看见了却明说不动」——比没看见更凉（D103 判据句）')
  ok(life.TPL_SOUL.includes('怎么这么说自己'), 'SOUL 的接法示例改成问那件事，不再评价他的用词')
  ok(!life.TPL_SOUL.includes('一句「听着挺累的」就够了'), 'SOUL 里那句空洞安慰的示例已删')
  ok(!life.TPL_BOOTSTRAP.includes('「还行」这个词，一般都不太行'), 'BOOTSTRAP 里那句评价式示例已删')
  // 第六轮实测（2026-11-06 12:20）：他连说「冷」「你好冷」，它的应对全是错的——
  // 道歉退场（「不问了」「就先这样」）、同一句自我批评说两遍、转头又给二选一问卷、
  // 反驳他的自评（「这句我不太认」「那是行情，不是你菜」）。
  ok(bsFirst.includes('不道歉退场'), '批评应对写成了换方式，不是认错（D103 判据句）')
  ok(bsFirst.includes('把自己撤出来'), '写明为什么道歉退场不行（D103 判据句）')
  ok(bsFirst.includes('接着在场'), '同一句检讨说两遍等于告诉他没打算改（D103 换成正向动作）')
  ok(bsFirst.includes('「，还是」'), '禁「还是」拼两个问题（覆盖二选一场景）')
  ok(bsFirst.includes('「我在」比「你想聊什么」有用'), '没得接的时候给的是在场，不是新问题')
  ok(life.TPL_SOUL.includes('不反驳、不附和、不纠正'), '自我评价不是命题：不辩论')
  ok(!life.TPL_SOUL.includes('他自欺时，**方式可以软，结论不能软**'), '「不附和」条款已限定到事实判断')
  // 第七轮实测（12:25–12:27）：他说「笨笨的 冷冷的」。翻出来是**问句拼装**——
  // 六句里四句把两个问题糊成一句，还爱用「A 还是 B」：「晚上几点…，早上还是半夜脑子最清楚？」
  // 「工作是能停下来的，还是停不了？」。笨不在用词，在不会问一个干净的问题。
  ok(bsFirst.includes('一次只问一件'), '问句只问一件，不许把两个问题拼成一句')
  ok(bsFirst.includes('，还是'), '点名「还是」拼接这种最省事也最像问卷的写法（D103 判据句）')
  ok(bsFirst.includes('有的轮次一句话收尾更好'), '允许某一轮不给问号——每句都收在问号上就是面试（D105 判据句）')
  // 它把一小时前说成「昨天」：「昨天聊的都是写代码那些事」。这不只是语气问题，是算错了时间。
  ok(bsFirst.includes('不说「昨天」「上次」「好久没聊」'), '禁时间词：它会算错，且报时间差本身有钟表味')
  ok(bsFirst.includes('开场不提「之前聊过什么」'), '禁开场复述记忆（那是把档案读给他听）')
  // ---- D108：语气层压过输出层 ----
  // 他的原话是「回答任何问题都过于理性」。前四轮都在加词（D083／D091／D093／D104），
  // 这一次动的是**优先级**：语气层在最前，理性规则在最后，不动优先级靠后的永远赢。
  ok(bsFirst.includes('这一节压过下面的行动和输出规则'), 'persona latch 在：语气层压过行动与输出规则（照 openclaw 的 <persona_latch>）')
  ok(
    bsFirst.includes('这一节压过下面的行动和输出规则') &&
      bsFirst.indexOf('这一节压过下面的行动和输出规则') < bsFirst.indexOf('## Execution Bias'),
    'latch 写在 Interaction Style 里、排在 Execution Bias 之前（写在后面就压不住）'
  )
  ok(!life.TPL_SOUL.includes('## 里面这层：理性'), 'SOUL 里不再有「理性层」这一节（判断力归执行层，不归人格文件）')
  ok(life.TPL_SOUL.includes('这一轮只接住'), '新增「这一轮先做哪件」：累了就只接住')
  ok(!life.TPL_SOUL.includes('判断要有据：说「你上周也提过一次」'), '「判断要有据」不再是无条件的（无条件＝他难受时也在举证）')
  ok(bsFirst.includes('他要方向时才举证'), '举证加上条件：只有他要方向时（D108 对 D044 的落地修正）')
  ok(!bsFirst.includes('判断要具体：说「你昨天也说卡在这里」'), '旧的无条件举证句已删（它在提示词最末，权重最高）')
  ok(
    life.buildSystemPrompt().indexOf('接住他') < life.buildSystemPrompt().indexOf('理清思路'),
    '定位句里「接住」排在「理清思路」前面（三个任务不再并列）'
  )
  // 真机 22:34／22:36 那三句原话，逐条对上之后的补丁。三句都不是「理性」，
  // 是同一件事的三个面：拿钟表起头、汇报记忆、把球推回去。
  // D115 之后「别拿时间当招呼」从文案判据变成了**结构判据**：
  // 判定器的提示词里根本没有当前时间，也没有可抄的示例。
  ok(!life.buildRitualPrompt().includes('这个点了'), '仪式程序拿不到时刻，也没有可抄的示例（D059）')
  ok(!life.buildRitualPrompt().includes('Runtime Context'), '判定器没有 Runtime Context 段 —— 时间从源头就断了')
  ok(bsFirst.includes('不把球推回去'), '「要我怎么配合直接说」被点名（把选择权还给他＝没在场）')
  ok(bsFirst.includes('不汇报你记了什么'), '「名字落我这儿了」被点名（记忆不是进度汇报）')
  ok(
    life.SOUL_HISTORY.at(-2).includes('里面这层：理性'),
    '历史表倒数第二格是 D108 之前那版（含理性层）——漏掉它，装那版的机器永远升不上来'
  )
  // ---- D117：他没话说那一轮（2026-11-09）----
  // 他连着两次说「还是比预期中要短」「也比预期中冷」。D111 已经证伪字数假设
  // （放宽配额不变长、全删更短），所以这次一个字都没动长度，动的是**落点**：
  // 旧版「这一轮先做哪件」五种情形全假设「他说了一件有事的话」，「好的」一条都不命中，
  // 没命中就走默认 —— 默认是确认 + 结束。那两句的毛病不是短，是每句都在关掉这一轮。
  ok(life.TPL_SOUL.includes('他没什么话说'), '空输入有落点了（「好的」不再一路滑到「去睡吧」）')
  ok(life.TPL_SOUL.includes('这一轮你来起头'), '空输入这一轮由它起头，不是把门带上')
  ok(life.TPL_SOUL.includes('把它关掉'), '点名「去睡吧」「不用回我」这类关门口的写法')
  ok(life.TPL_SOUL.includes('安慰说的是他的状态，不是他的作息'), '安慰和管作息分开（「早点睡」是管他）')
  ok(life.TPL_SOUL.includes('有话没说出来'), '旧的「绕着说」那条还在（新条是补位，不是替换）')
  ok(life.SOUL_HISTORY.length === 7, '七版出厂 SOUL 都在表里（V7 = D108 版）')
  ok(!life.SOUL_HISTORY.at(-1).includes('他没什么话说'), '历史表最后一格是**被换掉**那版，不是当前版')

  // ---- D119：照 openclaw 的档案结构补两节（2026-11-09）----
  // 他的原话：「你看 openclaw 多有人味 我建议完全模仿他 不要另起炉灶」。
  // 翻他机器上真在跑的那份（~/.openclaw/ 与 workspace/）：SOUL.md 1888 字符里
  // 中文只有 7 行、**没有一条语气规则**；人味来自 USER.md 最后那一类
  // （珍视这段关系、怕被遗忘）和按天写得很细的日记。我们的 USER.md 只有
  // 「关于他／要求」，情感那一层没有地方落。
  ok(life.TPL_USER.includes('## 他在意什么'), 'USER.md 模板有了「他在意什么」一节')
  ok(life.TPL_MEMORY.includes('## 我们之间'), 'MEMORY.md 模板有了「我们之间」一节')
  ok(life.TPL_IDENTITY.includes('答名字，不答你能干什么'), 'IDENTITY 里写明「他问你是谁，答名字不答功能」')

  // 只调 ensureProfileSections，不调 ensureLife —— ensureLife 会种仪式文件，
  // 把主测试线（TMP）里 BOOTSTRAP.md 的演进状态搅乱。这里要验的只是补节本身。
  const LEGACY = path.join(ROOT, '.dev/test-legacy-sec')
  const ldir = path.join(LEGACY, 'users', 'local', 'agents', 'hundun')
  fs.rmSync(LEGACY, { recursive: true, force: true })
  fs.mkdirSync(ldir, { recursive: true })
  fs.writeFileSync(path.join(ldir, 'USER.md'), '# USER.md — 关于你\n\n## 关于他\n\n- [称呼] 芜柒\n\n## 要求\n\n## 访谈实录\n', 'utf8')
  fs.writeFileSync(path.join(ldir, 'MEMORY.md'), '# MEMORY.md\n\n## 关于你（事实）\n\n## 按天的记录\n\n', 'utf8')
  process.env.HUNDUN_LIFE_DIR = LEGACY
  const filled = life.ensureProfileSections()
  const patched = fs.readFileSync(path.join(ldir, 'USER.md'), 'utf8')
  const patchedMem = fs.readFileSync(path.join(ldir, 'MEMORY.md'), 'utf8')
  ok(filled.length === 2, '两个老档案都补了节', JSON.stringify(filled))
  ok(patched.includes('## 他在意什么'), '存量档案补上「他在意什么」')
  ok(patched.indexOf('## 他在意什么') < patched.indexOf('## 要求'), '补在「要求」前面，不是追加到末尾')
  ok(patched.includes('- [称呼] 芜柒'), '补节没动他写过的那行')
  ok(patchedMem.includes('## 我们之间'), '老 MEMORY.md 补上「我们之间」')
  ok(life.ensureProfileSections().length === 0, '补节是幂等的（跑第二遍无事可做）')
  fs.rmSync(LEGACY, { recursive: true, force: true })
  process.env.HUNDUN_LIFE_DIR = TMP
  ok(
    life.ritualReply({ kind: 'missing', slot: life.RITUAL_SLOTS[1] }).includes('未检测到有效输入'),
    '他绕开时按「未检测到有效输入」打回，不判他错（D122 的协议话术）'
  )
  ok(
    life.ritualReply({ kind: 'missing', slot: life.RITUAL_SLOTS[1] }).includes('“跳过”'),
    '打回那行告诉他可以输入跳过——跳过是他手里的选项，不是我们替他决定'
  )
  ok(
    !life.ritualReply({ kind: 'missing', slot: life.RITUAL_SLOTS[0] }).includes('可输入'),
    '称呼那格打回时不给跳过选项——没有称呼，开口那一句接不住'
  )
  ok(!life.bootstrapDone(), '一条都没记时不算走完')

  // [2]/[3] 段的会话测试用 endRitual() 模拟过「他不想答了」，把 BOOTSTRAP.md 删掉了。
  // 这一段验的是仪式判定本身，不能建立在上一段的副作用上 —— 显式放回去。
  // （`seedBootstrapOnce` 不会帮我们种：`.bootstrap` 一次性标记早就写下了。）
  if (!life.bootstrapPending()) {
    fs.writeFileSync(path.join(life.lifeDir(), 'BOOTSTRAP.md'), life.TPL_BOOTSTRAP, 'utf8')
  }
  // 档案也重置回空白：前面验落盘时写过一条「职业」，留着它，数主题时会平白多占一格
  // （2 格 + 职业 = 3 格，判据直接过）。这一段要从「一条都没有」开始验。
  fs.writeFileSync(path.join(life.lifeDir(), 'USER.md'), life.TPL_USER, 'utf8')

  life.ingestProfile(['称呼｜叫他老吴'])
  ok(life.bootstrapPending() && !life.bootstrapDone(), '只问了一件：文件还在，仪式没结束', 'pending=' + life.bootstrapPending() + ' done=' + life.bootstrapDone() + ' keys=' + life.aboutKeys().join(','))

  // 实测踩到的：档案一记上「称呼」就不再是空的，如果注入判据写成
  // `isProfileEmpty()`，第一条答完仪式就整个消失，剩下几格永远不问。
  // 注入判据必须是「文件还在不在」，和完成判据是同一个开关。
  ok(!life.isProfileEmpty(), '记了一件之后档案已经不是空的')
  const bsMid = life.buildRitualPrompt()
  ok(bsMid.includes('主题：在做'), '只答了一件：下一格是「在做」，不会重问称呼')
  ok(!bsMid.includes('主题：称呼'), '已经答过的那格不再问（按档案判断，不靠游标）')

  // 判据从「五条活的话」改成「不同主题各一条」，D113 再把门槛降到三格。
  life.ingestProfile(['在做｜写代码'])
  ok(!life.bootstrapDone(), '两格还不够（门槛三个主题）')
  life.ingestProfile(['红线｜别提家里的事'])
  ok(life.bootstrapDone(), '三格且含「称呼」→ 算走完（D113 的 5 → 3）')

  const bsDone = life.buildSystemPrompt()
  ok(!life.bootstrapPending(), '走完的当轮就把文件删了（retireBootstrapIfDone）')
  ok(life.ritualState().pending === false, '仪式状态同步成「已走完」—— 界面靠它放过场')

  life.ensureLife()
  ok(!life.bootstrapPending(), '重启也不会再种回来')

  const bsRoot2 = path.join(TMP, 'bs-manual')
  fs.rmSync(bsRoot2, { recursive: true, force: true })
  process.env.HUNDUN_LIFE_DIR = bsRoot2
  life.ensureLife()
  ok(life.bootstrapPending(), '再开一个新目录，仪式又会出现')
  fs.unlinkSync(path.join(life.lifeDir(), 'BOOTSTRAP.md'))
  life.ensureLife()
  ok(!life.bootstrapPending(), '他手动删掉就等于「别再问了」，重启不补种')
  ok(
    !life.buildSystemPrompt().includes('BOOTSTRAP.md（第一次见他'),
    '删掉之后提示词里也没有它'
  )

  process.env.HUNDUN_LIFE_DIR = bsPrev
}

/* ---------------- 3j. 用户档案：写要求，覆盖不追加（D079） ---------------- */
console.log('\n[3j] 用户档案：写要求，覆盖不追加')

{
  const profRoot = path.join(TMP, 'prof')
  fs.rmSync(profRoot, { recursive: true, force: true })
  const prev = process.env.HUNDUN_LIFE_DIR
  process.env.HUNDUN_LIFE_DIR = profRoot
  life.ensureLife()

  const read = () => fs.readFileSync(path.join(life.lifeDir(), 'USER.md'), 'utf8')

  ok(life.isProfileEmpty(), '新建的档案是空的')

  life.ingestProfile(['称呼｜叫他老吴'])
  ok(/## 关于他[\s\S]*叫他老吴/.test(read()), '事实（称呼）进「关于他」')
  ok(read().includes('[称呼]'), '条目带着主题标记，下次好覆盖')
  ok(!life.isProfileEmpty(), '记下一条就不再算空档案')

  life.ingestProfile(['回答长度｜别超过三句'])
  ok(/## 要求[\s\S]*别超过三句/.test(read()), '要求进「要求」那一节')
  ok(/<!--\s*observed: \d{4}-\d{2}-\d{2} \| status: active -->/.test(read()), '带观察日期和活跃状态')

  // 一字不差：从上下文里读到的内容不许再记一遍（召回防回环）
  const dup = life.ingestProfile(['回答长度｜别超过三句'])
  ok(/跳过/.test(dup[0]), '一字不差的直接跳过')
  ok((read().match(/别超过三句/g) || []).length === 1, '文件里只有一份，没有复读')

  // 同主题改主意：旧的标 superseded，新的接在后面，**不是并列两条 active**
  const chg = life.ingestProfile(['回答长度｜可以长一点'])
  ok(/改/.test(chg[0]), '同主题当作「他改主意了」')
  const after = read()
  ok(
    /status: superseded[\s\S]*别超过三句[\s\S]*status: active[\s\S]*可以长一点/.test(after),
    '旧的标 superseded、新的紧随其后 active'
  )
  ok((after.match(/status: active/g) || []).length === 2, '同一主题只剩一条 active')
  ok(after.includes('别超过三句'), '旧条目没被删，看得见他是怎么变的')

  // 带新细节的重述不能被当成重复丢掉。
  // 这里踩过：相似度分母取「较小那条」，短句是长句前缀时恒等于 1，
  // 于是「别用emoji表情」被当成「别用 emoji」的复读直接扔了。
  life.ingestProfile(['别用 emoji'])
  life.ingestProfile(['别用emoji表情'])
  const em = read()
  ok(em.includes('别用 emoji') && em.includes('别用emoji表情'), '加了细节的重述要留下，不能当重复丢掉')

  // 长期记忆同样防回环
  life.appendLongterm(['每天 22 点后进入状态'])
  const memBefore = fs.readFileSync(path.join(life.lifeDir(), 'MEMORY.md'), 'utf8')
  life.appendLongterm(['每天 22 点后进入状态'])
  const memAfter = fs.readFileSync(path.join(life.lifeDir(), 'MEMORY.md'), 'utf8')
  ok(memBefore === memAfter, 'MEMORY.md 同一句话不会写两遍')
  ok((memAfter.match(/每天 22 点后进入状态/g) || []).length === 1, '长期记忆里也只留下一份')

  // 它自己开口那一轮，一个字都不许记（session-kind gating）
  const beforeChat = fs.existsSync(path.join(life.lifeDir(), 'memory', life.dateStr() + '.md'))
    ? fs.readFileSync(path.join(life.lifeDir(), 'memory', life.dateStr() + '.md'), 'utf8')
    : ''
  const schedWrite = conversation.persistNotes(
    [{ target: 'memory', lines: ['我编的一句话，他根本没说过'] }],
    { provenance: 'scheduler' }
  )
  const afterChat = fs.existsSync(path.join(life.lifeDir(), 'memory', life.dateStr() + '.md'))
    ? fs.readFileSync(path.join(life.lifeDir(), 'memory', life.dateStr() + '.md'), 'utf8')
    : ''
  ok(schedWrite.length === 0, '调度器发起的那轮不写任何记忆')
  ok(!afterChat.includes('我编的一句话'), '日记里没有它自己编的内容')

  const userWrite = conversation.persistNotes(
    [{ target: 'memory', lines: ['他说今天很累'] }],
    { provenance: 'user' }
  )
  ok(userWrite.length > 0, '他说的话照常记')
  ok(
    fs.readFileSync(path.join(life.lifeDir(), 'memory', life.dateStr() + '.md'), 'utf8').includes('他说今天很累'),
    '这一条真的落进了日记'
  )

  process.env.HUNDUN_LIFE_DIR = prev
}

/* 老模板升级：只动还空着的那份 */
{
  const oldRoot = path.join(TMP, 'prof-old')
  fs.rmSync(oldRoot, { recursive: true, force: true })
  const prev = process.env.HUNDUN_LIFE_DIR
  process.env.HUNDUN_LIFE_DIR = oldRoot
  life.ensureLife()
  const up = path.join(life.lifeDir(), 'USER.md')

  fs.writeFileSync(
    up,
    '# USER.md — 关于你\n\n## 你是谁\n（待访谈）\n\n## 你的作息\n（待访谈）\n\n## 访谈实录\n',
    'utf8'
  )
  life.ensureLife()
  ok(fs.readFileSync(up, 'utf8').includes('## 关于他'), '空着的老档案自动升成新结构')

  fs.writeFileSync(up, '# USER.md — 关于你\n\n## 你是谁\n老吴，做后端的\n\n## 访谈实录\n', 'utf8')
  life.ensureLife()
  const kept = fs.readFileSync(up, 'utf8')
  ok(kept.includes('老吴，做后端的'), '已经写了东西的老档案原样保留')
  ok(!kept.includes('## 关于他'), '有内容的不硬转，免得把他写的话揉坏')

  process.env.HUNDUN_LIFE_DIR = prev
}

/* ---------------- 3k. 记忆折叠（P1） ---------------- */
console.log('\n[3k] 记忆折叠：攒够几天才折，失败不推进')

{
  const dream = require(path.join(ROOT, 'src/main/dream.js'))
  const { plan, digest, pick } = dream

  // --- 挑哪几天（纯函数，把「今天是哪天」捏死） ---
  const NOW = new Date('2026-11-10T10:00:00')
  ok(plan(['2026-11-08'], null, NOW) === null, '只有一天不折，挑不出持久的')

  const three = plan(['2026-11-01', '2026-11-02', '2026-11-03'], null, NOW)
  ok(three && three.days.length === 3, '攒够三天就折')
  ok(three.from === '2026-11-01' && three.to === '2026-11-03', '折的区间是首尾两天')

  ok(plan(['2026-11-08', '2026-11-09'], null, NOW) === null, '今天和昨天不折（它们本来就在上下文里）')

  const after = plan(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'], '2026-11-02', NOW)
  ok(after === null, '上次折到 11-02，之后只剩两天，不够数就先不动')

  const many = plan(
    Array.from({ length: 20 }, (_, i) => '2026-10-' + String(i + 1).padStart(2, '0')),
    null,
    NOW
  )
  ok(many.days.length === dream.LIMITS.MAX_DAYS, '一次最多折七天，不一口气嚼三个月')
  ok(many.pending > many.days.length, '剩下的记在 pending 里，下次接着来')

  // --- 材料 ---
  const dg = digest([{ day: '2026-11-01', text: 'x'.repeat(200) }], 50)
  ok(dg.truncated, '材料太长会截断')
  ok(dg.text.length < 120, '截断后确实短了')

  // --- 解析 ---
  ok(
    JSON.stringify(pick('好的\n<longterm>\n- 他在做馄饨Agent\n</longterm>\n说完了')) ===
      JSON.stringify(['他在做馄饨Agent']),
    '只取 <longterm> 里的内容，正文一个字不要'
  )
  ok(pick('这几天没什么值得留的').length === 0, '没有块就是没有，不瞎猜')
  // prompt 里写着「最多 6 条」，原来代码里根本没兜（LIMITS.MAX_ITEMS 是 undefined，
  // slice(0, undefined) 等于不截断），一次折叠塞多少条全看模型心情。
  ok(
    pick('<longterm>\n' + Array.from({ length: 9 }, (_, i) => '- 第' + i + '条').join('\n') + '\n</longterm>')
      .length === dream.LIMITS.MAX_ITEMS,
    '最多几条由代码兜住，不是 prompt 里的一句请求',
    String(dream.LIMITS.MAX_ITEMS)
  )

  // --- 全链路 ---
  const dr = path.join(TMP, 'dream')
  fs.rmSync(dr, { recursive: true, force: true })
  const prev = process.env.HUNDUN_LIFE_DIR
  process.env.HUNDUN_LIFE_DIR = dr
  life.ensureLife()

  for (const day of ['2026-11-01', '2026-11-02', '2026-11-03']) {
    fs.writeFileSync(
      path.join(life.lifeDir(), 'memory', day + '.md'),
      '# ' + day + '\n\n### 记录\n- 他在做馄饨Agent，卡在调度器\n- 今天很累\n',
      'utf8'
    )
  }

  let asked = 0
  let lastPrompt = ''
  const d1 = dream.create({
    chat: async ({ messages }) => {
      asked++
      lastPrompt = messages[messages.length - 1].content
      return { text: '<longterm>\n- 他在做馄饨Agent，长期在做\n</longterm>' }
    },
    now: () => new Date('2026-11-05T10:00:00'),
    log: () => {}
  })

  const r1 = await d1.run(true)
  ok(r1.items.length === 1, '折出 1 条')
  ok(life.readSafe('MEMORY.md', 99999).includes('馄饨Agent'), '提炼的东西进了 MEMORY.md')
  ok(dream.readState().lastDay === '2026-11-03', '进度推到这批的最后一天')
  ok(lastPrompt.includes('=== 2026-11-01 ==='), '喂进去的材料按天分段')
  ok(lastPrompt.includes('已有记忆'), '带着已有记忆，让它别重复')
  ok(lastPrompt.includes('不要挑') && lastPrompt.includes('当天的情绪'), '提示词里写死了「情绪不算记忆」')
  ok(!('text' in r1), '折叠的结果里没有一句话 —— 它不会借机开口')

  const r2 = await d1.run(true)
  ok(r2.skipped === 'not-enough', '刚折完不会马上再折一遍')
  ok(asked === 1, '第二次没有白调一次模型')

  // 空回复：推进，但不写
  const dr2 = path.join(TMP, 'dream-empty')
  fs.rmSync(dr2, { recursive: true, force: true })
  process.env.HUNDUN_LIFE_DIR = dr2
  life.ensureLife()
  for (const day of ['2026-11-04', '2026-11-05', '2026-11-06']) {
    fs.writeFileSync(path.join(life.lifeDir(), 'memory', day + '.md'), '- 今天很累\n', 'utf8')
  }
  const d2 = dream.create({
    chat: async () => ({ text: '   ' }),
    now: () => new Date('2026-11-08T10:00:00'),
    log: () => {}
  })
  const r3 = await d2.run(true)
  ok(r3.empty === true, '模型一个字不说，当作「没有值得留的」')
  ok(dream.readState().lastDay === '2026-11-06', '这种情况也要推进 —— 否则这一天成了路障，后面全堵着')

  // 抛错：不推进
  const dr3 = path.join(TMP, 'dream-err')
  fs.rmSync(dr3, { recursive: true, force: true })
  process.env.HUNDUN_LIFE_DIR = dr3
  life.ensureLife()
  for (const day of ['2026-11-01', '2026-11-02', '2026-11-03']) {
    fs.writeFileSync(path.join(life.lifeDir(), 'memory', day + '.md'), '- 有内容\n', 'utf8')
  }
  const d3 = dream.create({
    chat: async () => {
      throw new Error('net::ERR_INVALID_ARGUMENT')
    },
    now: () => new Date('2026-11-05T10:00:00'),
    log: () => {}
  })
  const r4 = await d3.run(true)
  ok(/ERR_INVALID_ARGUMENT/.test(r4.error || ''), '调用失败会记下来')
  ok(!dream.readState().lastDay, '失败不推进进度，下次重来（不写半截）')

  // 他正在等一句话时不抢网络
  const d4 = dream.create({
    chat: async () => ({ text: '<longterm>\n- x\n</longterm>' }),
    isBusy: () => true,
    now: () => new Date('2026-11-05T10:00:00')
  })
  ok((await d4.run()).skipped === 'chatting', '有对话在生成时不插队')
  ok((await d4.run(true)).items, '强制跑时不受影响（测试和手动触发用）')

  process.env.HUNDUN_LIFE_DIR = prev
}

console.log('\n[3l] 没合上的话：只有一天窗口，问完即消失')

{
  const sched = require(path.join(ROOT, 'src/main/schedule.js'))
  const { parseBlocks, groupNotes } = require(path.join(ROOT, 'src/main/blocks.js'))

  // --- 块协议：它不能混进日记 ---
  // 混进去的后果很具体：那句话被写成一行日记，而日记只写不读（D028），
  // 于是第二天没人问起 —— 不报错、不崩，只是从此不再提这件事。
  const pb = parseBlocks('好的，那就先这样<open>\n- 话题 | 方案他说再想想\n</open>')
  ok(groupNotes(pb.notes).open.length === 1, '<open> 进了自己的桶，没混进日记')
  ok(pb.clean === '好的，那就先这样', '<open> 不会漏到界面上')

  const prev = process.env.HUNDUN_LIFE_DIR
  const dir = path.join(TMP, 'open-p14')
  fs.rmSync(dir, { recursive: true, force: true })
  process.env.HUNDUN_LIFE_DIR = dir
  life.ensureLife()

  const openFile = path.join(life.lifeDir(), 'OPEN.md')
  ok(fs.existsSync(openFile), 'OPEN.md 和别的种子文件一起种出来')
  ok(fs.readFileSync(openFile, 'utf8').includes('## 没合上的'), '模板里有表，他手改也看得懂')

  // --- 写入的三条判据 ---
  life.ingestOpens(['话题 | 方案他说再想想'])
  const rows = life.listOpens()
  ok(rows.length === 1 && rows[0].kind === '话题', '话题落盘')
  ok(/^\d{4}-\d{2}-\d{2}$/.test(rows[0].date), '记的时候带上当天日期（窗口靠它算）')

  life.ingestOpens(['话题 | 方案他说再想想'])
  ok(life.listOpens().length === 1, '同一件事说两遍只记一条 —— 否则第二天会连着问两次')

  life.ingestOpens(['瞎写 | 随便'])
  ok(life.listOpens().length === 1, '类型认不出来就丢：猜成话题会把它当成轻松的事去问')

  life.ingestOpens(['状态 | 他说最近睡不着'])
  const withState = life.listOpens()
  ok(withState.length === 2 && withState.some((o) => o.kind === '状态'), '状态单独一条')

  // 表格写坏了没有：markdown 表格中间多一个空行就断开，他打开看到的是三行散字
  const body = fs.readFileSync(openFile, 'utf8')
  ok(/\| --- \| --- \| --- \|\n\| /.test(body), '写入时不会在分隔行和数据行之间留空行（表格不断开）')

  // --- 窗口：只接昨天 ---
  fs.rmSync(dir, { recursive: true, force: true })
  process.env.HUNDUN_LIFE_DIR = dir
  life.ensureLife()
  life.addOpen({ kind: '状态', what: '他说最近睡不着', date: '2026-11-04' })
  life.addOpen({ kind: '话题', what: '方案他说再想想', date: '2026-11-04' })
  life.addOpen({ kind: '话题', what: '今天刚说的', date: '2026-11-05' })
  life.addOpen({ kind: '状态', what: '三天前的', date: '2026-11-03' })

  const NOW = new Date('2026-11-05T10:00:00')
  const CFG = {
    disturb: { on: true, windows: [{ from: '08:00', to: '23:00' }], dailyLimit: 2 },
    quietDate: ''
  }
  const judgeNow = (extra = {}) =>
    sched.judge({
      now: NOW,
      cfg: CFG,
      items: life.listCommitments(),
      opens: life.listOpens(),
      sentToday: 0,
      ...extra
    })

  const d1 = judgeNow()
  ok(d1.fire && d1.source === 'open', '昨天没合上的话，今天成为候选')
  ok(d1.kind === 'state', '一天只问一件时先问人（状态），后问事（话题）')

  const dropOne = (kind, date) => {
    // 每次删完行号都会前移，所以要重新读一次
    const o = life.listOpens().find((x) => x.kind === kind && x.date === date)
    if (o) life.removeOpenAt(o.line)
  }
  dropOne('状态', '2026-11-04')
  const d2 = judgeNow()
  ok(d2.kind === 'topic', '状态没了就问话题')

  // --- 话题排在约定的前面 ---
  life.addCommitment({ what: '交周报', due: '2026-11-05', pinned: true })
  const d3 = judgeNow()
  ok(d3.source === 'open', '昨天的话题排在今天到期的约定（哪怕 pinned）前面：它只有今天能问，约定明天还能问')

  dropOne('话题', '2026-11-04')
  const d4 = judgeNow()
  ok(d4.fire && d4.source === 'commit', '没合上的话问完了，才轮到约定')

  // --- 今天记的不选，前天的作废 ---
  const d5 = sched.judge({ now: NOW, cfg: CFG, items: [], opens: life.listOpens() })
  ok(!d5.fire, '只剩今天记的那些时，什么都不说 —— 它们是给明天留的')

  ok(life.pruneOpens('2026-11-05') === 1, '过窗口的只清一条（前天那条）')
  ok(!life.listOpens().some((o) => o.date === '2026-11-03'), '前天的不补问，直接作废')
  ok(life.listOpens().some((o) => o.date === '2026-11-05'), '今天的留着，明天才轮到它')

  // --- 措辞：两个最容易滑坡的地方 ---
  const pt = sched.promptFor({ kind: 'topic', item: { what: '方案他说再想想' } })
  ok(pt.includes('不要复述他说过的话'), '话题的指令要求不要复述 —— 复述就变成记账')
  ok(pt.includes('不要说「昨天你说过」'), '话题明确禁止「昨天你说」这种开场')
  ok(pt.includes('问完就停'), '话题只问一句')

  const ps = sched.promptFor({ kind: 'state', item: { what: '他说最近睡不着' } })
  ok(ps.includes('比昨天好点了吗'), '状态明确禁止让他给自己打分（F06-2 ③ 第 3 条）')
  ok(ps.includes('不要给建议'), '状态明确禁止分析原因、给建议')
  ok(ps.includes('就到这儿'), '他说「好多了」就闭合，不再追')

  // --- 送到才算问过 ---
  const dUnit = path.join(TMP, 'open-mark')
  fs.rmSync(dUnit, { recursive: true, force: true })
  process.env.HUNDUN_LIFE_DIR = dUnit
  life.ensureLife()
  life.addOpen({ kind: '状态', what: '他说最近睡不着', date: '2026-11-04' })
  const pick = () => ({ source: 'open', kind: 'state', item: life.listOpens()[0] })

  ok(sched.mark(pick(), false) === 'pending', '没送到什么都不标（当天后面几轮还能再试）')
  ok(life.listOpens().length === 1, '没送到的那条留着')
  ok(sched.mark(pick(), true) === 'delivered', '送到了')
  ok(life.listOpens().length === 0, '送到就删 —— 「一条状态只问一次」全靠这个')

  // 行被他删掉时：不能照着旧行号删 —— 那会吃掉他刚写的那句话
  ok(
    sched.mark({ source: 'open', kind: 'topic', item: { line: 999, what: '根本不存在的话' } }, true) ===
      'skipped',
    '行对不上就跳过，不误删别的行'
  )
  life.addOpen({ kind: '话题', what: '这句话还在', date: '2026-11-04' })
  const shifted = life.listOpens()[0]
  ok(
    life.removeOpenAt(shifted.line + 5, shifted.what) === true,
    '行号错位时按内容兜底找到它（他会手动改这个文件）'
  )

  process.env.HUNDUN_LIFE_DIR = prev
}

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

/* ---------------- 4a. 等待态（D109） ---------------- */

console.log('\n[4a] 等待态：它还没开口的时候不是一片空白')

{
  // live.js 是渲染层的纯函数，不依赖 Vue／Electron，可以直接 import。
  // 路径要过 pathToFileURL：Windows 上 `e:` 这种盘符裸路径 ESM loader 不认。
  const live = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/live.js')).href)

  ok(live.isThinking({ live: true, content: '' }), '刚发出去、还没有字的时候算「在想」')
  ok(live.isThinking({ live: true, content: ' \n\t ' }), '只有空白也算「在想」——空白和没有一样')
  ok(!live.isThinking({ live: true, content: '嗯。' }), '第一个字到了就不再显示「在想」')
  ok(
    !live.isThinking({ live: false, content: '' }),
    '已收尾的空消息不显示「在想」——那是要被删掉的，不是等待'
  )
  ok(!live.isThinking(null) && !live.isThinking(undefined), '没有这条消息时不抛错')

  const think = live.liveHtml({ live: true, content: '' })
  ok(think.includes('在想'), '等待态渲染出「在想」', think)
  ok(think.includes('class="thinking"'), '等待态有专门的类名，样式挂得上', think)
  ok(!think.includes('caret'), '等待态不挂光标——一根光标停在空行里更像卡死')

  const first = live.liveHtml({ live: true, content: '我在。' })
  ok(first.includes('我在。') && first.includes('caret'), '开始说话后回到正常文本 + 光标', first)

  const done = live.liveHtml({ live: false, content: '**嗯**。' })
  ok(
    done.includes('<strong>嗯</strong>') && !done.includes('caret'),
    '收尾后走 markdown，且没有光标',
    done
  )
}

/* ---------------- 4b. 仪式过场的节奏 ---------------- */

console.log('\n[4b] 仪式过场：他要的那几个停顿')

{
  // 同样抽成纯函数再测：时序写在 .vue 里就没有断言守得住。
  const ce = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/ceremony.js')).href)

  const LINES = ['你好 芜柒', '我是馄饨 幸会', '希望这里 能短暂的温暖你']
  const steps = ce.ceremonySteps(LINES)
  const waitAt = (line, text) => {
    const s = steps.find((x) => x.line === line && x.text === text)
    return s ? s.wait : -1
  }

  ok(waitAt(0, '你好 ') === 700, '「你好」之后那个空格停 0.7 秒')
  ok(waitAt(0, '你好 芜柒') === 1000, '第一行整行打完停 1 秒')
  ok(waitAt(1, '我是馄饨 ') === 700, '「我是馄饨」之后那个空格停 0.7 秒')
  ok(waitAt(1, '我是馄饨 幸会') === 1000, '第二行整行打完停 1 秒')
  ok(waitAt(2, '希望这里 ') === 500, '「希望这里」之后那个空格停 0.5 秒')

  const tail = steps[steps.length - 1]
  ok(tail.text === null && tail.wait === 5000, '最后那句打完之后停 5 秒才收场')
  ok(waitAt(2, '希望这里 能短暂的温暖你') === 0, '最后一行不另加行停顿——它接的就是那 5 秒')

  ok(
    ce.CHAR_MS === 130 && ce.ceremonySteps(['你好'])[0].wait === 130,
    '字与字之间 130ms（原来 86，他说慢一点）'
  )

  const total = steps.reduce((n, s) => n + s.wait, 0)
  ok(total > 10000, '整段铺到十秒以上，不是一眨眼', total + 'ms')

  // 没有称呼时第一行短了两个字，后面的停顿不能跟着错位
  const noName = ce.ceremonySteps(['你好', '我是馄饨 幸会', '希望这里 能短暂的温暖你'])
  ok(
    noName.find((x) => x.text === '我是馄饨 ')?.wait === 700,
    '第一行短了，第二行的停顿不往前移'
  )

  // D117：断句靠空格，不靠标点。整段输出里不该出现任何标点字符
  const allTyped = steps.filter((s) => s.text !== null).map((s) => s.text.slice(-1))
  ok(!allTyped.some((ch) => '，。、,.'.includes(ch)), '打出来的字里一个标点都没有')
  ok(ce.ceremonySteps(['我们是朋友']).length === 6, '没有空格的一行就只是五个字 + 收场那一步')

  ok(ce.ceremonySteps([]).length === 0, '没有文案就一步都不走')
  ok(ce.ceremonySteps([null, '', '在']).length === 2, '空行不计入（一个字 + 收场那一步）')
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

/* ---------------- 3m. 老目录补仪式 + 老 SOUL 升级 ---------------- */
console.log('\n[3m] 老目录补仪式：D078 之前建的目录也能问一次')

{
  const prev = process.env.HUNDUN_LIFE_DIR

  // 造一个「D078 之前就存在」的目录：种子文件都在，唯独没有 BOOTSTRAP.md、没有标记
  const oldRoot = path.join(TMP, 'oldlife')
  fs.rmSync(oldRoot, { recursive: true, force: true })
  process.env.HUNDUN_LIFE_DIR = oldRoot
  life.ensureLife()
  fs.unlinkSync(path.join(life.lifeDir(), 'BOOTSTRAP.md'))
  fs.rmSync(path.join(life.lifeDir(), '.bootstrap'), { force: true })
  ok(!life.bootstrapPending(), '前提：这是没有仪式的老目录')

  life.ensureLife()
  ok(life.bootstrapPending(), '老目录 + 空档案 → 补种一次仪式（今天没被问的成因就是这个）')
  ok(
    life.buildPrompt().includes('判定器') && life.ritualSlot().key === '称呼',
    '补种的仪式当轮就进去了：判定器 + 第一格是「称呼」'
  )

  // 他删掉 = 别再问了。标记记着「这件事决定过」，所以重启也不补
  fs.unlinkSync(path.join(life.lifeDir(), 'BOOTSTRAP.md'))
  life.ensureLife()
  ok(!life.bootstrapPending(), '删掉之后不再补种（靠标记，不靠目录新旧）')

  // 档案里已经有他：不种仪式，只落标记
  const knownRoot = path.join(TMP, 'oldknown')
  fs.rmSync(knownRoot, { recursive: true, force: true })
  process.env.HUNDUN_LIFE_DIR = knownRoot
  life.ensureLife()
  fs.unlinkSync(path.join(life.lifeDir(), 'BOOTSTRAP.md'))
  fs.rmSync(path.join(life.lifeDir(), '.bootstrap'), { force: true })
  life.ingestProfile(['称呼｜叫他老吴'])
  life.ensureLife()
  ok(!life.bootstrapPending(), '档案里已经有他 → 不补仪式（早就认识的人不必再走一遍）')
  ok(fs.existsSync(path.join(life.lifeDir(), '.bootstrap')), '但落一次标记，不用每轮重判')

  // 老 SOUL → 新 SOUL：只动他没改过的那份（逐字等于历史出厂版才升级）
  const soulPath = path.join(life.lifeDir(), 'SOUL.md')
  fs.writeFileSync(soulPath, life.SOUL_HISTORY[0], 'utf8')
  life.ensureLife()
  const soul = fs.readFileSync(soulPath, 'utf8')
  // D108：判断力移出人格文件，SOUL 里不再有「理性内核」那一节。
  // 升级判据没变（逐字等于某个历史出厂版才换），断言值保留，名字改准。
  ok(soul.includes('外面这层'), '老 SOUL 升级到当前出厂版（D108 后「理性」不再是人格里的一节）')
  ok(soul.includes('不要翻旧账'), '带着「不数落他重复」这条（那句「你第三遍了」的反面）')
  // 判据从「结论不能软」改成「事实判断」：D093 把「不附和」限定到事实层了，
  // 自我评价不辩论（那是他的感受，不是命题）。D108 又把这条从「理性层」搬进了
  // 「这一轮先做哪件」，判据（这两个词在不在）不变，它改的是**落点**。
  ok(soul.includes('事实判断'), '「事实判断不附和／自我评价不辩论」没丢（D108 移到情形节）')

  life.ensureLife()
  ok(
    (fs.readFileSync(soulPath, 'utf8').match(/外面这层/g) || []).length === 1,
    '再跑一遍不会换第二次（幂等）'
  )

  // 上一个中间版本也要能升上来
  fs.writeFileSync(soulPath, life.SOUL_HISTORY[1], 'utf8')
  life.ensureLife()
  ok(
    fs.readFileSync(soulPath, 'utf8').includes('情绪要给对地方'),
    '中间版本（V2）也能升到当前版'
  )

  fs.writeFileSync(soulPath, '# 我的 SOUL\n\n## 改写记录\n（我自己改过）\n', 'utf8')
  life.ensureLife()
  ok(!fs.readFileSync(soulPath, 'utf8').includes('外面这层'), '他改过 SOUL → 一个字都不碰')

  // 他在正文里加了一句但没记改写记录：不是出厂样式，也不许覆盖
  fs.writeFileSync(soulPath, life.SOUL_HISTORY[0] + '\n- 我加的一行\n', 'utf8')
  life.ensureLife()
  ok(
    fs.readFileSync(soulPath, 'utf8').includes('我加的一行'),
    '手改过但忘了记录 → 也不覆盖（不做模糊匹配）'
  )

  // D108：老 BOOTSTRAP 也要能升上来。它比 SOUL 更隐蔽——模板只在**没有文件时**种一次，
  // 已经种过的机器上那份永远不会被替换，所以改了开场文案、重启了窗口，他看到的还是旧的。
  const bootPath = path.join(life.lifeDir(), 'BOOTSTRAP.md')
  fs.writeFileSync(bootPath, life.TPL_BOOTSTRAP_V1, 'utf8')
  life.ensureLife()
  ok(
    fs.readFileSync(bootPath, 'utf8').trim() === life.TPL_BOOTSTRAP.trim(),
    '老 BOOTSTRAP 升到当前版（否则改了开场文案，存量机器看不到）'
  )
  fs.writeFileSync(bootPath, life.TPL_BOOTSTRAP_V1 + '\n- 我自己加的一格\n', 'utf8')
  life.ensureLife()
  ok(
    fs.readFileSync(bootPath, 'utf8').includes('我自己加的一格'),
    '他在仪式里写过字 → 不覆盖（那是他的仪式）'
  )

  process.env.HUNDUN_LIFE_DIR = prev
}

console.log('\n[3n] 提示词骨架照 openclaw：段落顺序与文件次序')

{
  const prev = process.env.HUNDUN_LIFE_DIR
  const root = path.join(TMP, 'skel')
  process.env.HUNDUN_LIFE_DIR = root
  fs.rmSync(root, { recursive: true, force: true })
  life.ensureLife()

  const p = life.buildSystemPrompt()
  // D112 之后仪式是一整个**独立程序**，所以骨架分成两份验：
  // `p` 是主程序（馄饨），`rp` 是仪式期那个安装程序。混在一起验，
  // 一份缺段就会误报成另一份的错。
  const rp = life.buildRitualPrompt()
  const at = (s) => p.indexOf(s)
  const atR = (s) => rp.indexOf(s)
  const order = (a, b, label) => ok(at(a) >= 0 && at(b) >= 0 && at(a) < at(b), label)
  const orderR = (a, b, label) => ok(atR(a) >= 0 && atR(b) >= 0 && atR(a) < atR(b), label)

  // 段与段的顺序（照 src/agents/system-prompt.ts 的组装顺序）
  order('## Interaction Style', '## Execution Bias', 'Interaction Style 在 Execution Bias 之前')
  order('## Execution Bias', '## Promised Work', 'Execution Bias 在 Promised Work 之前')
  order('## Promised Work', '## Runtime Context', 'Promised Work 在 Runtime Context 之前')
  order('## Runtime Context', '## 他（你手上关于他的全部）', 'Runtime Context 在「他」之前')
  order('## 他（你手上关于他的全部）', '# Project Context', '「他」在 Project Context 之前')
  order('# Project Context', '## Care', 'Project Context 在 Care 之前')
  order('## Care', '## Memory（记忆规则）', 'Care 在记忆规则之前')
  order('## Memory（记忆规则）', '## Output（输出规则）', '记忆规则在输出规则之前')

  // 文件次序（照 openclaw 的 CONTEXT_FILE_ORDER：soul 20 / identity 30 / user 40 / memory 70）
  order('## AGENTS.md（这个窗口是干什么的）', '## SOUL.md（你是谁', 'AGENTS 在 SOUL 之前（先有目的，再有人格）')
  order('## SOUL.md（你是谁', '## IDENTITY.md', 'SOUL 在 IDENTITY 之前')
  order('## IDENTITY.md', '## USER.md（关于他）', 'IDENTITY 在 USER 之前')
  order('## USER.md（关于他）', '## MEMORY.md（长期记忆）', 'USER 在 MEMORY 之前')

  // 主程序里一个字都不许提仪式（D112 的硬分叉判据）
  ok(!p.includes('## Bootstrap Pending'), '主程序提示词里没有 Bootstrap Pending（仪式是另一个程序）')
  ok(!p.includes('## BOOTSTRAP.md（照上面那节走）'), '主程序也不注入 BOOTSTRAP.md 全文')

  // 仪式那一份现在没有「段落顺序」这回事了（D115）：它是一份判定器，
  // 只有这一格、已记下的、三种标记。可见的话全在 RITUAL_SLOTS 里。
  const keys = life.RITUAL_SLOTS.map((s) => s.key).join('、')
  ok(keys === '称呼、在做、愿望、红线', '固定四格，顺序就是优先级（称呼必须先问，D122 加了愿望）', keys)
  ok(
    life.RITUAL_SLOTS[0].skippable === false && life.RITUAL_SLOTS.slice(1).every((s) => s.skippable),
    '只有称呼不能跳——其余三格他都有说「跳过」的权利'
  )
  ok(
    life.RITUAL_SLOTS.every((s) => s.ask && s.recorded && s.label && s.hint && s.req),
    '每一格的问话、回执、标签、判据都齐——缺一样，那一轮就会说到一半没词'
  )
  ok(rp.length < 1200, '判定器提示词很短 —— 仪式不再注入 BOOTSTRAP.md 全文', String(rp.length))
  // 它就是「另一个人」：人格层一样都不带给它（他原话「另一个 agent」）
  ok(!rp.includes('## Interaction Style'), '仪式程序没有人格层（Interaction Style）')
  ok(!rp.includes('## SOUL.md（你是谁'), '仪式程序不注入 SOUL.md')
  ok(!rp.includes('## Execution Bias'), '仪式程序没有行动偏向段')
  ok(rp.includes('判定器'), '仪式程序第一句就说清自己只做判定')
  ok(rp.includes('不会显示给人看'), '它知道自己的字不会出现在界面上 —— 这条不写，它会开始说话')

  // 搬过来的判据要在，不是只搬了标题
  ok(p.includes('温暖、合作、安静地支持他'), 'Interaction Style 搬了「安静地支持」')
  ok(p.includes('不演、不黏人'), 'Interaction Style 搬了「不许演过头」（D103 压缩版）')
  ok(p.includes('不编身体感受和私生活'), 'Interaction Style 搬了「不编身体感受与私生活」（D103 压缩版）')
  ok(p.includes('不要先问「要不要我帮你分析一下」'), 'Execution Bias 搬了「能答就答，别先问许可」')
  ok(p.includes('「在做了」不是做完了'), 'Promised Work 搬了「过程不是结论」')
  ok(p.includes('到点自己回来说结果'), 'Promised Work 和调度器对上了（承诺过的事自己回来）')
  ok(p.includes('不念文件名，不提路径'), 'Care 搬了「别把内部结构暴露给他」')

  // 实测踩到的：模型回了「芜柒。记住了。」但 USER.md 一个字没加。
  // D115 之后这件事不再靠模型自觉：它只输出 <slot>，写档案由代码调 ingestProfile 做 ——
  // 「说记住了」和「真写进去」之间没有它插话的地方。
  ok(p.includes('说「记住了」不算记'), '记忆规则里仍有这条判据（主程序说话时）')
  ok(!rp.includes('<profile>'), '判定器不被要求写块（写档案是代码的事，少一个会错的环节）')

  // 截断必须说出来：不说的截断 = 模型以为自己看全了
  const memPath = path.join(life.lifeDir(), 'MEMORY.md')
  fs.writeFileSync(memPath, '# MEMORY.md\n\n' + '旧事一行。\n'.repeat(2000), 'utf8')
  const cutP = life.buildSystemPrompt()
  ok(cutP.includes('只加载了开头'), 'MEMORY.md 超长时，提示词里明说「后面你看不到」')
  ok(cutP.includes('不要补全，也不要假装记得'), '截断提示带上了「当不知道」这条判据')

  // 仪式走完：Bootstrap Pending 消失，但骨架其余部分一个都不能少
  fs.writeFileSync(memPath, '# MEMORY.md\n\n（暂无）\n', 'utf8')
  fs.unlinkSync(path.join(life.lifeDir(), 'BOOTSTRAP.md'))
  fs.writeFileSync(path.join(life.lifeDir(), '.bootstrap'), 'skip 2026-11-05 测试', 'utf8')
  const after = life.buildSystemPrompt()
  ok(after.includes('## Interaction Style'), '仪式走完 → 语气层还在')
  ok(after.includes('## Execution Bias'), '仪式走完 → 行动偏向还在')
  ok(after.includes('## Care'), '仪式走完 → Care 还在')
  // 仪式那一份比主程序短得多：它没有人格层、没有行动偏向、没有承诺段、没有日记
  ok(rp.length < after.length, '仪式程序比主程序短（它只管问和记）')

  process.env.HUNDUN_LIFE_DIR = prev
}

console.log('\n[3p] 写入回执：说「记住了」不算，块落到盘上才算')

{
  const memgate = require(path.join(ROOT, 'src/main/memgate.js'))
  const prev = process.env.HUNDUN_LIFE_DIR
  const root = path.join(TMP, 'memgate')
  process.env.HUNDUN_LIFE_DIR = root
  fs.rmSync(root, { recursive: true, force: true })
  life.ensureLife()

  /* ---- 判据：什么时候该补 ---- */

  ok(memgate.claimsWrite('芜柒。记住了。'), '认得「记住了」')
  ok(memgate.claimsWrite('好，我记下了'), '认得「记下了」')
  ok(memgate.claimsWrite('这个我帮你记着'), '认得「帮你记着」')
  ok(!memgate.claimsWrite('我记得你说过那个接口'), '「我记得你说过」是回忆，不是承诺 —— 不能算')
  ok(!memgate.claimsWrite('芜柒，好名字。你平时忙什么？'), '没提记不记，不算')

  const nr = (o) => memgate.needsRepair(o)
  const base = { userText: '您好 我是芜柒', assistantText: '芜柒。记住了。', notes: [] }

  ok(nr(base).reason === 'claimed-not-written', '说了记却没块 → 要补（那次实测就是这一条）')
  ok(nr({ ...base, notes: [{ target: 'profile', lines: ['[称呼] 叫他芜柒'] }] }) === null, '已经有块 → 不补')
  ok(nr({ ...base, provenance: 'scheduler' }) === null, '它自己开口那轮 → 一个字都不补')
  ok(nr({ ...base, assistantText: '' }) === null, '空回复没什么可信 → 不补')

  // 仪式期间：即使它没说「记住了」，答了话就得进档案
  ok(
    nr({ userText: '程序员', assistantText: '写什么的？', notes: [], bootstrapPending: true }).reason ===
      'ritual-unrecorded',
    '仪式期间答了话却没进档案 → 也要补'
  )
  ok(
    nr({ userText: '嗨', assistantText: '嗨，我是馄饨。先问一句，怎么称呼你？', notes: [], bootstrapPending: true }) ===
      null,
    '第一次打开那句纯招呼 → 不去补（那不是一条事实）'
  )
  ok(memgate.looksLikeGreeting('嗨'), '纯招呼认出来了')
  ok(!memgate.looksLikeGreeting('我叫芜柒，写代码的'), '一句正经回答不算招呼')
  // D102 真机事故：length>12 被当成招呼拦掉，「又见面了…我是芜柒」19 字，
  // 称呼永远进不了档案。长度不是判据，正则才是。
  ok(!memgate.looksLikeGreeting('又见面了 不知道这是第几次了 我是芜柒'), '带称呼的长消息不算招呼（length 判据已废）')
  ok(!memgate.looksLikeGreeting('晚上十二点就倒下了 下午干活'), '一句平常的话不算招呼')
  // 抽取提示词：主题不许硬套示例（「你是最重要的」被记成 [称呼] 的教训）
  {
    const mg = memgate.buildPrompt({ userText: 'x', assistantText: 'y' })[0].content
    ok(mg.includes('不许把内容硬套进示例里的主题'), '抽取规矩：主题按内容起，不硬套')
    ok(mg.includes('别硬进 <profile>'), '抽取规矩：情绪话不进 profile')
  }

  /* ---- D123：日记补写（daily-unwritten）---- */

  // 探针事实：模型会写日记，但只在对话收尾那轮写。前面几轮一个字不写，
  // 一天聊十轮、他说了十件事，日记里只有收尾那两条 —— 密度起不来。
  const daily = { userText: '今天接了个外包，客户又改需求，烦死了', assistantText: '需求改来改去最烦。改的是哪块？', notes: [] }
  ok(
    nr({ ...daily, dailyDue: true }).reason === 'daily-unwritten',
    '说了件事、零块、到点了 → 补一趟日记'
  )
  ok(nr({ ...daily }) === null, '没到点（dailyDue 没给）→ 不补，节流归调用方管')
  ok(
    nr({ ...daily, dailyDue: true, notes: [{ target: 'memory', lines: ['他在赶外包'] }] }) === null,
    '模型自己写了块 → 不重复补'
  )
  ok(nr({ ...daily, dailyDue: true, userText: '嗯' }) === null, '纯应答不点补写的火')
  ok(nr({ ...daily, dailyDue: true, userText: '好的我知道了谢谢你啊' }) === null, '长一点的应答也不点（ACK 正则）')
  ok(
    nr({ ...daily, dailyDue: true, bootstrapPending: true }).reason === 'ritual-unrecorded',
    '仪式期走 ritual 那条，不叠成 daily（同一个理由不做两趟）'
  )

  {
    const dg = memgate.buildPrompt({ userText: 'x', assistantText: 'y', daily: true })[0].content
    ok(dg.includes('补几条日记'), '补日记那趟的语气换成了「补日记」')
    ok(dg.includes('日记可以写你的判断'), '日记允许写判断（挂在他说的话上）')
    ok(dg.includes('不许写性格定性'), '判断不许写成性格定性')
    ok(dg.includes('待办：'), '给了待办的写法')
    ok(!dg.includes('不写你的感受'), '抽事实那句「不写你的感受」不能出现在日记分支里——它会把判断一起掐死')
    ok(dg.includes('待办：'), '待办是给明天的自己留的')

    const og = memgate.buildPrompt({ userText: 'x', assistantText: 'y' })[0].content
    ok(og.includes('不写你的感受'), '不补日记时，抽事实那句原样还在')
  }

  /* ---- 结构校验：不过就整批不要 ---- */

  ok(memgate.validate('NOTHING').status === 'nothing', 'NOTHING → 没有可记的，不硬编')
  ok(memgate.validate('').status === 'empty', '空返回 → empty')
  ok(memgate.validate('好的，我明白了').status === 'no-blocks', '只说话不给块 → 不认')
  ok(
    memgate.validate('很好，我记下了。\n<profile>\n[称呼] 叫他芜柒\n</profile>').status === 'ok',
    '块加一小句过渡 → 认'
  )
  ok(
    memgate.validate(
      '<profile>\n[称呼] 叫他芜柒\n</profile>\n\n' +
        '另外我想说，你刚才提到写代码这件事其实挺重要的，因为长期作息不规律会影响身体，' +
        '建议你早点睡，别再熬夜了，身体才是本钱，别等到出了事才后悔。'
    ).status === 'chatty',
    '块外面还留着一大段话 → 它在聊天不是抽取，整批不要'
  )

  /* ---- 块没解析出来时，得能说出为什么 ---- */

  const { diagnose } = require(path.join(ROOT, 'src/main/blocks.js'))
  ok(diagnose('芜柒，记下了。你现在忙什么？') === null, '压根没写块 → 不报错（这是提示词的事，不是正则的事）')
  ok(diagnose('<profile>\n- 称呼｜叫他芜柒') === '<profile> 开了没闭合', '开了没闭合 → 说清楚')
  ok(diagnose('〈profile〉叫他芜柒〈/profile〉').includes('全角'), '全角尖括号 → 说清楚')
  ok(diagnose('<profile>\n- 称呼｜叫他芜柒\n</profile>') === null, '写对了就不吭声')

  /* ---- 补写：走的是同一条写入路径 ---- */

  const calls = []
  const written = []
  const gate = memgate.create({
    chat: async ({ messages }) => {
      calls.push(messages)
      return '<profile>\n[称呼] 叫他芜柒\n</profile>'
    },
    write: (notes) => {
      const r = life.ingestProfile(notes.filter((n) => n.target === 'profile').flatMap((n) => n.lines))
      written.push(...r)
      return r
    }
  })

  const r1 = await gate.repair({ userText: '您好 我是芜柒', assistantText: '芜柒。记住了。', reason: 'claimed-not-written' })
  ok(r1.status === 'written', '补写跑通了')
  ok(written.length === 1, '真的写进档案了（不是嘴上说）')
  const user = fs.readFileSync(path.join(life.lifeDir(), 'USER.md'), 'utf8')
  ok(user.includes('[称呼] 叫他芜柒'), 'USER.md 里有这一条')
  ok(!life.isProfileEmpty(), '补完之后档案不再是空的 —— 下次不会再问「怎么称呼你」')

  // 提示词里带上了现场：他说的话、它的回复、已有档案
  const last = calls[calls.length - 1]
  const userMsg = last[last.length - 1].content
  ok(userMsg.includes('您好 我是芜柒'), '补写提示词里带着他的原话')
  ok(userMsg.includes('芜柒。记住了。'), '补写提示词里带着它的回复')
  ok(userMsg.includes('别重复'), '补写提示词里带着「档案已有的别重复」')
  ok(last[0].content.includes('NOTHING'), '抽取指令允许它说「没有可记的」')

  // 说 NOTHING 就真的什么都不写
  const gate2 = memgate.create({ chat: async () => 'NOTHING', write: () => ['不该被调用'] })
  const r2 = await gate2.repair({ userText: '嗯', assistantText: '记住了。', reason: 'claimed-not-written' })
  ok(r2.status === 'nothing' && r2.written.length === 0, '它说没有可记的 → 一条都不写')

  // 调不通不能把已经说完的那轮搞坏
  const gate3 = memgate.create({
    chat: async () => {
      throw new Error('网络断了')
    },
    write: () => ['不该被调用']
  })
  const r3 = await gate3.repair({ userText: '我是芜柒', assistantText: '记住了。', reason: 'claimed-not-written' })
  ok(r3.status === 'error' && r3.detail === '网络断了', '补写失败不抛，只返回失败原因')
  ok(fs.readFileSync(path.join(life.lifeDir(), 'USER.md'), 'utf8').includes('[称呼] 叫他芜柒'), '失败不会把已写好的档案弄坏')

  // 降级：它承诺过记下来，补写却没成 → 原话进日记，不静默丢
  life.ensureJournal(life.dateStr())
  const jp = life.journalPath(life.dateStr())
  ok(!fs.readFileSync(jp, 'utf8').includes('我叫周野'), '日记里本来没有这句')
  const gate4 = memgate.create({
    chat: async () => 'NOTHING',
    write: () => []
  })
  await gate4.repair({ userText: '我叫周野，做物流的', assistantText: '记住了。', reason: 'claimed-not-written' })
  ok(fs.readFileSync(jp, 'utf8').includes('我叫周野'), '补写没成 → 原话降级进日记（append-only 退路）')

  // 身份换了就别落盘
  const gate5 = memgate.create({
    chat: async () => '<profile>\n[称呼] 叫他别人\n</profile>',
    write: () => ['USER.md（不该发生）']
  })
  const r5 = await gate5.repair({ userText: 'x', assistantText: '记住了', reason: 'claimed-not-written', guard: () => false })
  ok(r5.status === 'stale' && r5.written.length === 0, '补写期间换了身份 → 不落盘')

  process.env.HUNDUN_LIFE_DIR = prev
}

console.log('\n[3q] AGENTS.md：这个窗口为什么存在，排在最前')

{
  const prev = process.env.HUNDUN_LIFE_DIR
  const root = path.join(TMP, 'agents')
  process.env.HUNDUN_LIFE_DIR = root
  fs.rmSync(root, { recursive: true, force: true })
  life.ensureLife()

  // 用 life.lifeDir()，不要拼 root：ensureLayout 会把目录搬进 users/<u>/agents/<a>/
  const agPath = path.join(life.lifeDir(), 'AGENTS.md')
  ok(fs.existsSync(agPath), '第一次启动就种了 AGENTS.md')
  const ag = fs.readFileSync(agPath, 'utf8')

  /* ---- 内容：产品目的必须真的在里面 ---- */

  ok(ag.includes('他为什么来，为什么关'), '有「他为什么来」这一节')
  ok(ag.includes('安慰，或者方向'), '写清了关窗口时该带走什么')
  ok(ag.includes('比开窗口的时候好一点'), '有可执行的判断标准，不是口号')
  ok(ag.includes('不要拿废话填'), '给了「两样都给不了」时的出口')
  ok(ag.includes('先说「好久不见」'), '红线里带着久别回来的顺序（不先催收）')
  ok(ag.includes('Red Lines') && ag.includes('Do Freely') && ag.includes('Ask First'), '照 openclaw 的 Red Lines / Do Freely / Ask First 三分')
  ok(ag.includes('First Run') && ag.includes('Session Startup'), '照搬 First Run 与 Session Startup 两节')
  ok(ag.includes('Make It Yours'), '照搬「这个文件可以改」')

  /* ---- 位置：排在 SOUL 之前，且是常驻 ---- */

  const p0 = life.buildSystemPrompt()
  ok(p0.includes('## AGENTS.md（这个窗口是干什么的）'), 'AGENTS.md 进了提示词')
  ok(
    p0.indexOf('## AGENTS.md（这个窗口是干什么的）') <
      p0.indexOf('## SOUL.md（你是谁、怎么说话）'),
    '排在 SOUL 之前（agents=10 < soul=20）'
  )
  ok(p0.indexOf('## AGENTS.md（这个窗口是干什么的）') > p0.indexOf('# Project Context'), '属于 Project Context，不是散落在正文')
  ok(p0.includes('他关窗口的时候，应该带走一样东西'), '提示词里真的能读到这句（不是只写在文件里）')

  /* ---- 常驻：仪式走完之后它必须在（D087 的教训） ---- */

  ok(life.bootstrapPending(), '这时候仪式还没走完')
  ok(life.buildPrompt().includes('判定器'), '仪式期发出去的是判定器那一份')

  life.ingestProfile(['称呼｜叫他小周', '在做｜写代码', '喜欢｜骑车', '性子｜话少', '作息｜十一点后别找我'])
  // 收尾发生在 buildSystemPrompt 开头（retireBootstrapIfDone），所以要先跑一次再判
  const p1 = life.buildSystemPrompt()
  ok(!life.bootstrapPending(), '五件问满，仪式退出')
  ok(!p1.includes('## Bootstrap Pending'), '仪式确实不在了')
  ok(p1.includes('## AGENTS.md（这个窗口是干什么的）'), '但 AGENTS.md 还在 —— 一次性流程结束不该带走常驻文件')
  ok(p1.includes('他关窗口的时候，应该带走一样东西'), '内容也还完整，不是只剩标题')

  /* ---- 常驻文件不进索引（否则召回会把它的话当他的话复述） ---- */

  const searchMod = require(path.join(ROOT, 'src/main/search.js'))
  fs.appendFileSync(life.journalPath(), '- 今天把迁移那个接口收尾了\n', 'utf8')
  const rowsQ = searchMod.collectRows()
  const filesQ = new Set(rowsQ.map((r) => r.file))
  ok(!filesQ.has('AGENTS.md'), 'AGENTS.md 不进索引 —— 每轮都注入，再召回就是把提示词当他的话')
  ok(!filesQ.has('SOUL.md') && !filesQ.has('USER.md'), 'SOUL／USER 也不进（老问题，一并挡住）')
  ok([...filesQ].some((f) => f.startsWith('memory/')), '日记照旧进索引')

  /* ---- 他改过的不被覆盖；删了会补回来（与 BOOTSTRAP 相反） ---- */

  fs.writeFileSync(agPath, '# 我的 AGENTS\n\n## Red Lines\n- 我自己加的一条\n', 'utf8')
  life.ensureLife()
  ok(fs.readFileSync(agPath, 'utf8').includes('我自己加的一条'), '他改过的 AGENTS.md 一个字都不碰')

  fs.unlinkSync(agPath)
  life.ensureLife()
  ok(fs.existsSync(agPath), '删掉会补回来 —— 它是常驻约定，不是「别再问了」那个开关')

  process.env.HUNDUN_LIFE_DIR = prev
}

console.log('\n[3r] 仪式收尾：问不动了也要能结束')

{
  const prev = process.env.HUNDUN_LIFE_DIR
  const root = path.join(TMP, 'retire')
  process.env.HUNDUN_LIFE_DIR = root
  fs.rmSync(root, { recursive: true, force: true })
  life.ensureLife()

  /* ---- 第六种块：解析、归桶、不进正文 ---- */

  const parsedBs = parseBlocks('问过了。\n<bootstrap>\n- 问过：称呼、在做\n- 没问到：作息\n</bootstrap>')
  ok(parsedBs.notes.length === 1 && parsedBs.notes[0].target === 'bootstrap', '<bootstrap> 是第六种块')
  ok(!parsedBs.clean.includes('bootstrap'), '块不会留在正文里，界面上看不到标签')
  const gBs = groupNotes(parsedBs.notes)
  ok(gBs.bootstrap.length === 2, '归到 bootstrap 桶，两条都在')

  /* ---- 白卷不退：模型不能一句话把仪式跳过 ---- */

  ok(life.retireBootstrap([]) === '', '空清单什么都不做')
  ok(life.retireBootstrap(['-', ' ']) === '', '只有符号的清单也不做')
  ok(life.bootstrapPending(), '文件还在')

  const rBs0 = life.retireBootstrap(['问过：称呼', '没问到：在做、作息、在意、红线'])
  ok(rBs0.includes('档案还是空的'), '档案一条都没有就不退 —— 否则等于它替他把问题取消了')
  ok(life.bootstrapPending(), 'BOOTSTRAP.md 还在')

  const uBs = fs.readFileSync(path.join(life.lifeDir(), 'USER.md'), 'utf8')
  ok(uBs.includes('没问到：在做、作息、在意、红线'), '清单落进档案，问过什么有据可查')
  ok(uBs.indexOf('没问到：在做') > uBs.indexOf('## 访谈实录'), '写在「访谈实录」下面，不是文件末尾的野行')

  /* ---- 问过至少一件 → 块一到就收尾 ---- */

  life.ingestProfile(['称呼｜叫他芜柒'])
  const rBs1 = life.retireBootstrap(['问过：称呼', '没问到：在做、作息'])
  ok(rBs1.includes('已删'), '问过至少一件，收尾块就生效')
  ok(!life.bootstrapPending(), 'BOOTSTRAP.md 删了，仪式不会再来第二次')

  const pBs = life.buildSystemPrompt()
  ok(!pBs.includes('## Bootstrap Pending'), '下一轮提示词里没有仪式了')
  ok(pBs.includes('## AGENTS.md（这个窗口是干什么的）'), '常驻的 AGENTS.md 不受影响')
  ok(life.retireBootstrap(['问过：称呼']).includes('早就结束了'), '再收一次不报错，只说早就结束了')

  /* ---- 五个主题凑满那条老路仍然有效 ---- */

  const root2 = path.join(TMP, 'retire2')
  process.env.HUNDUN_LIFE_DIR = root2
  fs.rmSync(root2, { recursive: true, force: true })
  life.ensureLife()
  life.ingestProfile(['称呼｜叫他小周', '在做｜写代码', '喜欢｜骑车', '性子｜话少', '作息｜十一点后别找我'])
  life.buildSystemPrompt()
  ok(!life.bootstrapPending(), '五个主题各一条照样退（两条路并存，注入判据仍只有一个）')

  /* ---- 但光堆条数不算：五条不带主题的要求，一格也没问到 ---- */

  const root3 = path.join(TMP, 'retire3')
  process.env.HUNDUN_LIFE_DIR = root3
  fs.rmSync(root3, { recursive: true, force: true })
  life.ensureLife()
  life.ingestProfile(['别用 emoji', '别写长段落', '别叫我老板', '别说教', '别复述我刚说的话'])
  ok(!life.bootstrapDone(), '五条不带主题的话凑不出五件事 —— 条数不等于格数')
  life.buildSystemPrompt()
  ok(life.bootstrapPending(), '文件还在，剩下几格下次接着问')

  process.env.HUNDUN_LIFE_DIR = prev
}

/* ---------------- [3j2] 档案分节：自述类主题不进「要求」 ---------------- */
console.log('\n[3j2] 档案分节：只有真要求才进「要求」')

{
  const askRoot = path.join(TMP, 'prof-ask')
  fs.rmSync(askRoot, { recursive: true, force: true })
  const prev = process.env.HUNDUN_LIFE_DIR
  process.env.HUNDUN_LIFE_DIR = askRoot
  life.ensureLife()

  const read = () => fs.readFileSync(path.join(life.lifeDir(), 'USER.md'), 'utf8')

  // 分节判据曾经是白名单（FACT_TOPIC 只有十二个词）：不在名单里的主题一律进「要求」，
  // 而「要求」节是**当指令读**的。真机现场：他把「我是一个失败的程序员」说给模型，
  // 模型记成 `[自述]` / `[处境]`，两条都落进「要求」——档案里就成了
  // 「他要我当他是个失败者」。宁可错在「关于他」（只是事实），不可错在「要求」（会被执行）。
  life.ingestProfile(['自述｜说自己是「一个失败的程序员」', '性子｜话少，被追问会烦', '喜欢｜骑车'])
  const usr = read()
  ok(
    /## 关于他[\s\S]*失败的程序员/.test(usr) && !/## 要求[\s\S]*失败的程序员/.test(usr),
    '自述进「关于他」，不进「要求」（要求会被当指令执行）'
  )
  ok(/## 关于他[\s\S]*被追问会烦/.test(usr), '「性子」这类不在老白名单里的主题也进「关于他」')
  ok(/## 关于他[\s\S]*骑车/.test(usr), '「喜欢」同理')

  life.ingestProfile(['别用 emoji', '回复短一点', '说话｜少用书面语'])
  const req = read()
  ok(/## 要求[\s\S]*别用 emoji/.test(req), '祈使句照样进「要求」')
  ok(/## 要求[\s\S]*短一点/.test(req), '「回复」开头的一样进「要求」')
  ok(/## 要求[\s\S]*少用书面语/.test(req), '主题带「说话」的进「要求」')

  process.env.HUNDUN_LIFE_DIR = prev
}

console.log('\n[3s] 初始化应用：删目录重种，回到出厂（D100 开发者菜单）')

{
  const rlPrev = process.env.HUNDUN_LIFE_DIR
  const rlRoot = path.join(TMP, 'reset-new')
  fs.rmSync(rlRoot, { recursive: true, force: true })
  process.env.HUNDUN_LIFE_DIR = rlRoot
  life.ensureLife()

  // 先弄脏：写日记、写档案、删仪式（模拟走完仪式后聊了好几天）
  life.appendDiary('白天写代码，晚上十二点睡')
  life.ingestProfile(['自述｜写 Java 的'])
  fs.rmSync(path.join(life.lifeDir(), 'BOOTSTRAP.md'), { force: true })
  ok(!life.bootstrapPending(), '弄脏后：仪式已结束、日记和档案有内容')

  life.resetLife()
  ok(life.bootstrapPending(), 'resetLife 后仪式重新出现（.bootstrap 标记跟着目录一起没了）')
  ok(
    !fs.readFileSync(path.join(life.lifeDir(), 'USER.md'), 'utf8').includes('写 Java 的'),
    '档案回到空模板'
  )
  ok(
    !fs.existsSync(path.join(life.lifeDir(), 'memory', life.dateStr() + '.md')) ||
      !fs
        .readFileSync(path.join(life.lifeDir(), 'memory', life.dateStr() + '.md'), 'utf8')
        .includes('白天写代码'),
    '日记回到空模板'
  )
  ok(fs.existsSync(path.join(life.lifeDir(), 'AGENTS.md')), '种子文件全部重种（AGENTS.md 在）')
  // 幂等：连按两下不炸
  life.resetLife()
  ok(life.bootstrapPending(), '连按两次也是同一个出厂态')

  process.env.HUNDUN_LIFE_DIR = rlPrev
}

/* [3t] 示例占位：模板和抽取提示词里不许有真名化的示例答案（D085 第三次踩后的加固） */
{
  // 真机事故：他叫芜柒，示例占位是「叫他小周」——抽取模型照抄示例，同主题顶替
  // 让假名字成了 active。占位必须是「〈名字〉」这种一眼假的模板形式。
  const memgate = require(path.join(ROOT, 'src/main/memgate.js'))
  const mg = memgate.buildPrompt({ userText: 'x', assistantText: 'y' })[0].content
  // D115 之后仪式模板里**已经没有任何示例答案**了（问题全在 RITUAL_SLOTS 里现成给出），
  // 所以这条现在只对抽取提示词生效。反向断言留着，防止有人把示例又写回模板。
  ok(!life.TPL_BOOTSTRAP.includes('小周'), '仪式模板里不再出现示例真名「小周」')
  ok(!life.TPL_BOOTSTRAP.includes('叫他'), '仪式模板里没有任何称呼示例 —— 没有可抄的答案就不会抄')
  for (const [where, txt] of [['抽取提示词', mg]]) {
    ok(!txt.includes('小周'), where + '里不再出现示例真名「小周」')
    ok(txt.includes('〈名字〉'), where + '的称呼示例是尖括号占位形式')
    ok(txt.includes('照抄') || txt.includes('不要照抄') || txt.includes('别照抄') || txt.includes('照抄进档案'), where + '里明说不要照抄')
  }
}

/* [3u] 话题调度：新输入优先、旧线作废（D101，对齐 openclaw steering） */
console.log('\n[3u] 话题调度：新输入优先，旧线作废')
{
  const sp = life.buildSystemPrompt()
  ok(sp.includes('答的就是你最近问的那件事'), '回答锚定最近的问题这条在提示词里')
  ok(sp.includes('就地作废'), '未被接住的旧线头作废这条在提示词里（D103 压缩版）')
  ok(sp.includes('旧线就地作废') && sp.includes('不套框架校验'), '点名禁止「套框架校验」（D103 压缩版保留判据）')
}

/* [3v] 长期记忆的覆盖与溢出、检索门槛、同一段对话不抖（D106／D107） */
console.log('\n[3v] 长期记忆覆盖与溢出 / 检索门槛 / 召回不抖')
{
  const prev = process.env.HUNDUN_LIFE_DIR
  const MTMP = path.join(ROOT, '.dev/test-memory')
  fs.rmSync(MTMP, { recursive: true, force: true })
  process.env.HUNDUN_LIFE_DIR = MTMP
  life.ensureLife()

  const memFile = path.join(life.lifeDir(), 'MEMORY.md')
  const readMem = () => fs.readFileSync(memFile, 'utf8')

  // ① 同主题覆盖：新的顶掉旧的，旧的留痕不删
  life.appendLongterm(['在学的东西｜在学嵌入式'])
  life.appendLongterm(['在学的东西｜转去写后端了'])
  const covered = readMem()
  ok(covered.includes('在学嵌入式'), '被顶掉的那条留在文件里（能看到他是怎么变的）')
  ok(/在学嵌入式（已过时 \d{2}-\d{2}）/.test(covered), '被顶掉的那条标了「已过时」和日期')
  ok(covered.includes('转去写后端了'), '新的一条写进去了')
  const pCover = life.buildSystemPrompt()
  ok(pCover.includes('转去写后端了'), '注入的是当前有效的那条')
  ok(!pCover.includes('在学嵌入式'), '已过时的不进上下文 —— 两条并存时模型会挑旧的答')

  // ② 换了主题就不许覆盖上一条
  life.appendLongterm(['作息｜凌晨一点睡'])
  const twoKeys = readMem()
  ok(twoKeys.includes('转去写后端了') && !/转去写后端了（已过时/.test(twoKeys), '不同主题互不顶替')

  // ③ 溢出：结构节不能被记录挤掉，最新的必须留下，丢了多少天要说出来
  const filler = '这一天的记录比较长，用来把文件撑过预算。'.repeat(12)
  let big = '# MEMORY.md — 长期记忆\n\n## 关于你（事实）\n（暂无）\n\n## 进行中的事\n（暂无）\n\n## 你划过的红线\n（暂无）\n\n'
  for (let i = 1; i <= 40; i++) {
    big += '### 2026-01-' + String(i).padStart(2, '0') + '\n- 第' + i + '天：' + filler + '\n\n'
  }
  fs.writeFileSync(memFile, big, 'utf8')
  const pFull = life.buildSystemPrompt()
  ok(pFull.includes('## 你划过的红线'), '超预算时结构节还在（原来会被日期块挤到最后、一起截掉）')
  ok(pFull.includes('第40天'), '最新的那条在上下文里（原来是保头弃尾，切掉的正是最新的）')
  ok(!pFull.includes('第1天：'), '最老的那条让出去了')
  ok(/更早有 \d+ 天的记录没放进来/.test(pFull), '少给了几天要明说，不能悄悄少给')

  // ④ 检索门槛：一个词撞上不算命中
  const search2 = require(path.join(ROOT, 'src/main/search.js'))
  const st = search2.tokenize('我们现在觉得')
  ok(!st.includes('现在') && !st.includes('觉得'), '停用词不进查询词', st.join('/'))
  ok(!search2.tokenize('debug the login flow').includes('the'), '英文停用词也挡掉')

  fs.writeFileSync(
    path.join(life.lifeDir(), 'memory', '2026-02-01.md'),
    '# 2026-02-01\n\n- 明天要交周报\n- 那天卡在登录页，token 过期\n',
    'utf8'
  )
  await search2.rebuild()
  const weak = await search2.search('周报的事先放一放')
  ok(weak.length === 0, '只有一个词撞上就不算命中（否则会在不相干的话题里翻旧账）', JSON.stringify(weak.map((h) => h.text)))
  const strong = await search2.search('登录页又挂了')
  ok(strong.length >= 1, '真相关的话照样命中', JSON.stringify(strong.map((h) => h.text)))

  // ⑤ 同一段对话里不换答案
  const conversation2 = require(path.join(ROOT, 'src/main/conversation.js'))
  conversation2.reset()
  const rA = await conversation2.recall('登录页又挂了')
  const rB = await conversation2.recall('登录页又挂了，还是那个错')
  ok(rA.length >= 1 && JSON.stringify(rA) === JSON.stringify(rB), '同一个话题里沿用上一批（每轮重查会忽而记得忽而不记得）')
  const rC = await conversation2.recall('量子色动力学')
  ok(JSON.stringify(rC) !== JSON.stringify(rA), '换到不相干的话题才换一批')

  process.env.HUNDUN_LIFE_DIR = prev
  life.ensureLife()
}

/* ---------------- 3w. 加一个模型（D110） ---------------- */

console.log('\n[3w] 加一个模型：名字、同地址合并、排到最后')

{
  // 起点：一家供应商、一个模型，正是「简单模式」生成的那种形状
  const start = {
    provider: {
      deepseek: {
        name: 'DeepSeek',
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'https://api.deepseek.com/v1', apiKey: 'k1' },
        models: { 'deepseek-chat': { name: 'DeepSeek Chat', limit: { context: 128000 } } }
      }
    },
    model: 'deepseek/deepseek-chat',
    'x-hundun': { simple: { preset: 'deepseek', baseUrl: '', apiKey: 'k1', model: 'deepseek-chat' } }
  }

  // ① 换一个地址（中转站）→ 必须新建一家，不能占掉原来那家
  const r1 = mm.addEntry(start, {
    presetId: 'deepseek',
    presetName: 'DeepSeek',
    baseUrl: 'https://relay.example/v1',
    apiKey: 'k2',
    modelId: 'deepseek-chat',
    name: 'DeepSeek（中转站）',
    context: 64000
  })
  ok(r1.ok, '能加进一个不同地址的模型', r1.error)
  const n1 = mm.normalize(r1.config)
  ok(n1.ok && n1.chain.length === 2, '链上变成两个', n1.errors.join('；'))
  ok(n1.chain[1].modelName === 'DeepSeek（中转站）', '名字就是他要的那个（卡片标题）', n1.chain[1].modelName)
  ok(n1.chain[1].providerId !== 'deepseek', '地址不同就另立一家，不覆盖原来那份', n1.chain[1].providerId)
  ok(n1.chain[0].apiKey === 'k1' && n1.chain[1].apiKey === 'k2', '两家的 key 各归各的')
  ok(n1.selected.modelId === 'deepseek-chat' && n1.selected.apiKey === 'k1', '首选没变（排在前面的一直是先用）')

  // ② 同一个地址再加一个模型 → 并进同一家，key 只需要填一遍
  const r2 = mm.addEntry(r1.config, {
    presetId: 'deepseek',
    presetName: 'DeepSeek',
    baseUrl: 'https://relay.example/v1',
    apiKey: '',
    modelId: 'deepseek-reasoner',
    name: 'DeepSeek 4.1',
    context: 128000
  })
  ok(r2.ok, '同地址能再加一个', r2.error)
  const n2 = mm.normalize(r2.config)
  ok(new Set(n2.chain.map((m) => m.providerId)).size === 2, '同地址没有多出一家（还是一个 provider 两个模型）')
  ok(n2.chain[2].apiKey === 'k2', '第二个模型沿用同一家的 key（不用再填一遍）')
  ok(n2.chain[2].modelName === 'DeepSeek 4.1', '每张卡片各叫各的名字')
  ok(n2.chain.length === 3, '新的排在最后（优先用前面的）', n2.chain.map((m) => m.modelName).join(','))

  // ③ 同一个 provider+模型 再加一次 → 明说，而不是静默变成两条
  const dup = mm.addEntry(r2.config, {
    presetId: 'deepseek',
    presetName: 'DeepSeek',
    baseUrl: 'https://relay.example/v1',
    modelId: 'deepseek-reasoner',
    name: '重复的'
  })
  ok(!dup.ok && dup.error.includes('已经在清单里'), '重复加同一个模型会明说', dup.error)

  // ④ 从一家一个模型变成多个之后，「简单配置」的标记必须去掉
  ok(!r1.config['x-hundun'].simple, '加第二个之后不再自称「简单配置」（留着它下次读的人会以为只有一家一个模型）')
  ok(
    mm.addEntry({ provider: {}, model: '' }, { presetId: 'x', baseUrl: 'https://a.example/v1', modelId: 'm' }).ok,
    '从一份空配置起也能加（新装第一次）'
  )

  // ⑤ 输入不合法就说清楚，不写半份进去
  ok(!mm.addEntry(start, { baseUrl: 'https://a.example/v1', modelId: '' }).ok, '没填模型名 → 拒绝')
  ok(!mm.addEntry(start, { baseUrl: 'ftp://a', modelId: 'm' }).ok, '地址不是 http(s) → 拒绝')
  ok(!mm.addEntry(start, { baseUrl: 'https://a.example/v1', modelId: 'a/b' }).ok, '模型名带斜杠 → 拒绝（斜杠是分隔符）')

  // ⑥ 没起名字的时候：沿用原来的显示名，不要把目录里的名字冲成 id
  const keep = mm.addEntry(start, {
    presetId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    modelId: 'deepseek-chat',
    name: ''
  })
  ok(!keep.ok, '同一家同一个模型重复加还是拒绝（这里只是确认不会悄悄改名）')

  const noName = mm.addEntry({ provider: {}, model: '' }, {
    presetId: 'zhipu',
    presetName: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'kz',
    modelId: 'glm-4.6'
  })
  const nn = mm.normalize(noName.config)
  ok(noName.ok && nn.chain[0].modelName === 'glm-4.6', '没起名字就用模型名当标题', nn.chain[0]?.modelName)
  ok(nn.chain[0].providerName === '智谱 GLM', 'provider 的名字留在副标题里（认得出是哪一家）')
}

console.log('\n[3x] 仪式是一整个独立程序：安装程序 → 走完 → 换成馄饨（D112）')

{
  const prev = process.env.HUNDUN_LIFE_DIR
  const mk = (name) => {
    const root = path.join(TMP, name)
    process.env.HUNDUN_LIFE_DIR = root
    fs.rmSync(root, { recursive: true, force: true })
    life.ensureLife()
    return root
  }

  /* ① 仪式期发出去的是「判定器」，不是给馄饨加一段说明 */
  mk('ritual-a')
  const rp = life.buildPrompt()
  const mp = life.buildSystemPrompt()
  ok(rp !== mp, '仪式期和主程序是两份不同的提示词（不是同一份加个段落）')
  ok(rp.includes('判定器'), '仪式程序第一句就交代自己只做判定')
  ok(!rp.includes('## Interaction Style'), '它没有人格层 —— 所以他说的「另一个 agent」是结构，不是比喻')
  ok(!rp.includes('## Execution Bias'), '它没有行动偏向（不办别的事）')
  ok(rp.includes('<slot>end</slot>'), '他说想被陪着时可以判 end —— 出口还在')
  ok(life.ritualState().pending, 'ritualState 说仪式还在')

  /* ② 话是现成的：每个字都来自代码，模型造句的自由被拿掉了（D115／D122） */
  const boot = life.ritualReply({ kind: 'boot', slot: life.RITUAL_SLOTS[0] })
  ok(boot.includes('[INPUT-REQ]'), '开场就是第一条录入请求——终端协议，不是寒暄')
  ok(boot.includes('怎么称呼你'), '问题本身是完整中文（不用先解码）')
  ok(!boot.includes('我'), '没有人称自述 —— 「我这边还是空的」这类句子没有出处了')
  const skipLine = life.ritualReply({ kind: 'missing', slot: life.RITUAL_SLOTS[2] })
  ok(skipLine.includes('未检测到有效输入') && !skipLine.includes('错误'), '他绕开时按协议打回，不判他错')
  ok(
    life.ritualReply({ kind: 'skipped', prev: life.RITUAL_SLOTS[2], slot: null }).includes('[STATUS: SKIPPED]') &&
      life.ritualReply({ kind: 'skipped', prev: life.RITUAL_SLOTS[2], slot: null }).includes('[STATUS: INIT-DONE]'),
    '跳过那格有回执，最后一格跳过时也照样收尾'
  )
  ok(
    life.ritualReply({ kind: 'fill', prev: life.RITUAL_SLOTS[0], slot: null }).includes('INIT-DONE'),
    '走完那一轮有收尾那一条'
  )
  ok(
    life.ritualReply({ kind: 'fill', prev: life.RITUAL_SLOTS[0], slot: life.RITUAL_SLOTS[1] }).includes(
      '正在构建用户画像'
    ),
    '第一格录完带一句画像构建——只有这一处，后面不再重复'
  )

  /* ②b 判定标记：解析不出来一律当 skip，绝不瞎填（这一条是整件事的安全阀） */
  ok(life.parseVerdict('<slot>称呼|芜柒</slot>', '称呼').value === '芜柒', '正常标记能解析出内容')
  ok(life.parseVerdict('好的，我记下了。', '称呼').kind === 'skip', '没有标记 → skip（不猜）')
  ok(life.parseVerdict('<slot>skip</slot>', '称呼').kind === 'skip', 'skip 标记')
  ok(life.parseVerdict('<slot>end</slot>', '称呼').kind === 'end', 'end 标记')
  ok(life.parseVerdict('<slot>称呼|</slot>', '称呼').kind === 'skip', '空值当 skip，不写空条目')
  ok(life.parseVerdict('<slot>在做|写代码</slot>', '称呼').key === '称呼', '主题用代码里那一格，不信模型写的')

  /* ③ 名字：那一屏要说「你好 芜柒」，取不到就不硬编一个 */
  mk('ritual-b')
  const w0 = life.ritualState().welcome
  ok(w0[0] === '你好', '还没有称呼时只说「你好」，不拿「朋友」替他填')
  ok(w0[1] === '我是馄饨 幸会' && w0[2] === '希望这里 能短暂的温暖你', '三句话就是他要的那三句')
  ok(
    w0.every((l) => !/[，。、,.]/.test(l)),
    '三句里一个标点都没有——断句交给空格和停顿（D117）'
  )
  life.ingestProfile(['称呼｜叫他芜柒'])
  const st1 = life.ritualState()
  ok(st1.name === '芜柒', '从 USER.md 取出称呼（去掉「叫他」）', st1.name)
  ok(st1.welcome[0] === '你好 芜柒', '那一屏带上名字，中间是一个空格而不是逗号')

  /* ④ 门槛：三格、且必须有「称呼」 */
  ok(!life.bootstrapDone(), '只有一格时不走完')
  life.ingestProfile(['在做｜写代码'])
  ok(!life.bootstrapDone(), '两格也不走完')
  life.ingestProfile(['陪伴｜多陪陪他'])
  ok(life.bootstrapDone(), '三格含「称呼」就走完')
  life.buildPrompt() // 触发 retireBootstrapIfDone
  ok(!life.bootstrapPending(), '走完那轮就把 BOOTSTRAP.md 删掉')
  ok(!life.ritualState().pending, 'ritualState 跟着变成「走完了」')
  ok(life.buildPrompt() === life.buildSystemPrompt(), '走完之后发出去的就是馄饨那一份')
  ok(life.buildPrompt().includes('## Interaction Style'), '主程序的人格层回来了')

  /* ⑤ 三格但没有称呼：还得问下去（称呼是开口要用的） */
  mk('ritual-c')
  life.ingestProfile(['在做｜写代码', '作息｜十一点后别找我', '性子｜话少'])
  ok(!life.bootstrapDone(), '三个主题但没有「称呼」→ 不算走完')
  ok(life.bootstrapPending(), '那就继续问')

  /* ⑥ 界面接线：过场只能靠真机验，这里只证「线接上了」 */
  const vue = fs.readFileSync(path.join(ROOT, 'src/renderer/src/App.vue'), 'utf8')
  ok(vue.includes('ceremony'), '界面里有那一屏的元素')
  ok(vue.includes('syncRitual'), '每轮结束后会比一次仪式状态')
  ok(vue.includes('playCeremony'), '逐字打出来的函数在')
  ok(vue.includes('endCeremony'), '点一下能跳过')
  ok(
    !/messages\.value\s*=\s*\[\]/.test(
      vue.slice(vue.indexOf('function endCeremony'), vue.indexOf('function syncRitual'))
    ),
    '点跳过只是提前淡出，不动消息'
  )
  // ---- 走完那一刻：整屏清空（D121）----
  // 判据换成「仪式刚结束」这一个事实，不再逐条看标记：标记漏一条，那条就永远留在屏幕上，
  // 而且看不出来是哪一条漏的（14:20 真机上他自己的三句回答就停在屏幕中间）。
  const syncBody = vue.slice(
    vue.indexOf('function syncRitual'),
    vue.indexOf('/* ---------- 事件 ----------')
  )
  ok(/messages\.value\s*=\s*\[\]/.test(syncBody), '仪式走完那一刻整屏清空，一条不留（D121）')
  ok(
    !/filter\(\(m\)\s*=>\s*!m\.ritual\)/.test(vue),
    '不再靠逐条标记去滤——那种写法漏一条，它就永远留着'
  )
  const clearAt = syncBody.indexOf('messages.value = []')
  const guardAt = syncBody.indexOf('if (!was || next.pending) return')
  ok(guardAt >= 0 && clearAt > guardAt, '清空在「真的刚走完」那个早退之后，不是每轮都清')
  ok(
    vue.includes('ceremony-ghost') && vue.includes('ceremony-ink'),
    '每行有一份透明副本撑住宽度，打字时整行不会左右抖'
  )
  ok(
    !/content: t, ritual/.test(vue),
    '他说的那几句不打标记了——清空不看标记，多一个标记就是多一处会漏的地方（D121）'
  )
  ok(
    /sys: m\.ritual && m\.role !== 'user'/.test(vue),
    '标记归标记，他自己说的话仍然靠右排，不套「非馄饨」那套缩进'
  )
  ok(vue.includes('__hello__'), '走完那一屏收起来之后让它先开口')
  ok(
    /if \(!text\.length\) return firstWord\(\)/.test(vue),
    '过场没词可放时直接让它开口——清空之后要是也没声音，屏幕上就真的一片空'
  )
  ok(
    /greeted\s*=\s*false[\s\S]{0,200}playCeremony/.test(vue) &&
      /if \(greeted\) return/.test(vue),
    '只开口一次：跳过、播完、再点一下，不该说三遍'
  )

  // 跨文件：界面靠「这一轮带回来的 ritual」才知道仪式走完了。
  // 作废的那一轮要是不带，界面就没理由清屏——14:20 那一屏正是这么留下来的。
  const conv = fs.readFileSync(path.join(ROOT, 'src/main/conversation.js'), 'utf8')
  ok(
    /dropped: true, text: '', ritual: life\.ritualState\(\)/.test(conv),
    '作废的那一轮也把仪式状态带回来，否则界面不知道已经走完'
  )
  ok(
    /跳过\|skip/.test(conv) && /life\.skipSlot\(slot\.key\)/.test(conv),
    '「跳过」由主进程字面认，不经过判定模型——认命令词是程序的事，不是模型的事（D122）'
  )
  ok(
    /if \(!next\) \{\s*life\.endRitual\(\)/.test(conv),
    '最后一格走完（填完或跳完）也要删 BOOTSTRAP.md——只靠主题数判，「称呼填了其余全跳」那条路会永远收不了尾'
  )

  const mainJs = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8')
  ok(
    mainJs.includes('__hello__') && mainJs.includes('第一次见他'),
    '那条开场指令在主进程里，且说清了是「第一次见」——不然它会照着久别回来的口气开口'
  )

  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/src/styles.css'), 'utf8')
  // 自检那行的停留时长来自 App.vue 的 sleep(1100)，动画时长来自 styles.css。
  // 两个数分在两个文件里，对不上不会报错——只是那行字永远闪不完就被摘掉。
  // 所以这里不硬编码秒数，直接拿两边算。
  const bootHold = (vue.match(/await sleep\((\d+)\)\s*\n\s*if \(my !== ceremonySeq\) return\s*\n\s*ceremony\.value\.boot = false/) || [])[1]
  const bootAnim = css.match(/\.ceremony-boot\s*\{[^}]*animation:\s*ceremony-dim ([\d.]+)s[^;]*\s(\d+);/)
  ok(
    bootHold && bootAnim && Number(bootAnim[1]) * 1000 * Number(bootAnim[2]) <= Number(bootHold),
    `自检那行闪两下 ${bootAnim ? `${Number(bootAnim[1]) * 1000 * Number(bootAnim[2])}ms` : '?'}` +
      ` 要在它存在的 ${bootHold || '?'}ms 里播得完（原来是 1.8s 硬塞进 1.1s，永远被打断）`
  )

  process.env.HUNDUN_LIFE_DIR = prev
}

/* ---------------- 汇总 ---------------- */
console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 通过 / ' + fail + ' 失败\n')
process.exit(fail === 0 ? 0 : 1)
