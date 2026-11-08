/**
 * T1 改版特性测试 — 双主题 / 输入历史 / 工具卡折叠 / Header。
 */

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Box } from "ink";
import {
  ChatView,
} from "../tui/chat-view.tsx";
import { Header } from "../tui/header.tsx";
import { Input, navigateHistory } from "../tui/input.tsx";
import { ToolView, type ToolCallInfo } from "../tui/tool-view.tsx";
import {
  activeTokens,
  getThemeMode,
  setThemeMode,
  theme,
  statusColors,
} from "../tui/theme.ts";
import { COMMANDS } from "../commands.ts";

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("双主题（theme.ts）", () => {
  const initial = getThemeMode();

  test("setThemeMode 切换后 Proxy 令牌即时生效", () => {
    const darkBrand = activeTokens().brand;
    setThemeMode("light");
    expect(getThemeMode()).toBe("light");
    expect(theme.brand).toBe(activeTokens().brand);
    expect(theme.brand).not.toBe(darkBrand);
    expect(statusColors.success).toBe(activeTokens().success);
    setThemeMode("dark");
    expect(theme.brand).toBe(darkBrand);
  });

  test("两套令牌核心色不同且键集一致", () => {
    setThemeMode("dark");
    const dark = { ...activeTokens() };
    setThemeMode("light");
    const light = { ...activeTokens() };
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
    expect(dark.text).not.toBe(light.text);
    expect(dark.background).not.toBe(light.background);
  });

  // 还原运行前模式，避免影响其它测试
  test("还原初始模式", () => {
    setThemeMode(initial);
    expect(getThemeMode()).toBe(initial);
  });
});

describe("输入历史导航（navigateHistory）", () => {
  const history = ["第一句", "第二句", "第三句"];

  test("prev：草稿态(-1) → 最新一条；继续 prev 往旧走", () => {
    expect(navigateHistory(history, -1, "prev")).toBe(2);
    expect(navigateHistory(history, 2, "prev")).toBe(1);
    expect(navigateHistory(history, 1, "prev")).toBe(0);
  });

  test("prev 在最旧处钳制", () => {
    expect(navigateHistory(history, 0, "prev")).toBe(0);
  });

  test("next：往新走，越过最新回到草稿态(-1)并钳制", () => {
    expect(navigateHistory(history, 0, "next")).toBe(1);
    expect(navigateHistory(history, 2, "next")).toBe(-1);
    expect(navigateHistory(history, -1, "next")).toBe(-1);
  });

  test("空历史恒为 -1", () => {
    expect(navigateHistory([], -1, "prev")).toBe(-1);
    expect(navigateHistory([], -1, "next")).toBe(-1);
  });
});

describe("工具卡默认折叠（ToolView）", () => {
  const info: ToolCallInfo = {
    id: "t1",
    name: "bash",
    input: { command: "rm -rf /tmp/x" },
    result: { content: "done" },
  };

  test("默认单行：工具名 + 命令摘要，无 args/result 块", () => {
    const { lastFrame } = render(<ToolView info={info} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("bash");
    expect(out).toContain("rm -rf /tmp/x");
    expect(out).not.toContain("args:");
    expect(out).not.toContain("result:");
  });

  test("verbose：完整卡片含 args/result", () => {
    const { lastFrame } = render(<ToolView info={info} verbose />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("args:");
    expect(out).toContain("result:");
    expect(out).toContain("完成");
  });

  test("摘要优先取 command/path/pattern 字段，否则紧凑 JSON", () => {
    const { lastFrame: byPath } = render(
      <ToolView info={{ id: "a", name: "file-read", input: { path: "a.ts" } }} />,
    );
    expect(stripAnsi(byPath() ?? "")).toContain("a.ts");
    const { lastFrame: byJson } = render(
      <ToolView info={{ id: "b", name: "web-fetch", input: { url: "https://x" } }} />,
    );
    expect(stripAnsi(byJson() ?? "")).toContain("https://x");
  });
});

describe("顶部 Header", () => {
  test("品牌 + 会话短 ID + 模型 + 提示", () => {
    const { lastFrame } = render(
      <Header sessionId="abc12345" model="deepseek-chat" status="idle" />,
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("FengAgentCli");
    expect(out).toContain("abc12345");
    expect(out).toContain("deepseek-chat");
    expect(out).toContain("Ctrl+O");
  });

  test("运行态右侧显示状态文案", () => {
    const { lastFrame } = render(
      <Header sessionId="s1" model="m" status="running" />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("生成中");
  });
});

describe("ChatView verboseTools 透传", () => {
  /** 与 App 布局同构的挂载壳：固定高度 + flexGrow 视口（measureElement 需要稳定高度） */
  function mountChat(toolCalls: ToolCallInfo[], verbose?: boolean) {
    return render(
      <Box flexDirection="column" height={12}>
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minHeight={0}
          width="100%"
          overflowY="hidden"
        >
          <ChatView messages={[]} streamingText="" toolCalls={toolCalls} isRunning={false} verboseTools={verbose} />
        </Box>
      </Box>,
    );
  }

  test("默认（折叠）：工具调用只出单行摘要", async () => {
    const { lastFrame } = mountChat([
      { id: "t1", name: "bash", input: { command: "ls -la" }, result: { content: "ok" } },
    ]);
    await new Promise((r) => setTimeout(r, 60));
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("bash");
    expect(out).toContain("ls -la");
    expect(out).not.toContain("args:");
  });

  test("verboseTools=true：出 args 块", async () => {
    const { lastFrame } = mountChat([{ id: "t1", name: "bash", input: { command: "ls -la" } }], true);
    await new Promise((r) => setTimeout(r, 60));
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("args:");
  });
});

describe("输入框 T1 形态", () => {
  test("框状输入：占位符含 历史/命令 提示", () => {
    const { lastFrame } = render(<Input onSubmit={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("发消息");
    expect(out).toContain("↑ 历史");
  });
});

describe("/theme 命令注册", () => {
  test("COMMANDS 含 theme（界面类）", () => {
    const themeCmd = COMMANDS.find((c) => c.name === "theme");
    expect(themeCmd).toBeDefined();
    expect(themeCmd!.category).toBe("界面");
    expect(themeCmd!.usage).toBe("/theme [dark|light]");
  });
});
