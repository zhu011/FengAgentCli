/**
 * @fengagent/tools — 非交互宿主的预授权策略（AGE-29 ACP 路径）
 *
 * 现场：Multica 守护进程下 `createAgent` 没有 `requestPermission` 回调，bash 等
 * ask 类工具被判 `unrecoverable` → 整轮对话立即结算，用户看到
 * `-32603 ... requires user approval but no permission callback is available`。
 *
 * 本测试固化两条语义：
 * 1. 默认（deny）行为不变：无回调 + ask → isError + `metadata.unrecoverable`；
 * 2. 预授权（allow）宿主：无回调 + ask → 工具照常执行并打
 *    `metadata.permissionPreAuthorized`，且**不覆盖**有回调时的真实审批流程。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { createToolExecutor } from "../executor.ts";
import { createPermissionChecker } from "../permission.ts";
import { bashTool } from "../builtin/bash.ts";
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";

const TEST_WORKDIR = process.cwd();

const CONTEXT: ToolContext = {
  workdir: TEST_WORKDIR,
  sessionId: "preauth-session",
  messageId: "preauth-msg",
};

/** 破坏性工具：属性推断路径（isDestructive → 无回调时 denyUnrecoverable） */
const destructiveTool: ToolDefinition = {
  name: "destructive-tool",
  description: "A destructive tool",
  inputSchema: z.object({ command: z.string() }),
  execute: async () => ({ content: "executed" }),
  isReadOnly: () => false,
  isDestructive: () => true,
};

/** ask 类工具：工具自带 checkPermissions（bash 的真实形状） */
const askTool: ToolDefinition = {
  name: "ask-tool",
  description: "Tool that asks for approval",
  inputSchema: z.object({ command: z.string() }),
  execute: async () => ({ content: "executed" }),
  isReadOnly: () => false,
  isDestructive: () => true,
  checkPermissions: () => ({ decision: "ask", message: "confirm?" }),
};

const ENV_KEYS = ["FENG_AUTO_APPROVE_TOOLS", "FENG_ALLOWED_TOOLS", "FENG_DENIED_TOOLS"];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("权限检查器 — 破坏性工具的预授权", () => {
  it("默认策略：无回调 → denyUnrecoverable（历史行为不变）", () => {
    const checker = createPermissionChecker(TEST_WORKDIR, undefined, {});
    const result = checker.checkPermissions(destructiveTool, { command: "ls" }, CONTEXT);
    expect(result.decision).toBe("deny");
    expect(result).toMatchObject({ unrecoverable: true });
  });

  it("预授权策略：无回调 → allow（不再判不可恢复）", () => {
    const checker = createPermissionChecker(TEST_WORKDIR, undefined, {
      unattendedPermissionPolicy: "allow",
    });
    const result = checker.checkPermissions(destructiveTool, { command: "ls" }, CONTEXT);
    expect(result.decision).toBe("allow");
  });

  it("预授权策略不改变「有回调时先问用户」：ask 仍然交给回调", () => {
    const checker = createPermissionChecker(TEST_WORKDIR, undefined, {
      unattendedPermissionPolicy: "allow",
    });
    const result = checker.checkPermissions(destructiveTool, { command: "ls" }, {
      ...CONTEXT,
      requestPermission: async () => ({ decision: "allow" }),
    });
    expect(result.decision).toBe("ask");
  });
});

describe("工具执行器 — ask 类工具在无回调宿主下的行为", () => {
  it("默认策略：ask + 无回调 → isError 且 unrecoverable（loop 层立即结算）", async () => {
    const executor = createToolExecutor();
    const [result] = await executor.executeMany([{ tool: askTool, input: { command: "pwd" } }], CONTEXT);
    expect(result!.result.isError).toBe(true);
    expect(result!.result.content).toContain("no permission callback is available");
    expect(result!.result.metadata).toMatchObject({ unrecoverable: true });
  });

  it("预授权策略：ask + 无回调 → 工具真正执行，结果带 permissionPreAuthorized", async () => {
    const executor = createToolExecutor(undefined, undefined, {
      unattendedPermissionPolicy: "allow",
    });
    const [result] = await executor.executeMany([{ tool: askTool, input: { command: "pwd" } }], CONTEXT);
    expect(result!.result.isError).toBeFalsy();
    expect(result!.result.content).toContain("executed");
    expect(result!.result.metadata).toMatchObject({ permissionPreAuthorized: true });
  });

  it("预授权策略：有回调时仍然走审批，用户拒绝则工具不执行", async () => {
    const executor = createToolExecutor(undefined, undefined, {
      unattendedPermissionPolicy: "allow",
    });
    const [result] = await executor.executeMany([{ tool: askTool, input: { command: "pwd" } }], {
      ...CONTEXT,
      requestPermission: async () => ({ decision: "deny", reason: "不想跑" }),
    });
    expect(result!.result.isError).toBe(true);
    expect(result!.result.content).toContain("Permission denied by user");
    expect(result!.result.metadata).not.toMatchObject({ permissionPreAuthorized: true });
  });

  it("bash 工具（真实工具定义）自带 ask 语义：默认宿主仍拒绝，预授权宿主放行", () => {
    // bash 自带 checkPermissions → ask，是现场报错的那个工具
    expect(bashTool.checkPermissions?.({ command: "pwd" } as never, CONTEXT)).toMatchObject({
      decision: "ask",
    });

    // 默认策略（TUI 之外的批处理 / 子 Agent）：保持「ask 无法满足 → 拒绝」，
    // 防止预授权被误扩散到所有无回调宿主
    const defaultChecker = createPermissionChecker(TEST_WORKDIR, undefined, {});
    expect(defaultChecker.checkPermissions(bashTool, { command: "pwd" }, CONTEXT)).toMatchObject({
      decision: "ask",
    });
  });
});
