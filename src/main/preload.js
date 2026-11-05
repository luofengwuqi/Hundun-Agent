const { contextBridge, ipcRenderer } = require('electron')

/**
 * 渲染层只能看到这一层薄接口。
 * API Key 的读取也只发生在主进程；渲染层拿到的是同一份 config（本机自用，不做额外隔离）。
 */
contextBridge.exposeInMainWorld('hundun', {
  info: () => ipcRenderer.invoke('app:info'),
  // 用系统浏览器打开外部链接（服务商后台的 key 页面）。只在主进程里放行 https。
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  cfg: {
    get: () => ipcRenderer.invoke('cfg:get'),
    set: (patch) => ipcRenderer.invoke('cfg:set', patch),
    test: (patch) => ipcRenderer.invoke('cfg:test', patch),
    // 模型配置：预览（不写）／应用（要么整份成功要么整份失败）／从磁盘导入
    previewModel: (text) => ipcRenderer.invoke('cfg:modelPreview', text),
    applyModel: (payload) => ipcRenderer.invoke('cfg:modelApply', payload),
    // 简单模式（D077）：选一家 + 选一个 + 填 key。落到磁盘上仍是同一份 JSON。
    applySimple: (simple) => ipcRenderer.invoke('cfg:modelSimple', simple),
    presets: () => ipcRenderer.invoke('cfg:modelPresets'),
    setKey: (key) => ipcRenderer.invoke('cfg:setKey', key),
    pickModelFile: () => ipcRenderer.invoke('cfg:pickModelFile'),
    // 卡片上的排序／增删。只改对象不写盘，改完还要走 applyModel 才算数。
    editModel: (payload) => ipcRenderer.invoke('cfg:modelEdit', payload)
  },

  life: {
    open: () => ipcRenderer.invoke('life:open'),
    openRules: () => ipcRenderer.invoke('life:openRules'),
    search: (q, limit) => ipcRenderer.invoke('life:search', { q, limit }),
    reindex: () => ipcRenderer.invoke('life:reindex')
  },

  chat: {
    state: () => ipcRenderer.invoke('chat:state'),
    reset: () => ipcRenderer.invoke('chat:reset'),
    send: (text) => ipcRenderer.invoke('chat:send', text),
    onDelta: (cb) => ipcRenderer.on('chat:delta', (_e, d) => cb(d)),
    // 这一轮不是他点的发送：主进程到点自己开口（P-10）。
    // 没有这个收尾，那个光标会一直闪，这句话永远停在「正在输入」。
    onTurn: (cb) => ipcRenderer.on('chat:turn', (_e, d) => cb(d)),
    onDone: (cb) => ipcRenderer.on('chat:done', (_e, d) => cb(d)),
    onError: (cb) => ipcRenderer.on('chat:error', (_e, d) => cb(d)),
    onCompacted: (cb) => ipcRenderer.on('chat:compacted', (_e, d) => cb(d)),
    // 排在前面的模型没连上，换了后面那个
    onFallback: (cb) => ipcRenderer.on('chat:fallback', (_e, d) => cb(d))
  },

  identity: {
    current: () => ipcRenderer.invoke('identity:current'),
    switch: (next) => ipcRenderer.invoke('identity:switch', next),
    onChanged: (cb) => ipcRenderer.on('identity:changed', (_e, d) => cb(d))
  },

  quiet: {
    get: () => ipcRenderer.invoke('quiet:get'),
    toggle: () => ipcRenderer.invoke('quiet:toggle'),
    onState: (cb) => ipcRenderer.on('quiet:state', (_e, on) => cb(on))
  },

  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    hide: () => ipcRenderer.send('win:hide'),
    close: () => ipcRenderer.send('win:close')
  }
})
