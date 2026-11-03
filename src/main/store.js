const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.7,
  contextWindow: 32000,
  // 检查点：默认两个点。时间由用户在设置里改，不硬编码在代码里。
  checkpoints: [
    { id: 'morning', label: '早间', time: '08:30', enabled: true },
    { id: 'evening', label: '晚间', time: '21:30', enabled: true }
  ],
  quietDate: '', // 等于今天日期时，当天所有检查点静音
  windowBounds: null
}

let cache = null

function configPath() {
  const base = process.env.HUNDUN_CONFIG_DIR || app.getPath('userData')
  return path.join(base, 'config.json')
}

function read() {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    cache = { ...DEFAULTS, ...parsed }
    // 数组字段单独兜底，避免旧配置缺项
    if (!Array.isArray(cache.checkpoints) || cache.checkpoints.length === 0) {
      cache.checkpoints = DEFAULTS.checkpoints.map((c) => ({ ...c }))
    }
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS))
  }
  return cache
}

function write(patch) {
  const next = { ...read(), ...patch }
  cache = next
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {}
  return next
}

/** 给渲染进程用：不带任何敏感字段以外的裁剪，key 由用户自己填自己看 */
function publicConfig() {
  const c = read()
  return { ...c, hasApiKey: Boolean(c.apiKey && c.apiKey.trim()) }
}

function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function isQuietToday() {
  return read().quietDate === todayStr()
}

function toggleQuiet() {
  const on = !isQuietToday()
  write({ quietDate: on ? todayStr() : '' })
  return on
}

module.exports = { read, write, publicConfig, todayStr, isQuietToday, toggleQuiet, DEFAULTS }
