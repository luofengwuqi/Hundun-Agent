const { net } = require('electron')

/**
 * OpenAI 兼容协议的极简客户端。
 *
 * 用 Electron 的 net 模块而不是 node:http / fetch：
 *  - 走 Chromium 网络栈，自动继承系统代理设置（国内直连、国外走代理都省事）
 *  - 不碰 undici，无需 WASM（本机环境 Node 的 fetch/HTTP 会因虚拟内存上限直接崩）
 *  - 自带 TLS、重定向、连接池，不用自己处理
 */

function endpoint(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!u) throw new Error('还没有填 API 地址')
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  if (!/\/chat\/completions$/.test(u)) u += '/chat/completions'
  return u
}

/**
 * 发一个 POST，把响应流交回给调用方。
 * @returns {Promise<{status:number, res:any}>}
 */
function post(urlStr, payload, apiKey) {
  return new Promise((resolve, reject) => {
    let req
    try {
      req = net.request({ method: 'POST', url: urlStr, redirect: 'follow' })
    } catch (e) {
      return reject(new Error('请求创建失败：' + e.message))
    }

    const body = JSON.stringify(payload)
    req.setHeader('Content-Type', 'application/json')
    // 千万不要手设 Content-Length（2026-11-05 踩过，报 net::ERR_INVALID_ARGUMENT）。
    // Electron 的 net 走 Chromium 的上传数据模型：write() 进来的 body 由它自己算长度，
    // 再手设一个就与内部的上传描述冲突，Chromium 判参数非法、3 毫秒内直接失败 ——
    // 报的是网络错，其实一个字节都没发出去，所以「换代理」「换直连」都不会好。
    // 数字和字符串两种写法都试过，都失败；不设则服务端正常收到完整请求体。
    req.setHeader('Authorization', 'Bearer ' + String(apiKey || '').trim())
    req.setHeader('Accept', payload.stream ? 'text/event-stream' : 'application/json')
    req.setHeader('Accept-Encoding', 'identity')

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        req.abort()
      } catch {}
      const err = new Error('请求超时（180 秒）。检查一下网络，或者接口地址填错了。')
      // 超时不降级（见 streamChat）。标一下，让上层认得出是哪类失败。
      err.timeout = true
      reject(err)
    }, 180000)

    req.on('response', (res) => {
      clearTimeout(timer)
      settled = true
      resolve({ status: res.statusCode, res })
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      const msg = String(e.message || e)
      if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/.test(msg)) {
        reject(new Error('连不上模型接口：' + msg + '（地址或网络有问题）'))
      } else {
        reject(new Error('连不上模型接口：' + msg))
      }
    })

    req.write(body)
    req.end()
  })
}

function collect(res) {
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', (c) => chunks.push(Buffer.from(c)))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    res.on('error', (e) => reject(new Error('读取响应失败：' + e.message)))
  })
}

function prettyError(status, raw) {
  let msg = raw
  try {
    const j = JSON.parse(raw)
    msg = j.error?.message || j.message || raw
  } catch {}
  return '模型接口返回 ' + status + (msg ? '：' + String(msg).slice(0, 300) : '')
}

/** 流式对话的一次尝试；返回完整文本 */
async function streamOne({ baseUrl, apiKey, model, messages, temperature = 0.7 }, onDelta) {
  const { status, res } = await post(
    endpoint(baseUrl),
    { model, messages, temperature, stream: true },
    apiKey
  )

  if (status !== 200) throw new Error(prettyError(status, await collect(res)))

  return new Promise((resolve, reject) => {
    let buf = ''
    let full = ''
    let done = false

    const flush = () => {
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const j = JSON.parse(data)
          const piece = j.choices?.[0]?.delta?.content
          if (piece) {
            full += piece
            onDelta && onDelta(piece)
          }
        } catch {
          // 半个 JSON，等下一块
        }
      }
    }

    res.on('data', (chunk) => {
      buf += Buffer.from(chunk).toString('utf8')
      flush()
    })
    res.on('end', () => {
      if (done) return
      done = true
      flush()
      resolve(full)
    })
    res.on('error', (e) => {
      if (done) return
      done = true
      reject(new Error('读取流失败：' + e.message))
    })
  })
}

