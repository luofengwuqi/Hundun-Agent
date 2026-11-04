const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, shell, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')

const store = require('./store')
const life = require('./life')
const conversation = require('./conversation')
const llm = require('./llm')
const search = require('./search')
const paths = require('./paths')

let mainWindow = null
let tray = null
let schedulerTimer = null
let busy = false
const firedKeys = new Set()

const ROOT = path.join(__dirname, '..', '..')

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
  const icon = resolveIcon()
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
/* 检查点调度                                                          */
/* ------------------------------------------------------------------ */

function pad(n) {
  return String(n).padStart(2, '0')
}

async function fireCheckpoint(cp) {
  if (busy) return
  if (store.isQuietToday()) return
  if (!store.read().apiKey) return

  busy = true
  try {
    showWindow()
    const section = conversation.checkpointSection(cp.label)
    const instruction =
      '（这是「' + cp.label + '」检查点，由你主动开口，不是你收到的消息。）\n' +
      '按下面的要求说：\n' +
      section
    if (mainWindow) mainWindow.webContents.send('checkpoint:start', { id: cp.id, label: cp.label })

    const result = await conversation.send(instruction, {
      internal: true,
      onDelta: (d) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('chat:delta', d)
    })

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:done', { ...result, checkpoint: cp.id })
    }

    if (Notification.isSupported()) {
      const body = result.text.replace(/\s+/g, ' ').slice(0, 90)
      new Notification({ title: '馄饨 · ' + cp.label, body, icon: resolveIcon() || undefined }).show()
    }
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:error', { message: e.message })
    }
  } finally {
    busy = false
  }
}

function tickScheduler() {
  const cfg = store.read()
  if (!cfg.apiKey) return
  if (store.isQuietToday()) return
  const now = new Date()
  const hm = pad(now.getHours()) + ':' + pad(now.getMinutes())
  for (const cp of cfg.checkpoints || []) {
    if (!cp.enabled || !cp.time) continue
    const key = store.todayStr() + ':' + cp.id
    if (firedKeys.has(key)) continue
    if (hm === cp.time) {
      firedKeys.add(key)
      fireCheckpoint(cp)
    }
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function fileTree() {
  const root = life.lifeDir()
  const out = []
  const push = (rel, label) => {
    try {
      const st = fs.statSync(path.join(root, rel))
      out.push({ rel, label, mtime: st.mtimeMs, size: st.size, dir: label === 'memory' })
    } catch {}
  }
  for (const name of ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md', 'CHECKPOINTS.md']) push(name, name)
  let days = []
  try {
    days = fs
      .readdirSync(path.join(root, 'memory'))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
  } catch {}
  for (const f of days.slice(0, 40)) out.push({ rel: 'memory/' + f, label: f.replace('.md', ''), mtime: 0, size: 0, dir: true })
  return out
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    lifeDir: life.lifeDir(),
    electron: process.versions.electron,
    node: process.versions.node
  }))

  ipcMain.handle('cfg:get', () => store.publicConfig())
  ipcMain.handle('cfg:set', (_e, patch) => {
    const next = store.write(patch)
    refreshTrayMenu()
    return { ...next, hasApiKey: Boolean(next.apiKey) }
  })
  ipcMain.handle('cfg:test', async (_e, patch) => {
    const cfg = { ...store.read(), ...(patch || {}) }
    try {
      const reply = await llm.testConnection(cfg)
      return { ok: true, reply }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('life:tree', () => ({ root: life.lifeDir(), files: fileTree() }))
  ipcMain.handle('life:read', (_e, rel) => life.readSafe(rel, 200000))
  ipcMain.handle('life:write', (_e, { rel, content }) => life.writeSafe(rel, content))
  ipcMain.handle('life:open', () => shell.openPath(life.lifeDir()))
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
    let internal = false
    let content = text
    if (text === '__opening__') {
      internal = true
      content = '（开始对话。按你现在的认知主动说第一句；USER.md 是空的，就按访谈要求问第一个问题。）'
    }
    busy = true
    try {
      const result = await conversation.send(content, {
        internal,
        onDelta: (d) => event.sender.send('chat:delta', d),
        onCompact: (info) => event.sender.send('chat:compacted', info)
      })
      return result
    } catch (e) {
      event.sender.send('chat:error', { message: e.message })
      return { error: e.message }
    } finally {
      busy = false
    }
  })

  ipcMain.handle('quiet:get', () => store.isQuietToday())
  ipcMain.handle('quiet:toggle', () => {
    const on = store.toggleQuiet()
    refreshTrayMenu()
    return on
  })

  ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize())
  ipcMain.on('win:close', () => app.quit())
  ipcMain.on('win:hide', () => mainWindow && mainWindow.hide())
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
    // 身份必须在任何记忆读写之前设好，否则会读到默认用户头上
    const cfg = store.read()
    paths.setContext({ userId: cfg.currentUser, agentId: cfg.currentAgent })
    life.ensureLife()
    registerIpc()
    createWindow()
    buildTray()
    schedulerTimer = setInterval(tickScheduler, 20000)
    // 启动时把索引对齐一次（索引是缓存，重建不影响任何记忆文件）
    search
      .rebuild()
      .then((n) => console.log('[search] 索引就绪，' + n + ' 条'))
      .catch((e) => console.warn('[search] 索引不可用，改用文件扫描：' + e.message))
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (schedulerTimer) clearInterval(schedulerTimer)
    app.quit()
  })
}
