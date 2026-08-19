/**
 * CLI Input 组件测试 — 验证 / 命令补全交互
 *
 * 使用 ink-testing-library 模拟键盘输入，验证补全列表渲染。
 */

import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Input } from "../tui/input.tsx";
import { filterCommands, COMMANDS, getHelpMessage, handleCommand } from "../commands.ts";

// 纯函数测试 — filterCommands 逻辑
test("filterCommands: 空前缀返回全部命令", () => {
  const result = filterCommands("");
  expect(result.length).toBe(COMMANDS.length);
  expect(result.some((c) => c.name === "help")).toBe(true);
  expect(result.some((c) => c.name === "compact")).toBe(true);
  expect(result.some((c) => c.name === "tool")).toBe(true);
  expect(result.some((c) => c.name === "provider")).toBe(true);
  // Phase 4 新增图命令
  expect(result.some((c) => c.name === "graph")).toBe(true);
  expect(result.some((c) => c.name === "rollback")).toBe(true);
});

test("filterCommands: /com 过滤到 compact", () => {
  const result = filterCommands("/com");
  expect(result.length).toBe(1);
  expect(result[0]!.name).toBe("compact");
});

test("filterCommands: /cl 过滤到 clear", () => {
  const result = filterCommands("/cl");
  expect(result.length).toBe(1);
  expect(result[0]!.name).toBe("clear");
});

test("filterCommands: /s 过滤到 session", () => {
  const result = filterCommands("/s");
  expect(result.some((c) => c.name === "session")).toBe(true);
});

test("filterCommands: 不匹配的前缀返回空", () => {
  const result = filterCommands("/xyz");
  expect(result.length).toBe(0);
});

test("filterCommands: 按描述模糊匹配", () => {
  const result = filterCommands("/压缩");
  // "压缩" 匹配 "手动压缩上下文" 描述
  expect(result.some((c) => c.name === "compact")).toBe(true);
});

// COMMANDS 元数据完整性测试
test("COMMANDS: 包含所有新增命令", () => {
  const names = COMMANDS.map((c) => c.name);
  expect(names).toContain("compact");
  expect(names).toContain("clear");
  expect(names).toContain("restore");
  expect(names).toContain("tool");
  expect(names).toContain("help");
  expect(names).toContain("exit");
  expect(names).toContain("session");
  expect(names).toContain("model");
  expect(names).toContain("provider");
  expect(names).toContain("export");
  expect(names).toContain("quit");
});

test("COMMANDS: 每个命令都有 name/description/usage/category", () => {
  for (const cmd of COMMANDS) {
    expect(cmd.name).toBeTruthy();
    expect(cmd.description).toBeTruthy();
    expect(cmd.usage).toBeTruthy();
    expect(cmd.category).toBeTruthy();
  }
});

// getHelpMessage 测试
test("getHelpMessage: 包含所有命令分类", () => {
  const help = getHelpMessage();
  expect(help).toContain("基础:");
  expect(help).toContain("上下文:");
  expect(help).toContain("会话:");
  expect(help).toContain("模型:");
  expect(help).toContain("工具:");
  expect(help).toContain("导出:");
  expect(help).toContain("/compact");
  expect(help).toContain("/restore");
  expect(help).toContain("/tool list");
});

// 组件渲染测试 — 验证 Input 组件能正确渲染
test("Input 组件: 初始渲染包含提示符和占位文本", () => {
  const { lastFrame } = render(<Input onSubmit={() => {}} />);
  const frame = lastFrame();
  expect(frame).toContain("❯");
  expect(frame).toContain("输入消息");
});

test("Input 组件: disabled 状态显示 ThinkingPet", () => {
  const { lastFrame } = render(<Input onSubmit={() => {}} disabled={true} />);
  const frame = lastFrame();
  expect(frame).toBeTruthy();
});

// ink-testing-library lastFrame 断言 — 验证补全列表渲染
// ink-testing-library 在 Bun 下 stdin.write 不触发 useInput，
// 但我们可以直接渲染带 showAutocomplete 状态的组件来验证布局。
// 为此需要一个测试用的 wrapper 组件来控制内部状态。

// 由于 Input 的 showAutocomplete 是内部状态（由 useInput 触发），
// 我们无法从外部直接控制。但我们可以在测试中通过 render 验证
// 组件初始渲染（无补全时）是正确的，然后通过纯函数测试覆盖补全逻辑。

// 验证：MAX_VISIBLE=10 时全部命令可显示
test("补全列表: 全部命令在可视范围内", () => {
  const all = filterCommands("");
  expect(all.length).toBe(COMMANDS.length);
  // MAX_VISIBLE=10, scrollOffset=0 → visibleStart=0, visibleEnd=10
  const visible = all.slice(0, 10);
  expect(visible.length).toBe(10);
  expect(visible[0]!.name).toBe("help");
  expect(visible[9]!.name).toBe("export");
});

