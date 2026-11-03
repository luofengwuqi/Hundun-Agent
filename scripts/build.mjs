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
    external: ['electron', 'better-sqlite3'],
    outfile: path.join(OUT, 'main/index.js'),
    sourcemap: false,
    logLevel: 'warning'
  })
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

async function main() {
  rmrf(OUT)
  fs.mkdirSync(path.join(OUT, 'renderer/assets'), { recursive: true })
  await Promise.all([buildMain(), buildPreload(), buildRenderer()])
  await buildHtml()
  console.log('构建完成 → out/')
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})
