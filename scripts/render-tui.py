"""Round-1 TUI 截图渲染：ANSI 彩色帧 → PNG（PIL）。

用法: python scripts/render-tui.py
读取 screenshots/tui-raw/*.txt（ink-testing-library 输出的 ANSI 帧），
渲染为 screenshots/r1-tui-*.png。
"""

import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

RAW_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "screenshots", "tui-raw")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "screenshots")

FONT_SIZE = 24
CELL_W = 14   # ASCII 单元宽
CELL_H = 28   # 行高

FONTS = {
    "ascii": ImageFont.truetype(r"C:\Windows\Fonts\consola.ttf", FONT_SIZE),
    "ascii_bold": ImageFont.truetype(r"C:\Windows\Fonts\consolab.ttf", FONT_SIZE),
    "cjk": ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", FONT_SIZE),
    "symbol": ImageFont.truetype(r"C:\Windows\Fonts\seguisym.ttf", FONT_SIZE),
}

BG = (11, 11, 16)          # theme.background #0B0B10
FG_DEFAULT = (232, 230, 224)  # theme.text #E8E6E0

SGR_RE = re.compile(r"\x1b\[([0-9;]*)m")
ESC_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return (
        0x2E80 <= cp <= 0x9FFF
        or 0xF900 <= cp <= 0xFAFF
        or 0xFF00 <= cp <= 0xFF60
        or 0x3000 <= cp <= 0x303F
        or 0xFE30 <= cp <= 0xFE6F
        or 0x20000 <= cp <= 0x2FA1F
    )


def is_symbol(ch: str) -> bool:
    cp = ord(ch)
    return 0x2000 <= cp <= 0x27BF or 0x1F000 <= cp <= 0x1FAFF


def split_emojis(text: str):
    """按码点切分，代理对合并为单个字符。"""
    out = []
    i = 0
    while i < len(text):
        c = text[i]
        if 0xD800 <= ord(c) <= 0xDBFF and i + 1 < len(text) and 0xDC00 <= ord(text[i + 1]) <= 0xDFFF:
            out.append(text[i:i + 2])
            i += 2
        else:
            out.append(c)
            i += 1
    return out


def parse_frame(raw: str):
    """把 ANSI 帧解析为 (行, 列) -> (char, fg, bg, bold)。"""
    grid = {}
    max_cols = 0
    fg = FG_DEFAULT
    bg = BG
    bold = False
    italic = False

    # 逐段处理：先按 SGR 切分，非 SGR 段按行/列写入
    tokens = []
    pos = 0
    for m in SGR_RE.finditer(raw):
        if m.start() > pos:
            tokens.append(("text", raw[pos:m.start()]))
        tokens.append(("sgr", m.group(1)))
        pos = m.end()
    if pos < len(raw):
        tokens.append(("text", raw[pos:]))

    row = 0
    col = 0
    for kind, val in tokens:
        if kind == "sgr":
            codes = [int(x) for x in val.split(";") if x != ""] if val else [0]
            i = 0
            while i < len(codes):
                c = codes[i]
                if c == 0:
                    fg, bg, bold = FG_DEFAULT, BG, False
                elif c == 1:
                    bold = True
                elif c == 3:
                    italic = True
                elif c == 22:
                    bold = False
                elif c == 23:
                    italic = False
                elif 30 <= c <= 37:
                    fg = ((0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0),
                          (0, 0, 128), (128, 0, 128), (0, 128, 128), (192, 192, 192))[c - 30]
                elif c == 39:
                    fg = FG_DEFAULT
                elif 90 <= c <= 97:
                    fg = ((128, 128, 128), (255, 0, 0), (0, 255, 0), (255, 255, 0),
                          (0, 0, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255))[c - 90]
                elif 40 <= c <= 47:
                    bg = ((0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0),
                          (0, 0, 128), (128, 0, 128), (0, 128, 128), (192, 192, 192))[c - 40]
                elif c == 49:
                    bg = BG
                elif c == 38 and i + 2 < len(codes) and codes[i + 1] == 2:
                    fg = (codes[i + 2], codes[i + 3], codes[i + 4])
                    i += 4
                elif c == 48 and i + 2 < len(codes) and codes[i + 1] == 2:
                    bg = (codes[i + 2], codes[i + 3], codes[i + 4])
                    i += 4
                i += 1
            continue

        # text
        for ch in split_emojis(val):
            if ch == "\n":
                row += 1
                col = 0
                continue
            if ch == "\r":
                continue
            if ch == "\t":
                col += 4
                continue
            grid[(row, col)] = (ch, fg, bg, bold)
            col += 2 if (is_cjk(ch) or ord(ch) > 0xFFFF) else 1
            max_cols = max(max_cols, col)

    return grid, max_cols


def draw_frame(name: str):
    raw = open(os.path.join(RAW_DIR, name), encoding="utf-8").read()
    grid, max_cols = parse_frame(raw)
    if not grid:
        print("empty frame:", name)
        return
    rows = max(r for r, _ in grid) + 1
    cols = max_cols
    img = Image.new("RGB", (cols * CELL_W, rows * CELL_H), BG)
    d = ImageDraw.Draw(img)

    for (row, col), (ch, fg, bg, bold) in grid.items():
        x = col * CELL_W
        y = row * CELL_H
        if bg != BG:
            d.rectangle([x, y, x + CELL_W * (2 if ord(ch) > 0xFFFF or is_cjk(ch) else 1), y + CELL_H], fill=bg)
        if ch == " " or ch == "":
            continue
        if is_cjk(ch):
            font = FONTS["cjk"]
        elif ord(ch) > 0xFFFF or is_symbol(ch):
            font = FONTS["symbol"]
        else:
            font = FONTS["ascii_bold"] if bold else FONTS["ascii"]
        w = 2 * CELL_W if (is_cjk(ch) or ord(ch) > 0xFFFF) else CELL_W
        bbox = d.textbbox((0, 0), ch, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        tx = x + (w - tw) // 2
        ty = y + (CELL_H - th) // 2 - 2
        d.text((tx, ty), ch, font=font, fill=fg)

    out = os.path.join(OUT_DIR, name.replace(".txt", ".png").replace("01-welcome", "r2-tui-welcome").replace("02-conversation", "r2-tui-conversation"))
    img.save(out)
    print("rendered", out, img.size)


def main():
    for f in sorted(os.listdir(RAW_DIR)):
        if f.endswith(".txt"):
            draw_frame(f)


if __name__ == "__main__":
    sys.exit(main())
