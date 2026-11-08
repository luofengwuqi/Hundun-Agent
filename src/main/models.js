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
 *
 * 多个模型排一条链（第二个起是备用）时，顺序写在 `x-hundun.modelOrder` 里：
 *
 *   "model": "deepseek/deepseek-chat",
 *   "x-hundun": { "modelOrder": ["deepseek/deepseek-chat", "local/qwen2.5:7b"] }
 *
 * 顶层 `model` 仍然是首选——它是 opencode 的标准字段，也是他手改 JSON 时最直觉的入口。
 * 两者冲突时以 `model` 为准并把它提到最前，否则就会变成「改了 model 却没反应」。
 * 写入时这两个值永远一起重算，所以不存在两份互相矛盾的事实。
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

/* ============================================================
   简单模式（D077）
   ============================================================

   为什么还要有简单模式：
   一份 opencode 格式的 JSON 能说清「跟谁说话」的一切，但它要填 地址、provider id、
   models 下的键、limit.context、引用里的斜杠。第一次用的人只知道自己买的是哪家的 key ——
   他得先学会这套格式，才能说第一句话。那是把实现细节收成了入场费。

   所以给一份**预置目录**：选一家，填 key，就完事。目录里的地址和模型名都是写死的常量，
   不再是他手填的两个字符串 —— 这正是当初改用 JSON 要治的那个病（地址可能是网关、
   模型名可能是别名，错了不报错，只是变笨）。

   简单模式不是另一套配置，它是**同一份 JSON 的另一种写法**：
   切换时会用 simpleToConfig 把 JSON 重新生成一遍，写完还是走 normalize 那一条路。
   所以只有一份源、一套校验、一条备用链 —— 不存在「两种模式互相不认识」。
*/

/**
 * 写死的目录。**它会过期，这是一条已知的债。**
 *
 * 这些 id 是 2026-11-08 逐家核对过的（官方模型页 + OpenRouter 的 /models 接口）：
 * 之前那份是更早写的，六家里五家已经下架 —— DeepSeek 的 deepseek-chat / deepseek-reasoner
 * 早在 2026-07-24 就停了，Kimi 的 k2 系列 2026-05-25 下线，选出来只会在发消息时 404。
 *
 * 顺序是「便宜够用的在前，旗舰在后」，因为**没选模型时用的是第一个**（simpleToConfig），
 * 而第一个不该是最贵的那个。界面上那句提示跟着改成「排在前面的是默认，越往后越强也越贵」。
 *
 * 真正的解法不是把这份名单改对，是别写死：这些家全都支持 GET /models
 * （OpenRouter 那个 461 条就是这么拉的）。等有人愿意为它开一个界面入口，这份就该退役。
 *
 * 有的家（Anthropic、Gemini 原生协议）不是 OpenAI 兼容的，列进去只会 404 ——
 * 那不是「支持得不好」，是根本不通。所以只放真能说 OpenAI 兼容接口的；其它一律走「自定义」。
 */
const PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      // 官方现役只有这两个（deepseek-flash 由 V4.1-Flash-1017 提供服务）
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', context: 1000000 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', context: 1000000 }
    ]
  },
  {
    id: 'moonshot',
    name: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    models: [
      // k2 系列已下线（2026-05-25），现役是 K3.1 一档、K3 一档。没有便宜档，
      // 所以默认就是 pro 本身；highspeed 只是同样的脑子跑得快些，放后面
      { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', context: 1000000 },
      { id: 'kimi-k3.1-pro-highspeed', name: 'Kimi K3.1 Pro 高速版', context: 1000000 }
    ]
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    models: [
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', context: 1000000 },
      { id: 'glm-5.3', name: 'GLM-5.3', context: 1000000 }
    ]
  },
  {
    id: 'qwen',
    name: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    models: [
      { id: 'qwen3.7-flash', name: 'Qwen3.7 Flash', context: 1000000 },
      { id: 'qwen3.7-max', name: 'Qwen3.7 Max', context: 1000000 }
    ]
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash（硅基）', context: 1048576 },
      { id: 'deepseek-ai/DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro（硅基）', context: 1048576 }
    ]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    models: [
      { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context: 1048576 },
      { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', context: 1000000 }
    ]
  },
  {
    id: 'ollama',
    name: 'Ollama（本机）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    noKey: true,
    models: [{ id: 'qwen3:8b', name: 'Qwen3 8B', context: 32000 }]
  },
  {
    id: 'custom',
    name: '自定义',
    baseUrl: '',
    custom: true,
    models: []
  }
]

