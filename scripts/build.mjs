/**
 * 构建脚本（替代 electron-vite 的构建管线）。
 *
 * 为什么不用 Vite：本机 Node 的虚拟内存被限制在 4GB，Vite 一加载就会
 * 触发 undici 的 WASM 初始化并直接 OOM。esbuild 是原生二进制、@vue/compiler-sfc
 * 是纯 JS，两者都不碰 WASM，构建链路稳定。
 *
 * 框架没变：仍然是 Electron 28 + Vue 3，只是打包器换了。
 *
 * 产出（与 electron-vite 相同的 out/ 布局）：
 *   out/main/index.js      CJS，external: electron
 *   out/preload/preload.js CJS
 *   out/renderer/index.html + assets/app.js + assets/app.css
 */
import esbuild from 'esbuild'
import { parse, compileScript } from '@vue/compiler-sfc'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'out')

const watch = process.argv.includes('--watch')

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

/** 把 .vue 编译成纯 JS（script setup + 内联模板） */
const vuePlugin = {
  name: 'vue-sfc',
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, 'utf8')
      const id = crypto.createHash('md5').update(args.path).digest('hex').slice(0, 8)
      const { descriptor, errors } = parse(source, { filename: args.path })

      if (errors && errors.length) {
        return { errors: errors.map((e) => ({ text: String(e.message || e) })) }
      }
      if (!descriptor.script && !descriptor.scriptSetup) {
        return { errors: [{ text: args.path + ' 没有 <script> 块' }] }
      }

      const compiled = compileScript(descriptor, { id, inlineTemplate: true })
      return {
        contents: compiled.content,
        loader: 'js',
        resolveDir: path.dirname(args.path)
      }
    })
  }
}

async function buildMain() {
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/main/index.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['electron'],
    outfile: path.join(OUT, 'main/index.js'),
    sourcemap: false,
    logLevel: 'warning'
  })

  // sql.js 是 WASM，没法打进单文件里跑，必须把 wasm 和它的壳一起放到 out/main/vendor，
  // 运行时用 fs 读 wasm 传进去（Electron 的 asar 内也能读）。
  const dist = path.join(ROOT, 'node_modules/sql.js/dist')
  const vendor = path.join(OUT, 'main/vendor')
  if (fs.existsSync(path.join(dist, 'sql-wasm.js'))) {
    fs.mkdirSync(vendor, { recursive: true })
    // 用 read + write 而不是 copyFileSync。copyfile 这个 syscall 在某些受限容器
    // 和网络文件系统上会失败，而且失败方式很坏——进程直接退出，连错误栈都不留，
    // 表现成「构建什么都不说就 exit 1」。read + write 到哪都能用，代价可忽略。
    const copy = (name) =>
      fs.writeFileSync(path.join(vendor, name), fs.readFileSync(path.join(dist, name)))
    copy('sql-wasm.js')
    copy('sql-wasm.wasm')
  } else {
    // 没装 sql.js 也能构建，检索会自动退回文件扫描
    console.warn('未找到 sql.js，检索将退回内存扫描模式')
  }
}

async function buildPreload() {
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/main/preload.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['electron'],
    outfile: path.join(OUT, 'preload/preload.js'),
    logLevel: 'warning'
  })
}

async function buildRenderer() {
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/renderer/src/main.js')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome118',
    outfile: path.join(OUT, 'renderer/assets/app.js'),
    plugins: [vuePlugin],
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'css', '.png': 'file', '.svg': 'file' },
    logLevel: 'warning'
  })
  // esbuild 会把 import 的 css 输出成同名 .css，放在 app.js 旁边

  const pub = path.join(ROOT, 'src/renderer/public')
  if (fs.existsSync(pub)) {
    fs.cpSync(pub, path.join(OUT, 'renderer'), { recursive: true })
  }
}

async function buildHtml() {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8')
  const html = src.replace('<!--BUNDLE-->', '<link rel="stylesheet" href="./assets/app.css" />\n    <script src="./assets/app.js"></script>')
  fs.writeFileSync(path.join(OUT, 'renderer/index.html'), html)
}

/**
 * logo 只有一个源：build/logo.svg。
 *
 * 界面里是 <img src="./logo.svg">，走 publicDir 原样拷进 out/renderer/。
 * 这里每次构建都从 build/logo.svg 重铺一遍 public/logo.svg，是为了「换了源就自动生效」——
 * 否则改了 build/logo.svg 却忘了跑 npm run gen-icon，界面还显示旧图，而且没人看得出来。
 * 同理补一次 resources/icon.png 的兜底：直接拷 SVG 是不行的，它要 PNG。
 */
function syncLogo() {
  const src = path.join(ROOT, 'build/logo.svg')
  if (!fs.existsSync(src)) {
    console.warn('build/logo.svg 不存在，界面 logo 会 404')
    return
  }
  const pub = path.join(ROOT, 'src/renderer/public')
  fs.mkdirSync(pub, { recursive: true })
  const dst = path.join(pub, 'logo.svg')
  const body = fs.readFileSync(src, 'utf8')
  if (fs.existsSync(dst) && fs.readFileSync(dst, 'utf8') === body) return
  fs.writeFileSync(dst, body)
  // PNG 只能靠 gen-icon 出，缺了就提醒一句，不至于让人对着空图标找半天
  if (!fs.existsSync(path.join(pub, 'icon.png'))) {
    console.warn('缺 src/renderer/public/icon.png，先跑一次 npm run gen-icon')
  }
}

async function main() {
  rmrf(OUT)
  fs.mkdirSync(path.join(OUT, 'renderer/assets'), { recursive: true })
  // 串行，不并发。三个 esbuild.build 挤在同一个 service 进程里并发运行时，
  // 会在解析 @vue/runtime-core、@vue/shared 这类间接依赖上偶发
  // 「Could not resolve」——单独跑或串行跑都不复现，属于并发下的解析缓存问题。
  // 三步合计几百毫秒，串行的代价可以忽略，换来的是构建结果稳定。
  await buildMain()
  await buildPreload()
  syncLogo()
  await buildRenderer()
  await buildHtml()
  console.log('构建完成 → out/')
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})
