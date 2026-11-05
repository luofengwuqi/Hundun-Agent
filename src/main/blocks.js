/**
 * 记忆块的解析。
 * 单独成文件是为了能脱离 Electron 直接跑测试。
 */

const BLOCK_RE = /<(memory|longterm|profile|commit)>([\s\S]*?)<\/\1>/gi

// commit 是第四种块（F06-1／P-09）：它不进日记，进 COMMITMENTS.md。
// 单独列出来是因为**它必须被看见**——一旦和 memory 混在一个桶里，
// 那条约定了会被写成一行日记，然后永远不会有人问起（静默失效）。
const VALID = new Set(['memory', 'longterm', 'profile', 'commit'])

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

/** 把零散的 notes 归并成 {memory:[], longterm:[], profile:[], commit:[]} */
function groupNotes(notes) {
  const bucket = { memory: [], longterm: [], profile: [], commit: [] }
  for (const n of notes) {
    if (bucket[n.target]) bucket[n.target].push(...n.lines)
  }
  return bucket
}

module.exports = { parseBlocks, groupNotes, BLOCK_RE }
