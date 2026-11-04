const path = require('path')
const os = require('os')
const fs = require('fs')

/**
 * 身份与目录。
 *
 * 三层：一个软件 → 多个人（users）→ 每个人有多个 agent（agents）。
 *
 *   ~/life/users/<QQ号>/agents/<agent>/
 *     SOUL.md IDENTITY.md USER.md MEMORY.md COMMITMENTS.md
 *     memory/ chat/ .index/
 *
 * 记忆刻意不放在 userData 里：这些文件是用户的，应当可读、可 git、可用任何编辑器改。
 * 环境变量 HUNDUN_LIFE_DIR 可覆盖根目录（测试用）。
 */

const DEFAULT_USER = 'local'
const DEFAULT_AGENT = 'hundun'

function lifeRoot() {
  return process.env.HUNDUN_LIFE_DIR || path.join(os.homedir(), 'life')
}

/** 身份会进文件路径，必须挡住 `../` 这类东西 */
function safeId(v, label) {
  const s = String(v == null ? '' : v).trim()
  const name = label || '身份'
  if (!s) throw new Error(name + '不能为空')
  if (!/^[\w\u4e00-\u9fa5-]+$/.test(s)) {
    throw new Error(name + '只能用字母、数字、下划线、短横线或汉字：' + s)
  }
  return s
}

// 当前身份。启动时由主进程按 config.json 设一次，切换用户时重设。
// 放在模块级而不是逐次传参：lifeDir() 有十几处调用，传参一定会漏一处，
// 而漏掉的那一处会静默读到别人的记忆。
let ctx = {
  userId: process.env.HUNDUN_USER_ID || DEFAULT_USER,
  agentId: process.env.HUNDUN_AGENT_ID || DEFAULT_AGENT
}

function setContext(next = {}) {
  if (next.userId !== undefined) ctx.userId = safeId(next.userId, '用户')
  if (next.agentId !== undefined) ctx.agentId = safeId(next.agentId, 'agent')
  return { ...ctx }
}

function context() {
  return { ...ctx }
}

function usersDir() {
  return path.join(lifeRoot(), 'users')
}

function userDir(userId) {
  const id = safeId(userId === undefined ? ctx.userId : userId, '用户')
  return path.join(usersDir(), id)
}

function agentDir(userId, agentId) {
  const u = userDir(userId)
  const a = safeId(agentId === undefined ? ctx.agentId : agentId, 'agent')
  return path.join(u, 'agents', a)
}

/** 当前身份的记忆目录。所有读写都以它为根。 */
function lifeDir() {
  return agentDir()
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

/**
 * 老布局把 *.md 直接摊在 ~/life/ 根上。新布局收进 users/<用户>/agents/<agent>/。
 * 只在「根上有 SOUL.md 且还没有 users/」时搬一次，幂等。
 *
 * 索引不搬：它随时能重建，而且里面记的是旧路径，搬过去只会指错。
 * 记忆不能重建，所以记忆优先，索引删了重来。
 */
function migrateLegacyLayout() {
  const root = lifeRoot()
  if (fs.existsSync(usersDir())) return null
  if (!fs.existsSync(path.join(root, 'SOUL.md'))) return null

  const target = lifeDir()
  fs.mkdirSync(target, { recursive: true })

  const moved = []
  for (const name of fs.readdirSync(root)) {
    if (name === 'users' || name === '.index') continue
    const from = path.join(root, name)
    const to = path.join(target, name)
    if (fs.existsSync(to)) continue
    try {
      fs.renameSync(from, to)
    } catch {
      // 跨设备时 rename 会失败，退回复制
      fs.cpSync(from, to, { recursive: true })
      fs.rmSync(from, { recursive: true, force: true })
    }
    moved.push(name)
  }

  const staleIndex = path.join(root, '.index')
  if (fs.existsSync(staleIndex)) fs.rmSync(staleIndex, { recursive: true, force: true })

  return moved
}

/** 建好当前身份的目录树，必要时把老布局搬进来 */
function ensureLayout() {
  fs.mkdirSync(lifeRoot(), { recursive: true })
  const migrated = migrateLegacyLayout()
  fs.mkdirSync(lifeDir(), { recursive: true })
  return { dir: lifeDir(), context: context(), migrated: migrated || [] }
}

module.exports = {
  lifeRoot,
  lifeDir,
  memoryDir,
  usersDir,
  userDir,
  agentDir,
  resolveInside,
  setContext,
  context,
  ensureLayout,
  safeId,
  DEFAULT_USER,
  DEFAULT_AGENT
}
