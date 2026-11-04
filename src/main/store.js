const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.7,
  contextWindow: 32000,
  // 这里原来有 checkpoints（08:30／21:30 两个钟点）。已作废（D039／O11），
  // 字段一并移除：留一个空数组也会让后来的人以为「这东西还在，只是没配」。
  // 打扰的重建见 M2／P-10，判据是约定而不是钟点。
  quietDate: '', // 等于今天日期时，当天所有检查点静音
  windowBounds: null,
  // 身份：登录做出来之前先给一个本地占位用户
  currentUser: 'local',
  currentAgent: 'hundun'
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
