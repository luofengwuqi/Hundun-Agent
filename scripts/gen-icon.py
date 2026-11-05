#!/usr/bin/env python3
"""
由 build/logo.svg 生成 HundunAgent 的全部图标 / 图片资源。

唯一源：build/logo.svg（馄饨 + A 的线稿，单色 #c3272b，透明底）。
要换 logo 只替换这一个文件、重跑本脚本，别去改生成的 PNG。

产出：
  resources/icon.png              512  窗口图标（Linux）
  resources/tray.png               32  托盘
  build/icons/<size>.png        16..512  electron-builder 图标集
  build/icon.ico                   256  Windows 打包图标（多尺寸）
  build/icon.icns                  512  macOS 打包图标
  src/renderer/public/icon.png     256  窗口兜底 / favicon
  src/renderer/public/logo.svg          界面里直接 <img src="./logo.svg">（矢量，不糊）

依赖：ImageMagick 的 convert + python3 标准库，不依赖 PIL。
"""
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SRC = os.path.join(ROOT, "build", "logo.svg")
RES = os.path.join(ROOT, "resources")
ICONS = os.path.join(ROOT, "build", "icons")
PUB = os.path.join(ROOT, "src", "renderer", "public")

SIZES = (16, 24, 32, 48, 64, 128, 256, 512)

# logo 已按图形包围盒收紧过 viewBox（221×141，宽高比约 1.57）。
# 图标是正方形，直接按高度缩会左右留出大片空，所以先「按宽度铺满」再居中补高。
# 留白给得小：标记是线稿，四周再空一圈，小尺寸就只剩一根头发丝。
MARGIN = 0.05  # 四周留白比例


def magick(*args):
    """跑 convert，失败就抛异常（不静默吞错）"""
    cmd = ["convert"] + [str(a) for a in args]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("convert %s 失败: %s" % (" ".join(cmd[1:]), r.stderr.decode().strip()))
    return r


def render_square(src_path, size):
    """
    等比缩到 size×size 的透明画布正中，四周留 MARGIN 的边（不拉伸）。

    用 -resize {inner}x{inner}（等比）而不是 {inner}x{inner}!：
    标记是横宽的，强制成正方形会把馄饨压扁；等比缩完高度不满，靠 -extent 补透明。
    """
    inner = max(1, size - int(round(size * MARGIN)) * 2)
    out = "/tmp/hundun-logo-out-%d.png" % size
    # -unsharp 是为小尺寸准备的：线稿只有 1~2px 粗，纯 Lanczos 缩下来边缘会虚成一片粉。
    # 轻微锐化让 16/32 也能看出「馄饨轮廓 + A」而不是一团红。
    magick(
        src_path,
        "-resize", "%dx%d" % (inner, inner),
        "-unsharp", "0x0.8+1+0",
        "-background", "none",
        "-gravity", "center",
        "-extent", "%dx%d" % (size, size),
        out,
    )
    with open(out, "rb") as f:
        data = f.read()
    os.unlink(out)
    return data


def write_ico(pngs, out):
    """手写 .ico（只用标准库）。Vista+ 允许内嵌 PNG，256 及以下直接塞 PNG。"""
    n = len(pngs)
    header = struct.pack("<HHH", 0, 1, n)
    entries = b""
    offset = 6 + 16 * n
    blobs = b""
    for size, data in pngs:
        w = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    with open(out, "wb") as f:
        f.write(header + entries + blobs)


def write_icns(pngs, out):
    """手写 .icns，写 icp4/icp5/icp6/ic07/ic08/ic09。"""
    legend = {16: b"icp4", 32: b"icp5", 64: b"icp6", 128: b"ic07", 256: b"ic08", 512: b"ic09"}
    chunks = b""
    for size, data in pngs:
        tag = legend.get(size)
        if tag:
            chunks += tag + struct.pack(">I", len(data) + 8) + data
    with open(out, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)


def main():
    if not os.path.exists(SRC):
        print("找不到 %s" % SRC, file=sys.stderr)
        return 1

    for d in (RES, ICONS, PUB):
        os.makedirs(d, exist_ok=True)

    # 先把矢量渲成一张 2048 的位图并裁掉空边，之后所有尺寸都从它缩，保证一致。
    # 2048 而不是 1024：ImageMagick 的 MSVG 渲染器抗锯齿一般，超采样给足
    # 才能在 16/32 这种尺寸上保住线稿的清晰度。
    big = "/tmp/hundun-logo-src.png"
    magick("-background", "none", "-density", "384", SRC, "-resize", "2048x2048", "-trim", "+repage", big)

    bufs = {s: render_square(big, s) for s in SIZES}

    def save(path, size):
        with open(path, "wb") as f:
            f.write(bufs[size])

    save(os.path.join(RES, "icon.png"), 512)
    save(os.path.join(RES, "tray.png"), 32)
    for s in SIZES:
        save(os.path.join(ICONS, "%dx%d.png" % (s, s)), s)

    write_ico([(s, bufs[s]) for s in (16, 24, 32, 48, 64, 128, 256)], os.path.join(ROOT, "build", "icon.ico"))
    write_icns([(s, bufs[s]) for s in (16, 32, 64, 128, 256, 512)], os.path.join(ROOT, "build", "icon.icns"))

    save(os.path.join(PUB, "icon.png"), 256)
    with open(SRC, "r", encoding="utf-8") as f:
        svg = f.read()
    with open(os.path.join(PUB, "logo.svg"), "w", encoding="utf-8") as f:
        f.write(svg)

    print("图标已由 build/logo.svg 生成：")
    print("  resources/icon.png · resources/tray.png")
    print("  build/icons/*.png · build/icon.ico · build/icon.icns")
    print("  src/renderer/public/icon.png · src/renderer/public/logo.svg")
    return 0


if __name__ == "__main__":
    sys.exit(main())
