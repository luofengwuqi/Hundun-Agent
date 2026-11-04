/**
 * 会话代次（F13-06 的防线）。
 *
 * 为什么需要它：`conversation.js` 的 history / summary / busy 是**进程级单值**，
 * 不分身份。切身份时把它们清空还不够——一个已经在飞的请求回来时，
 * 闭包里的 `history` 指向的还是同一个数组，于是 A 的回复会 push 进 B 的上下文，
 * 压缩时摘要还会写进 B 的 `MEMORY.md`。
 *
 * 这个错**不报错、不崩、不响**，等发现时别人的记忆里已经混着你的话。
 *
 * 做法：每次切换身份把代次 +1。请求开始时记下当时的代次，
 * 写任何东西之前先问一句「我出发时的那个身份还在吗」。不在就整个丢弃。
 *
 * 单独成模块是为了能被测试直接加载（不碰 electron）。
 */

let epoch = 0

function current() {
  return epoch
}

function bump() {
  epoch += 1
  return epoch
}

/** 这个请求出发时的身份，还是现在的身份吗 */
function isStale(myEpoch) {
  return myEpoch !== epoch
}

module.exports = { current, bump, isStale }
