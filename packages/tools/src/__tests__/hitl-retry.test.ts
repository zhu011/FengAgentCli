/**
 * @fengagent/tools — 工具入参 human-in-the-loop（改参后重试）测试
 *
 * 验证 executor 的两条人工干预路径：
 * 1. 权限审批 ask：用户可携带修改后的入参放行（{ decision: "allow", input }），
 *    工具以修改后的参数执行，结果带 userCorrectedInput 标记；
 * 2. 入参校验失败：仅当权限策略对该工具 ask（destructive / ask 规则）时，
 *    把校验错误作为审批原因推给用户改参；autoApprove / 只读自动放行场景
 *    保持原行为（直接返回校验错误给模型自行修正，不打扰用户）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createToolExecutor } from "../index.ts";
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import { z } from "zod";

const TEST_CONTEXT_BASE: ToolContext = {
  workdir: ".",
  sessionId: "hitl-test-session",
  messageId: "hitl-test-msg",
};

/** 记录实际执行入参的工具 — 用于断言「工具以新参数执行」 */
function recordTool(
  name: string,
  schema: z.ZodType,
  opts: { ask?: boolean; readOnly?: boolean } = {},
): { tool: ToolDefinition; executed: unknown[] } {
  const executed: unknown[] = [];
  const tool: ToolDefinition = {
    name,
    description: `test tool ${name}`,
    inputSchema: schema,
    isReadOnly: () => opts.readOnly ?? false,
    isDestructive: () => !(opts.readOnly ?? false),
    checkPermissions:
      opts.ask === true
        ? () => ({ decision: "ask" as const, message: "confirm please" })
        : undefined,
    async execute(input) {
      executed.push(input);
      return { content: `executed:${JSON.stringify(input)}` };
    },
  };
  return { tool, executed };
}

beforeEach(() => {
  delete process.env.FENG_AUTO_APPROVE_TOOLS;
  delete process.env.FENG_ALLOWED_TOOLS;
  delete process.env.FENG_DENIED_TOOLS;
});
afterEach(() => {
  delete process.env.FENG_AUTO_APPROVE_TOOLS;
  delete process.env.FENG_ALLOWED_TOOLS;
  delete process.env.FENG_DENIED_TOOLS;
});

