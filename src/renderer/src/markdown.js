/**
 * 极简 Markdown 渲染。
 * 只支持对话里真正会出现的几种：代码块、行内代码、粗体、标题、无序列表。
 * 先转义再替换，避免模型输出里的尖括号变成标签。
 */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

export function renderMarkdown(src) {
  const text = String(src || '')
  const out = []
  const fences = text.split(/```/)
  for (let i = 0; i < fences.length; i++) {
    const chunk = fences[i]
    if (i % 2 === 1) {
      const body = chunk.replace(/^[a-zA-Z0-9_-]*\n/, '')
      out.push('<pre><code>' + escapeHtml(body.replace(/\n$/, '')) + '</code></pre>')
      continue
    }
    const blocks = chunk.split(/\n{2,}/)
    for (const block of blocks) {
      const t = block.trim()
      if (!t) continue
      const lines = t.split('\n')
      if (/^#{1,4}\s/.test(t)) {
        const level = Math.min(4, (t.match(/^#+/) || ['#'])[0].length)
        out.push('<h' + level + '>' + inline(t.replace(/^#+\s*/, '')) + '</h' + level + '>')
        continue
      }
      if (lines.every((l) => /^\s*[-*]\s/.test(l))) {
        out.push('<ul>' + lines.map((l) => '<li>' + inline(l.replace(/^\s*[-*]\s*/, '')) + '</li>').join('') + '</ul>')
        continue
      }
      out.push('<p>' + lines.map(inline).join('<br>') + '</p>')
    }
  }
  return out.join('')
}
