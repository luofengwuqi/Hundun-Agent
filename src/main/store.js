const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const models = require('./models')

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.7,
  contextWindow: 32000,
  // 下面三个（baseUrl／apiKey／model）从 modelConfig 派生，不再由人直接填。
  // 留着是因为 llm.js 和连接测试只认这三个值 —— 但**源只有 modelConfig 一份**，
  // 每次写入都会重算，所以不存在「两边不一致」这件事。
  modelConfig: null,
  // modelConfig 存在但解析不通（比如 {env:} 的变量没设了）。界面据此显红，
  // 而不是让它在「配置好好的」的假象里用空地址去发请求。
  modelBroken: false,
  // 这里原来有 checkpoints（08:30／21:30 两个钟点）。已作废（D039／O11），
  // 字段一并移除：留一个空数组也会让后来的人以为「这东西还在，只是没配」。
  // 打扰的重建见 M2／P-10，判据是约定而不是钟点。
  quietDate: '', // 等于今天日期时，当天所有检查点静音
  // 打扰的三个参数（D045）。默认关、默认空、默认 0 不是「还没配好」，
  // 是默认态本身（D047）——填了才算他要。
  // 第四个参数「今天别烦我」是当天的作废，不是配置，仍在顶层 quietDate。
  disturb: { on: false, windows: [], dailyLimit: 0 },
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

/** {file:~/.secrets/key} 里的相对路径按配置文件所在目录算，和 opencode 一致。 */
function modelOpts() {
  return { baseDir: path.dirname(configPath()) }
}

/**
 * 模型配置的写入守卫。返回归一化结果，不合法则抛。
 * 抛出去的错误带 modelErrors / modelWarnings 两个数组，IPC 层原样交给界面逐条显示 ——
 * 「配置错了」这四个字对他没有用，他需要知道是哪一个 provider 的哪一行。
 */
function assertModel(cfg) {
  const r = models.normalize(cfg.modelConfig, modelOpts())
  if (!r.ok || !r.selected) {
    const err = new Error(r.errors.length ? r.errors.join('；') : '解析不出当前选中的模型')
    err.modelErrors = r.errors
    err.modelWarnings = r.warnings
    throw err
  }
  return r
}

/**
 * 从 modelConfig 现算那四个值，**只在内存里，不落盘**。
 *
 * 不落盘是有原因的：{env:XXX} 和 {file:path} 的全部意义就是「key 不写在配置文件里」。
 * 要是保存时展开一遍再写回去，占位符就白写了，key 又躺回 config.json 明文。
 *
 * 解析不出来的时候宁可空着，**绝不退回默认值**：空地址会当场报「还没有填 API 地址」，
 * 而默认值会让它带着一个能用的地址、一个错的模型名去说话 —— 后者不报错，只是答得不对。
 */
function withDerivedModel(state) {
  if (!state.modelConfig) {
    state.modelBroken = false
    return state
  }
  const r = models.resolve(state, modelOpts())
  if (r) {
    state.baseUrl = r.baseUrl
    state.apiKey = r.apiKey
    state.model = r.model
    if (r.contextWindow > 0) state.contextWindow = r.contextWindow
    state.modelBroken = false
  } else {
    state.baseUrl = ''
    state.apiKey = ''
    state.model = ''
    state.modelBroken = true
  }
  return state
}

function read() {
  if (cache) return cache
  let state
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    // disturb 单独合并：顶层展开只换整块，老配置里只有 {on:true} 时
    // windows / dailyLimit 会一起消失，而读它的人（P-10 的调度器）不会想到要兜底。
    state = {
      ...DEFAULTS,
      ...parsed,
      disturb: { ...DEFAULTS.disturb, ...(parsed.disturb || {}) }
    }
  } catch {
    state = JSON.parse(JSON.stringify(DEFAULTS))
  }
  cache = withDerivedModel(state)
  return cache
}

/** 有 modelConfig 时，派生值不落盘（见 withDerivedModel）。老配置没有这一层，三字段原样保留。 */
function persistable(cfg) {
  const out = { ...cfg }
  delete out.modelBroken
  delete out.hasApiKey
  if (out.modelConfig) {
    delete out.baseUrl
    delete out.apiKey
    delete out.model
  }
  return out
}

function write(patch) {
  const next = { ...read(), ...patch }

  // 模型那四样只能从 modelConfig 推出来。谁要是直接把 baseUrl／apiKey／model 写进来，
  // 就等于在源之外另立一份事实，将来必然对不上 —— 这里统一重算，不给分叉的机会。
  // 校验不过就抛，**一个字段都不落盘**：半写是最坏的结果（JSON 是新的、地址是旧的，
  // 它会在错误的地址上说话，而且不报错）。
  if ('modelConfig' in patch) assertModel(next)
  withDerivedModel(next)

  cache = next
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(persistable(next), null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {}
  return next
}

/** 给渲染进程用：不带任何敏感字段以外的裁剪，key 由用户自己填自己看 */
function publicConfig() {
  const c = read()
  return {
    ...c,
    hasApiKey: Boolean(c.apiKey && c.apiKey.trim()),
    // 老配置（只有手填的三个字段）第一次打开设置页时，用它生成一份等价的 JSON 填进编辑器。
    // 只在内存里生成，不落盘 —— 他没点「应用」之前，配置一个字都不该变。
    modelSeed: c.modelConfig ? null : models.seedFromLegacy(c)
  }
}

/** 只解析不写，给设置页实时校验用。和写入共用同一套 opts —— 两处各算一次 baseDir 早晚会不一样。 */
function previewModel(obj) {
  return models.normalize(obj, modelOpts())
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

/** 丢掉内存缓存，下次 read 重新读盘。只给测试用（生产里没有「换配置」这件事）。 */
function _reset() {
  cache = null
}

module.exports = {
  read,
  write,
  publicConfig,
  previewModel,
  todayStr,
  isQuietToday,
  toggleQuiet,
  DEFAULTS,
  _reset
}
