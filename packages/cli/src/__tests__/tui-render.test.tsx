/**
 * TUI 渲染快照验证 — 用 ink-testing-library 渲染 App 的关键区域，
 * 校验美化后的文字输出（欢迎卡片、状态栏、消息列表、动态指示器）。
 */

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
    expect(theme.success).toBe("#82B89D");
    expect(theme.error).toBe("#DA8A93");
    expect(theme.warning).toBe("#D8B270");
  });
});
