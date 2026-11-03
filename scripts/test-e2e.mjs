/**
 * 端到端测试：真的跑一轮对话。
 *
 * 做法：把 electron 模块替换成一个用 node:http 实现的 net 桩，
 * 这样 conversation.send 的完整链路（拼提示 → 流式收字 → 抠记忆块 → 落盘）
 * 都能在纯 Node 里跑，不需要 Chromium。
 *
 * 依赖：先起假模型服务
 *   python3 scripts/mock-llm.py 8787
 *   node scripts/test-e2e.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const DEV = path.join(ROOT, '.dev')
const TMP = path.join(DEV, 'e2e')
const PORT = 8787

/* ---------- 自己拉起假模型服务（不依赖外部先启动） ---------- */

const mock = spawn('/usr/bin/python3', [path.join(ROOT, 'scripts/mock-llm.py'), String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe']
})
mock.stdout.on('data', () => {})
mock.stderr.on('data', (d) => process.stderr.write('[mock] ' + d))

let up = false
for (let i = 0; i < 40 && !up; i++) {
  await new Promise((r) => setTimeout(r, 120))
  up = await new Promise((resolve) => {
    const http = require('node:http')
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST' },
      (res) => {
        res.resume()
        resolve(true)
      }
    )
    req.on('error', () => resolve(false))
    req.setHeader('Content-Type', 'application/json')
    req.end(JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }))
  })
}
if (!up) {
  console.error('假模型服务没起来，端口 ' + PORT)
  mock.kill()
  process.exit(1)
}

let pass = 0
let fail = 0
const ok = (c, n, e = '') => {
  if (c) {
    pass++
    console.log('  ✓ ' + n)
  } else {
    fail++
    console.log('  ✗ ' + n + (e ? '  → ' + e : ''))
  }
}

fs.mkdirSync(DEV, { recursive: true })

/* ---------- electron 桩 ---------- */

const stub = path.join(DEV, 'electron-stub.cjs')
fs.writeFileSync(
  stub,
  `
const http = require('http')
const https = require('https')
const { EventEmitter } = require('events')

const app = { getPath: () => process.env.HUNDUN_CONFIG_DIR }

function request(options) {
  const emitter = new EventEmitter()
  const u = new URL(options.url)
  const mod = u.protocol === 'https:' ? https : http
  const req = mod.request(
    { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: options.method || 'GET' },
    (res) => emitter.emit('response', res)
  )
  req.on('error', (e) => emitter.emit('error', e))
  const api = {
    setHeader: (k, v) => req.setHeader(k, v),
    write: (d) => req.write(d),
    end: () => req.end(),
    abort: () => req.destroy(),
    on: (ev, cb) => { emitter.on(ev, cb); return api }
  }
  return api
}

module.exports = { app, net: { request } }
`
)

/* ---------- 打包（electron → 桩） ---------- */

const entry = path.join(DEV, 'e2e-entry.js')
const bundle = path.join(DEV, 'e2e-main.cjs')

fs.writeFileSync(
  entry,
  `
exports.life = require(${JSON.stringify(path.join(ROOT, 'src/main/life.js'))})
exports.conversation = require(${JSON.stringify(path.join(ROOT, 'src/main/conversation.js'))})
exports.llm = require(${JSON.stringify(path.join(ROOT, 'src/main/llm.js'))})
`
)

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: bundle,
  logLevel: 'silent',
  plugins: [
    {
      name: 'stub-electron',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: stub }))
      }
    }
  ]
})

/* ---------- 沙箱环境 ---------- */

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, 'config'), { recursive: true })
fs.writeFileSync(
  path.join(TMP, 'config/config.json'),
  JSON.stringify({
    baseUrl: 'http://127.0.0.1:8787/v1',
    apiKey: 'test-key',
    model: 'mock',
    temperature: 0.7,
    contextWindow: 32000,
    checkpoints: []
  })
)
process.env.HUNDUN_LIFE_DIR = path.join(TMP, 'life')
process.env.HUNDUN_CONFIG_DIR = path.join(TMP, 'config')

const { life, conversation, llm } = require(bundle)

/* ---------- 断言 ---------- */

console.log('\n[e2e] 接口地址归一化')
ok(llm.endpoint('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1/chat/completions', '补全 /v1 后缀')
ok(llm.endpoint('https://x.com/v1/') === 'https://x.com/v1/chat/completions', '去掉尾部斜杠')
ok(llm.endpoint('api.x.com/v1') === 'https://api.x.com/v1/chat/completions', '缺协议时补 https')

console.log('\n[e2e] 流式解析')
let deltas = 0
const text = await llm.streamChat(
  {
    baseUrl: 'http://127.0.0.1:8787/v1',
    apiKey: 'test-key',
    model: 'mock',
    messages: [{ role: 'user', content: '开始对话' }]
  },
  () => deltas++
)
ok(deltas > 3, '收到多次增量（真的在流式）', 'deltas=' + deltas)
ok(text.length > 5, '拼出完整回复：' + text.slice(0, 20) + '…')

console.log('\n[e2e] 一轮完整对话')
life.ensureLife()
const result = await conversation.send('我是写后端的，晚上效率高')
ok(Boolean(result.text), '拿到回复正文')
ok(!result.text.includes('<memory>'), '正文里没有残留记忆标签')
ok(result.notes >= 1, '识别出记忆块', 'notes=' + result.notes)
ok(result.written.length >= 1, '记忆已落盘：' + result.written.join(', '))

const journal = fs.readFileSync(path.join(TMP, 'life/memory', life.dateStr() + '.md'), 'utf8')
ok(journal.includes('主要做开发'), '日记里能看到刚记下的内容')

const state = conversation.state()
ok(state.history.length === 2, '历史里是一问一答两轮', '实际 ' + state.history.length)
ok(state.history[1].role === 'assistant', '第二轮是 assistant')

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 通过 / ' + fail + ' 失败\n')
mock.kill()
process.exit(fail === 0 ? 0 : 1)
