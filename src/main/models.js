/**
 * 模型配置的解析层。
 *
 * 为什么不再用「接口地址 + 模型名」两个输入框：
 * 手填两个字符串，人和程序对「现在到底在跟谁说话」的理解永远对不上——
 * 地址可能是官方域名，也可能是某个网关；模型名可能是真名，也可能是网关的别名。
 * 出错的时候，它不会报错，它只是变笨了，而你没有任何东西可以对照。
 *
 * 所以照 opencode 的做法：把「有哪些 provider、每个 provider 有哪些模型、现在用哪个」
 * 写成一份 JSON，引用一律用 `provider/model` 这种带前缀的形式。
 * **JSON 是唯一的源**，其它字段都是它的派生物。
 *
 * 格式（外面那一圈 $schema、tools、mcp 之类不认识就忽略，只取这三样）：
 *
 *   {
 *     "provider": {
 *       "deepseek": {
 *         "name": "DeepSeek",
 *         "options": { "baseURL": "https://api.deepseek.com/v1", "apiKey": "{env:DEEPSEEK_API_KEY}" },
 *         "models": {
 *           "deepseek-chat": { "name": "DeepSeek Chat", "limit": { "context": 64000 } }
 *         }
 *       }
 *     },
 *     "model": "deepseek/deepseek-chat"
 *   }
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

// opencode 用这个包名表示「OpenAI 兼容协议」。本应用只会说这一种协议，
// 所以别的包名不是不能用，是用了也不会按它想的方式工作 —— 要明确说出来。
const OPENAI_COMPATIBLE = '@ai-sdk/openai-compatible'

const VAR_RE = /\{(env|file):([^}]+)\}/g

function expandHome(p) {
  const s = String(p || '')
  if (s === '~') return os.homedir()
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2))
  return s
}

/**
 * 替换 {env:NAME} 与 {file:path}。
 *
 * 这两个占位符抄自 opencode，用处很实在：不用把 key 抄进配置文件里，
 * 也不用在多台机器之间同步同一份 key。没设的变量替换成空串（和 opencode 一致），
 * 但要记一条警告 —— 空 key 的后果是一个 401，而不是「你猜哪里错了」。
 */
function substitute(value, baseDir, warns, where) {
  if (typeof value === 'string') {
    // 整值就是一个占位符时保留原类型（{file:xxx} 里的数字不会被变成字符串）
    const whole = value.trim().match(/^\{(env|file):([^}]+)\}$/)
    if (whole) {
      const got = readVar(whole[1], whole[2].trim(), baseDir, warns, where)
      return got
    }
    return value.replace(VAR_RE, (m, kind, name) => {
      const got = readVar(kind, String(name).trim(), baseDir, warns, where)
      return got == null ? '' : String(got)
    })
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, baseDir, warns, where))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, baseDir, warns, where)
    return out
  }
  return value
}

function readVar(kind, name, baseDir, warns, where) {
  if (kind === 'env') {
    const v = process.env[name]
    if (v === undefined) {
      warns.push(`${where} 引用了环境变量 ${name}，但它没有设，按空值处理`)
      return ''
    }
    return v
  }
  const file = path.isAbsolute(expandHome(name)) ? expandHome(name) : path.resolve(baseDir || '.', expandHome(name))
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch (e) {
    warns.push(`${where} 引用的文件读不到：${file}`)
    return ''
  }
}

/** 把 "provider/model" 切开。按第一个斜杠切：模型 id 本身可以带斜杠（google/gemma-3n-e4b）。 */
function splitRef(ref) {
  const s = String(ref || '').trim()
  const i = s.indexOf('/')
  if (i <= 0 || i === s.length - 1) return null
  return { providerId: s.slice(0, i), modelId: s.slice(i + 1) }
}

/**
 * 解析并校验。**一次把所有问题都说出来**，不要修一个报一个。
 * @returns {{ok:boolean, errors:string[], warnings:string[], providers:Array, ref:string, selected:Object|null}}
 */
