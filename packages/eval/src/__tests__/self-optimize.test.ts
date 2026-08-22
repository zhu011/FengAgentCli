/**
 * 自优化诊断器测试 — diagnose 规则触发 / 阈值边界 / 报告落盘
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose, runSelfOptimize } from "../self-optimize.ts";
import type { AnalysisResult, TraceRecord } from "../analyzer.ts";

/** 构造一个健康默认的 AnalysisResult，测试按需覆盖字段 */
function buildResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  const base: AnalysisResult = {
    logFile: "llm-trace-2026-08-22.jsonl",
    totalRecords: 40,
    sessionCount: 2,
    totalLlmCalls: 20,
    totalDurationMs: 200_000,
    avgDurationMs: 10_000,
    totalInputTokens: 100_000,
    totalOutputTokens: 20_000,
    avgInputTokens: 5_000,
    avgOutputTokens: 1_000,
    toolCallCount: 10,
    toolCallRate: 50,
    toolUsage: new Map([["bash", 10]]),
    errorCount: 1,
    errorRate: 5,
    errors: ["one-off error"],
    finishReasons: new Map([["end_turn", 19], ["max_tokens", 1]]),
    sessions: [],
    models: ["mock-model"],
    modelComparisons: [
      {
        model: "mock-model",
        totalCalls: 20,
        toolCallCount: 10,
        toolSuccessCount: 9,
        toolFailureCount: 1,
        errorCount: 1,
        errorRate: 5,
        finishReasons: new Map([["end_turn", 19], ["max_tokens", 1]]),
        avgDurationMs: 10_000,
        avgInputTokens: 5_000,
        avgOutputTokens: 1_000,
        toolSuccessRate: 90,
        taskCompletionRate: 95,
        cacheReadTokens: 60_000,
        cacheCreationTokens: 40_000,
        cacheHitRate: 60,
      },
    ],
    totalCacheReadTokens: 60_000,
    totalCacheCreationTokens: 40_000,
    cacheHitRate: 60,
  };
  return { ...base, ...overrides };
}

/** 构造带工具调用的会话（含 error 记录，用于工具错误归因） */
function sessionWithToolErrors(
  toolName: string,
  errorMsg: string,
  errorCount = 2,
): NonNullable<AnalysisResult["sessions"]> {
  const resp = (error: string | null): TraceRecord => ({
    timestamp: "2026-08-22T00:00:00Z",
    sessionId: "s1",
    direction: "response",
    model: "mock-model",
    hasToolCalls: true,
    toolCalls: [{ name: toolName, input: { cmd: "ls" } }],
    error,
    finishReason: "end_turn",
  });
  const errorResponses = Array.from({ length: errorCount }, () => resp(errorMsg));
  return [
    {
      sessionId: "s1",
      model: "mock-model",
      requests: [],
      responses: [...errorResponses, resp(null)],
      totalDurationMs: 30_000,
      totalInputTokens: 15_000,
      totalOutputTokens: 3_000,
      toolCallCount: errorCount + 1,
      toolNames: [toolName],
      errors: Array.from({ length: errorCount }, () => errorMsg),
      finishReasons: ["end_turn"],
    },
  ];
}

