/**
 * T1 改版验证帧：before/after 对比用（对话流 + 工具卡 + 输入 + 状态栏 + header）。
 * 渲染：对话流（含工具卡）+ 输入 + 状态栏 的组合帧，输出 ANSI 文本
 * 到 screenshots/tui-raw/t1-*.txt，再由 scripts/render-tui.py 转 PNG。
 *
 * 用法: bun packages/cli/src/scripts/shoot-t1.tsx
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { ChatView } from "../tui/chat-view.tsx";
import { Header } from "../tui/header.tsx";
import { Input } from "../tui/input.tsx";
import { StatusBar } from "../tui/status-bar.tsx";
import { ToolView, type ToolCallInfo } from "../tui/tool-view.tsx";
import { theme } from "../tui/theme.ts";
import type { Message } from "@fengagent/core";

const OUT_DIR = join(import.meta.dir, "..", "..", "..", "..", "screenshots", "tui-raw");
mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function save(name: string, frame: string): void {
  writeFileSync(join(OUT_DIR, name), frame, "utf8");
  console.log("[t1] saved", name);
}

const messages: Message[] = [
  {
    id: "m1",
    role: "user",
    content: [{ type: "text", text: "帮我看一下这个目录里有哪些 TypeScript 文件" }],
    createdAt: Date.now(),
  },
  {
    id: "m2",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "我用 `glob` 工具查一下：",
      },
    ],
    createdAt: Date.now(),
  },
];

const toolCalls: ToolCallInfo[] = [
  {
    id: "t1",
    name: "glob",
    input: { pattern: "**/*.ts" },
    result: { content: "src/index.ts\nsrc/app.ts\nsrc/lib/util.ts（共 3 个文件）" },
  },
  {
    id: "t2",
    name: "bash",
    input: { command: "wc -l src/*.ts", timeout: 10000 },
    result: { content: "  42 src/index.ts\n 128 src/app.ts\n  67 src/lib/util.ts" },
  },
];

function Frame({ children, height = 24 }: { children: React.ReactNode; height?: number }): React.ReactElement {
  return <Box flexDirection="column" width={80} height={height}>{children}</Box>;
}

// ── 帧 1：对话 + 工具卡 + 输入 + 状态栏（默认视图）──
function MainView(): React.ReactElement {
  return (
    <Frame>
      <Header sessionId="abc12345" model="deepseek-chat" status="idle" />
      <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} width="100%" overflowY="hidden">
        <ChatView messages={messages} streamingText="" toolCalls={toolCalls} isRunning={false} />
      </Box>
      <Input onSubmit={() => {}} />
      <StatusBar model="deepseek-chat" tokenCount={18432} status="idle" sessionId="abc12345" contextWindow={128000} />
    </Frame>
  );
}

// ── 帧 2：命令面板态 ──
function AutocompleteView(): React.ReactElement {
  return (
    <Frame>
      <Header sessionId="abc12345" model="deepseek-chat" status="idle" />
      <Text color={theme.dim}>（对话区）</Text>
      <Input onSubmit={() => {}} />
      <StatusBar model="deepseek-chat" tokenCount={18432} status="idle" sessionId="abc12345" contextWindow={128000} />
    </Frame>
  );
}

// ── 帧 3：工具卡特写（折叠默认 / verbose / 失败态）──
function ToolCards(): React.ReactElement {
  return (
    <Box flexDirection="column" width={80}>
      <ToolView info={toolCalls[0]!} />
      <ToolView info={{ id: "t3", name: "bash", input: { command: "npm test" } }} />
      <ToolView info={{ id: "t4", name: "file-write", input: { path: "x.ts" }, result: { content: "EACCES: permission denied", isError: true } }} />
      <ToolView info={toolCalls[1]!} verbose />
    </Box>
  );
}

const { lastFrame: mainFrame } = render(<MainView />);
await sleep(80);
save("t1-main.txt", mainFrame() ?? "");

const { lastFrame: autoFrame } = render(<AutocompleteView />);
await sleep(80);
save("t1-autocomplete.txt", autoFrame() ?? "");

const { lastFrame: toolFrame } = render(<ToolCards />);
await sleep(80);
save("t1-toolcards.txt", toolFrame() ?? "");