describe("权限审批 ask：allow 携带修改后的入参（human-in-the-loop 改参）", () => {
  it("ask + allow 不带 input → 以原始入参执行", async () => {
    const { tool, executed } = recordTool("ask-tool", z.object({ path: z.string() }), { ask: true });
    const ctx: ToolContext = {
      ...TEST_CONTEXT_BASE,
      requestPermission: async () => ({ decision: "allow" as const }),
    };
    const executor = createToolExecutor();
    const result = await executor.execute(tool, { path: "/a" }, ctx);

    expect(result.isError).not.toBe(true);
    expect(executed).toEqual([{ path: "/a" }]);
  });

  it("ask + allow 携带修改后的入参 → 工具以新参数执行，结果带 userCorrectedInput 标记", async () => {
    const { tool, executed } = recordTool("ask-tool", z.object({ path: z.string() }), { ask: true });
    const ctx: ToolContext = {
      ...TEST_CONTEXT_BASE,
      requestPermission: async () => ({
        decision: "allow" as const,
        input: { path: "/corrected" },
      }),
    };
    const executor = createToolExecutor();
    const result = await executor.execute(tool, { path: "/wrong" }, ctx);

    expect(result.isError).not.toBe(true);
    // 工具以用户修改后的参数执行（而非模型原始参数）
    expect(executed).toEqual([{ path: "/corrected" }]);
    expect(
      (result.metadata as Record<string, unknown> | undefined)?.userCorrectedInput,
    ).toBe(true);
  });

  it("executeMany 返回实际执行入参（改参后）", async () => {
    const { tool, executed } = recordTool("ask-tool", z.object({ path: z.string() }), { ask: true });
    const ctx: ToolContext = {
      ...TEST_CONTEXT_BASE,
      requestPermission: async () => ({
        decision: "allow" as const,
        input: { path: "/fixed" },
      }),
    };
    const executor = createToolExecutor();
    const results = await executor.executeMany([{ tool, input: { path: "/orig" } }], ctx);

    expect(executed).toEqual([{ path: "/fixed" }]);
    expect(results[0]!.input).toEqual({ path: "/fixed" });
  });

  it("ask + 修改后入参仍校验失败 → 返回校验错误（不再二次询问）", async () => {
    let askCount = 0;
    const { tool, executed } = recordTool("ask-tool", z.object({ path: z.string() }), { ask: true });
    const ctx: ToolContext = {
      ...TEST_CONTEXT_BASE,
      requestPermission: async () => {
        askCount++;
        return { decision: "allow" as const, input: { path: 123 } };
      },
    };
    const executor = createToolExecutor();
    const result = await executor.execute(tool, { path: "/orig" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("用户修改后的入参校验失败");
    expect(executed).toEqual([]);
    expect(askCount).toBe(1);
  });

  it("ask + deny → 拒绝本次调用", async () => {
    const { tool, executed } = recordTool("ask-tool", z.object({ path: z.string() }), { ask: true });
    const ctx: ToolContext = {
      ...TEST_CONTEXT_BASE,
      requestPermission: async () => ({ decision: "deny" as const, reason: "不想执行" }),
    };
    const executor = createToolExecutor();
    const result = await executor.execute(tool, { path: "/a" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Permission denied by user: 不想执行");
    expect(executed).toEqual([]);
  });
});

describe("入参校验失败 → 按权限策略决定是否打扰用户改参", () => {
  it("ask 策略工具 + 入参校验失败 + 用户改参后 allow → 以修正参数执行", async () => {
    const { tool, executed } = recordTool(
      "need-path",
      z.object({ path: z.string().min(3) }),
      { ask: true },
    );
    const ctx: ToolContext = {
      ...TEST_CONTEXT_BASE,
      requestPermission: async () => ({
        decision: "allow" as const,
        input: { path: "/tmp/ok" },
      }),
    };
    const executor = createToolExecutor();
    const result = await executor.execute(tool, { path: "x" }, ctx);

    expect(result.isError).not.toBe(true);
    expect(executed).toEqual([{ path: "/tmp/ok" }]);
    expect(
      (result.metadata as Record<string, unknown> | undefined)?.userCorrectedInput,
    ).toBe(true);
  });

  it("ask 策略工具 + 入参校验失败 + allow 未改参 → 仍校验失败报错", async () => {
    const { tool, executed } = recordTool(
      "need-path",
      z.object({ path: z.string().min(3) }),
      { ask: true },
    );
    const ctx: ToolContext = {
      ...TEST_CONTEXT_BASE,
      requestPermission: async () => ({ decision: "allow" as const }),
    };
    const executor = createToolExecutor();
    const result = await executor.execute(tool, { path: "x" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("仍校验失败");
    expect(executed).toEqual([]);
  });

  it("只读自动放行工具 + 入参校验失败 → 不打扰用户，直接返回校验错误（原行为）", async () => {
    let askCount = 0;
    const { tool, executed } = recordTool("read-tool", z.object({ path: z.string() }), {
      readOnly: true,
    });
    const ctx: ToolContext = {
      ...TEST_CONTEXT_BASE,
      requestPermission: async () => {
        askCount++;
        return { decision: "allow" as const };
      },
    };
    const executor = createToolExecutor();
    const result = await executor.execute(tool, { path: 42 }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
    expect(askCount).toBe(0);
    expect(executed).toEqual([]);
  });

  it("无 requestPermission（CLI/子 Agent）→ 直接返回校验错误，不询问", async () => {
    const { tool, executed } = recordTool("no-interactive", z.object({ path: z.string() }), {
      ask: true,
    });
    const executor = createToolExecutor();
    const result = await executor.execute(tool, { path: 42 }, TEST_CONTEXT_BASE);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
    expect(executed).toEqual([]);
  });
});
