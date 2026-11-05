const fs = require('fs')
const path = require('path')
const life = require('./life')
const SQLS = require('./search-sql')

/**
 * 记忆检索层。
 *
 * 约定（和最初的设计一致）：
 *  - Markdown 文件是唯一事实来源，索引只是缓存，随时可删，删了不丢任何记忆。
 *  - 首选 SQLite（sql.js，纯 WASM，无原生模块，Electron 里开箱即用）。
 *  - WASM 起不来时（个别受限环境）自动退回内存扫描，功能等价，只是重。
 *
 * 用法：await search.init() 之后 rebuild() / search()。
 */

let ready = null
let backend = null

function dbPath() {
  return path.join(life.lifeDir(), '.index', 'memory.sqlite')
}

function init() {
  if (!ready) ready = boot()
  return ready
}

async function boot() {
  try {
    const vendor = path.join(__dirname, 'vendor')
    const initSqlJs = require(path.join(vendor, 'sql-wasm.js'))
    const wasmBinary = fs.readFileSync(path.join(vendor, 'sql-wasm.wasm'))
    const SQL = await initSqlJs({ wasmBinary })
    const p = dbPath()
    let db
    if (fs.existsSync(p)) {
      db = new SQL.Database(fs.readFileSync(p))
    } else {
      db = new SQL.Database()
      for (const s of SQLS.schema) db.run(s)
    }
    backend = {
      kind: 'sqlite',
      db,
      persist() {
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, Buffer.from(db.export()))
      }
    }
  } catch (e) {
    // WASM 起不来（典型：虚拟内存受限的环境）→ 退回内存扫描
    backend = { kind: 'memory', rows: [], error: String(e.message || e), persist() {} }
  }
  return backend
}

/* ---------- 两种后端共用的小工具 ---------- */

function runDb(db, sql, params) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  stmt.step()
  stmt.free()
}

function queryDb(db, sql, params) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}

/**
 * 不进索引的常驻文件。
 *
 * 这些文件**每一轮都已经注入**（见 buildSystemPrompt 的 Project Context）。
 * 再索引一遍不只是冗余：召回那段的说明是「这些是过去真实记下的原话，
 * 可以直接引用（说「你那天说过」）」——模型会把 SOUL／AGENTS 里的口吻
 * 当成**他说过的话**复述出来。那是把提示词当记忆，比记不住更糟。
 *
 * 索引只该收「随时间累积的东西」：memory/日期.md（日记）与 chat/日期.md（原话）。
 */
const NOT_INDEXED = new Set([
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'MEMORY.md',
  'RULES.md',
  'BOOTSTRAP.md',
  'COMMITMENTS.md',
  'OPEN.md'
])

/** 扫描 ~/life 下所有 md，按行切成索引单元 */
function collectRows() {
  const root = life.lifeDir()
  const rows = []
  const walk = (dir, rel) => {
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of ents) {
      const r = rel ? rel + '/' + ent.name : ent.name
      if (ent.isDirectory()) {
        if (ent.name === '.index' || ent.name.startsWith('.')) continue
        walk(path.join(dir, ent.name), r)
      } else if (ent.name.endsWith('.md')) {
        if (NOT_INDEXED.has(ent.name)) continue
        let txt
        try {
          txt = fs.readFileSync(path.join(dir, ent.name), 'utf8')
        } catch {
          continue
        }
        const day = (ent.name.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null
        txt.split('\n').forEach((line, i) => {
          const t = line.trim()
          if (t.length >= 4 && !t.startsWith('#')) rows.push({ file: r, day, line: i + 1, text: t })
        })
      }
    }
  }
  walk(root, '')
  return rows
}

/**
 * 全量重建索引。个人规模（几千行）耗时在毫秒级，
 * 每次记忆落盘后调一次比维护增量逻辑可靠得多。
 */
async function rebuild() {
  const b = await init()
  const rows = collectRows()
  if (b.kind === 'sqlite') {
    b.db.run(SQLS.clear)
    for (const r of rows) runDb(b.db, SQLS.insert, [r.file, r.day, r.line, r.text])
    runDb(b.db, SQLS.setMeta, ['built_at', new Date().toISOString()])
    b.persist()
  } else {
    b.rows = rows
  }
  return rows.length
}

/**
 * 中文没有空格，按「英文整词 + 中文双字滑窗」切查询词。
 * "主要做开发" → 主要/要做/做开/开发
 */
function tokenize(q) {
  const s = String(q || '')
  const terms = []
  for (const m of s.toLowerCase().match(/[a-z0-9_]{2,}/g) || []) terms.push(m)
  for (const run of s.match(/[一-鿿]+/g) || []) {
    if (run.length <= 3) terms.push(run)
    else for (let i = 0; i + 1 < run.length; i++) terms.push(run.slice(i, i + 2))
  }
  return [...new Set(terms)].slice(0, 8)
}

/**
 * 关键词检索记忆。返回 [{file, day, line, text, score}]，按相关度降序。
 * 打分：命中词数为主，行内命中次数为辅，再给近的日子一点点加成。
 */
async function search(q, limit = 10) {
  const b = await init()
  const terms = tokenize(q)
  if (!terms.length) return []

  const seen = new Map()
  const add = (r, matched) => {
    const key = r.file + ':' + r.line
    const cur = seen.get(key)
    if (cur) cur.matched += matched
    else seen.set(key, { file: r.file, day: r.day, line: r.line, text: r.text, matched })
  }

  if (b.kind === 'sqlite') {
    for (const t of terms) {
      for (const row of queryDb(b.db, SQLS.byTerm, [t, 200])) {
        const low = String(row.text).toLowerCase()
        let n = 0
        let at = low.indexOf(t.toLowerCase())
        while (at >= 0) {
          n++
          at = low.indexOf(t.toLowerCase(), at + 1)
        }
        add(row, n)
      }
    }
  } else {
    for (const r of b.rows) {
      const low = r.text.toLowerCase()
      let m = 0
      for (const t of terms) {
        const tt = t.toLowerCase()
        let n = 0
        let at = low.indexOf(tt)
        while (at >= 0) {
          n++
          at = low.indexOf(tt, at + 1)
        }
        m += n
      }
      if (m) add(r, m)
    }
  }

  const scored = [...seen.values()].map((r) => ({
    file: r.file,
    day: r.day,
    line: r.line,
    text: r.text,
    score:
      r.matched * 2 +
      Math.min(r.text.length, 60) / 60 +
      (r.day ? Math.max(0, Date.parse(r.day) / 1e12) : 0)
  }))
  scored.sort((a, b2) => b2.score - a.score || (a.file + a.line).localeCompare(b2.file + b2.line))
  return scored.slice(0, limit)
}

/** 状态信息，给界面显示用 */
async function info() {
  const b = await init()
  if (b.kind === 'sqlite') {
    const rows = queryDb(b.db, SQLS.count, [])
    return { kind: 'sqlite', count: rows[0] ? Number(rows[0].n) : 0, path: dbPath() }
  }
  return { kind: 'memory', count: b.rows.length, error: b.error || '' }
}

module.exports = { init, rebuild, search, tokenize, info, collectRows, dbPath }
