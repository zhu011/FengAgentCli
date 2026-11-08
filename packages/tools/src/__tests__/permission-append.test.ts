/**
 * appendPermissionRule（TUI 永久放行写盘）— 行为测试。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPermissionRule,
  loadPermissionConfig,
  PERMISSIONS_CONFIG_PATH,
} from "../permission-config.ts";

let root: string;

describe("appendPermissionRule", () => {
  test("文件不存在时创建（含目录）并写入规则", () => {
    root = mkdtempSync(join(tmpdir(), "feng-perm-append-"));
    const config = appendPermissionRule(root, { tool: "bash", action: "allow", reason: "TUI 永久放行" });
    expect(config.rules).toEqual([{ tool: "bash", action: "allow", reason: "TUI 永久放行" }]);

    // 落盘可回读
    const reread = loadPermissionConfig(root);
    expect(reread.rules).toHaveLength(1);
    expect(reread.rules[0]).toMatchObject({ tool: "bash", action: "allow" });
    expect(reread.cache).toBe(true);
  });

  test("保留已有规则，追加不覆盖", () => {
    mkdirSync(join(root, ".fengagent"), { recursive: true });
    writeFileSync(
      join(root, PERMISSIONS_CONFIG_PATH),
      JSON.stringify({
        rules: [{ tool: "file-read", action: "allow" }],
        cache: false,
      }),
      "utf-8",
    );

    const config = appendPermissionRule(root, { tool: "bash", action: "allow" });
    expect(config.rules.map((r) => r.tool)).toEqual(["file-read", "bash"]);
    expect(config.cache).toBe(false); // 原 cache 配置保留

    const reread = loadPermissionConfig(root);
    expect(reread.rules).toHaveLength(2);
    expect(reread.cache).toBe(false);
  });

  test("同 tool + action 去重", () => {
    const config = appendPermissionRule(root, { tool: "bash", action: "allow", reason: "again" });
    expect(config.rules.filter((r) => r.tool === "bash")).toHaveLength(1);
    // 已存在同 tool+action（reason 不同）也不重复
    const again = appendPermissionRule(root, { tool: "bash", action: "allow", reason: "third" });
    expect(again.rules).toHaveLength(2);
  });

  test("同 tool 不同 action 不去重", () => {
    const config = appendPermissionRule(root, { tool: "bash", action: "deny" });
    expect(config.rules.filter((r) => r.tool === "bash")).toHaveLength(2);
    const raw = JSON.parse(readFileSync(join(root, PERMISSIONS_CONFIG_PATH), "utf-8"));
    expect(raw.rules).toHaveLength(3);
  });

  test("不污染共享的 EMPTY_PERMISSION_CONFIG 常量", () => {
    appendPermissionRule(root, { tool: "solo-tool", action: "allow" });
    // 换一个全新 workdir：若共享常量被污染，这里会读到残留规则
    const fresh = mkdtempSync(join(tmpdir(), "feng-perm-fresh-"));
    const empty = loadPermissionConfig(fresh);
    expect(empty.rules).toHaveLength(0);
    rmSync(fresh, { recursive: true, force: true });
  });
});

// 清理（Bun test 无全局 afterAll 作用域问题的写法：模块级 try/finally 不适用，手动在最后清）
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows 句柄延迟时留给系统临时目录清理
  }
});
