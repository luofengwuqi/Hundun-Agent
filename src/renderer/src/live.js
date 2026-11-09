/**
 * 一格对话里该显示什么。
 *
 * 单独成文件是为了一件事：**能脱离 Electron／Vue 直接跑测试**（和 `blocks.js` 同一个理由）。
 * SSR 那条路在 Windows 上本来就跑不起来（P-01 的同一个根），
 * 而「等待态长什么样」是能纯函数判定的，不该因为界面跑不起来就没人测。
 *
 * 这里真正管的是一个瞬间：**他已经把话发出去了，而它还没吐出第一个字。**
 * 那一段原来显示的是一个空气泡加一根闪的光标——看起来像卡死，而不是在想（D109）。
 */
import { renderMarkdown } from './markdown.js'

/**
 * 还没开口时显示的那三个字。
 *
 * **不加「正在检索记忆」「正在挑模型」这类分阶段文案**：我们此刻并不知道它到了哪一步
 * （检索在主进程里，界面只收到 delta），写出来就是编一个内部状态给他看。
 * 只有「在想」这一句是真的——它确实在跑，也确实还没说话。
 */
export const WAIT_TEXT = '在想'

/**
 * 仪式期的等待文案（D115，D122 换成录入协议的口吻）。
 *
 * 那几轮根本没有模型在「想」—— 话是现成的，只有一次判定要等。
 * 显示「在想」等于让装程序用馄饨的口吻说话，正是这次要拿掉的东西。
 */
export const WAIT_RITUAL = '[STATUS: VERIFYING] 正在核对录入...'

/**
 * 是不是「它在想」的那一刻。
 *
 * 判据只有一条：**还没有可见内容**。不引入时间阈值——
 * 「超过 N 秒换个说法」需要一个 N，而这个 N 没有来源（§1.6 第 6 条）。
 *
 * 一个已知的近似：模型先吐 `<memory>` 块时，`content`（已剥块）仍是空的，
 * 于是这里继续显示「在想」。这不是事故——宁可多挂一句「还没说完」，
 * 也不要让他在那几秒里盯着一片空白。
 */
export function isThinking(m) {
  if (!m || !m.live) return false
  return !String(m.content || '').trim()
}

/** 助手这一格的 HTML。等待态／流式中／已收尾，三种走同一条判断。 */
export function liveHtml(m) {
  if (!m) return ''
  if (isThinking(m)) {
    const text = m.ritual ? WAIT_RITUAL : WAIT_TEXT
    return (
      '<span class="thinking">' +
      text +
      '<span class="dots"><i></i><i></i><i></i></span></span>'
    )
  }
  const body = renderMarkdown(m.content)
  return m.live ? body + '<span class="caret"></span>' : body
}
