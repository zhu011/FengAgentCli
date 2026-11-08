/**
 * 权限对话框五键决策 — 测试。
 *
 * 覆盖：五键渲染提示、键位→决策映射（resolveChoiceKey 纯函数）、改参编辑
 * 视图（EditParamView 直渲染）、种子/解析纯函数（seedEditValue /
 * parseEditedInput）、永久放行写盘冒烟。
 *
 * 注：ink-testing-library 在 Bun 下 stdin.write 不触发 useInput
 * （见 input-autocomplete.test.tsx:107 的既有结论），交互路径用纯函数覆盖。
 */

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EditParamView,
  PermissionDialog,
  parseEditedInput,
  resolveChoiceKey,
  seedEditValue,
  type PermissionDialogRequest,
} from "../tui/permission-dialog.tsx";
import { PERMISSIONS_CONFIG_PATH, appendPermissionRule } from "@fengagent/tools/permission-config";

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

const REQ: PermissionDialogRequest = {
  id: "test-1",
  toolName: "bash",
  input: { command: "rm -rf /tmp/x" },
  reason: "destructive",
};

describe("PermissionDialog 渲染", () => {
  test("五键提示 + 工具名 + 参数/原因", () => {
    const { lastFrame } = render(
      <PermissionDialog request={REQ} onRespond={() => {}} />,
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("权限请求");
    expect(out).toContain("bash");
    expect(out).toContain("rm -rf /tmp/x");
    expect(out).toContain("[y] 允许");
    expect(out).toContain("[e] 改参后允许");
    expect(out).toContain("[s] 本会话总允许");
    expect(out).toContain("[p] 永久允许");
    expect(out).toContain("[n] 拒绝");
  });

  test("编辑视图：值 + 光标 + 提示行；错误态替换提示行", () => {
    const { lastFrame: normal } = render(<EditParamView value='{"a":1}' />);
    const out = stripAnsi(normal() ?? "");
    expect(out).toContain('参数(JSON)');
    expect(out).toContain('{"a":1}');
    expect(out).toContain("回车提交 · Esc 返回");

    const { lastFrame: errored } = render(
      <EditParamView value="not-json" error="JSON 解析失败" />,
    );
    expect(stripAnsi(errored() ?? "")).toContain("JSON 解析失败");
  });
});

describe("resolveChoiceKey 键位映射", () => {
  const noMods = { return: false, escape: false };

  test("y / Y / Enter → 允许（本次）", () => {
    expect(resolveChoiceKey("y", noMods)).toEqual({ kind: "allow" });
    expect(resolveChoiceKey("Y", noMods)).toEqual({ kind: "allow" });
    expect(resolveChoiceKey("", { return: true, escape: false })).toEqual({ kind: "allow" });
  });

  test("e / E → 改参", () => {
    expect(resolveChoiceKey("e", noMods)).toEqual({ kind: "edit" });
    expect(resolveChoiceKey("E", noMods)).toEqual({ kind: "edit" });
  });

  test("s → 会话级放行；p → 永久放行", () => {
    expect(resolveChoiceKey("s", noMods)).toEqual({ kind: "allow-remember", remember: "session" });
    expect(resolveChoiceKey("S", noMods)).toEqual({ kind: "allow-remember", remember: "session" });
    expect(resolveChoiceKey("p", noMods)).toEqual({ kind: "allow-remember", remember: "permanent" });
    expect(resolveChoiceKey("P", noMods)).toEqual({ kind: "allow-remember", remember: "permanent" });
  });

  test("n / Esc → 拒绝；其它键无动作", () => {
    expect(resolveChoiceKey("n", noMods)).toEqual({ kind: "deny" });
    expect(resolveChoiceKey("", { return: false, escape: true })).toEqual({ kind: "deny" });
    expect(resolveChoiceKey("x", noMods)).toBeNull();
    expect(resolveChoiceKey("", noMods)).toBeNull();
  });
});

describe("改参种子与解析", () => {
  test("seedEditValue：对象紧凑 JSON / 空值 {} / 字符串带引号", () => {
    expect(seedEditValue({ command: "ls" })).toBe('{"command":"ls"}');
    expect(seedEditValue(undefined)).toBe("{}");
    expect(seedEditValue(null)).toBe("{}");
    expect(seedEditValue("plain")).toBe('"plain"');
  });

  test("parseEditedInput：合法 JSON 解析；非法留在编辑模式", () => {
    expect(parseEditedInput('{"command":"echo hi"}')).toEqual({
      ok: true,
      input: { command: "echo hi" },
    });
    expect(parseEditedInput("not-json").ok).toBe(false);
    expect(parseEditedInput("").ok).toBe(false);
  });
});

describe("永久放行写盘（hook 内部路径冒烟）", () => {
  test("appendPermissionRule 落盘 permissions.json", () => {
    const root = mkdtempSync(join(tmpdir(), "feng-perm-dlg-"));
    appendPermissionRule(root, { tool: "bash", action: "allow", reason: "TUI 永久放行" });
    const raw = JSON.parse(readFileSync(join(root, PERMISSIONS_CONFIG_PATH), "utf-8"));
    expect(raw.rules[0]).toMatchObject({ tool: "bash", action: "allow" });
    rmSync(root, { recursive: true, force: true });
  });
});
