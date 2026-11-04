/**
 * 身份切换的唯一出口（P-25）。
 *
 * 「换一个人 / 换一个 agent」不是改个路径字符串就完事。要按顺序做四件事：
 *
 *   1. paths.setContext    —— 之后所有读写落到新目录
 *   2. life.ensureLife     —— 新身份可能还没有目录，先建好（空档案会触发访谈）
 *   3. conversation.resetSession —— 清历史与摘要，并把代次 +1（旧请求就此作废）
 *   4. search.rebuild      —— 索引是缓存的旧路径，不重建就会一直检索上一个人的记忆
 *
 * 顺序不能换：先换路径再复位会话，否则复位完的 history 还是按旧身份算的；
 * 索引必须最后重建，因为它要读新目录。
 *
 * 为什么不让 paths.setContext 自己顺手做这些：它是路径模块，不该知道
 * 「会话」「索引」这些东西的存在。把副作用堆进去，以后任何一次 setContext
 * 都会连带清空对话——包括不涉及切换的调用。
 */

const paths = require('./paths')
const store = require('./store')
const life = require('./life')
const conversation = require('./conversation')
const search = require('./search')

const listeners = []

/** 切换之后想知道的人挂这里（主进程用它放开忙碌锁、通知界面重载） */
function onSwitch(fn) {
  listeners.push(fn)
  return () => {
    const i = listeners.indexOf(fn)
    if (i >= 0) listeners.splice(i, 1)
  }
}

function current() {
  return paths.context()
}

/** 四件事，按顺序。init 与 switchTo 共用，保证两条路不会走出两种结果。 */
function apply(wanted, opts) {
  const before = paths.context()
  const after = paths.setContext(wanted)
  life.ensureLife()
  conversation.resetSession()
  search.rebuild().catch(() => {})
  if (opts.persist) {
    store.write({ currentUser: after.userId, currentAgent: after.agentId })
  }
  for (const fn of listeners) {
    try {
      fn({ ...after }, { ...before })
    } catch {
      // 一个监听者出错不能影响切换本身
    }
  }
  return { ...after }
}

/**
 * 启动时调一次。**不做「相同就跳过」的判断**——第一次启动时内存里的默认身份
 * 和配置里写的往往就是同一个，跳过就等于没建目录、没复位会话。
 */
function init(next = {}) {
  const cur = paths.context()
  return apply(
    {
      userId: next.userId === undefined ? cur.userId : next.userId,
      agentId: next.agentId === undefined ? cur.agentId : next.agentId
    },
    { persist: false }
  )
}

/**
 * 交互式切换。同一个身份再切一次直接返回：不该因为点了两下就清空正在聊的会话。
 * @param {{userId?: string, agentId?: string, persist?: boolean}} next
 */
function switchTo(next = {}) {
  const before = paths.context()
  const wanted = {
    userId: next.userId === undefined ? before.userId : next.userId,
    agentId: next.agentId === undefined ? before.agentId : next.agentId
  }
  if (wanted.userId === before.userId && wanted.agentId === before.agentId) {
    return { ...before }
  }
  return apply(wanted, { persist: next.persist !== false })
}

module.exports = { current, init, switchTo, onSwitch }