function normalize(raw, opts = {}) {
  const errors = []
  const warnings = []
  const baseDir = opts.baseDir || process.cwd()

  const src = substitute(raw, baseDir, warnings, '配置')

  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    return { ok: false, errors: ['这份 JSON 的顶层必须是一个对象'], warnings, providers: [], ref: '', selected: null }
  }

  const provNode = src.provider
  if (!provNode || typeof provNode !== 'object' || Array.isArray(provNode)) {
    return {
      ok: false,
      errors: ['缺 provider 段。至少要有一个 provider，形如 "provider": { "deepseek": { ... } }'],
      warnings,
      providers: [],
      ref: '',
      selected: null
    }
  }

  const providers = []
  for (const [id, conf] of Object.entries(provNode)) {
    if (id.includes('/')) {
      errors.push(`provider 的 id 不能带斜杠（${id}）：引用是 "provider/model"，带斜杠就切不开了`)
      continue
    }
    if (!conf || typeof conf !== 'object') {
      errors.push(`${id}：这个 provider 的内容不是一个对象`)
      continue
    }

    if (conf.npm && conf.npm !== OPENAI_COMPATIBLE) {
      warnings.push(`${id}：npm 写的是 ${conf.npm}，本应用只会说 OpenAI 兼容协议，这个字段被忽略`)
    }

    const options = conf.options && typeof conf.options === 'object' ? conf.options : {}
    const baseUrl = String(options.baseURL || options.baseUrl || '').trim()
    if (!baseUrl) {
      errors.push(`${id}：缺 options.baseURL，没有地址就没法发请求`)
    } else if (!/^https?:\/\//i.test(baseUrl)) {
      errors.push(`${id}：baseURL 必须以 http:// 或 https:// 开头（现在是 ${baseUrl}）`)
    }

    const apiKey = String(options.apiKey == null ? '' : options.apiKey).trim()
    if (!apiKey) {
      // 本地模型（ollama / lmstudio）本来就不要 key，所以这是提醒不是错误。
      warnings.push(`${id}：没有 apiKey，本地模型没关系，云端服务商这样会 401`)
    }

    const modelNode = conf.models
    if (!modelNode || typeof modelNode !== 'object' || !Object.keys(modelNode).length) {
      errors.push(`${id}：缺 models，一个模型都没有就等于这个 provider 用不了`)
      continue
    }

    const models = []
    for (const [mid, mconf] of Object.entries(modelNode)) {
      const m = mconf && typeof mconf === 'object' ? mconf : {}
      const limit = m.limit && typeof m.limit === 'object' ? m.limit : {}
      const context = Number(limit.context)
      models.push({
        id: mid,
        // opencode 里 models 的键是真实请求用的 id，name 只是显示名
        name: String(m.name || mid),
        context: Number.isFinite(context) && context > 0 ? Math.floor(context) : 0,
        output: Number(limit.output) > 0 ? Math.floor(Number(limit.output)) : 0
      })
    }

    providers.push({
      id,
      name: String(conf.name || id),
      baseUrl,
      apiKey,
      hasKey: Boolean(apiKey),
      models
    })
  }

  if (!providers.length && !errors.length) errors.push('provider 段里一个可用的都没有')
  if (!providers.length) {
    return { ok: false, errors, warnings, providers: [], ref: '', selected: null }
  }

  // ---- 选哪个 ----
  let ref = String(src.model || '').trim()
  if (!ref) {
    const first = providers[0]
    ref = first.id + '/' + first.models[0].id
    warnings.push(`顶层没写 model，先按第一个用：${ref}`)
  }

  const parsed = splitRef(ref)
  let selected = null
  if (!parsed) {
    errors.push(`model 要写成 "provider/model" 的形式（现在是 "${ref}"）`)
  } else {
    const p = providers.find((x) => x.id === parsed.providerId)
    if (!p) {
      errors.push(`model 指向的 provider 不存在：${parsed.providerId}`)
    } else {
      const m = p.models.find((x) => x.id === parsed.modelId)
      if (!m) {
        errors.push(`${parsed.providerId} 下面没有这个模型：${parsed.modelId}`)
      } else {
        selected = {
          providerId: p.id,
          providerName: p.name,
          modelId: m.id,
          modelName: m.name,
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          contextWindow: m.context
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, providers, ref, selected }
}

/**
 * 从已保存的配置算出「实际要用的四个值」。
 *
 * 这四个值是 llm.js 唯一认的东西。它们不再由人直接填，而是每次从 modelConfig 现算 ——
 * 这样就没有「两边不一致」这件事了：不一致的可能是零，因为只有一份是源。
 * @returns {{baseUrl,apiKey,model,contextWindow}|null} 解析不出来返回 null
 */
function resolve(cfg, opts = {}) {
  if (!cfg || !cfg.modelConfig) return null
  const r = normalize(cfg.modelConfig, opts)
  if (!r.ok || !r.selected) return null
  return {
    baseUrl: r.selected.baseUrl,
    apiKey: r.selected.apiKey,
    model: r.selected.modelId,
    contextWindow: r.selected.contextWindow || 0
  }
}

/** 老配置（只有 baseUrl/apiKey/model 三个手填字段）→ 一份等价的 opencode JSON。只在新装/升级时用一次。 */
function seedFromLegacy(cfg) {
  const c = cfg || {}
  const url = String(c.baseUrl || '').trim()
  const model = String(c.model || '').trim() || 'default'
  const key = String(c.apiKey || '').trim()

  // provider 的 id 从域名里取，好在 JSON 里认出这是谁
  let id = 'default'
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname
    const parts = host.split('.')
    if (parts.length >= 2) id = parts[parts.length - 2]
  } catch {}
  id = id.replace(/[^a-zA-Z0-9_-]/g, '') || 'default'

  const conf = { name: id }
  conf.options = { baseURL: url || 'https://api.deepseek.com/v1' }
  if (key) conf.options.apiKey = key
  conf.models = { [model]: { name: model } }
  if (Number(c.contextWindow) > 0) conf.models[model].limit = { context: Number(c.contextWindow) }

  return { provider: { [id]: conf }, model: id + '/' + model }
}

module.exports = { normalize, resolve, seedFromLegacy, splitRef, substitute, OPENAI_COMPATIBLE }
