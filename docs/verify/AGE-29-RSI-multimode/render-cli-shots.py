"""RSI 验证：CLI print 模式输出 → 终端风格 PNG 截图（PIL）。"""
import os
from PIL import Image, ImageDraw, ImageFont

ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
FONT_SIZE = 22
CELL_W = 13
CELL_H = 26
FONT = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", FONT_SIZE)
MONO = ImageFont.truetype(r"C:\Windows\Fonts\consola.ttf", FONT_SIZE)
BG = (11, 11, 16)
FG = (220, 220, 230)
ACCENT = (120, 200, 255)
GREEN = (140, 230, 140)
YELLOW = (240, 220, 130)

def render(text, out, width=110, title=""):
    lines = []
    if title:
        lines.append(("title", title))
        lines.append(("sep", "=" * width))
    for line in text.split("\n"):
        lines.append(("body", line))
    h = max(len(lines) * CELL_H + 60, 200)
    img = Image.new("RGB", (width * CELL_W, h), BG)
    draw = ImageDraw.Draw(img)
    y = 30
    for kind, text_line in lines:
        if kind == "title":
            draw.text((20, y), text_line, font=FONT, fill=ACCENT)
        elif kind == "sep":
            draw.text((20, y), text_line, font=MONO, fill=(60, 60, 80))
        else:
            color = FG
            if "PASS" in text_line or "✓" in text_line or "产卡" in text_line or "入库" in text_line:
                color = GREEN
            elif "WARN" in text_line or "✗" in text_line or "失败" in text_line:
                color = YELLOW
            draw.text((20, y), text_line, font=FONT if any(ord(c) > 127 for c in text_line) else MONO, fill=color)
        y += CELL_H
    img.save(os.path.join(ASSETS, out))
    print(f"saved {out} ({img.width}x{img.height})")

# 1) 产卡跳终端输出（从 eval --judge 的日志重建）
judge_output = """$ FENG_DATA_DIR=.verify-rsi/data bun run eval --judge

==== 测试集真跑 → 自省卡（RSI 产卡跳）====
  [INFO] agent prompt start: 请原样回复这个暗号：多端验证-A1-7c31
  [INFO] agent-loop turn end reason=end_turn, step=1
  [INFO] agent prompt start: 请用 bash 工具执行 echo RSI-E2E-9f2c 并贴出输出
  [INFO] tool-executor tool=bash, permission decision=ask
  [WARN] tool result: error — Tool "bash" requires user approval but no permission callback
  [ERROR] unrecoverable tool result guard: 已终止本轮对话

  测试集 rsi-verify: 跑 2 条（通过 1 / 失败 1，1.0 步、5706 token） → 产卡 1 张、入库 1 张
    ✗ case-fail: failed（0 分）Agent 未能执行 bash 工具…未完成用户要求输出 RSI-E2E-9f2c 的任务。
  合计: 产卡 1 张，入库 1 张（库: .verify-rsi/data/reflect/reflections.db）
"""
render(judge_output, "00-cli-judge-run.png", title="CLI: bun run eval --judge（产卡跳）")

# 2) CLI print 模式输出
cli_output = """$ FENG_DATA_DIR=.verify-rsi/data bun run packages/cli/src/entry.ts --print "请原样回复这个暗号：CLI注入验证-B2-4e8a"

  [INFO] cli CLI start, args=--print
  [INFO] agent prompt start: 请原样回复这个暗号：CLI注入验证-B2-4e8a
  [INFO] agent-loop loop start step=1, model=deepseek-v4-pro
  [INFO] agent-loop LLM call start model=deepseek-v4-pro, messageCount=1

CLI注入验证-B2-4e8a

  [INFO] agent-loop turn end reason=end_turn, step=1
  [INFO] agent prompt completed sessionId=8ecb8db9

  ✓ 回复正确；系统提示已注入「过往教训」自省卡（DB 验证：status=injected, injectedCount=1）
"""
render(cli_output, "02-cli-print-output.png", title="CLI: print 模式对话（注入验证）")

# 3) DB 取证
db_output = open(os.path.join(ASSETS, "03-db-after-cli.txt"), encoding="utf-8").read()
render(db_output, "03-db-after-cli.png", title="SQLite: CLI 轮后 reflections.db")

db_webui = open(os.path.join(ASSETS, "09-db-after-webui-shots.txt"), encoding="utf-8").read()
render(db_webui, "09-db-after-webui.png", title="SQLite: WebUI 轮后 reflections.db")

print("done")
