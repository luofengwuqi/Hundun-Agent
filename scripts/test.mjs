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

// 收尾：切回本节开始时的身份，否则后面检索那节会在 222 的目录里找 111 的东西
paths.setContext({ userId: 'local', agentId: 'hundun' })
life.ensureLife()
conversation.resetSession()

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
ok(refs.length === 2, '页面引用了 js 与 css', refs.join(', '))
for (const r of refs) {
  ok(fs.existsSync(path.join(ROOT, 'out/renderer', r)), '产物存在：' + r)
}
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
