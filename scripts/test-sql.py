#!/usr/bin/env python3
"""
用 Python 自带的 sqlite3 验证 search-sql.js 里的 SQL 语句。

为什么绕这一圈：本机虚拟内存被限在 4GB，sql.js 的 WASM 初始化不起来，
JS 侧的 SQLite 分支在这里没法执行。但 SQL 是标准的，交给原生 sqlite3 验一遍，
JS 那边只剩 prepare/bind/step 的薄胶水，出错面很小。

用法（由 scripts/test.mjs 调用，也可单独跑）：
    node -e "console.log(JSON.stringify(require('./src/main/search-sql.js')))" | python3 scripts/test-sql.py
"""
import json
import sqlite3
import sys

spec = json.load(sys.stdin)
db = sqlite3.connect(":memory:")

pass_n = 0
fail_n = 0


def ok(cond, name, extra=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print("  ✓ " + name)
    else:
        fail_n += 1
        print("  ✗ " + name + ("  → " + str(extra) if extra else ""))


# 建表（语句来自 search-sql.js，不在这里重写）
for stmt in spec["schema"]:
    db.execute(stmt)
print("  ✓ 建表语句可执行（%d 条）" % len(spec["schema"]))

rows = [
    ("memory/2026-10-01.md", "2026-10-01", 3, "主要做后端开发，晚上效率最高"),
    ("memory/2026-10-02.md", "2026-10-02", 5, "今天卡在登录页，token 过期"),
    ("MEMORY.md", None, 9, "判断：周三下午效率低 → 见 10-01/10-08"),
    ("memory/2026-10-03.md", "2026-10-03", 1, "100% 完成度这种词别记"),
]
db.executemany(spec["insert"], rows)

n = db.execute(spec["count"]).fetchone()[0]
ok(n == len(rows), "插入后可计数", n)

hit = db.execute(spec["byTerm"], ("登录页", 10)).fetchall()
ok(len(hit) == 1 and "登录页" in hit[0][3], "中文检索命中", hit)

hit = db.execute(spec["byTerm"], ("开发", 10)).fetchall()
ok(len(hit) == 1, "中文词命中", hit)

# instr 不是 LIKE：% 和 _ 必须当字面量
hit = db.execute(spec["byTerm"], ("%", 10)).fetchall()
ok(len(hit) == 1 and "100%" in hit[0][3], "% 当字面量，不当通配符", hit)

hit = db.execute(spec["byTerm"], ("_", 10)).fetchall()
ok(len(hit) == 0, "_ 当字面量，不当通配符", hit)

# lower() 让英文检索不区分大小写（SQLite 的 lower 只处理 ASCII，中文不受影响）
hit = db.execute(spec["byTerm"], ("TOKEN", 10)).fetchall()
ok(len(hit) == 1, "英文大小写不敏感", hit)

# LIMIT 生效
hit = db.execute(spec["byTerm"], ("效率", 1)).fetchall()
ok(len(hit) == 1, "LIMIT 生效", hit)

# clear 能清空
db.execute(spec["clear"])
ok(db.execute(spec["count"]).fetchone()[0] == 0, "clear 清空索引")

# meta 读写
db.execute(spec["setMeta"], ("built_at", "2026-11-03T10:00:00Z"))
db.execute(spec["setMeta"], ("built_at", "2026-11-03T11:00:00Z"))
v = db.execute(spec["getMeta"], ("built_at",)).fetchone()
ok(v and v[0] == "2026-11-03T11:00:00Z", "meta 覆盖写（INSERT OR REPLACE）", v)

print("\n" + ("全部通过" if fail_n == 0 else "有失败项") + "：%d 通过 / %d 失败" % (pass_n, fail_n))
sys.exit(0 if fail_n == 0 else 1)