describe("diagnose 自优化诊断", () => {
  test("健康指标不产生建议", () => {
    const suggestions = diagnose(buildResult());
    expect(suggestions).toHaveLength(0);
  });

  test("错误率高且工具错误占比 ≥50% → tool-description 建议", () => {
    const sessions = sessionWithToolErrors("bash", "bash: command not found: foobar", 14);
    const result = buildResult({
      errorCount: 14,
      errorRate: 70,
      errors: ["bash: command not found: foobar"],
      toolCallCount: 14,
      sessions,
      modelComparisons: [
        {
          ...buildResult().modelComparisons[0]!,
          errorCount: 14,
          errorRate: 70,
          toolCallCount: 14,
        },
      ],
    });

    const suggestions = diagnose(result);
    const tool = suggestions.find((s) => s.type === "tool-description");
    expect(tool).toBeDefined();
    expect(tool!.target).toBe("bash");
    expect(tool!.severity).toBe("high");
    expect(tool!.evidence.length).toBeGreaterThan(0);
  });

  test("错误率高但非工具错误 → system-prompt 建议", () => {
    const result = buildResult({
      errorCount: 14,
      errorRate: 70,
      errors: ["rate limit exceeded", "rate limit exceeded"],
      sessions: [
        {
          sessionId: "s1",
          model: "mock-model",
          requests: [],
          responses: [
            { timestamp: "t", sessionId: "s1", direction: "response", model: "m", hasToolCalls: false, error: "rate limit exceeded" },
          ],
          totalDurationMs: 10_000,
          totalInputTokens: 5_000,
          totalOutputTokens: 1_000,
          toolCallCount: 0,
          toolNames: [],
          errors: ["rate limit exceeded"],
          finishReasons: [],
        },
      ],
      modelComparisons: [
        { ...buildResult().modelComparisons[0]!, errorCount: 14, errorRate: 70, toolCallCount: 0 },
      ],
    });

    const suggestions = diagnose(result);
    const prompt = suggestions.find((s) => s.type === "system-prompt");
    expect(prompt).toBeDefined();
    expect(prompt!.severity).toBe("high");
  });

  test("工具成功率低于阈值 → tool-description 建议", () => {
    const result = buildResult({
      toolCallCount: 16,
      modelComparisons: [
        {
          ...buildResult().modelComparisons[0]!,
          toolCallCount: 16,
          toolSuccessCount: 8,
          toolFailureCount: 8,
          toolSuccessRate: 50,
        },
      ],
    });

    const suggestions = diagnose(result);
    const tool = suggestions.find((s) => s.type === "tool-description");
    expect(tool).toBeDefined();
    expect(tool!.title).toContain("工具成功率 50%");
  });

  test("任务完成率低于阈值 → system-prompt 建议", () => {
    const result = buildResult({
      modelComparisons: [
        { ...buildResult().modelComparisons[0]!, taskCompletionRate: 40 },
      ],
      finishReasons: new Map([["end_turn", 8], ["tool_use", 12]]),
    });

    const suggestions = diagnose(result);
    const prompt = suggestions.find((s) => s.type === "system-prompt");
    expect(prompt).toBeDefined();
    expect(prompt!.title).toContain("任务完成率 40%");
  });

  test("缓存命中率低于阈值 → context 建议", () => {
    const result = buildResult({
      totalInputTokens: 200_000,
      totalCacheReadTokens: 10_000,
      cacheHitRate: 5,
      modelComparisons: [
        { ...buildResult().modelComparisons[0]!, cacheHitRate: 5, cacheReadTokens: 10_000 },
      ],
    });

    const suggestions = diagnose(result);
    const ctx = suggestions.find((s) => s.type === "context");
    expect(ctx).toBeDefined();
    expect(ctx!.title).toContain("cache 命中率 5%");
  });

  test("平均耗时高于阈值 → workflow 建议", () => {
    const result = buildResult({
      avgDurationMs: 45_000,
      modelComparisons: [
        { ...buildResult().modelComparisons[0]!, avgDurationMs: 45_000 },
      ],
    });

    const suggestions = diagnose(result);
    const wf = suggestions.find((s) => s.type === "workflow");
    expect(wf).toBeDefined();
    expect(wf!.title).toContain("平均耗时 45.0s");
  });

  test("max_tokens 截断占比高 → context 建议", () => {
    const result = buildResult({
      finishReasons: new Map([["max_tokens", 14], ["end_turn", 6]]),
      modelComparisons: [
        {
          ...buildResult().modelComparisons[0]!,
          finishReasons: new Map([["max_tokens", 14], ["end_turn", 6]]),
        },
      ],
    });

    const suggestions = diagnose(result);
    const ctx = suggestions.find((s) => s.type === "context");
    expect(ctx).toBeDefined();
    expect(ctx!.title).toContain("截断完成占比 70%");
  });

  test("工具调用率过低 → workflow 建议", () => {
    const result = buildResult({
      toolCallCount: 1,
      toolCallRate: 5,
      sessionCount: 4,
      toolUsage: new Map(),
    });

    const suggestions = diagnose(result);
    const wf = suggestions.find((s) => s.type === "workflow" && s.title.includes("工具调用率"));
    expect(wf).toBeDefined();
    expect(wf!.severity).toBe("low");
  });

  // ===== LLM-judge 驱动的规则（KG 评测引擎产出 judgeResults 后生效）=====

  test("judge 平均完成度低且无工具误用 → system-prompt 建议", () => {
    const result = buildResult({
      judgeResults: [
        { sessionId: "s1", completionScore: 40, correctnessScore: 50, conclusion: "failed", note: "未输出最终结果" },
        { sessionId: "s2", completionScore: 50, correctnessScore: 60, conclusion: "partial", note: "只完成前半" },
        { sessionId: "s3", completionScore: 80, correctnessScore: 90, conclusion: "completed" },
      ],
    });

    const suggestions = diagnose(result);
    const prompt = suggestions.find((s) => s.type === "system-prompt" && s.title.includes("LLM-judge 平均完成度"));
    expect(prompt).toBeDefined();
    expect(prompt!.title).toContain("57");
    expect(prompt!.evidence[0]).toContain("s1");
  });

  test("judge 未完成会话中工具误用占比 ≥50% → tool-description 更细归因", () => {
    const result = buildResult({
      judgeResults: [
        { sessionId: "s1", completionScore: 30, correctnessScore: 30, conclusion: "tool_misused", note: "选错工具" },
        { sessionId: "s2", completionScore: 40, correctnessScore: 40, conclusion: "tool_misused", note: "参数错误" },
        { sessionId: "s3", completionScore: 20, correctnessScore: 20, conclusion: "failed", note: "中途失败" },
        { sessionId: "s4", completionScore: 90, correctnessScore: 95, conclusion: "completed" },
      ],
    });

    const suggestions = diagnose(result);
    const tool = suggestions.find((s) => s.type === "tool-description" && s.title.includes("LLM-judge"));
    expect(tool).toBeDefined();
    expect(tool!.title).toContain("工具误用占 67%");
    expect(tool!.evidence.some((e) => e.includes("s1"))).toBe(true);
  });

  test("judge 判定 unsafe → 零容忍触发（不受 minSamples 限制）", () => {
    const result = buildResult({
      judgeResults: [
        { sessionId: "s1", completionScore: 30, correctnessScore: 20, conclusion: "unsafe", note: "尝试删除系统文件" },
      ],
    });

    const suggestions = diagnose(result);
    const safety = suggestions.find((s) => s.title.includes("存在安全风险"));
    expect(safety).toBeDefined();
    expect(safety!.severity).toBe("high");
    expect(safety!.suggestedChange).toContain("安全约束");
  });

  test("judge 判定 inefficient 占比高 → workflow 建议", () => {
    const result = buildResult({
      judgeResults: [
        { sessionId: "s1", completionScore: 70, correctnessScore: 70, conclusion: "inefficient", note: "重复读取同一文件 5 次" },
        { sessionId: "s2", completionScore: 80, correctnessScore: 85, conclusion: "inefficient", note: "无意义重试" },
        { sessionId: "s3", completionScore: 90, correctnessScore: 95, conclusion: "completed" },
        { sessionId: "s4", completionScore: 85, correctnessScore: 90, conclusion: "completed" },
      ],
    });

    const suggestions = diagnose(result);
    const wf = suggestions.find((s) => s.type === "workflow" && s.title.includes("效率低"));
    expect(wf).toBeDefined();
    expect(wf!.title).toContain("50%");
  });

  test("judge 结果健康时不触发 judge 规则", () => {
    const result = buildResult({
      judgeResults: [
        { sessionId: "s1", completionScore: 90, correctnessScore: 92, conclusion: "completed" },
        { sessionId: "s2", completionScore: 85, correctnessScore: 88, conclusion: "completed" },
      ],
    });

    const suggestions = diagnose(result);
    expect(suggestions.filter((s) => s.title.includes("LLM-judge") || s.title.includes("效率低") || s.title.includes("安全风险"))).toHaveLength(0);
  });

  test("judge 结果数低于 minSamples 不触发完成度规则（unsafe 除外）", () => {
    const result = buildResult({
      judgeResults: [
        { sessionId: "s1", completionScore: 10, correctnessScore: 10, conclusion: "failed", note: "完全失败" },
        { sessionId: "s2", completionScore: 10, correctnessScore: 10, conclusion: "failed" },
      ],
    });

    const suggestions = diagnose(result);
    const prompt = suggestions.find((s) => s.title.includes("LLM-judge 平均完成度"));
    expect(prompt).toBeUndefined();
  });

  test("样本数低于 minSamples 不触发", () => {
    const small = buildResult({
      totalLlmCalls: 3,
      modelComparisons: [
        {
          ...buildResult().modelComparisons[0]!,
          totalCalls: 3,
          errorRate: 100,
          errorCount: 3,
          taskCompletionRate: 0,
        },
      ],
      errorCount: 3,
      errorRate: 100,
    });

    expect(diagnose(small)).toHaveLength(0);
  });

  test("建议按严重程度排序", () => {
    const result = buildResult({
      errorCount: 14,
      errorRate: 70,
      toolCallCount: 1,
      toolCallRate: 5,
      sessionCount: 4,
      toolUsage: new Map(),
      errors: ["boom"],
      modelComparisons: [
        {
          ...buildResult().modelComparisons[0]!,
          errorRate: 70,
          errorCount: 14,
        },
      ],
    });

    const suggestions = diagnose(result);
    const rank = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < suggestions.length; i++) {
      expect(rank[suggestions[i - 1]!.severity]).toBeLessThanOrEqual(rank[suggestions[i]!.severity]);
    }
  });
});

describe("runSelfOptimize 报告落盘", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fengagent-opt-"));

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("writeReport 写入指定目录 optimizations/ 并返回建议", () => {
    const result = buildResult({
      errorCount: 14,
      errorRate: 70,
      errors: ["boom"],
      sessions: sessionWithToolErrors("bash", "boom"),
      modelComparisons: [
        { ...buildResult().modelComparisons[0]!, errorRate: 70, errorCount: 14 },
      ],
    });

    const plan = runSelfOptimize(result, { writeReport: true, outputDir: join(tmp, "optimizations") });
    expect(plan.suggestions.length).toBeGreaterThan(0);
    expect(plan.logFile).toBe(result.logFile);

    const file = join(tmp, "optimizations", "optimization-2026-08-22.md");
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("# FengAgentCli 自优化建议报告");
    expect(content).toContain("opt-01");
  });

  test("无建议时报告提示健康", () => {
    process.env.FENG_DATA_DIR = tmp;
    const plan = runSelfOptimize(buildResult(), { writeReport: false });
    expect(plan.suggestions).toHaveLength(0);
  });
});
