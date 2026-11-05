/**
 * 记忆块的解析。
 * 单独成文件是为了能脱离 Electron 直接跑测试。
 */

const BLOCK_RE = /<(memory|longterm|profile|commit|open)>([\s\S]*?)<\/\1>/gi

// commit 是第四种块（F06-1／P-09）：它不进日记，进 COMMITMENTS.md。
// open 是第五种（F06-2 ②③／P-14）：也不进日记，进 OPEN.md。
//
// 三种「不止是记忆」的块都必须单列：一旦和 memory 混进同一个桶，
// 那件事会被写成一行日记，然后永远不会有人问起——不报错、不崩，
// 只是从此刻起它不再提这件事。
const VALID = new Set(['memory', 'longterm', 'profile', 'commit', 'open'])

/**
 * 从模型回复里抠出记忆块。
 * @returns {{clean:string, notes:Array<{target:string, lines:string[]}>}}
 */
function parseBlocks(text) {
  const notes = []
  const clean = String(text || '')
    .replace(BLOCK_RE, (_, tag, body) => {
      const target = String(tag).toLowerCase()
      if (!VALID.has(target)) return ''
      const lines = body
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !/^[-*]$/.test(s))
      if (lines.length) notes.push({ target, lines })
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { clean, notes }
}

/** 把零散的 notes 归并成 {memory:[], longterm:[], profile:[], commit:[], open:[]} */
function groupNotes(notes) {
  const bucket = { memory: [], longterm: [], profile: [], commit: [], open: [] }
  for (const n of notes) {
    if (bucket[n.target]) bucket[n.target].push(...n.lines)
  }
  return bucket
}

/**
 * 一个块都没解析出来时，说说为什么。
 *
 * 「模型没写块」和「模型写了但没闭合」在结果上一样（notes 为空），
 * 但修法完全不同：前者是提示词的事，后者是正则的事。
 * 只回一句人能看懂的话，不把正文倒进日志（那是他的原话）。
 *
 * @returns {string|null} 没问题时返回 null
 */
function diagnose(text) {
  const s = String(text || '')
  if (!s) return null
  const found = []
  for (const tag of VALID) {
    const open = (s.match(new RegExp('<' + tag + '(?=[\\s>])', 'gi')) || []).length
    const close = (s.match(new RegExp('</' + tag + '\\s*>', 'gi')) || []).length
    if (open && !close) found.push('<' + tag + '> 开了没闭合')
    else if (open > close) found.push('<' + tag + '> 开 ' + open + ' 个只闭合 ' + close + ' 个')
  }
  // 全角的尖括号：模型偶尔会把 <> 打成 〈〉，正则认不出
  const wide = (s.match(/[〈＜]\s*(memory|longterm|profile|commit|open)\s*[〉＞]/gi) || []).length
  if (wide) found.push('用了全角尖括号')
  return found.length ? found.join('；') : null
}

module.exports = { parseBlocks, groupNotes, diagnose, BLOCK_RE }
