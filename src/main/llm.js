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
    // 显式给长度：不设的话部分实现会退回 chunked 传输，老式服务端读不到请求体
    req.setHeader('Content-Length', Buffer.byteLength(body))
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
      reject(new Error('请求超时（180 秒）。检查一下网络，或者接口地址填错了。'))
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

/** 流式对话；返回完整文本 */
async function streamChat({ baseUrl, apiKey, model, messages, temperature = 0.7 }, onDelta) {
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

/** 非流式对话；压缩摘要、连通性测试用 */
async function chat({ baseUrl, apiKey, model, messages, temperature = 0.3, maxTokens }) {
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

async function testConnection(cfg) {
  const { text } = await chat({
    ...cfg,
    messages: [{ role: 'user', content: '只回复两个字：在的' }],
    maxTokens: 16,
    temperature: 0
  })
  return text.trim() || '（返回为空）'
}

module.exports = { streamChat, chat, testConnection, endpoint }
