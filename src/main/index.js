const { app, BrowserWindow, ipcMain, Tray, Menu, shell, dialog, nativeImage, Notification } = require('electron')
const path = require('path')
const fs = require('fs')

const store = require('./store')
const models = require('./models')
const life = require('./life')
const conversation = require('./conversation')
const llm = require('./llm')
const search = require('./search')
const identity = require('./identity')
const session = require('./session')
const schedule = require('./schedule')
const dream = require('./dream')

let mainWindow = null
let tray = null
let busy = false
let scheduler = null
let dreamer = null

const ROOT = path.join(__dirname, '..', '..')

/**
 * JSON.parse 说的是「Unexpected token } in JSON at position 217」。
 * 那个位置数字对他没有用 —— 换成第几行第几列，他才知道往哪儿看。
 */
function jsonError(text, e) {
  const src = typeof text === 'string' ? text : ''
  const m = /position (\d+)/.exec(String((e && e.message) || ''))
  if (!m) return 'JSON 语法错误：' + ((e && e.message) || e)
  const pos = Math.min(Number(m[1]), src.length)
  const head = src.slice(0, pos)
  const line = head.split('\n').length
  const col = pos - head.lastIndexOf('\n')
  return `JSON 语法错误：第 ${line} 行第 ${col} 列附近（多半是少了或多了逗号、引号）`
}

function resolvePreload() {
  const candidates = [
    path.join(__dirname, '../preload/preload.js'),
    path.join(__dirname, 'preload.js')
  ]
  return candidates.find((p) => fs.existsSync(p)) || candidates[0]
}

function resolveIcon() {
  const candidates = [
    path.join(ROOT, 'resources/icon.png'),
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(ROOT, 'src/renderer/public/icon.png')
  ]
  return candidates.find((p) => p && fs.existsSync(p)) || null
}

/**
 * 托盘用小尺寸那张（32px 由 scripts/gen-icon.py 从 build/logo.svg 生成）。
 * 托盘环境按系统 DPI 取图，直接拿 512 的窗口图标缩到 22 会糊：
 * 源图缩小时的损失比重绘一次大得多。
 */
function resolveTrayIcon() {
  const candidates = [
    path.join(ROOT, 'resources/tray.png'),
    path.join(process.resourcesPath || '', 'tray.png'),
    path.join(ROOT, 'build/icons/32x32.png')
  ]
  return candidates.find((p) => p && fs.existsSync(p)) || null
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow() {
  const bounds = store.read().windowBounds
  mainWindow = new BrowserWindow({
    width: (bounds && bounds.width) || 1020,
    height: (bounds && bounds.height) || 700,
    x: bounds ? bounds.x : undefined,
    y: bounds ? bounds.y : undefined,
    minWidth: 780,
    minHeight: 540,
    show: false,
    frame: false,
    backgroundColor: '#FFF8E8',
    icon: resolveIcon() || undefined,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // 调试用：HUNDUN_SHOT=<路径> 时，加载完截一张图就退出（自动化验证用）
  if (process.env.HUNDUN_SHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await mainWindow.webContents.capturePage()
          fs.writeFileSync(process.env.HUNDUN_SHOT, img.toPNG())
          console.log('screenshot saved ->', process.env.HUNDUN_SHOT)
        } catch (e) {
          console.error('screenshot failed', e.message)
        }
        app.isQuitting = true
        app.quit()
      }, Number(process.env.HUNDUN_SHOT_DELAY || 2500))
    })
  }

  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const b = mainWindow.getBounds()
      store.write({ windowBounds: b })
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */

function buildTray() {
  const icon = resolveTrayIcon() || resolveIcon()
  if (!icon) return
  try {
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 22, height: 22 }))
  } catch {
    return
  }
  tray.setToolTip('馄饨')
  refreshTrayMenu()
  tray.on('click', showWindow)
}

function refreshTrayMenu() {
  if (!tray) return
  const quiet = store.isQuietToday()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开馄饨', click: showWindow },
      { type: 'separator' },
      {
        label: '今天别烦我',
        type: 'checkbox',
        checked: quiet,
        click: () => {
          const on = store.toggleQuiet()
          refreshTrayMenu()
          if (mainWindow) mainWindow.webContents.send('quiet:state', on)
        }
      },
      { label: '打开记忆目录', click: () => shell.openPath(life.lifeDir()) },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; app.quit() } }
    ])
  )
}

/* ------------------------------------------------------------------ */
/* 主动开口（P-10 调度 / P-12 送达标记）                                 */
/* ------------------------------------------------------------------ */

