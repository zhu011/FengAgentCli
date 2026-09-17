/**
 * @fengagent/tools — 死循环防护与单行输出契约（AGE-29）
 *
 * 两组契约：
 * 1. 无权限回调的「需要人工审批」拒绝必须标记为 `unrecoverable`：
 *    同一环境下重试必然再次失败，loop 层据此立即结算而不是空转到 maxTurns。
 * 2. 工具结果内容必须是**单物理行**：宿主按行采集子进程输出，多行 pretty JSON
 *    会被切开，首行只剩 `[` 之类的碎片（现场 `hermes provider error: [`）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { createToolExecutor } from "../executor.ts";
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_WORKDIR = join(tmpdir(), "fengagent-loop-safety");

const CONTEXT: ToolContext = {
  workdir: TEST_WORKDIR,
  sessionId: "test-session",
  messageId: "test-msg",
};

/** 破坏性工具：无 requestPermission 回调时权限层无法征求用户同意 */
const destructiveTool: ToolDefinition = {
  name: "destructive-tool",
  description: "A destructive tool",
  inputSchema: z.object({ command: z.string() }),
  execute: async () => ({ content: "ok" }),
  isReadOnly: () => false,
  isDestructive: () => true,
};

/** 入参 schema 严格：传错参数会得到多行 pretty JSON 的 zod 错误 */
const strictTool: ToolDefinition = {
  name: "strict-tool",
  description: "Needs a string filePath",
  inputSchema: z.object({ filePath: z.string() }),
  execute: async () => ({ content: "ok" }),
  isReadOnly: () => true,
};

const ENV_KEYS = ["FENG_AUTO_APPROVE_TOOLS", "FENG_ALLOWED_TOOLS", "FENG_DENIED_TOOLS"];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  if (existsSync(TEST_WORKDIR)) rmSync(TEST_WORKDIR, { recursive: true, force: true });
  mkdirSync(TEST_WORKDIR, { recursive: true });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (existsSync(TEST_WORKDIR)) rmSync(TEST_WORKDIR, { recursive: true, force: true });
});

describe("无权限回调的审批拒绝 — 标记为不可恢复", () => {
  it("破坏性工具 + 无 requestPermission → isError 且 metadata.unrecoverable", async () => {
    const executor = createToolExecutor();
    const results = await executor.executeMany(
      [{ tool: destructiveTool, input: { command: "ls -la" } }],
      CONTEXT,
    );

    const result = results[0]!.result;
    expect(result.isError).toBe(true);
    expect((result.metadata as Record<string, unknown>).permissionDecision).toBe("deny");
    expect((result.metadata as Record<string, unknown>).unrecoverable).toBe(true);
    expect(String(result.content)).toContain("no permission callback available");
  });

  it("有 requestPermission 回调时走审批流程 → 不标记不可恢复（HITL 无回归）", async () => {
    const executor = createToolExecutor();
    let asked = 0;
    const results = await executor.executeMany(
      [{ tool: destructiveTool, input: { command: "ls -la" } }],
      {
        ...CONTEXT,
        requestPermission: async () => {
          asked++;
          return { decision: "allow" };
        },
      },
    );

    expect(asked).toBe(1);
    expect(results[0]!.result.isError).toBeFalsy();
    expect(
      (results[0]!.result.metadata as Record<string, unknown> | undefined)?.unrecoverable,
    ).toBeUndefined();
  });

  it("有回调但用户拒绝 → 普通拒绝，不标记不可恢复", async () => {
    const executor = createToolExecutor();
    const results = await executor.executeMany(
      [{ tool: destructiveTool, input: { command: "ls -la" } }],
      {
        ...CONTEXT,
        requestPermission: async () => ({ decision: "deny", reason: "nope" }),
      },
    );

    const result = results[0]!.result;
    expect(result.isError).toBe(true);
    expect((result.metadata as Record<string, unknown>).unrecoverable).toBeUndefined();
  });
});

describe("工具结果内容 — 单物理行契约", () => {
  it("zod 校验失败的多行错误被压成单行（不再只剩 `[`）", async () => {
    const executor = createToolExecutor();
    // 传错类型 → zod 的 message 是多行 pretty JSON
    const results = await executor.executeMany(
      [{ tool: strictTool, input: {} }],
      CONTEXT,
    );

    const result = results[0]!.result;
    expect(result.isError).toBe(true);
    const content = String(result.content);
    expect(content.startsWith("Error: ")).toBe(true);
    expect(content.includes("\n")).toBe(false);
    expect(content.includes("\r")).toBe(false);
    // 弹窗/日志里能看到真实原因，而不是一个孤立的 `[`
    expect(content).toContain("filePath");
  });

  it("工具抛异常的多行 message 也被压成单行", async () => {
    const throwingTool: ToolDefinition = {
      name: "throwing-tool",
      description: "Throws a multi-line error",
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error("boom: [\n  { \"code\": 1 }\n]");
      },
      isReadOnly: () => true,
    };
    const executor = createToolExecutor();
    const results = await executor.executeMany([{ tool: throwingTool, input: {} }], CONTEXT);

    const content = String(results[0]!.result.content);
    expect(content.includes("\n")).toBe(false);
    expect(content).toContain("code");
  });
});