/** 只给界面看的目录副本。apiKey 不在里面 —— 那是他自己填的，不是目录带的。 */
function presets() {
  return PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    keyUrl: p.keyUrl || '',
    noKey: Boolean(p.noKey),
    custom: Boolean(p.custom),
    models: p.models.map((m) => ({ ...m }))
  }))
}

/**
 * 简单模式那几项 → 一份 opencode JSON。
 *
 * @param {{preset?:string, baseUrl?:string, apiKey?:string, model?:string}} simple
 * @param {{config?:object}} opts config 是「切换前那份」，用来把自定义服务商的模型带过来
 *
 * 几个刻意的取舍：
 * - 目录里的地址是常量，**不接受他自己改**：能改的话就成了「手填地址」的老问题。
 *   要改地址，去自定义那一档，或者切到「直接写 JSON」。
 * - key 里带 {env:} / {file:} 就原样写进去，不展开 —— 展开再落盘等于把 key 又抄成明文。
 * - 只保留这一个 provider。留着别的家的 provider，目录里就查不到它的 key 该填在哪。
 */
function simpleToConfig(simple, opts = {}) {
  const s = simple && typeof simple === 'object' ? simple : {}
  const prev = opts.config && typeof opts.config === 'object' ? opts.config : {}
  const preset = String(s.preset || '').trim()

  const def = PRESETS.find((p) => p.id === preset)
  if (!def) {
    return { provider: {}, 'x-hundun': { simple: { ...s, preset: preset || 'deepseek' } } }
  }

  const custom = def.custom
  const baseUrl = custom ? String(s.baseUrl || '').trim() : def.baseUrl
  const apiKey = String(s.apiKey == null ? '' : s.apiKey).trim()

  // 模型名。目录以外的名字也允许手填：目录不可能穷举人家新发的模型，
  // 而「目录更新不及时」不该表现成「用不了」，只该表现成「这里没有，你自己填」。
  const catalog = def.models.map((m) => m.id)
  const picked = String(s.model || '').trim()
  const modelId = picked || catalog[0] || ''

  const conf = { name: def.name }
  conf.npm = OPENAI_COMPATIBLE
  conf.options = { baseURL: baseUrl }
  if (apiKey) conf.options.apiKey = apiKey

  const models = {}
  for (const m of def.models) models[m.id] = { name: m.name, limit: { context: m.context } }
  if (modelId && !models[modelId]) {
    // 他手填的模型名：上下文未知，不写 limit —— 写了就是编一个数出来。
    models[modelId] = { name: modelId }
  }
  // 自定义服务商从上一份配置里带过来的模型：他自己写过的名字，别在切换时弄丢。
  if (custom && prev.provider && prev.provider[def.id] && prev.provider[def.id].models) {
    for (const [mid, mconf] of Object.entries(prev.provider[def.id].models)) {
      if (!models[mid]) models[mid] = JSON.parse(JSON.stringify(mconf || {}))
    }
  }

  const out = { provider: { [def.id]: { ...conf, models } } }
  if (modelId) out.model = def.id + '/' + modelId
  out['x-hundun'] = {
    simple: { preset: def.id, baseUrl: custom ? baseUrl : '', apiKey, model: modelId }
  }
  return out
}

/**
 * 反过来：从一份 JSON 认出现在是简单模式的哪几家。
 *
 * 只有「目录里的 provider、目录里写的地址、只有一个 model 引用」时才认成简单模式；
 * 认不出就返回 null，界面退回 JSON —— 与其猜错、把他手写的备用链丢掉，不如不认。
 */