/**
 * 这里原来是一套「检查点」：每天固定钟点开口，配置里写着 08:30／21:30。
 * 那套东西已作废（D039／D047／O11）——它开口的原因是「时间到了」，
 * 而产品要的是「你有一句还没合上的话」。判据不同，代码不能复用。
 *
 * 现在的调度在 schedule.js：60 秒一次，判五条，说一件。
 */

/**
 * 系统通知。返回的是「真的弹出来了吗」，不是「调过 show() 没有」。
 *
 * 送达判据要的是前者：没有通知守护进程的桌面（精简发行版、某些 WM）里
 * show() 一声不响地什么也不做，把它算成送达，这条约定就永久结案了 ——
 * 而 D057 只允许往「多问一句」的方向错。
 */
function notifySystem({ title, body }) {
  return new Promise((resolve) => {
    try {
      if (!Notification.isSupported()) return resolve(false)
      const n = new Notification({ title, body, icon: resolveIcon() || undefined })
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        resolve(v)
      }
      n.on('show', () => finish(true))
      n.on('failed', () => finish(false))
      // 通知只提示，点开才进窗口（F06-3 第 3 步：不抢焦点）
      n.on('click', () => showWindow())
      n.show()
      // 有些环境既不 show 也不 failed，就这么悬着。等两秒，当没送到。
      setTimeout(() => finish(false), 2000)
    } catch {
      resolve(false)
    }
  })
}

function startScheduler() {
  scheduler = schedule.start({
    getWindow: () => mainWindow,
    isBusy: () => busy,
    // 往界面推事件。窗口不在也能推 —— 渲染进程活着，回来就能看见这句话
    send: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
    },
    sendTurn: (text, hooks) => conversation.send(text, hooks),
    notify: notifySystem,
    log: (m) => console.log('[schedule] ' + m)
  })
}

/**
 * 记忆折叠（搬迁台账 P1）。
 *
 * 和调度器是两个东西，别混：
 *   - 调度器的判据是「有一条还没合上的话」，产出是**跟他说话**；
 *   - 折叠的判据是「日记攒够几天了」，产出是**写文件**，一句话都不说。
 *
 * 放一起会让两条判定纠缠，也容易写着写着就变成「整理完了顺便告诉他一声」——
 * 那正是 D049 否掉的东西。
 */
