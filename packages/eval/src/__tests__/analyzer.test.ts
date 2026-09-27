/**
 * @fengagent/eval — 分析器指标口径测试（AGE-29 P2）
 *
 * 缺陷原状：观测页指标卡「工具调用 50 次」统计的是**含工具调用的响应轮次**，
 * 而同一页面的「工具使用分布」是逐次累加的真实调用数（如 bash 48 + file-write 5 = 53），
 * 两个数字自相矛盾。修复后：
 * - `toolCallCount`    = 含工具调用的响应轮次（与 toolCallRate 同口径）
 * - `toolInvocationCount` = 真实工具调用次数（= Σ toolUsage），与分布图同口径
 */

import { describe, test, expect } from "bun:test";
import { analyzeRecords } from "../analyzer.ts";
import type { TraceRecord } from "../analyzer.ts";

/**
 * 一个 response 轮次里带多个工具调用（真实场景：一轮回复同时发起 bash + file-write）。
 * 轮次口径 = 1，调用次数口径 = 2 —— 这正是原来对不上的地方。
 */
const RECORDS: TraceRecord[] = [
  {
    timestamp: "2026-09-26T10:00:00.000Z",
    sessionId: "s1",
    messageId: "m1",
    direction: "request",
    model: "deepseek-v4-pro",
    hasToolCalls: false,
  },
  {
    timestamp: "2026-09-26T10:00:02.000Z",
    sessionId: "s1",
    messageId: "m1",
    direction: "response",
    model: "deepseek-v4-pro",
    durationMs: 2000,
    inputTokens: 100,
    outputTokens: 20,
    hasToolCalls: true,
    toolCalls: [
      { name: "bash", input: { command: "ls" } },
      { name: "file-write", input: { path: "a.txt" } },
    ],
    finishReason: "tool_use",
  },
  {
    timestamp: "2026-09-26T10:00:04.000Z",
    sessionId: "s1",
    messageId: "m2",
    direction: "request",
    model: "deepseek-v4-pro",
    hasToolCalls: false,
  },
  {
    timestamp: "2026-09-26T10:00:05.000Z",
    sessionId: "s1",
    messageId: "m2",
    direction: "response",
    model: "deepseek-v4-pro",
    durationMs: 1000,
    inputTokens: 120,
    outputTokens: 30,
    hasToolCalls: true,
    toolCalls: [{ name: "bash", input: { command: "pwd" } }],
    finishReason: "end_turn",
  },
];

describe("analyzeRecords — 工具调用口径", () => {
  const result = analyzeRecords(RECORDS, "fixture.jsonl");

  test("toolCallCount 统计的是含工具调用的响应轮次", () => {
    expect(result.toolCallCount).toBe(2);
    expect(result.totalLlmCalls).toBe(2);
    expect(result.toolCallRate).toBe(100);
  });

  test("toolInvocationCount 统计真实调用次数，与 toolUsage 合计一致", () => {
    const usageSum = Array.from(result.toolUsage.values()).reduce((a, b) => a + b, 0);
    expect(result.toolInvocationCount).toBe(3);
    expect(result.toolInvocationCount).toBe(usageSum);
    expect(result.toolUsage.get("bash")).toBe(2);
    expect(result.toolUsage.get("file-write")).toBe(1);
  });

  test("两个口径在本 fixture 下确实不同（回归护栏）", () => {
    expect(result.toolCallCount).not.toBe(result.toolInvocationCount);
  });

  test("模型维度同样给出两个口径", () => {
    const comp = result.modelComparisons.find((m) => m.model === "deepseek-v4-pro");
    expect(comp).toBeDefined();
    expect(comp!.toolCallCount).toBe(2);
    expect(comp!.toolInvocationCount).toBe(3);
  });

  test("无工具调用时两者均为 0", () => {
    const empty = analyzeRecords(
      [
        {
          timestamp: "2026-09-26T10:00:00.000Z",
          sessionId: "s2",
          direction: "response",
          model: "model-a",
          hasToolCalls: false,
          finishReason: "end_turn",
        },
      ],
      "empty.jsonl",
    );
    expect(empty.toolCallCount).toBe(0);
    expect(empty.toolInvocationCount).toBe(0);
  });
});