function configToSimple(json) {
  const ext = json && json['x-hundun'] && typeof json['x-hundun'] === 'object' ? json['x-hundun'] : {}
  const s = ext.simple && typeof ext.simple === 'object' ? ext.simple : null
  if (!s) return null
  const def = PRESETS.find((p) => p.id === String(s.preset || ''))
  if (!def) return null
  const sel = (() => {
    const nodes = (json && json.model) || ''
    const r = splitRef(nodes)
    if (!r) return ''
    return r.providerId === def.id ? r.modelId : ''
  })()
  return {
    preset: def.id,
    baseUrl: String(s.baseUrl || ''),
    apiKey: String(s.apiKey || ''),
    model: sel || String(s.model || ''),
    models: def.custom
      ? Object.keys((json.provider && json.provider[def.id] && json.provider[def.id].models) || {})
      : def.models.map((m) => m.id)
  }
}

/**
 * 解析并校验。**一次把所有问题都说出来**，不要修一个报一个。
 * @returns {{ok:boolean, errors:string[], warnings:string[], providers:Array, ref:string, selected:Object|null, simple:boolean}}
 */
function normalize(raw, opts = {}) {
  const errors = []
  const warnings = []
  const baseDir = opts.baseDir || process.cwd()

  // 简单模式：它只认这三样，其余字段（尤其是 x-hundun.simple）原样带过 ——
  // 少写一个字段就会把「用户选的是简单模式」这件事悄悄丢掉，下次打开又变成直接写 JSON。
  const simple = Boolean(raw && typeof raw === 'object' && raw['x-hundun'] && raw['x-hundun'].simple)

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

  // ---- 排一条链：先用谁、连不上再用谁 ----
  //
  // 顺序存在 JSON 里（x-hundun.modelOrder），不另存到 config.json。理由和上面一样：
  // 「有哪些模型」和「先用哪一个」是同一件事的两半，分开存就一定会有对不上的一天，
  // 而对不上的时候它不报错 —— 只是用的不是他排的那个。
  const ext = src['x-hundun'] && typeof src['x-hundun'] === 'object' ? src['x-hundun'] : {}
  const orderRaw = Array.isArray(ext.modelOrder) ? ext.modelOrder : []

  const known = new Map()
  for (const p of providers) {
    for (const m of p.models) known.set(p.id + '/' + m.id, { p, m })
  }
  const toItem = ({ p, m }) => ({
    providerId: p.id,
    providerName: p.name,
    modelId: m.id,
    modelName: m.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    contextWindow: m.context
  })

  // 首选：顶层 model 说了算；它空着才看顺序的第一项；都没有就挑第一个能用的。
  let head = String(src.model || '').trim()
  if (!head) {
    const firstInOrder = orderRaw.map((r) => String(r || '').trim()).find(Boolean)
    if (firstInOrder) {
      head = firstInOrder
    } else {
      head = providers[0].id + '/' + providers[0].models[0].id
      warnings.push(`顶层没写 model，先按第一个用：${head}`)
    }
  }

  let selected = null
  const parsed = splitRef(head)
  if (!parsed) {
    errors.push(`model 要写成 "provider/model" 的形式（现在是 "${head}"）`)
  } else {
    const p = providers.find((x) => x.id === parsed.providerId)
    if (!p) {
      errors.push(`model 指向的 provider 不存在：${parsed.providerId}`)
    } else {
      const m = p.models.find((x) => x.id === parsed.modelId)
      if (!m) {
        errors.push(`${parsed.providerId} 下面没有这个模型：${parsed.modelId}`)
      } else {
        selected = toItem({ p, m })
      }
    }
  }

  // 备选：顺序里除首选之外的。**引用不到的只丢一项、记一条警告，不整份报错** ——
  // 少一个备用模型不应该让整个配置不可用，那会把「备用」变成「负担」。
  const chain = selected ? [selected] : []
  for (const raw of orderRaw) {
    const ref = String(raw || '').trim()
    if (!ref || ref === head) continue
    if (chain.some((c) => c.providerId + '/' + c.modelId === ref)) continue
    const hit = known.get(ref)
    if (hit) chain.push(toItem(hit))
    else warnings.push(`顺序里的 "${ref}" 找不到对应模型，已跳过`)
  }

  return { ok: errors.length === 0, errors, warnings, providers, ref: head, selected, chain, simple }
}

