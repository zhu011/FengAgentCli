/**
 * removePermissionRule（权限收回）+ PermissionChecker.reload — 行为测试。
 *
 * 覆盖「只能加、不能收」缺口的后端语义：
 * - 按 tool / tool+action 撤销永久规则，其余规则与 cache 开关原样保留；
 * - 无命中 / 无文件时不写盘（不凭空创建配置文件）；
 * - 撤销后 reload 让运行中的检查器立刻按新规则判定（含清空决策缓存）。
 */

import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@fengagent/core/tool";
import {
  appendPermissionRule,
  loadPermissionConfig,
  removePermissionRule,
  PERMISSIONS_CONFIG_PATH,
} from "../permission-config.ts";
import { createPermissionChecker } from "../permission.ts";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "feng-perm-revoke-"));
  roots.push(root);
  return root;
}

function writeRules(root: string, payload: unknown): void {
  mkdirSync(join(root, ".fengagent"), { recursive: true });
  writeFileSync(join(root, PERMISSIONS_CONFIG_PATH), JSON.stringify(payload), "utf-8");
}

/** 需要审批的破坏性工具（无规则时 → ask） */
const destructiveTool: ToolDefinition = {
  name: "bash",
  description: "destructive",
  inputSchema: { parse: (v: unknown) => v } as unknown as ToolDefinition["inputSchema"],
  async execute() {
    return { content: "ok" };
  },
  isReadOnly: () => false,
  isDestructive: () => true,
} as unknown as ToolDefinition;

// 有 requestPermission 回调 → 破坏性工具无规则时判 ask（否则会被判不可恢复拒绝）
const context = {
  requestPermission: async () => ({ decision: "allow" as const }),
} as unknown as Parameters<ReturnType<typeof createPermissionChecker>["checkPermissions"]>[2];

afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟时留给系统临时目录清理
    }
  }
});

describe("removePermissionRule", () => {
  test("按 tool + action 撤销，其余规则与 cache 开关保留", () => {
    const root = makeRoot();
    writeRules(root, {
      rules: [
        { tool: "bash", action: "allow", reason: "永久放行" },
        { tool: "bash", action: "deny" },
        { tool: "file-read", action: "allow" },
      ],
      cache: false,
    });

    const result = removePermissionRule(root, { tool: "bash", action: "allow" });
    expect(result.removed).toEqual([{ tool: "bash", action: "allow", reason: "永久放行" }]);
    expect(result.config.cache).toBe(false);
    expect(result.config.rules).toEqual([
      { tool: "bash", action: "deny" },
      { tool: "file-read", action: "allow" },
    ]);

    // 落盘可回读（不是只改了内存副本）
    const reread = loadPermissionConfig(root);
    expect(reread.rules.map((r) => `${r.tool}:${r.action}`)).toEqual([
      "bash:deny",
      "file-read:allow",
    ]);
    expect(reread.cache).toBe(false);
  });

  test("不给 action 时删掉该工具的全部规则", () => {
    const root = makeRoot();
    writeRules(root, {
      rules: [
        { tool: "bash", action: "allow" },
        { tool: "bash", action: "ask" },
        { tool: "grep", action: "allow" },
      ],
    });

    const result = removePermissionRule(root, { tool: "bash" });
    expect(result.removed).toHaveLength(2);
    expect(result.config.rules).toEqual([{ tool: "grep", action: "allow" }]);
    expect(loadPermissionConfig(root).rules).toHaveLength(1);
  });

  test("无命中时不动文件", () => {
    const root = makeRoot();
    writeRules(root, { rules: [{ tool: "bash", action: "allow" }] });
    const before = readFileSync(join(root, PERMISSIONS_CONFIG_PATH), "utf-8");

    const result = removePermissionRule(root, { tool: "not-installed" });
    expect(result.removed).toEqual([]);
    expect(readFileSync(join(root, PERMISSIONS_CONFIG_PATH), "utf-8")).toBe(before);
  });

  test("文件不存在时返回空结果且不创建文件", () => {
    const root = makeRoot();
    const result = removePermissionRule(root, { tool: "bash" });
    expect(result.removed).toEqual([]);
    expect(result.config.rules).toEqual([]);
    expect(existsSync(join(root, PERMISSIONS_CONFIG_PATH))).toBe(false);
  });

  test('"*" 只删通配那一条，不做通配展开', () => {
    const root = makeRoot();
    writeRules(root, {
      rules: [
        { tool: "*", action: "allow" },
        { tool: "bash", action: "allow" },
      ],
    });

    const result = removePermissionRule(root, { tool: "*" });
    expect(result.removed).toEqual([{ tool: "*", action: "allow" }]);
    expect(result.config.rules).toEqual([{ tool: "bash", action: "allow" }]);
  });

  test("空 tool 不误删", () => {
    const root = makeRoot();
    writeRules(root, { rules: [{ tool: "bash", action: "allow" }] });
    const result = removePermissionRule(root, { tool: "   " });
    expect(result.removed).toEqual([]);
    expect(loadPermissionConfig(root).rules).toHaveLength(1);
  });

  test("与 appendPermissionRule 串起来：加→收→再加", () => {
    const root = makeRoot();
    appendPermissionRule(root, { tool: "bash", action: "allow", reason: "永久允许" });
    expect(loadPermissionConfig(root).rules).toHaveLength(1);

    removePermissionRule(root, { tool: "bash", action: "allow" });
    expect(loadPermissionConfig(root).rules).toHaveLength(0);

    appendPermissionRule(root, { tool: "bash", action: "allow" });
    expect(loadPermissionConfig(root).rules).toEqual([{ tool: "bash", action: "allow" }]);
  });
});

describe("PermissionChecker.reload", () => {
  test("撤销永久规则后 reload → 立即回到 ask（并清空决策缓存）", () => {
    const root = makeRoot();
    writeRules(root, { rules: [{ tool: "bash", action: "allow" }] });

    const checker = createPermissionChecker(root);
    expect(checker.checkPermissions(destructiveTool, { cmd: "rm -rf x" }, context).decision).toBe(
      "allow",
    );
    // 决策缓存里已有 allow —— 撤销后必须被清掉，否则界面看起来「收不回」
    expect(checker.checkPermissions(destructiveTool, { cmd: "rm -rf x" }, context).decision).toBe(
      "allow",
    );

    removePermissionRule(root, { tool: "bash", action: "allow" });
    const reloaded = checker.reload();
    expect(reloaded.rules).toHaveLength(0);

    expect(checker.checkPermissions(destructiveTool, { cmd: "rm -rf x" }, context).decision).toBe(
      "ask",
    );
  });

  test("重载能读到新增规则（同一 checker 不需要重启）", () => {
    const root = makeRoot();
    const checker = createPermissionChecker(root);
    expect(checker.checkPermissions(destructiveTool, { cmd: "ls" }, context).decision).toBe("ask");

    appendPermissionRule(root, { tool: "bash", action: "allow" });
    checker.reload();

    // 注意：入参不同才会绕过旧缓存路径，这里同时验证新规则本身生效
    expect(checker.checkPermissions(destructiveTool, { cmd: "ls -la" }, context).decision).toBe(
      "allow",
    );
  });
});
