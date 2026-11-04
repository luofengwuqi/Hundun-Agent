#!/usr/bin/env node
/**
 * 把 src/renderer/src/styles.css 内联进 preview.html。
 *
 * 为什么内联：preview.html 是给人在浏览器/预览面板里直接打开的样张。
 * 用 <link href="src/renderer/src/styles.css"> 这种相对路径，
 * 一旦不是在项目根用 file:// 打开（例如被预览面板单独渲染），
 * 路径解析失败 → 整页无样式，看起来像「CSS 丢了」。
 *
 * 为什么用脚本而不是手工复制：手工复制会和 styles.css 漂移。
 * 这里以 styles.css 为唯一源，每次跑一下重新生成，改完样式不会忘。
 *
 * 用法：node scripts/sync-preview.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cssPath = path.join(root, 'src/renderer/src/styles.css')
const htmlPath = path.join(root, 'preview.html')

const BEGIN = '<!-- css:begin 由 scripts/sync-preview.mjs 生成，勿手改 -->'
const END = '<!-- css:end -->'
const LINK = /[ \t]*<link\s+rel="stylesheet"\s+href="src\/renderer\/src\/styles\.css"\s*\/?>\n/

const css = fs.readFileSync(cssPath, 'utf8').replace(/\s+$/, '')
let html = fs.readFileSync(htmlPath, 'utf8')

const block = `${BEGIN}\n    <style>\n${css}\n    </style>\n    ${END}\n`

let how
if (html.includes(BEGIN) && html.includes(END)) {
  const from = html.indexOf(BEGIN)
  const to = html.indexOf(END) + END.length + 1
  html = html.slice(0, from) + block + html.slice(to)
  how = '替换已有内联块'
} else if (LINK.test(html)) {
  html = html.replace(LINK, block)
  how = '把 <link> 换成内联块'
} else {
  console.error('找不到 <link> 也没有内联标记，preview.html 结构变了，先看一眼再跑。')
  process.exit(1)
}

fs.writeFileSync(htmlPath, html, 'utf8')

// 自检：内联后不该再有任何外部样式引用
const dirty = /<link[^>]+stylesheet/i.test(html)

console.log(`已同步 preview.html（${how}）`)
console.log(`  来源: src/renderer/src/styles.css  ${(css.length / 1024).toFixed(1)} KB / ${css.split('\n').length} 行`)
console.log(`  产物: preview.html  ${(html.length / 1024).toFixed(1)} KB / ${html.split('\n').length} 行`)
console.log(`  外部样式引用: ${dirty ? '仍存在（需检查）' : '无，已自包含'}`)
if (dirty) process.exit(1)
