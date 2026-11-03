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

for (const f of ['SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'CHECKPOINTS.md']) {
  ok(fs.existsSync(path.join(TMP, f)), '初始化生成 ' + f)
}
ok(fs.existsSync(path.join(TMP, 'memory')), '初始化生成 memory/ 目录')
const todayFile = path.join(TMP, 'memory', life.dateStr() + '.md')
ok(fs.existsSync(todayFile), '生成今天的日记文件')

const userSeed = fs.readFileSync(path.join(TMP, 'USER.md'), 'utf8')
ok(userSeed.includes('待访谈'), 'USER.md 是空白档案（会触发访谈）')
ok(life.isProfileEmpty(), '识别出档案为空')

let prompt = life.buildSystemPrompt({})
ok(prompt.includes('SOUL.md'), '提示里包含 SOUL')
ok(prompt.includes('MEMORY.md'), '提示里包含 MEMORY')
ok(prompt.includes('记忆规则'), '提示里包含记忆规则')
ok(prompt.includes('<longterm>'), '提示声明了 longterm 块')
ok(prompt.includes('把 USER.md 填起来'), '档案为空时注入访谈指令')
ok(prompt.includes(life.dateStr()), '提示里带上了今天日期')

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
const mem = fs.readFileSync(path.join(TMP, 'MEMORY.md'), 'utf8')
ok(mem.includes('连续三天周三下午效率低'), '长期记忆已落盘')
ok(mem.indexOf('连续三天') < mem.indexOf('## 进行中的事'), '长期记忆插在锚点之前，结构没被破坏')

life.appendProfile(['做后端，主要写 Java'])
const usr = fs.readFileSync(path.join(TMP, 'USER.md'), 'utf8')
ok(usr.includes('做后端，主要写 Java'), '用户档案已落盘')
ok(/## 访谈实录[\s\S]*### \d{4}-/.test(usr), '档案按日期分节记录')

ok(!life.isProfileEmpty(), '档案写入后不再判定为空')

/* ---------------- 3. 检查点 ---------------- */

console.log('\n[3] 检查点文案')
const morning = life.checkpointSection('早间')
const evening = life.checkpointSection('晚间')
ok(morning.includes('最重要的一件事'), '早间文案能取出', morning.slice(0, 30))
ok(evening.includes('一句话'), '晚间文案能取出', evening.slice(0, 30))
ok(!morning.includes('晚间'), '两节不会串')
ok(life.checkpointSection('不存在').length > 0, '缺失时回退到默认文案')

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

/* ---------------- 汇总 ---------------- */

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 通过 / ' + fail + ' 失败\n')
process.exit(fail === 0 ? 0 : 1)
