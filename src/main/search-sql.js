/**
 * 检索索引的全部 SQL 语句，单独成文件。
 *
 * 目的：语义（建表、增删查）可以用任何 SQLite 实现验证——
 * 本机跑不了 WASM，scripts/test-sql.py 就用 Python 自带的 sqlite3 执行这些语句。
 * JS 侧只留薄胶水，SQL 出错的概率集中在这里被测掉。
 */
module.exports = {
  schema: [
    `CREATE TABLE IF NOT EXISTS notes (
       id INTEGER PRIMARY KEY,
       file TEXT NOT NULL,
       day TEXT,
       line INTEGER,
       text TEXT NOT NULL
     )`,
    'CREATE INDEX IF NOT EXISTS idx_notes_day ON notes(day)',
    'CREATE INDEX IF NOT EXISTS idx_notes_file ON notes(file)',
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)'
  ],
  clear: 'DELETE FROM notes',
  insert: 'INSERT INTO notes (file, day, line, text) VALUES (?, ?, ?, ?)',
  count: 'SELECT COUNT(*) AS n FROM notes',
  // 用 instr 而不是 LIKE：查询词里带 % _ 时不会被当通配符
  byTerm: 'SELECT file, day, line, text FROM notes WHERE instr(lower(text), lower(?)) > 0 LIMIT ?',
  setMeta: 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
  getMeta: 'SELECT value FROM meta WHERE key = ?'
}
