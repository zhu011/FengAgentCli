/**
 * Round-3 设计验证：TUI 帧捕获脚本（放在 cli 包内以解析 ink/react 依赖）
 *
 * 用 ink-testing-library 渲染真实 TUI 组件（欢迎卡片 + 对话流 + 状态栏），
 * 输出带 ANSI 颜色的原始帧文本，再由 scripts/render-tui.py 渲染为 PNG。
 * Round 3 新增：超长用户消息帧（验证填充气泡多行换行后的背景边界与右对齐）。
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
              {" v0.2.0 "}
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
        <Text color={theme.subtle}> · v0.2.0</Text>
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

// ── Round 3：超长用户消息 — 验证填充气泡多行换行的背景/右对齐边界 ──
const LONG_TEXT =
  "这个需求涉及多个模块，麻烦详细说明一下：首先是核心的 LLM 调用层，需要支持 OpenAI / Anthropic / Bedrock / Google 四家 provider 的流式输出与重试；" +
  "其次是工具系统，要支持文件读写、Bash 执行、MCP 协议和权限审批；然后是上下文管理，长对话超过阈值后要自动压缩历史消息；" +
  "最后是 Agent 运行时，需要实现主 Agent 派生子 Agent 并行处理子任务的机制，并把所有事件持久化到 SQLite，方便后续做对话图可视化和回退。";

function LongTextConversation(): React.ReactElement {
  const longMessages: Message[] = [
    {
      id: "lt1",
      role: "user",
      content: [{ type: "text", text: LONG_TEXT }],
      createdAt: Date.now(),
    },
    {
      id: "lt2",
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "好的，我来逐层说明。先看 **LLM 调用层**：每个 provider 都实现统一的 `LLMClient` 接口，流式输出走 SSE，重试策略为指数退避。\n\n" +
            "```ts\ninterface LLMClient {\n  stream(messages: Message[]): AsyncIterable<Delta>\n}\n```\n\n" +
            "**工具系统**通过 `ToolRegistry` 注册，权限审批由 Hook 拦截。更多细节可以查看文档。",
        },
      ],
      createdAt: Date.now(),
    },
  ];

  return (
    <Box flexDirection="column" width={80}>
      <Box flexDirection="row" justifyContent="center" marginBottom={0}>
        <Text bold color={theme.brand}>⚡ FENGAGENTCLI</Text>
        <Text color={theme.subtle}> · v0.2.0</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} minHeight={0} width="100%" overflowY="hidden">
        <ChatView messages={longMessages} streamingText="" toolCalls={[]} isRunning={false} />
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

const longConv = render(<LongTextConversation />);
await sleep(50);
save("03-longtext.txt", longConv.lastFrame() ?? "");

// ── Round 4：思考过程可视化 — 流式思考（streamingThinking，正文未开始）──
const THINKING_TEXT =
  "用户想让我介绍 FengAgentCli。先梳理核心能力：本地 AI Agent，TUI 与 WebUI 双界面，" +
  "支持工具调用、多 Agent 协作、上下文压缩、记忆系统。回答突出特性并给出快速上手命令。";

function ThinkingStreaming(): React.ReactElement {
  const history: Message[] = [
    {
      id: "t0",
      role: "user",
      content: [{ type: "text", text: "你好，介绍一下你自己" }],
      createdAt: Date.now(),
    },
  ];
  return (
    <Box flexDirection="column" width={80}>
      <Box flexDirection="row" justifyContent="center" marginBottom={0}>
        <Text bold color={theme.brand}>⚡ FENGAGENTCLI</Text>
        <Text color={theme.subtle}> · v0.2.0</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} minHeight={0} width="100%" overflowY="hidden">
        <ChatView
          messages={history}
          streamingText=""
          streamingThinking={THINKING_TEXT}
          toolCalls={[]}
          isRunning={true}
        />
      </Box>
      <Box>
        <Text color={theme.prompt} bold>{"❯ "}</Text>
        <Text><Text color={theme.brand}>█</Text></Text>
      </Box>
      <StatusBar
        model="deepseek-reasoner"
        tokenCount={12843}
        status="running"
        sessionId="abc12345"
        contextWindow={200000}
      />
    </Box>
  );
}

const thinkingConv = render(<ThinkingStreaming />);
await sleep(50);
save("04-thinking-streaming.txt", thinkingConv.lastFrame() ?? "");

// ── Round 4：思考过程可视化 — 完成态（消息内 thinking 块 + 正文）──
function ThinkingComplete(): React.ReactElement {
  const doneMessages: Message[] = [
    {
      id: "tc0",
      role: "user",
      content: [{ type: "text", text: "你好，介绍一下你自己" }],
      createdAt: Date.now(),
    },
    {
      id: "tc1",
      role: "assistant",
      content: [
        { type: "thinking", text: "先梳理核心能力，再给出快速上手命令。" },
        {
          type: "text",
          text:
            "你好！我是 **FengAgentCli**，一个开源本地 AI Agent 对话平台。\n\n" +
            "- 💬 多轮智能对话（SSE 流式输出）\n" +
            "- 🔧 工具调用（文件 / Bash / 搜索 / MCP）\n\n" +
            "```bash\nfengagent        # 启动终端 TUI\n```",
        },
      ],
      createdAt: Date.now(),
    },
  ];

  return (
    <Box flexDirection="column" width={80}>
      <Box flexDirection="row" justifyContent="center" marginBottom={0}>
        <Text bold color={theme.brand}>⚡ FENGAGENTCLI</Text>
        <Text color={theme.subtle}> · v0.2.0</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} minHeight={0} width="100%" overflowY="hidden">
        <ChatView messages={doneMessages} streamingText="" toolCalls={[]} isRunning={false} />
      </Box>
      <Box>
        <Text color={theme.prompt} bold>{"❯ "}</Text>
        <Text><Text color={theme.brand}>█</Text></Text>
      </Box>
      <StatusBar
        model="deepseek-reasoner"
        tokenCount={12843}
        status="idle"
        sessionId="abc12345"
        contextWindow={200000}
      />
    </Box>
  );
}

const completeConv = render(<ThinkingComplete />);
await sleep(50);
save("05-thinking-complete.txt", completeConv.lastFrame() ?? "");
