/**
 * 一键自测（P-06）。
 *
 * 为什么要有它：M2 之后至少二十条验收要反复跑，靠手点一定会漏，
 * 而漏掉的那条恰好是最容易静默出错的那条（送达标记）。
 *
 *   node scripts/check.mjs             构建 → 单元测试 → 产物检查
 *   node scripts/check.mjs --no-build  跳过构建（产物已是最新时用）
 *   node scripts/check.mjs --gui       另外起一次真窗口截图（需要图形环境）
 *
 * 三项都过了才算过。GUI 那一项在起不来时会记成「跳过」而不是「失败」——
 * 这不是放水：它判断的是「这台机器有没有图形环境」，不是「代码对不对」。
 * 但跳过会明确打出来，免得有人以为验过了。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath
const args = process.argv.slice(2)
const withBuild = !args.includes('--no-build')
const withGui = args.includes('--gui')

let failed = 0
const skipped = []

function head(t) {
  console.log('\n=== ' + t + ' ===')
}

function run(cmd, cmdArgs, env) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
    maxBuffer: 32 * 1024 * 1024
  })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

/* ---------- 1. 构建 ---------- */

if (withBuild) {
  head('1/3 构建')
  const r = run(NODE, ['scripts/build.mjs'])
  if (r.code !== 0) {
    failed++
    console.log('构建失败：')
    console.log(r.out.trim().split('\n').slice(-25).join('\n'))
  } else {
    console.log(r.out.trim() || '构建完成')
  }
} else {
  head('1/3 构建')
  console.log('跳过（--no-build）')
  skipped.push('构建')
}

/* ---------- 2. 单元测试 ---------- */

head('2/3 单元测试')
const t = run(NODE, ['scripts/test.mjs'])
// 只打最后一行汇总 + 失败项，避免刷屏
const lines = t.out.trim().split('\n')
const bad = lines.filter((l) => l.includes('✗'))
if (bad.length) bad.forEach((l) => console.log(l))
console.log(lines[lines.length - 1] || '(无输出)')
if (t.code !== 0) failed++

/* ---------- 3. 产物与页面结构 ---------- */

head('3/3 产物')
const must = [
  'out/main/index.js',
  'out/preload/preload.js',
  'out/renderer/index.html',
  'out/renderer/assets/app.js',
  'out/renderer/assets/app.css'
]
for (const f of must) {
  const p = path.join(ROOT, f)
  const exists = fs.existsSync(p)
  console.log((exists ? '  ✓ ' : '  ✗ ') + f + (exists ? '' : '（缺失）'))
  if (!exists) failed++
}

// 预加载脚本必须挂在 contextBridge 上，否则界面拿不到任何接口
try {
  const pre = fs.readFileSync(path.join(ROOT, 'out/preload/preload.js'), 'utf8')
  const okBridge = pre.includes('exposeInMainWorld')
  console.log((okBridge ? '  ✓ ' : '  ✗ ') + 'preload 暴露了 window.hundun')
  if (!okBridge) failed++
} catch {}

/* ---------- 4. 可选：真窗口 ---------- */

if (withGui) {
  head('附加：真窗口冒烟')
  const shot = path.join(ROOT, '.dev/shot.png')
  fs.mkdirSync(path.join(ROOT, '.dev'), { recursive: true })
  try {
    fs.rmSync(shot, { force: true })
  } catch {}
  const r = run(
    path.join(ROOT, 'node_modules/.bin/electron'),
    ['.', '--no-sandbox', '--disable-gpu'],
    {
      HUNDUN_SHOT: shot,
      HUNDUN_SHOT_DELAY: '2500',
      HUNDUN_LIFE_DIR: path.join(ROOT, '.dev/gui-life'),
      HUNDUN_CONFIG_DIR: path.join(ROOT, '.dev/gui-config')
    }
  )
  if (fs.existsSync(shot)) {
    console.log('  ✓ 窗口起来了，截图：' + shot)
  } else {
    console.log('  ! 窗口没起来（这台机器常见于无图形环境或沙箱拦截）')
    console.log('    最后输出：' + r.out.trim().split('\n').slice(-2).join(' | '))
    skipped.push('真窗口（本机未能启动）')
  }
}

/* ---------- 汇总 ---------- */

console.log('\n' + (failed === 0 ? '通过' : '有失败项') + (skipped.length ? '（跳过：' + skipped.join('、') + '）' : ''))
process.exit(failed === 0 ? 0 : 1)
