const { contextBridge, ipcRenderer } = require('electron')

/**
 * 渲染层只能看到这一层薄接口。
 * API Key 的读取也只发生在主进程；渲染层拿到的是同一份 config（本机自用，不做额外隔离）。
 */
contextBridge.exposeInMainWorld('hundun', {
  info: () => ipcRenderer.invoke('app:info'),

  cfg: {
    get: () => ipcRenderer.invoke('cfg:get'),
    set: (patch) => ipcRenderer.invoke('cfg:set', patch),
    test: (patch) => ipcRenderer.invoke('cfg:test', patch)
  },

  life: {
    tree: () => ipcRenderer.invoke('life:tree'),
    read: (rel) => ipcRenderer.invoke('life:read', rel),
    write: (rel, content) => ipcRenderer.invoke('life:write', { rel, content }),
    open: () => ipcRenderer.invoke('life:open')
  },

  chat: {
    state: () => ipcRenderer.invoke('chat:state'),
    reset: () => ipcRenderer.invoke('chat:reset'),
    send: (text) => ipcRenderer.invoke('chat:send', text),
    onDelta: (cb) => ipcRenderer.on('chat:delta', (_e, d) => cb(d)),
    onDone: (cb) => ipcRenderer.on('chat:done', (_e, d) => cb(d)),
    onError: (cb) => ipcRenderer.on('chat:error', (_e, d) => cb(d)),
    onCompacted: (cb) => ipcRenderer.on('chat:compacted', (_e, d) => cb(d)),
    onCheckpointStart: (cb) => ipcRenderer.on('checkpoint:start', (_e, d) => cb(d))
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
