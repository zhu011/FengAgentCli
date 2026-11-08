"""Round-3 TUI 截图渲染：ANSI 彩色帧 → PNG（PIL）。

用法: python scripts/render-tui.py
读取 screenshots/tui-raw/*.txt（ink-testing-library 输出的 ANSI 帧），
渲染为 screenshots/r3-tui-*.png。
支持 24-bit 前景/背景色（48;2;r;g;b），等价于 Linux/macOS 等
truecolor 终端的渲染效果（Round 3 非 Windows 终端填充气泡验证）。

T1 对齐修复（owner 反馈「歪歪扭扭」的两个根因）：
1. **字体**：改用真·等宽组合 —— Consolas@26（全字符推进恰为 CELL_W=14，
   含制表符/块元素/几何图形）画 ASCII/边框/进度条；SimHei@28（CJK 推进恰为
   2×CELL_W=28）画中文；Segoe UI Symbol 只画真正的 emoji/状态图标（居中）。
   旧版微软雅黑是非等宽字体（A=20、╭=17、·=7 各不相同）+ 逐字符居中，
   混排必然歪斜。
2. **列宽**：`⚡ ⏳` 等 Emoji_Presentation 字符 ink/string-width 按 **2 格**算，
   渲染器旧版按 1 格 → 边框/右对齐内容整体错位。现按与 string-width 一致
   的宽字符口径计数（含 BMP 内的 emoji 宽字符集）。
"""

import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

RAW_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "screenshots", "tui-raw")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "screenshots")

CELL_W = 14   # ASCII 单元宽（Consolas@26 实测推进 = 14.0）
CELL_H = 28   # 行高（SimHei@28 CJK 推进 = 28.0 = 2 格）

FONTS = {
    # Consolas@26：全部字符（含 ─ ╭ █ ● 等）推进恰为 14.0 = CELL_W，等宽不歪
    "ascii": ImageFont.truetype(r"C:\Windows\Fonts\consola.ttf", 26),
    "ascii_bold": ImageFont.truetype(r"C:\Windows\Fonts\consolab.ttf", 26),
    # SimHei@28：CJK 推进恰为 28.0 = 2×CELL_W，与 Consolas 构成严格 2:1 双宽
    "cjk": ImageFont.truetype(r"C:\Windows\Fonts\simhei.ttf", 28),
    # 真·emoji / 状态图标（⚡ ⏳ ✓ ✗ ⚠ ❯ …）专用，按实际宽度居中
    "symbol": ImageFont.truetype(r"C:\Windows\Fonts\seguisym.ttf", 24),
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


# BMP 内 Emoji_Presentation=Yes 的字符（ink/string-width 按 2 格计数）。
# 覆盖 Unicode 13 的 BMP 宽 emoji 集（⌚⌛⏩-⏳⏰⏽◐-◑光谱圈除外——
# ● ◐ 等几何图形是 Ambiguous，string-width 默认按 1 格）。
EMOJI_WIDE_RANGES = (
    (0x231A, 0x231B), (0x2329, 0x232A), (0x23E9, 0x23EC), (0x23F0, 0x23F0),
    (0x23F3, 0x23F3), (0x25FD, 0x25FE), (0x2614, 0x2615), (0x2648, 0x2653),
    (0x267F, 0x267F), (0x2693, 0x2693), (0x26A1, 0x26A1), (0x26AA, 0x26AB),
    (0x26BD, 0x26BE), (0x26C4, 0x26C5), (0x26CE, 0x26CE), (0x26D4, 0x26D4),
    (0x26EA, 0x26EA), (0x26F2, 0x26F3), (0x26F5, 0x26F5), (0x26FA, 0x26FA),
    (0x26FD, 0x26FD), (0x2705, 0x2705), (0x270A, 0x270B), (0x2728, 0x2728),
    (0x274C, 0x274C), (0x274E, 0x274E), (0x2753, 0x2755), (0x2757, 0x2757),
    (0x2795, 0x2797), (0x27B0, 0x27B0), (0x27BF, 0x27BF), (0x2B1B, 0x2B1C),
    (0x2B50, 0x2B50), (0x2B55, 0x2B55),
)


def is_wide(ch: str) -> bool:
    """与 ink/string-width 一致的宽度判定：CJK / 增补平面 / BMP 宽 emoji → 2 格。"""
    cp = ord(ch)
    if is_cjk(ch) or cp > 0xFFFF:
        return True
    for lo, hi in EMOJI_WIDE_RANGES:
        if lo <= cp <= hi:
            return True
    return False


def is_symbol(ch: str) -> bool:
    """真·emoji / 状态图标（走 symbol 字体居中画）。

    制表符（0x2500-0x257F）、块元素（0x2580-0x259F）、几何图形（0x25A0-0x25FF，
    含 ● ◐ ○ ■）Consolas 全覆盖且等宽 —— 归 ascii 字体，边框/进度条才对得齐。
    """
    cp = ord(ch)
    if 0x2500 <= cp <= 0x25FF:
        return False
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
            col += 2 if is_wide(ch) else 1
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
        wide = is_wide(ch)
        span = 2 * CELL_W if wide else CELL_W
        if bg != BG:
            d.rectangle([x, y, x + span, y + CELL_H], fill=bg)
        if ch == " " or ch == "":
            continue
        if is_cjk(ch):
            font = FONTS["cjk"]
        elif is_symbol(ch):
            font = FONTS["symbol"]
        else:
            # ASCII + 制表符 + 块元素 + 几何图形（● ◐ …）全部走 Consolas：
            # 推进恰为 CELL_W / 2×CELL_W，左起画即严格对齐
            font = FONTS["ascii_bold"] if bold else FONTS["ascii"]
        bbox = d.textbbox((0, 0), ch, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        if is_symbol(ch):
            # emoji/图标：按实际字形在格内居中（seguisym 非等宽）
            tx = x + (span - tw) // 2
        else:
            # 等宽字体：左起画（advance == span），垂直仍按字形居中
            tx = x
        ty = y + (CELL_H - th) // 2 - 2
        d.text((tx, ty), ch, font=font, fill=fg)

    out = os.path.join(OUT_DIR, name.replace(".txt", ".png")
                       .replace("01-welcome", "r3-tui-welcome")
                       .replace("02-conversation", "r3-tui-conversation")
                       .replace("03-longtext", "r3-tui-longtext")
                       .replace("04-thinking-streaming", "r4-tui-thinking-streaming")
                       .replace("05-thinking-complete", "r4-tui-thinking-complete"))
    img.save(out)
    print("rendered", out, img.size)


def main():
    for f in sorted(os.listdir(RAW_DIR)):
        if f.endswith(".txt"):
            draw_frame(f)


if __name__ == "__main__":
    sys.exit(main())
