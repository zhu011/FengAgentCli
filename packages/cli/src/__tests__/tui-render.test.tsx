/**
 * TUI 渲染快照验证 — 用 ink-testing-library 渲染 App 的关键区域，
 * 校验美化后的文字输出（欢迎卡片、状态栏、消息列表、动态指示器）。
 */

import { Box, Text } from "ink";
import { test, expect, describe } from "bun:test";
import { render } from "ink-testing-library";
import { ChatView } from "../tui/chat-view.tsx";
import { StatusBar } from "../tui/status-bar.tsx";
import { ThinkingPet } from "../tui/thinking-pet.tsx";
import { ToolView } from "../tui/tool-view.tsx";
import { PermissionDialog } from "../tui/permission-dialog.tsx";
import { theme } from "../tui/theme.ts";
import type { Message } from "@fengagent/core";

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TUI 美化渲染快照", () => {
  test("状态栏包含 model/tokens/session 与进度条", () => {
    const { lastFrame } = render(
      <StatusBar model="deepseek-chat" tokenCount={12345} status="idle" sessionId="abc12345" contextWindow={1000000} />,
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("deepseek-chat");
    expect(out).toContain("Tokens: 12,345");
    expect(out).toContain("Session: abc12345");
    expect(out).toContain("/help");
  });

  test("运行中状态栏渲染动态指示器", () => {
    const { lastFrame } = render(
      <StatusBar model="m" tokenCount={0} status="running" sessionId="s" />,
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out.length).toBeGreaterThan(0);
  });

  test("消息列表：用户/助手标签 + 分隔线", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "你好" }],
        createdAt: Date.now(),
      },
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "text", text: "**你好**！`code`" }],
        createdAt: Date.now(),
      },
    ];
    const { lastFrame } = render(
      <ChatView messages={messages} streamingText="" toolCalls={[]} isRunning={false} />,
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("你");
    expect(out).toContain("FengAgentCli");
    expect(out).toContain("你好");
    expect(out).toContain("code");
  });

  test("运行中消息列表渲染 ThinkingPet 动态指示", () => {
    const { lastFrame } = render(
      <ChatView messages={[]} streamingText="" toolCalls={[]} isRunning={true} />,
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("FengAgentCli");
  });

  test("工具卡片：状态图标 + 结果", () => {
    const { lastFrame } = render(
      <ToolView info={{ id: "t1", name: "file-read", input: { path: "a.ts" }, result: { content: "ok" } }} />,
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("file-read");
    expect(out).toContain("✓");
    expect(out).toContain("ok");
  });

  test("权限对话框：琥珀警告 + 快捷键提示", () => {
    const { lastFrame } = render(
      <PermissionDialog
        request={{ id: "p1", toolName: "bash", input: { command: "ls" }, reason: "需要执行命令" }}
        onRespond={() => {}}
      />,
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("权限请求");
    expect(out).toContain("bash");
    expect(out).toContain("[y] 允许");
  });

  test("ThinkingPet 输出含动态帧与思考文案", () => {
    const { lastFrame } = render(<ThinkingPet text="思考中" />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("思考中");
  });

  test("主题令牌完整", () => {
    expect(theme.brand).toBe("#7DA1DE");
    expect(theme.success).toBe("#7FD88F");
    expect(theme.error).toBe("#E06C75");
    expect(theme.warning).toBe("#F5A742");
  });

  test("token 进度：大 contextWindow 下百分比不显示 0（保留 1 位小数）", () => {
    // 项目配置 contextWindow=1,000,000，普通对话 token 占比 <1%，
    // 旧实现 Math.round 后恒为 0%——必须显示 0.2% 这类非零进度
    const { lastFrame } = render(
      <StatusBar model="deepseek-v4-pro" tokenCount={2345} status="idle" sessionId="abc12345" contextWindow={1000000} />,
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("0.2%");
    expect(out).toContain("2,345 tok");
    expect(out).toMatch(/\d+%/);
  });

  test("token 进度：极小占比显示 <0.1%，且进度条至少有 1 格填充", () => {
    const { lastFrame } = render(
      <StatusBar model="m" tokenCount={100} status="idle" sessionId="s" contextWindow={1000000} />,
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("<0.1%");
    expect(out).toContain("█"); // 有 token 时进度条至少 1 格
  });
});

// ──────────────────────────────────────────────
// 长对话回归：内容较多时图标/问答/token百分比必须保持可见
// ──────────────────────────────────────────────

/** 模拟 App 的布局：固定高度根 + 对话区域 + 宠物/输入框/状态栏 */
function AppLikeLayout({
  messages,
  streamingText = "",
  isRunning = false,
  rows = 30,
}: {
  messages: Message[];
  streamingText?: string;
  isRunning?: boolean;
  rows?: number;
}) {
  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="row" justifyContent="center"><Text>⚡ HEADER</Text></Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} width="100%" overflowY="hidden">
        <ChatView messages={messages} streamingText={streamingText} toolCalls={[]} isRunning={isRunning} />
      </Box>
      <Box paddingX={1} marginBottom={0}>
        <ThinkingPet text="执行工具中" />
      </Box>
      <Box><Text>INPUT-LINE</Text></Box>
      <StatusBar model="deepseek-chat" tokenCount={12345} status="running" sessionId="abc12345" contextWindow={1000000} />
    </Box>
  );
}

/** 1000 行故事文本 */
const LONG_STORY = Array.from(
  { length: 1000 },
  (_, i) => `第${i + 1}行：这是一个非常长的故事内容，用来模拟 agent 写一千字故事时的场景，不断填充对话区域。`,
).join("\n");

const LONG_CONV: Message[] = [
  { id: "u1", role: "user", content: [{ type: "text", text: "请写一个一千字故事" }], createdAt: Date.now() },
  { id: "a1", role: "assistant", content: [{ type: "text", text: LONG_STORY }], createdAt: Date.now() },
  { id: "u2", role: "user", content: [{ type: "text", text: "继续讲" }], createdAt: Date.now() },
  { id: "a2", role: "assistant", content: [{ type: "text", text: "故事讲完了，谢谢！" }], createdAt: Date.now() },
];

/** 200 行短故事 — 滚动交互测试用（仍远超视口，事件数少跑得快） */
const SHORT_STORY = Array.from(
  { length: 200 },
  (_, i) => `第${i + 1}行：这是一个比较长的故事内容，用来模拟 agent 写长故事时的滚动场景。`,
).join("\n");

const SHORT_CONV: Message[] = [
  { id: "u1", role: "user", content: [{ type: "text", text: "写一个故事" }], createdAt: Date.now() },
  { id: "a1", role: "assistant", content: [{ type: "text", text: SHORT_STORY }], createdAt: Date.now() },
  { id: "u2", role: "user", content: [{ type: "text", text: "继续" }], createdAt: Date.now() },
  { id: "a2", role: "assistant", content: [{ type: "text", text: "故事讲完了" }], createdAt: Date.now() },
];

describe("长对话布局回归（内容较多不撑破界面）", () => {
  test("底部图标/输入框/状态栏/token百分比始终可见，最新问答可见", async () => {
    const { lastFrame } = render(<AppLikeLayout messages={LONG_CONV} />);
    // 等待 measureElement 布局后重渲染稳定
    for (let i = 0; i < 5; i++) await sleep(20);

    const out = stripAnsi(lastFrame() ?? "");
    // 底部 UI 不再被长内容挤出屏幕
    expect(out).toContain("HEADER");
    expect(out).toContain("执行工具中");
    expect(out).toContain("INPUT-LINE");
    expect(out).toContain("Tokens: 12,345");
    expect(out).toMatch(/[0-9]+%/); // token 使用百分比
    // 贴底：最新问答与故事结尾可见
    expect(out).toContain("继续讲");
    expect(out).toContain("故事讲完了");
    expect(out).toContain("第1000行");
    // 已滚到最底，故事开头不在视口内
    expect(out).not.toContain("第1行");
  });

  test("流式长文本到达时自动贴底，最新内容可见", async () => {
    const { lastFrame, rerender } = render(<AppLikeLayout messages={[]} />);
    for (let i = 0; i < 5; i++) await sleep(20);
    rerender(<AppLikeLayout messages={[]} streamingText={LONG_STORY} isRunning />);
    for (let i = 0; i < 5; i++) await sleep(20);

    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("第1000行"); // 流式文本结尾可见
    expect(out).toContain("INPUT-LINE");
    expect(out).toMatch(/[0-9]+%/);
  });

  test("含代码块/markdown 的长回复贴底时，最新问答仍可见（估算含代码块边框/标签行）", async () => {
    // 回归：行数估算漏算代码块边框(2)+语言标签(1)行 → 总高度低估 → 贴底时
    // 最后一条消息内容被 overflowY:hidden 裁掉（"继续讲"/"故事讲完了"不可见）
    const story = Array.from(
      { length: 40 },
      (_, i) => `第${i + 1}行：这是一个比较长的故事内容，用来模拟 agent 写长故事时的滚动场景，包含一些 **加粗** 和 \`code\`。`,
    ).join("\n");
    const mdMessages: Message[] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "请写一个故事" }], createdAt: Date.now() },
      {
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              `## 故事\n\n${story}\n\n下面是代码示例：\n` +
              "```ts\nconst hello = (name: string): string => {\n  // 注释\n  return `Hello ${name}!`; // 42\n};\n```",
          },
        ],
        createdAt: Date.now(),
      },
      { id: "u2", role: "user", content: [{ type: "text", text: "继续讲" }], createdAt: Date.now() },
      { id: "a2", role: "assistant", content: [{ type: "text", text: "故事讲完了，谢谢！" }], createdAt: Date.now() },
    ];
    const { lastFrame } = render(<AppLikeLayout messages={mdMessages} />);
    for (let i = 0; i < 5; i++) await sleep(20);

    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("继续讲");
    expect(out).toContain("故事讲完了");
    expect(out).toContain("const hello ="); // 代码块完整渲染
    expect(out).toContain("INPUT-LINE");
    expect(out).toMatch(/[0-9]+%/);
  });

  test("PgUp 可翻阅历史，PgDn 回到最底", async () => {
    const { lastFrame, stdin } = render(<AppLikeLayout messages={SHORT_CONV} />);
    for (let i = 0; i < 5; i++) await sleep(20);

    // 初始贴底
    const initial = stripAnsi(lastFrame() ?? "");
    expect(initial).toContain("故事讲完了");
    expect(initial).not.toContain("第1行");

    // 多次 PgUp 滚到顶部
    for (let i = 0; i < 30; i++) {
      stdin.write("\u001b[5~");
      await sleep(5);
    }
    await sleep(20);
    const top = stripAnsi(lastFrame() ?? "");
    expect(top).toContain("第1行"); // 故事开头可见
    expect(top).toMatch(/还有 \d+ 行/); // 下翻指示器

    // PgDn 回到最底并恢复贴底
    for (let i = 0; i < 30; i++) {
      stdin.write("\u001b[6~");
      await sleep(5);
    }
    await sleep(20);
    const bottom = stripAnsi(lastFrame() ?? "");
    expect(bottom).toContain("故事讲完了");
    expect(bottom).not.toMatch(/还有 \d+ 行/);
  }, 20_000);

  test("鼠标滚轮可上翻到顶部 / 下翻回到底部", async () => {
    const { lastFrame, stdin } = render(<AppLikeLayout messages={SHORT_CONV} />);
    for (let i = 0; i < 5; i++) await sleep(20);

    // 初始贴底：故事开头不可见
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("第1行");

    // SGR 滚轮上滚（<64 = 上滚）：多次滚动后到达顶部
    for (let i = 0; i < 100; i++) {
      stdin.write("\u001b[<64;5;10M");
      await sleep(5);
    }
    await sleep(20);
    const top = stripAnsi(lastFrame() ?? "");
    expect(top).toContain("第1行");
    expect(top).toMatch(/还有 \d+ 行/);

    // SGR 滚轮下滚（<65 = 下滚）：回到底部并恢复贴底
    for (let i = 0; i < 100; i++) {
      stdin.write("\u001b[<65;5;10M");
      await sleep(5);
    }
    await sleep(20);
    const bottom = stripAnsi(lastFrame() ?? "");
    expect(bottom).toContain("故事讲完了");
    expect(bottom).not.toMatch(/还有 \d+ 行/);
  }, 20_000);

  test("Home/End 一键跳顶/回底", async () => {
    const { lastFrame, stdin } = render(<AppLikeLayout messages={LONG_CONV} />);
    for (let i = 0; i < 5; i++) await sleep(20);
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("第1行");

    // Home — 跳到最顶端
    stdin.write("\u001b[H");
    await sleep(20);
    const top = stripAnsi(lastFrame() ?? "");
    expect(top).toContain("第1行");

    // End — 回到底部恢复贴底
    stdin.write("\u001b[F");
    await sleep(20);
    const bottom = stripAnsi(lastFrame() ?? "");
    expect(bottom).toContain("故事讲完了");
    expect(bottom).not.toMatch(/还有 \d+ 行/);
  });
});