/** 非流式对话的一次尝试；压缩摘要、连通性测试用 */
async function chatOne({ baseUrl, apiKey, model, messages, temperature = 0.3, maxTokens }) {
  const payload = { model, messages, temperature, stream: false }
  if (maxTokens) payload.max_tokens = maxTokens
  const { status, res } = await post(endpoint(baseUrl), payload, apiKey)

  const raw = await collect(res)
  if (status !== 200) throw new Error(prettyError(status, raw))

  let j
  try {
    j = JSON.parse(raw)
  } catch {
    throw new Error('模型返回的不是 JSON：' + raw.slice(0, 200))
  }
  return { text: j.choices?.[0]?.message?.content || '', usage: j.usage || null }
}

/**
 * 把 opts 归一成一条「先用谁、连不上再用谁」的链。
 * 没给 chain 时就是单元素——老的调用点（比如测试连接）不用改。
 */
function chainOf(opts) {
  if (Array.isArray(opts.chain) && opts.chain.length) {
    return opts.chain.map((c) => ({
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      model: c.modelId || c.model,
      label: c.modelName || c.modelId || c.model
    }))
  }
  return [{ baseUrl: opts.baseUrl, apiKey: opts.apiKey, model: opts.model, label: opts.model }]
}

function combineFailures(failed) {
  if (!failed.length) return new Error('没有可用的模型')
  const last = failed[failed.length - 1]
  if (failed.length === 1) return new Error(last.error)
  return new Error(`试了 ${failed.length} 个模型都没成。最后一个是 ${last.model}：${last.error}`)
}

/**
 * 按顺序跑 attempt，前一个失败才换下一个。
 *
 * 抽出来单独一层，是因为「什么时候可以换」这条规则只有一处能验证：
 * 已经往界面上推过字之后再换，显示出来的会是两个模型的话拼成一段，
 * 而接缝在哪没有任何人看得出来。这层不碰网络，测试能直接喂假的 attempt。
 *
 * attempt(one, markStarted) —— 推出第一个字符时必须调 markStarted()。
 */
async function runChain(chain, attempt, onFallback) {
  const failed = []

  for (let i = 0; i < chain.length; i++) {
    const one = chain[i]
    let started = false
    try {
      const out = await attempt(one, () => {
        started = true
      })
      if (i > 0 && typeof onFallback === 'function') {
        onFallback({ used: one, failed: failed.slice() })
      }
      if (i > 0) {
        // 只推界面事件不留痕，回头查「这句话为什么是这个腔调」就没有依据。
        // 落一行到主进程日志（启动器把它重定向到 ~/.cache/hundun-agent/latest.log）。
        console.warn(
          '[fallback] 前面的模型都失败了，这轮用的是',
          one.label || one.model,
          '失败记录:',
          failed.map((f) => `${f.model}(${f.error})`).join('; ')
        )
      }
      return out
    } catch (e) {
      if (started) throw e
      failed.push({ model: one.label || one.model, error: e.message })
      // 超时不换：换一个地址大概率同样超时，代价是把「卡三分钟」变成「卡九分钟」。
      if (e.timeout) throw new Error(`${one.label || one.model} 没响应：${e.message}`)
    }
  }
  throw combineFailures(failed)
}

/**
 * 流式对话。降级成功时会调 opts.onFallback。
 * 不声不响地换了模型，他会以为还在跟原来那个说话。
 */
async function streamChat(opts, onDelta) {
  const chain = chainOf(opts)
  return runChain(
    chain,
    (one, markStarted) =>
      streamOne({ ...opts, ...one }, (d) => {
        markStarted()
        onDelta && onDelta(d)
      }),
    opts.onFallback
  )
}

/** 非流式同上。它没有「已经推过字」的问题。 */
async function chat(opts) {
  return runChain(chainOf(opts), (one) => chatOne({ ...opts, ...one }))
}

async function testConnection(cfg) {
  // 预算要给思考型模型留量：deepseek-r1 / v4-1 这类先烧几百个 token 想再开口，
  // 给 16 的话全部喂给思考、正文为空，测试就误报「返回为空」还触发降级。
  const { text } = await chat({
    ...cfg,
    messages: [{ role: 'user', content: '只回复两个字：在的' }],
    maxTokens: 512,
    temperature: 0
  })
  return text.trim() || '（返回为空）'
}

module.exports = { streamChat, chat, testConnection, endpoint, chainOf, runChain }
