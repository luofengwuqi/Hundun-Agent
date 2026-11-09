/**
 * 仪式过场的节奏（D114）。
 *
 * 抽成纯函数的理由和 `live.js` 那条一样：界面那条 SSR 断言在 Windows 上跑不起来
 * （`e:` 盘符），写在 `App.vue` 里的时序没有任何东西守得住。节奏是这一屏的全部内容，
 * 它得能脱开窗口测。
 *
 * **停顿的数是他的原话，不是估计的**（2026-11-09）：
 *
 *   你好 (0.7s) 芜柒 (1s)
 *   我是馄饨 (0.7s) 幸会 (1s)
 *   希望这里 (0.5s) 能短暂的温暖你 (5s)
 *
 * 他给的是「一行的前半句 / 后半句 / 整行结束」三个位置，正好对上文案里的逗号与行尾，
 * 所以这里按「逗号之后」和「行尾」两个位置写，不按固定字数切。
 *
 * **只有字速是我定的**：`CHAR_MS` 原来 86，他说「整体字体出现的慢一点」。
 * 86 是一行八句字一眨眼就完，看不出在「打」。130 = 原来的 1.5 倍。
 * 这个数他随时可以改——改这一个常量就够，别的地方不写死字速。
 */

/** 每个字之间。慢到能看清是在打，又不至于一行等太久 */
export const CHAR_MS = 130

/** 逗号之后，按行取。第 i 行的第一个逗号 → COMMA_PAUSE[i] */
export const COMMA_PAUSE = [700, 700, 500]

/**
 * 整行打完，按行取。**只有前两行有**——最后一行不打行停顿，
 * 它后面接的是 TAIL_MS（他要的 5 秒）。
 */
export const LINE_PAUSE = [1000, 1000]

/** 全部打完停在这里，然后才收场。他要的就是让最后那句留在屏幕上五秒 */
export const TAIL_MS = 5000

/**
 * 文案里认哪些当「句读」，行内碰到它就停 COMMA_PAUSE。
 *
 * **只剩空格了**（D117）：他说「用空格替换标点符号」，所以文案里的逗号全换成空格。
 * 原来那几个中文逗号留在表里没有坏处，但留着会让「这一屏不该出现标点」这条
 * 在代码里没有对应的证据 —— 表里只有空格，就是那句要求的落点。
 */
const BREAKS = [' ']

/**
 * 把三行文案摊成一串「打到哪个字、然后等多久」。
 *
 * 返回项里的 `text` 是**到这一格为止的整行**（界面直接塞进 `typed[i]` 就行），
 * 不是增量字符 —— 少一次字符串拼接，也少一种「拼错了没人发现」。
 * 最后一项 `text` 为 null，那是收场前的 5 秒。
 *
 * @param {string[]} lines
 * @returns {{line:number, text:string|null, wait:number}[]}
 */
export function ceremonySteps(lines) {
  const src = Array.isArray(lines) ? lines.filter((l) => typeof l === 'string' && l) : []
  const steps = []

  src.forEach((line, i) => {
    const chars = Array.from(line)
    chars.forEach((ch, k) => {
      const isLast = k === chars.length - 1
      let wait = CHAR_MS
      if (BREAKS.includes(ch)) wait = COMMA_PAUSE[i] == null ? COMMA_PAUSE[0] : COMMA_PAUSE[i]
      // 行尾优先于逗号：一行万一以逗号结尾，那就是行结束了，不该只停 700ms
      if (isLast) wait = LINE_PAUSE[i] == null ? 0 : LINE_PAUSE[i]
      steps.push({ line: i, text: chars.slice(0, k + 1).join(''), wait })
    })
  })

  if (!steps.length) return steps
  steps.push({ line: src.length - 1, text: null, wait: TAIL_MS })
  return steps
}
