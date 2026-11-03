#!/usr/bin/env python3
"""
生成 HundunAgent 图标集。
零设计资源：一个朱红圆 + 奶油白「馄」字，和应用内的标识一致。

产出：
  resources/icon.png        512  窗口/通知图标
  resources/tray.png         64  托盘
  build/icons/<size>.png    16..512  electron-builder Linux 图标集
                              (必须是指标集目录，单文件会解析出 size=0，
                               见 hundunDesktop 决策 50)
"""
import os
from PIL import Image, ImageDraw, ImageFont

RED = (195, 39, 43, 255)
RED_DARK = (163, 28, 33, 255)
CREAM = (255, 248, 232, 255)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

FONT_PATH = "/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc"
FONT_INDEX = 0  # ttc 首个子字体，中文覆盖正常

SS = 4  # 超采样倍数


def draw_icon(size):
    """画一张 size×size、背景透明的图标"""
    px = size * SS
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = px * 0.04
    box = [pad, pad, px - pad, px - pad]
    d.ellipse(box, fill=RED, outline=RED_DARK, width=max(1, int(px * 0.012)))

    if size >= 24 and os.path.exists(FONT_PATH):
        # 中文字形几乎撑满 em 框，字号给到 0.42 才不会顶到圆边
        fsize = int(px * 0.42)
        font = ImageFont.truetype(FONT_PATH, fsize, index=FONT_INDEX)
        ch = "馄"
        bbox = d.textbbox((0, 0), ch, font=font)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        d.text(
            ((px - w) / 2 - bbox[0], (px - h) / 2 - bbox[1] + px * 0.01),
            ch,
            font=font,
            fill=CREAM,
        )
    else:
        # 极小尺寸：中文字糊成一团，改画一道奶油色弧线当记号
        r = px * 0.30
        cx = cy = px / 2
        d.arc(
            [cx - r, cy - r * 0.9, cx + r, cy + r * 0.9],
            start=200,
            end=340,
            fill=CREAM,
            width=max(1, int(px * 0.10)),
        )

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(os.path.join(ROOT, "resources"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "build", "icons"), exist_ok=True)

    draw_icon(512).save(os.path.join(ROOT, "resources", "icon.png"))
    draw_icon(64).save(os.path.join(ROOT, "resources", "tray.png"))

    for s in (16, 24, 32, 48, 64, 128, 256, 512):
        draw_icon(s).save(os.path.join(ROOT, "build", "icons", f"{s}x{s}.png"))

    # 窗口图标走 vite publicDir
    pub = os.path.join(ROOT, "src", "renderer", "public")
    os.makedirs(pub, exist_ok=True)
    draw_icon(256).save(os.path.join(pub, "icon.png"))

    print("图标已生成：resources/icon.png · resources/tray.png · build/icons/* · public/icon.png")


if __name__ == "__main__":
    main()