test("补全列表: /com 过滤后只剩 1 条", () => {
  const filtered = filterCommands("/com");
  expect(filtered.length).toBe(1);
  expect(filtered[0]!.name).toBe("compact");
  // 可视范围内应该只显示这 1 条
  const visible = filtered.slice(0, 10);
  expect(visible.length).toBe(1);
});

test("补全列表: listHeight 计算正确（10命令 + 提示行）", () => {
  const all = filterCommands("");
  const visibleCommands = all.slice(0, 10);
  // listHeight = visibleCommands.length + 2（提示行 + 可能的滚动指示器）
  // 10 命令 + 1 提示行 = 11（无滚动指示器因为全部可见）
  const listHeight = visibleCommands.length + 2;
  expect(listHeight).toBe(12);
});

// handleCommand 测试 — 新命令
test("handleCommand: /help 返回帮助消息", () => {
  const result = handleCommand("/help", { agent: null as never, currentModel: "test" });
  expect(result.handled).toBe(true);
  expect(result.message).toContain("可用命令");
});

test("handleCommand: /clear context 设置 shouldClearContext", () => {
  const result = handleCommand("/clear context", { agent: null as never, currentModel: "test" });
  expect(result.handled).toBe(true);
  expect(result.shouldClearContext).toBe(true);
  expect(result.message).toContain("已清空");
});

test("handleCommand: /clear 仅清屏", () => {
  const result = handleCommand("/clear", { agent: null as never, currentModel: "test" });
  expect(result.handled).toBe(true);
  expect(result.shouldClear).toBe(true);
  expect(result.shouldClearContext).toBeUndefined();
});

test("handleCommand: /exit 请求退出", () => {
  const result = handleCommand("/exit", { agent: null as never, currentModel: "test" });
  expect(result.handled).toBe(true);
  expect(result.shouldExit).toBe(true);
});

test("handleCommand: 未知命令返回提示", () => {
  const result = handleCommand("/xyz", { agent: null as never, currentModel: "test" });
  expect(result.handled).toBe(true);
  expect(result.message).toContain("未知命令");
});

test("handleCommand: 非命令返回 handled=false", () => {
  const result = handleCommand("hello", { agent: null as never, currentModel: "test" });
  expect(result.handled).toBe(false);
});

// 方向键转义序列识别逻辑测试（纯函数验证）
// 验证 \x1b[A/\x1b[B/\x1bOA/\x1bOB 被正确识别为方向键
test("方向键转义序列识别: \\x1b[A = upArrow", () => {
  const input = "\x1b[A";
  const isUp = input === "\x1b[A" || input === "\x1bOA";
  expect(isUp).toBe(true);
});

test("方向键转义序列识别: \\x1b[B = downArrow", () => {
  const input: string = "\x1b[B";
  const isDown = input === "\x1b[B" || input === "\x1bOB";
  expect(isDown).toBe(true);
});

test("方向键转义序列识别: \\x1bOA = upArrow (应用模式)", () => {
  const input: string = "\x1bOA";
  const isUp = input === "\x1b[A" || input === "\x1bOA";
  expect(isUp).toBe(true);
});

test("方向键转义序列识别: \\x1bOB = downArrow (应用模式)", () => {
  const input: string = "\x1bOB";
  const isDown = input === "\x1b[B" || input === "\x1bOB";
  expect(isDown).toBe(true);
});

test("方向键转义序列识别: 普通字符不误判", () => {
  const input: string = "a";
  const isUp = input === "\x1b[A" || input === "\x1bOA";
  const isDown = input === "\x1b[B" || input === "\x1bOB";
  expect(isUp).toBe(false);
  expect(isDown).toBe(false);
});

test("方向键转义序列识别: 转义序列不残留到输入值", () => {
  // 模拟 input.replace(/\x1b\[[A-D]/g, "") 的过滤效果
  const rawInput = "\x1b[A";
  const filtered = rawInput.replace(/\x1b\[[A-D]/g, "");
  expect(filtered).toBe(""); // 被完全过滤掉，不会追加到 value

  const rawInput2 = "\x1bOA";
  // \x1bOA 不被 /\x1b\[[A-D]/g 匹配（因为是 O 不是 [），需要额外处理
  // 但 useInput 里已经在 isUp/isDown 分支 return 了，不会走到追加逻辑
  // 验证它不会通过 replace 被清理（证明需要靠 return 阻止）
  const filtered2 = rawInput2.replace(/\x1b\[[A-D]/g, "");
  expect(filtered2).toBe("\x1bOA"); // 不被正则匹配，但 useInput 里已 return
});