/** 依次尝试的整条链。只有一个模型时就是它自己。 */
function chainOf(raw, opts = {}) {
  const r = normalize(raw, opts)
  return r.ok ? r.chain : []
}

/** JSON 里的顺序（首选在前）。规则与 normalize 一致：顶层 model 永远提到最前。 */
function orderOf(json) {
  const ext = json && json['x-hundun'] && typeof json['x-hundun'] === 'object' ? json['x-hundun'] : {}
  const list = Array.isArray(ext.modelOrder) ? ext.modelOrder : []
  const out = []
  const head = String((json && json.model) || '').trim()
  if (head) out.push(head)
  for (const raw of list) {
    const ref = String(raw || '').trim()
    if (ref && !out.includes(ref)) out.push(ref)
  }
  return out
}

/** 把顺序写回去：x-hundun.modelOrder 是源，顶层 model 是它的第一项（给 opencode 看的）。 */
function withOrder(json, refs) {
  const out = JSON.parse(JSON.stringify(json || {}))
  const list = []
  for (const raw of refs) {
    const ref = String(raw || '').trim()
    if (ref && !list.includes(ref)) list.push(ref)
  }
  const ext = out['x-hundun'] && typeof out['x-hundun'] === 'object' ? out['x-hundun'] : {}
  out['x-hundun'] = { ...ext, modelOrder: list }
  if (list.length) out.model = list[0]
  else delete out.model
  return out
}

/**
 * 改顺序／加一个／删一个。都是纯函数，返回新的 JSON 对象，不碰磁盘。
 * 放在这里而不是界面里，是因为界面那一份迟早会和解析那一份走偏 —— 而排序错了的表现
 * 只是「它用的模型不是排第一的那个」，没有任何报错。
 */
function moveModel(json, ref, to) {
  const list = orderOf(json)
  const i = list.indexOf(String(ref || '').trim())
  if (i < 0) return { ok: false, error: '这个模型不在列表里' }
  const target = Math.max(0, Math.min(list.length - 1, Number(to)))
  if (target === i) return { ok: true, config: json }
  list.splice(i, 1)
  list.splice(target, 0, ref)
  return { ok: true, config: withOrder(json, list) }
}

function addModel(json, ref) {
  const s = String(ref || '').trim()
  if (!s) return { ok: false, error: '没指定模型' }
  const list = orderOf(json)
  if (list.includes(s)) return { ok: false, error: '这个模型已经在列表里了' }
  list.push(s)
  return { ok: true, config: withOrder(json, list) }
}

function removeModel(json, ref) {
  const list = orderOf(json)
  const i = list.indexOf(String(ref || '').trim())
  if (i < 0) return { ok: false, error: '这个模型不在列表里' }
  // 至少留一个：删空了连「跟谁说话」都不存在，保存时必然报错，
  // 那不如现在就说清楚，而不是让他点删除之后才发现整份配置坏了。
  if (list.length === 1) return { ok: false, error: '至少留一个模型' }
  list.splice(i, 1)
  return { ok: true, config: withOrder(json, list) }
}

/**
 * 往清单里加一个模型（D110）。纯函数，不碰磁盘。
 *
 * 一个卡片 = 一份「地址 + key + 模型」，但**地址相同的并进同一个 provider**：
 * 同一家里放第二个模型不用再填一遍 key，一个地址也只有一把 key 才对得上。
 * 卡片上那个名字（他起的，比如「DeepSeek（中转站）」）存在 `models[模型].name` 里——
 * opencode 本来就用它当显示名，所以这不是新造的字段，只是把它交给他填。
 *
 * @param {object} json 现有配置
 * @param {{name?,presetId?,presetName?,baseUrl?,apiKey?,modelId,context?}} spec
 */
