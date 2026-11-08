/**
 * T2 特性测试 — @ 路径补全纯函数 + 命令面板分组渲染 + 双模式建议。
 */

import { describe, expect, test, afterAll } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAtCompletion,
  extractAtToken,
  listPathEntries,
} from "../tui/at-completion.ts";
import { Input, navigateHistory } from "../tui/input.tsx";
import { filterCommands } from "../commands.ts";

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("extractAtToken", () => {
  test("行首 @ 与空格后 @ 提取 token", () => {
    expect(extractAtToken("@src")).toEqual({ dir: "", prefix: "src" });
    expect(extractAtToken("看下 @pack")).toEqual({ dir: "", prefix: "pack" });
    expect(extractAtToken("@src/comp")).toEqual({ dir: "src", prefix: "comp" });
  });

  test("无 @ / 邮箱 / token 带空格 → null", () => {
    expect(extractAtToken("hello")).toBeNull();
    expect(extractAtToken("a@b.com")).toBeNull(); // @ 前不是空白
    expect(extractAtToken("@src file")).toBeNull(); // token 已结束
  });
});

describe("listPathEntries", () => {
  const root = mkdtempSync(join(tmpdir(), "feng-at-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# x", "utf-8");
  writeFileSync(join(root, "package.json"), "{}", "utf-8");
  writeFileSync(join(root, "src", "app.ts"), "", "utf-8");
  writeFileSync(join(root, "src", "util.ts"), "", "utf-8");

  test("空前缀：目录优先（带 / 后缀）+ 字典序", () => {
    const entries = listPathEntries(root, "", "");
    expect(entries.map((e) => e.name)).toEqual([
      "docs/",
      "src/",
      "package.json",
      "README.md",
    ].sort((a, b) => (a.endsWith("/") && !b.endsWith("/") ? -1 : 1)) as string[]);
    // 目录确在前两名
    expect(entries[0]!.isDir).toBe(true);
    expect(entries[1]!.isDir).toBe(true);
  });

  test("前缀过滤 + 子目录列出", () => {
    const md = listPathEntries(root, "", "REA");
    expect(md.map((e) => e.name)).toEqual(["README.md"]);
    const src = listPathEntries(root, "src", "app");
    expect(src.map((e) => e.name)).toEqual(["app.ts"]);
  });

  test("目录不存在 → 空数组不抛", () => {
    expect(listPathEntries(root, "no-such-dir", "")).toEqual([]);
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟时留给系统临时目录清理
    }
  });
});

describe("applyAtCompletion", () => {
  test("顶层补全替换 token", () => {
    expect(applyAtCompletion("看下 @pack", "package.json")).toBe("看下 @package.json");
  });

  test("子目录补全保留 dir 前缀", () => {
    expect(applyAtCompletion("@src/ap", "app.ts")).toBe("@src/app.ts");
  });
});

describe("命令面板分组（分类字段完备性）", () => {
  test("全部命令带 category，且至少 4 个分类（渲染层按其切换分组头）", () => {
    const all = filterCommands("/");
    expect(all.length).toBeGreaterThan(10);
    const cats = new Set(all.map((c) => c.category));
    expect(cats.size).toBeGreaterThanOrEqual(4);
    expect(cats.has("基础")).toBe(true);
    expect(cats.has("工具")).toBe(true);
  });
});

describe("占位符含 @ 文件提示（T2）", () => {
  test("默认占位符提及 @ 文件", () => {
    const { lastFrame } = render(<Input onSubmit={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("@ 文件");
    expect(out).toContain("Tab 补全");
  });
});

describe("navigateHistory 回归（T1 保持）", () => {
  test("prev/next 钳制语义不变", () => {
    const h = ["a", "b", "c"];
    expect(navigateHistory(h, -1, "prev")).toBe(2);
    expect(navigateHistory(h, 0, "prev")).toBe(0);
    expect(navigateHistory(h, 2, "next")).toBe(-1);
    expect(navigateHistory([], -1, "prev")).toBe(-1);
  });
});
