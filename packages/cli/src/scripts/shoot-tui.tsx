/**
 * Round-1 设计验证：TUI 帧捕获脚本（放在 cli 包内以解析 ink/react 依赖）
 *
 * 用 ink-testing-library 渲染真实 TUI 组件（欢迎卡片 + 对话流 + 状态栏），
 * 输出带 ANSI 颜色的原始帧文本，再由 scripts/render-tui.py 渲染为 PNG。
 *
 * 用法：bun packages/cli/src/scripts/shoot-tui.tsx
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { ChatView } from "../tui/chat-view.tsx";
import { StatusBar } from "../tui/status-bar.tsx";
import { theme } from "../tui/theme.ts";
import type { Message } from "@fengagent/core";

const OUT_DIR = join(import.meta.dir, "..", "..", "..", "..", "screenshots", "tui-raw");
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function save(name: string, frame: string): void {
  writeFileSync(join(OUT_DIR, name), frame, "utf8");
  console.log("[tui] saved", name);
}

// ── 欢迎卡片（与 app.tsx 欢迎态同款设计）──
function WelcomeCard(): React.ReactElement {
  return (
    <Box flexDirection="column" width={80}>
      <Box flexDirection="row" justifyContent="center" marginBottom={0}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.border}
          paddingX={3}
          paddingY={1}
          width={56}
        >
          <Box flexDirection="row" justifyContent="center" alignItems="center">
            <Text bold color={theme.brand}>⚡ FENGAGENTCLI</Text>
            <Text backgroundColor={theme.backgroundElement} color={theme.brandBright} bold>
              {" v0.1.0 "}
            </Text>
          </Box>
          <Box flexDirection="row" justifyContent="center">
            <Text color={theme.text}>开源本地 AI Agent 编程工具</Text>
          </Box>
          <Box flexDirection="row" justifyContent="center">
            <Text color={theme.dim}>CLI · TUI · Web · Multi-Agent · MCP</Text>
          </Box>
          <Text> </Text>
          <Box flexDirection="row" justifyContent="center">
            <Box width={18}><Text color={theme.brand}>🗣  对话</Text></Box>
            <Box width={18}><Text color={theme.brand}>🔧  工具</Text></Box>
            <Box width={18}><Text color={theme.brand}>🤖  多Agent</Text></Box>
          </Box>
          <Box flexDirection="row" justifyContent="center">
            <Box width={18}><Text color={theme.brand}>🧠  记忆</Text></Box>
            <Box width={18}><Text color={theme.brand}>⚡  MCP</Text></Box>
            <Box width={18}><Text color={theme.brand}>🎨  WebUI</Text></Box>
          </Box>
          <Text> </Text>
          <Box flexDirection="row" justifyContent="center">
            <Text color={theme.border}>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
          </Box>
          <Text> </Text>
          <Box flexDirection="row" justifyContent="center">
            <Text color={theme.text}>📝  输入问题开始对话</Text>
          </Box>
          <Box flexDirection="row" justifyContent="center">
            <Text color={theme.dim}>❓  /help 查看帮助 · /model 切换模型 · /provider 配置</Text>
          </Box>
        </Box>
      </Box>
      <Box>
        <Text color={theme.prompt} bold>{"❯ "}</Text>
        <Text><Text color={theme.brand}>█</Text><Text dimColor italic> 输入消息，按 Enter 发送...</Text></Text>
      </Box>
    </Box>
  );
}

const { lastFrame: welcomeFrame } = render(<WelcomeCard />);
await sleep(50);
save("01-welcome.txt", welcomeFrame() ?? "");

// ── 对话流：用户气泡 + 助手 Markdown + 状态栏 ──
const messages: Message[] = [
  {
    id: "m1",
    role: "user",
    content: [{ type: "text", text: "帮我写一个 Python 脚本：遍历目录下所有 .md 文件并统计字数" }],
    createdAt: Date.now(),
  },
  {
    id: "m2",
    role: "assistant",
    content: [
      {
        type: "text",
        text:
          "好的，下面是一个简单的脚本：\n\n" +
          "```python\nimport pathlib\n\n" +
          "for p in pathlib.Path('.').rglob('*.md'):\n" +
          "    count = len(p.read_text(encoding='utf-8'))\n" +
          "    print(f'{p}: {count} chars')\n```\n\n" +
          "**说明**：\n" +
          "- `rglob` 递归查找所有 `.md` 文件\n" +
          "- `read_text` 读取内容后统计字符数\n" +
          "- 如需按词统计可改用 `len(text.split())`",
      },
    ],
    createdAt: Date.now(),
  },
  {
    id: "m3",
    role: "user",
    content: [{ type: "text", text: "很好，谢谢！再帮我加一个按字数从多到少排序的功能。" }],
    createdAt: Date.now(),
  },
];

function Conversation(): React.ReactElement {
  return (
    <Box flexDirection="column" width={80}>
      <Box flexDirection="row" justifyContent="center" marginBottom={0}>
        <Text bold color={theme.brand}>⚡ FENGAGENTCLI</Text>
        <Text color={theme.subtle}> · v0.1.0</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} minHeight={0} width="100%" overflowY="hidden">
        <ChatView messages={messages} streamingText="" toolCalls={[]} isRunning={false} />
      </Box>
      <Box>
        <Text color={theme.prompt} bold>{"❯ "}</Text>
        <Text><Text color={theme.brand}>█</Text></Text>
      </Box>
      <StatusBar
        model="deepseek-chat"
        tokenCount={12843}
        status="idle"
        sessionId="abc12345"
        contextWindow={200000}
      />
    </Box>
  );
}

const conv = render(<Conversation />);
await sleep(50);
save("02-conversation.txt", conv.lastFrame() ?? "");