function addEntry(json, spec) {
  const s = spec && typeof spec === 'object' ? spec : {}
  const modelId = String(s.modelId || '').trim()
  const baseUrl = String(s.baseUrl || '').trim()
  const label = String(s.name || '').trim()
  if (!modelId) return { ok: false, error: '没填模型名' }
  if (modelId.includes('/')) return { ok: false, error: '模型名里不要带斜杠（斜杠是 provider 和模型的分界）' }
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: '接口地址要以 http:// 或 https:// 开头' }

  const out = JSON.parse(JSON.stringify(json && typeof json === 'object' ? json : {}))
  out.provider = out.provider && typeof out.provider === 'object' ? out.provider : {}

  const normUrl = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase()
  let pid = ''
  for (const [id, conf] of Object.entries(out.provider)) {
    if (id.includes('/') || !conf || typeof conf !== 'object') continue
    const opts = conf.options && typeof conf.options === 'object' ? conf.options : {}
    if (normUrl(opts.baseURL || opts.baseUrl) === normUrl(baseUrl)) {
      pid = id
      break
    }
  }

  if (!pid) {
    // provider 的 id 只用来切引用，他自己看的是 name，所以这里只要合法且不重名
    const base =
      String(s.presetId || 'custom')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 32) || 'custom'
    pid = base
    let n = 2
    while (out.provider[pid]) pid = base + '-' + n++
    out.provider[pid] = {
      name: String(s.presetName || '自定义').trim() || '自定义',
      npm: OPENAI_COMPATIBLE,
      options: { baseURL: baseUrl },
      models: {}
    }
  }

  const conf = out.provider[pid]
  conf.options = { ...(conf.options || {}) }
  if (!conf.options.baseURL) conf.options.baseURL = baseUrl
  const key = String(s.apiKey == null ? '' : s.apiKey).trim()
  // 同一地址只有一把 key。他重新填了就以新填的为准——留着旧的那把，
  // 表现是「改了 key 还是 401」，而没有任何地方会说哪里不对。
  if (key) conf.options.apiKey = key
  conf.models = conf.models && typeof conf.models === 'object' ? conf.models : {}

  const prev = conf.models[modelId] && typeof conf.models[modelId] === 'object' ? conf.models[modelId] : {}
  const mconf = { ...prev }
  // 没起名字就沿用原来的显示名，再没有就是模型 id —— 不要把他填过的名字冲成 id
  mconf.name = label || String(prev.name || '').trim() || modelId
  const ctx = Number(s.context)
  if (Number.isFinite(ctx) && ctx > 0) mconf.limit = { ...(mconf.limit || {}), context: Math.floor(ctx) }
  conf.models[modelId] = mconf

  const ref = pid + '/' + modelId
  const list = orderOf(out)
  if (list.includes(ref)) return { ok: false, error: '这个模型已经在清单里了' }
  list.push(ref)
  const cfg = withOrder(out, list)
  // 从一家一个模型变成两个以上，就不再是「简单配置」了；留着那个标记，
  // 下次有人读它就会以为是「只有一家、只有一个模型」。
  if (list.length > 1 && cfg['x-hundun'] && cfg['x-hundun'].simple) {
    const ext = { ...cfg['x-hundun'] }
    delete ext.simple
    cfg['x-hundun'] = ext
  }
  return { ok: true, config: cfg, ref }
}

/**
 * 从已保存的配置算出「实际要用的几个值」。
 *
 * 这些值是 llm.js 唯一认的东西。它们不再由人直接填，而是每次从 modelConfig 现算 ——
 * 这样就没有「两边不一致」这件事了：不一致的可能是零，因为只有一份是源。
 * @returns {{baseUrl,apiKey,model,contextWindow,chain}|null} 解析不出来返回 null
 */
function resolve(cfg, opts = {}) {
  if (!cfg || !cfg.modelConfig) return null
  const r = normalize(cfg.modelConfig, opts)
  if (!r.ok || !r.selected) return null
  return {
    baseUrl: r.selected.baseUrl,
    apiKey: r.selected.apiKey,
    model: r.selected.modelId,
    contextWindow: r.selected.contextWindow || 0,
    // 先用谁、连不上再用谁。只有一个模型时它就是单元素数组。
    chain: r.chain
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

module.exports = {
  normalize,
  resolve,
  chainOf,
  orderOf,
  withOrder,
  moveModel,
  addModel,
  addEntry,
  removeModel,
  seedFromLegacy,
  simpleToConfig,
  configToSimple,
  presets,
  PRESETS,
  splitRef,
  substitute,
  OPENAI_COMPATIBLE
}
