#!/usr/bin/env python3
"""
打 zip 包，并把中文文件名的 UTF-8 标志位设对。

为什么要自己写：本机 `zip` 命令会把 UTF-8 文件名按 Latin-1 单字节写入，
且不设 0x800 标志位，结果在 Windows 资源管理器里解压出来全是乱码。
Python 的 zipfile 写 UTF-8 名时会自动设置该标志。

用法：
    python3 scripts/make-zip.py <源目录> <输出.zip>
"""
import os
import sys
import zipfile


def add_dir(z, root, rel=""):
    """递归收集 root/rel 下的内容，归档路径以 root 的目录名开头"""
    base = os.path.join(root, rel) if rel else root
    top = os.path.basename(root.rstrip("/"))
    for name in sorted(os.listdir(base)):
        full = os.path.join(base, name)
        inner = (rel + "/" + name) if rel else name
        arc = top + "/" + inner.replace(os.sep, "/")
        if os.path.isdir(full):
            z.write(full, arc + "/")
            add_dir(z, root, inner)
        else:
            z.write(full, arc)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    src, out = sys.argv[1].rstrip("/"), sys.argv[2]
    if os.path.exists(out):
        os.remove(out)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        add_dir(z, src)
        count = sum(1 for n in z.namelist() if not n.endswith("/"))

    size = os.path.getsize(out)
    print(f"已生成 {os.path.basename(out)}：{count} 个文件，{size/1024:.0f} KB")

    # 自检：解出来文件名必须是正常中文
    with zipfile.ZipFile(out) as z:
        bad = z.testzip()
        names = z.namelist()
        utf8 = all((i.flag_bits & 0x800) for i in z.infolist() if not i.filename.isascii())
        sample = [n for n in names if n.endswith(".md")][:2]
    print("  完整性:", "正常" if bad is None else "损坏 " + bad)
    print("  中文名 UTF-8 标志:", "已设置" if utf8 else "未设置")
    for s in sample:
        print("  样例:", s)


if __name__ == "__main__":
    main()
