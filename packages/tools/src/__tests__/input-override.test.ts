/**
 * @fengagent/tools — 图上「改参并重放」的入参改写测试（AGE-29 图三件套 ①）
 *
 * 覆盖：
 * 1. 命中改写规则 → 工具**真的以新入参执行**，结果带 `userCorrectedInput` 留痕
 *    （与 HITL 审批改参同一条留痕链路）；
 * 2. 未命中（工具名不同 / from 不匹配）→ 仍以原始入参执行，不留改参痕；
 * 3. `from` 键序不同但语义相同 → 视为命中（前端编辑 JSON 会改键序）；
 * 4. `to` 与原入参等价 → 不算改参（不误标）；
 * 5. 改写后入参校验失败 → 报校验错误且不执行工具。
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import type { ToolContext, ToolInputOverride } from "@fengagent/core";
import { createToolExecutor } from "../executor.ts";

const schema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
});

function makeTool(executed: Array<{ command: string; cwd?: string }>) {
  return {
    name: "bash",
    description: "run command",
    inputSchema: schema,
    async execute(input: { command: string; cwd?: string }) {
      executed.push(input);
      return { content: `ran: ${input.command}` };
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
  };
}

function context(overrides?: ToolInputOverride[]): ToolContext {
  return {
    workdir: ".",
    sessionId: "s1",
    messageId: "m1",
    ...(overrides ? { inputOverrides: overrides } : {}),
  };
}

describe("工具执行器 — 入参改写（图上改参并重放）", () => {
  test("命中规则 → 以新入参执行并带 userCorrectedInput 留痕", async () => {
    const executed: Array<{ command: string; cwd?: string }> = [];
    const executor = createToolExecutor();
    const tool = makeTool(executed);

    const result = await executor.execute(
      tool,
      { command: "ls" },
      context([{ toolName: "bash", from: { command: "ls" }, to: { command: "ls -la" } }]),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("ran: ls -la");
    // 工具接收到的确实是新入参（不是原入参）
    expect(executed).toEqual([{ command: "ls -la" }]);
    expect((result.metadata as Record<string, unknown>)?.userCorrectedInput).toBe(true);
  });

  test("工具名不同 → 不命中，仍以原始入参执行", async () => {
    const executed: Array<{ command: string; cwd?: string }> = [];
    const executor = createToolExecutor();
    const tool = makeTool(executed);

    const result = await executor.execute(
      tool,
      { command: "ls" },
      context([{ toolName: "read_file", from: { command: "ls" }, to: { command: "rm -rf /" } }]),
    );

    expect(result.content).toBe("ran: ls");
    expect(executed).toEqual([{ command: "ls" }]);
    expect((result.metadata as Record<string, unknown>)?.userCorrectedInput).toBeUndefined();
  });

  test("from 不匹配 → 不命中（只改指定的那一次调用）", async () => {
    const executed: Array<{ command: string; cwd?: string }> = [];
    const executor = createToolExecutor();
    const tool = makeTool(executed);

    const result = await executor.execute(
      tool,
      { command: "pwd" },
      context([{ toolName: "bash", from: { command: "ls" }, to: { command: "ls -la" } }]),
    );

    expect(result.content).toBe("ran: pwd");
    expect(executed).toEqual([{ command: "pwd" }]);
  });

  test("from 键序不同但语义相同 → 命中（前端编辑 JSON 会改键序）", async () => {
    const executed: Array<{ command: string; cwd?: string }> = [];
    const executor = createToolExecutor();
    const tool = makeTool(executed);

    await executor.execute(
      tool,
      { command: "ls", cwd: "/tmp" },
      context([
        // from 的键序与调用入参相反
        { toolName: "bash", from: { cwd: "/tmp", command: "ls" }, to: { command: "ls -la" } },
      ]),
    );

    expect(executed).toEqual([{ command: "ls -la" }]);
  });

  test("to 与原入参等价 → 不算改参（不误标已改参）", async () => {
    const executed: Array<{ command: string; cwd?: string }> = [];
    const executor = createToolExecutor();
    const tool = makeTool(executed);

    const result = await executor.execute(
      tool,
      { command: "ls" },
      context([{ toolName: "bash", from: { command: "ls" }, to: { command: "ls" } }]),
    );

    expect(result.content).toBe("ran: ls");
    expect((result.metadata as Record<string, unknown>)?.userCorrectedInput).toBeUndefined();
  });

  test("from 缺省 → 匹配该工具的任何调用", async () => {
    const executed: Array<{ command: string; cwd?: string }> = [];
    const executor = createToolExecutor();
    const tool = makeTool(executed);

    await executor.execute(
      tool,
      { command: "whatever" },
      context([{ toolName: "bash", to: { command: "echo ok" } }]),
    );

    expect(executed).toEqual([{ command: "echo ok" }]);
  });

  test("改写后入参非法 → 返回校验错误且工具不执行", async () => {
    const executed: Array<{ command: string; cwd?: string }> = [];
    const executor = createToolExecutor();
    const tool = makeTool(executed);

    const result = await executor.execute(
      tool,
      { command: "ls" },
      context([{ toolName: "bash", from: { command: "ls" }, to: { command: 123 } }]),
    );

    expect(result.isError).toBe(true);
    expect(executed).toHaveLength(0);
  });

  test("没有改写规则时行为与现状一致", async () => {
    const executed: Array<{ command: string; cwd?: string }> = [];
    const executor = createToolExecutor();
    const tool = makeTool(executed);

    const result = await executor.execute(tool, { command: "ls" }, context());
    expect(result.content).toBe("ran: ls");
    expect((result.metadata as Record<string, unknown>)?.userCorrectedInput).toBeUndefined();
  });
});
