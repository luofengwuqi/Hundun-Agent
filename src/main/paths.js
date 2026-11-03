const path = require('path')
const os = require('os')

/**
 * 记忆根目录。刻意放在家目录下、独立的 ~/life/，
 * 而不是 userData 里：这些文件是用户的，应当可读、可 git、可用任何编辑器改。
 * 环境变量 HUNDUN_LIFE_DIR 可覆盖（测试用）。
 */
function lifeDir() {
  return process.env.HUNDUN_LIFE_DIR || path.join(os.homedir(), 'life')
}

function memoryDir() {
  return path.join(lifeDir(), 'memory')
}

/** 允许渲染进程读写的相对路径白名单校验，防目录穿越 */
function resolveInside(relPath) {
  const root = lifeDir()
  const abs = path.resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('路径越界: ' + relPath)
  }
  return abs
}

module.exports = { lifeDir, memoryDir, resolveInside }