function startDream() {
  dreamer = dream.create({
    chat: async ({ temperature, messages }) => {
      const cfg = store.read()
      if (!cfg.apiKey || !String(cfg.apiKey).trim()) throw new Error('还没有 API Key')
      return llm.chat({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature,
        messages
      })
    },
    // 他正在等一句话，别在这时候抢网络
    isBusy: () => busy,
    log: (m) => console.log('[dream] ' + m)
  })
  dreamer.start()
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    lifeDir: life.lifeDir(),
    electron: process.versions.electron,
    node: process.versions.node
  }))

  ipcMain.handle('cfg:get', () => store.publicConfig())

  /**
   * 外链只在主进程开，且只放行 https。
   *
   * 设置页里有一处「去 DeepSeek 拿一个 key」，地址来自主进程的目录常量，
   * 但这一层不能因为它「来自常量」就不设防 —— 渲染进程能调的东西，
   * 迟早会有人传别的东西进来。
   */
  ipcMain.handle('app:openExternal', (_e, url) => {
    const s = String(url || '').trim()
    if (!/^https:\/\//i.test(s)) return { ok: false, error: '只允许 https 链接' }
    shell.openExternal(s)
    return { ok: true }
  })
  ipcMain.handle('cfg:set', (_e, patch) => {
    try {
      const next = store.write(patch)
      refreshTrayMenu()
      return { ok: true, cfg: { ...next, hasApiKey: Boolean(next.apiKey) } }
    } catch (e) {
      // 模型配置不合法时 write 会整份拒写，这里把逐条原因原样交回去
      return { ok: false, errors: e.modelErrors || [e.message], warnings: e.modelWarnings || [] }
    }
  })

  /**
   * 只解析、不写。设置页每敲一个字就会来一次，所以它必须廉价且绝不产生副作用。
   * 返回 providers 是为了界面能画出「这个 provider 下面有哪些模型」，点一下就等于改顶层 model。
   */
  ipcMain.handle('cfg:modelPreview', (_e, text) => {
    let obj
    try {
      obj = typeof text === 'string' ? JSON.parse(text) : text
    } catch (e) {
      return { ok: false, errors: [jsonError(text, e)], warnings: [], providers: [], selected: null }
    }
    return store.previewModel(obj)
  })

  /** 应用一份模型配置。不合法则一个字段都不写。 */
  ipcMain.handle('cfg:modelApply', (_e, payload) => {
    let obj
    try {
      obj = typeof payload === 'string' ? JSON.parse(payload) : payload
    } catch (e) {
      return { ok: false, errors: [jsonError(payload, e)], warnings: [] }
    }
    try {
      // 先预览一遍：要么带着警告成功，要么带着原因失败，不做「写进去一半」
      const r = store.previewModel(obj)
      if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings }
      const out = store.applyModelConfig(obj)
      refreshTrayMenu()
      return { ok: true, warnings: r.warnings, selected: r.selected, cfg: out.cfg }
    } catch (e) {
      return { ok: false, errors: e.modelErrors || [e.message], warnings: e.modelWarnings || [] }
    }
  })

  /**
   * 卡片上的动作：置顶／上移／下移／移除／加入。
   *
   * 只改对象、不写盘 —— 结果回给界面，由界面走「预览 → 应用」那条老路。
   * 这样编辑器里还没应用的草稿不会被这里的操作悄悄吞掉。
   */
  ipcMain.handle('cfg:modelEdit', (_e, payload) => {
    const { config, op, ref, to } = payload || {}
    let obj
    try {
      obj = typeof config === 'string' ? JSON.parse(config) : config
    } catch (e) {
      return { ok: false, error: jsonError(config, e) }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, error: '这份配置不是一个对象' }
    }

    let r
    if (op === 'move') r = models.moveModel(obj, ref, to)
    else if (op === 'add') r = models.addModel(obj, ref)
    else if (op === 'remove') r = models.removeModel(obj, ref)
    else return { ok: false, error: '不认识的操作：' + op }
    if (!r.ok) return r

    const pv = store.previewModel(r.config)
    // 加入一个配置里根本没有的模型时，会被解析层当成「引用不到」直接跳过 ——
    // 那会变成一次静默的无效操作，所以在这里明说。
    if (op === 'add' && !pv.chain.some((c) => c.providerId + '/' + c.modelId === ref)) {
      return { ok: false, error: '配置里没有这个模型：' + ref }
    }
    return { ok: true, config: r.config, errors: pv.errors, warnings: pv.warnings }
  })

  /**
   * 「再加一个」（D110）：把一份「地址 + key + 模型 + 名字」拼进现有配置。
   *
   * 拼装放在主进程而不是界面里，理由和 `modelEdit` 一样：界面那份迟早会和解析那份走偏，
   * 而拼错的表现只是「它用的不是他加的那个」，没有任何报错。
   * 这里仍然只改对象、不写盘 —— 结果回给界面，由界面走「预览 → 应用」那条老路。
   */
  ipcMain.handle('cfg:modelAdd', (_e, payload) => {
    const { config, entry } = payload || {}
    let obj
    try {
      obj = typeof config === 'string' ? JSON.parse(config) : config
    } catch (e) {
      return { ok: false, error: jsonError(config, e) }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, error: '这份配置不是一个对象' }
    }
    const r = models.addEntry(obj, entry)
    if (!r.ok) return r
    const pv = store.previewModel(r.config)
    if (!pv.ok) return { ok: false, error: pv.errors.join('；'), errors: pv.errors }
    return { ok: true, config: r.config, ref: r.ref, warnings: pv.warnings }
  })

  /**
   * 简单模式：选一家、选一个、填个 key。
   *
   * 它不落成另一份配置，而是现场生成一份 JSON，再走上面那条「预览 → 写入」——
   * 所以两种模式共用一套校验和一条备用链，不存在「简单模式能用、JSON 那边认不出」这种事。
   * 目录里的地址是常量，这里不收他改的地址（要改就去自定义/直接写 JSON）。
   */
  ipcMain.handle('cfg:modelSimple', (_e, simple) => {
    try {
      const out = store.applySimple(simple)
      refreshTrayMenu()
      return out
    } catch (e) {
      return { ok: false, errors: e.modelErrors || [e.message], warnings: e.modelWarnings || [] }
    }
  })

  /** 设置页要画的目录。真值是常量，但放在主进程：界面那份迟早会和服务商一起过期。 */
  ipcMain.handle('cfg:modelPresets', () => models.presets())

  /**
   * 只换 key。走上一步是一样的校验，但**不重新生成 JSON** ——
   * 重新生成会把自定义服务商的模型、备用链的顺序一起冲掉。
   */
  ipcMain.handle('cfg:setKey', (_e, key) => {
    try {
      store.setApiKey(key)
      refreshTrayMenu()
      return { ok: true, cfg: store.publicConfig() }
    } catch (e) {
      return { ok: false, errors: e.modelErrors || [e.message], warnings: e.modelWarnings || [] }
    }
  })

  /** 从磁盘挑一个 json / jsonc 读成文本。不猜编码，不修内容，原样交给编辑器。 */
  ipcMain.handle('cfg:pickModelFile', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选一份模型配置',
      properties: ['openFile'],
      filters: [
        { name: 'JSON 配置', extensions: ['json', 'jsonc'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
    const file = r.filePaths[0]
    try {
      let text = fs.readFileSync(file, 'utf8')
      // JSONC 允许注释和尾逗号：opencode 两种都吃，我们照做，否则别人贴过来的配置会白报错
      text = text
        .replace(/^\uFEFF/, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,(\s*[}\]])/g, '$1')
      return { ok: true, path: file, name: path.basename(file), text }
    } catch (e) {
      return { ok: false, error: '读不了这个文件：' + e.message }
    }
  })
  ipcMain.handle('cfg:test', async (_e, patch) => {
    const cfg = { ...store.read(), ...(patch || {}) }
    try {
      // 只测这一个。store.read() 里带着 modelChain（整条备用链），眼下它不叫 chain
      // 所以不会被动用 —— 但这层安全靠的是字段名不同，太脆。显式清空：
      // 否则某天它改名叫 chain，这里就会测成「链上第一个能通」，而界面显示「这一张通了」。
      const reply = await llm.testConnection({ ...cfg, chain: [] })
      return { ok: true, reply }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('life:open', () => shell.openPath(life.lifeDir()))
  // 直接打开 RULES.md：光会「打开目录」不够，他得知道该改哪个文件、改完就生效
  ipcMain.handle('life:openRules', () => shell.openPath(path.join(life.lifeDir(), 'RULES.md')))
  ipcMain.handle('life:search', async (_e, { q, limit }) => {
    try {
      return { ok: true, hits: await search.search(q, limit || 20) }
    } catch (e) {
      return { ok: false, error: e.message, hits: [] }
    }
  })
  ipcMain.handle('life:reindex', async () => ({
    ok: true,
    count: await search.rebuild(),
    info: await search.info()
  }))

  ipcMain.handle('chat:state', () => conversation.state())
  ipcMain.handle('chat:reset', () => {
    conversation.reset()
    return true
  })

  ipcMain.handle('chat:send', async (event, text) => {
    if (busy) return { skipped: true }
    // 它正在自己开口（P-10）。两轮同时跑会共用一个 history，字会串成一段，
    // 而且接缝看不出来 —— 宁可让他再按一次回车。
    if (scheduler && scheduler.isBusy()) return { skipped: true, reason: '它正在说一句' }
    let internal = false
    let content = text
    if (text === '__opening__') {
      internal = true
      content = '（开始对话。按你现在的认知主动说第一句；USER.md 是空的，就按访谈要求问第一个问题。）'
    } else if (text === '__hello__') {
      // 仪式刚走完，馄饨的第一句（D120）。
      // 不写死文案：这一句得是它自己说的，否则「刚认识你」又变成一段过场台词。
      // 但要把该堵的堵住 —— 复述档案、说「我都记住了」、问「想聊点什么」，
      // 这三种正是它在这类场合最容易滑进去的客服腔（D117 那两句同源）。
      internal = true
      content =
        '（第一次见他。档案里已经有那三件事了：怎么称呼、在做什么、有什么不能忘的。' +
        '现在主动开口说第一句。不要复述档案，不要说「我都记住了」，' +
        '不要用「有什么想聊的」「需要我做什么」开头。' +
        '就一句话，像人坐下来会说的那句。）'
    } else if (text === '__resume__') {
      // D124：打开窗口时接着上次那句。**没有待办就不开口** —— 返回 skipped，
      // 界面连一个空气泡都不会留。不做「好久不见」（D059）。
      const todo = life.pendingTodo()
      if (!todo) return { skipped: true }
      internal = true
      content =
        '（他刚打开窗口。你手上有自己留给自己的这一句：' + todo.text + '。' +
        '直接问这一句，像你一直在想这件事。不要说「上次」「昨天」「我一直记着」，' +
        '不要先寒暄，不要解释你为什么问，只问这一句，问完就停。）'
      life.markTodoAsked(todo.key)
    }
    // 这一轮属于哪个身份。切过身份之后回来，锁不能乱放（见 finally）
    const myEpoch = session.current()
    busy = true
    try {
      const result = await conversation.send(content, {
        internal,
        onDelta: (d) => event.sender.send('chat:delta', d),
        onCompact: (info) => event.sender.send('chat:compacted', info),
        // 换了模型要说出来。悄悄换掉的话，他会以为这句还是原来那个说的。
        onFallback: (info) => event.sender.send('chat:fallback', info)
      })
      return result
    } catch (e) {
      try {
        event.sender.send('chat:error', { message: e.message })
      } catch {}
      return { error: e.message }
    } finally {
      // 身份换过 = 这把锁现在属于下一个身份的请求，别在这里放开
      if (!session.isStale(myEpoch)) busy = false
    }
  })

  ipcMain.handle('identity:current', () => identity.current())
  ipcMain.handle('identity:switch', (_e, next) => identity.switchTo(next || {}))
  // 开发者菜单（D100）：初始化应用。删除动作在主进程做，而且必须先过系统弹窗
  // ——渲染层按钮会误触，弹窗不会；「取消」是默认键。
  ipcMain.handle('dev:reset', () => {
    const r = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: '初始化应用',
      message: '清空全部内容，回到第一次见面的状态？',
      detail:
        '会删掉这个身份目录里的全部东西：档案、记忆、日记、对话、约定。' +
        '删完不能找回。模型配置、打扰设置不受影响。',
      buttons: ['取消', '清空并重置'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (r !== 1) return { done: false }
    life.resetLife()
    // init 不做「相同身份就跳过」的判断，正好：目录刚删，必须走完整的
    // 建目录→种模板→清会话→重建索引。onSwitch 会把 identity:changed 推给界面。
    identity.init()
    return { done: true }
  })

  ipcMain.handle('quiet:get', () => store.isQuietToday())
  ipcMain.handle('quiet:toggle', () => {
    const on = store.toggleQuiet()
    refreshTrayMenu()
    return on
  })

  ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize())
  // D026：✕ 是收进托盘，不是退出。窗口藏起来进程还在，到期的约定才发得出来。
  // 位置要在这里存一次——hide() 不触发 close 事件，只靠 close 里的保存会永远记不住。
  ipcMain.on('win:close', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    store.write({ windowBounds: mainWindow.getBounds() })
    mainWindow.hide()
    // D124：关窗 = 今天这段聊完了。补一趟日记（一天最多一趟），
    // 明天打开时它才有「一句自己的话」可接。不 await——他关窗口不该等模型。
    conversation.settle().catch(() => {})
  })
  ipcMain.on('win:hide', () => {
    if (mainWindow) mainWindow.hide()
    conversation.settle().catch(() => {})
  })
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

const singleLock = app.requestSingleInstanceLock()
if (!singleLock) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(() => {
    // 身份必须在任何记忆读写之前设好，否则会读到默认用户头上。
    // 走 identity.init 而不是直接 setContext：它顺手建好目录、复位会话、重建索引，
    // 保证「启动」和「切换」两条路得到同一个状态（少一样就是静默串味）。
    const cfg = store.read()
    identity.init({ userId: cfg.currentUser, agentId: cfg.currentAgent })

    // 切换身份后主进程这边要跟着松手：忙碌锁属于上一个身份，不放会永久卡住输入
    identity.onSwitch(() => {
      busy = false
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('identity:changed', identity.current())
      }
    })

    registerIpc()
    createWindow()
    buildTray()
    // 截图模式只活几秒，调度器一起来就会多一句不该出现的对话
    if (!process.env.HUNDUN_SHOT) {
      startScheduler()
      startDream()
    }
    search
      .info()
      .then((info) => console.log('[search] 索引就绪：' + (info.count || 0) + ' 条'))
      .catch((e) => console.warn('[search] 索引不可用，改用文件扫描：' + e.message))
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // 不 quit：这是常驻托盘的应用（D026）。窗口关了进程得活着，
    // 否则「它到了那天来问你」这件事根本不可能发生。
    // 调度器也不清：清掉的话进程还活着、却永远不开口——不报错、不崩，
    // 只表现为「它不再找我」。真退出只有一条路：托盘菜单里的「退出」。
  })

  app.on('before-quit', () => {
    app.isQuitting = true
    if (scheduler) scheduler.stop()
    if (dreamer) dreamer.stop()
  })
}
