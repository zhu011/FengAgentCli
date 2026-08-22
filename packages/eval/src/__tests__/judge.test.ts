/**
 * @fengagent/eval — LLM-judge 评测引擎测试
 */

import { describe, expect, test, mock } from "bun:test";
import {
  judgeSession,
  judgeAllSessions,
  mergeJudgeResults,
  buildSessionSummary,
} from "../judge.ts";
import type { SessionTrace, JudgeResult, AnalysisResult } from "../analyzer.ts";
import type { LLMClient, LLMResponse } from "@fengagent/llm";

/** 创建 mock LLM 客户端 */
function createMockClient(responseContent: string): LLMClient {
  const mockResponse: LLMResponse = {
    id: "mock-resp-1",
    model: "mock-judge",
    content: [{ type: "text", text: responseContent }],
    usage: { inputTokens: 100, outputTokens: 50 },
    finishReason: "end_turn",
  };
  return {
    generate: mock(() => Promise.resolve(mockResponse)),
    stream: async function* () {
      yield { type: "text-delta", text: responseContent };
      yield { type: "finish", finishReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 } };
    },
  } as unknown as LLMClient;
}

/** 创建测试用 SessionTrace */
function createTestSession(overrides?: Partial<SessionTrace>): SessionTrace {
  return {
    sessionId: "test-session-001",
    model: "deepseek-chat",
    requests: [
      {
        timestamp: "2026-08-21T10:00:00.000Z",
        sessionId: "test-session-001",
        direction: "request",
        model: "deepseek-chat",
        messages: [{ id: "msg-1", role: "user", content: [{ type: "text", text: "你好" }], createdAt: Date.now() }],
        tools: [],
        durationMs: 0,
        hasToolCalls: false,
      },
    ],
    responses: [
      {
        timestamp: "2026-08-21T10:00:01.000Z",
        sessionId: "test-session-001",
        direction: "response",
        model: "deepseek-chat",
        responseText: "你好！有什么可以帮助你的吗？",
        finishReason: "end_turn",
        durationMs: 1000,
        inputTokens: 10,
        outputTokens: 20,
        hasToolCalls: false,
      },
    ],
    totalDurationMs: 1000,
    totalInputTokens: 10,
    totalOutputTokens: 20,
    toolCallCount: 0,
    toolNames: [],
    errors: [],
    finishReasons: ["end_turn=1"],
    ...overrides,
  };
}

describe("LLM-judge 评测引擎", () => {
  test("judgeSession — 正常 JSON 响应解析", async () => {
    const mockJson = `{"completionScore": 85, "correctnessScore": 90, "conclusion": "completed", "note": "任务完成"}`;
    const client = createMockClient(mockJson);
    const session = createTestSession();

    const result = await judgeSession(session, { llmClient: client });

    expect(result.sessionId).toBe("test-session-001");
    expect(result.completionScore).toBe(85);
    expect(result.correctnessScore).toBe(90);
    expect(result.conclusion).toBe("completed");
    expect(result.note).toBe("任务完成");
  });

  test("judgeSession — markdown 代码块包裹的 JSON", async () => {
    const mockJson = "```json\n{\"completionScore\": 60, \"correctnessScore\": 70, \"conclusion\": \"partial\", \"note\": \"部分完成\"}\n```";
    const client = createMockClient(mockJson);

    const result = await judgeSession(createTestSession(), { llmClient: client });

    expect(result.completionScore).toBe(60);
    expect(result.correctnessScore).toBe(70);
    expect(result.conclusion).toBe("partial");
  });

  test("judgeSession — JSON 解析失败时降级为正则提取", async () => {
    const mockText = `评判结果：completionScore: 40, correctnessScore: 50, conclusion: "failed"`;
    const client = createMockClient(mockText);

    const result = await judgeSession(createTestSession(), { llmClient: client });

    expect(result.completionScore).toBe(40);
    expect(result.correctnessScore).toBe(50);
    expect(result.conclusion).toBe("failed");
    expect(result.note).toContain("降级");
  });

  test("judgeSession — LLM 空响应", async () => {
    const client = createMockClient("");

    const result = await judgeSession(createTestSession(), { llmClient: client });

    expect(result.completionScore).toBe(0);
    expect(result.correctnessScore).toBe(0);
    expect(result.conclusion).toBe("failed");
    expect(result.note).toBe("LLM 返回空响应");
  });

  test("judgeSession — LLM 调用异常时返回 failed", async () => {
    const errorClient: LLMClient = {
      generate: mock(() => Promise.reject(new Error("网络超时"))),
      stream: async function* () {},
    } as unknown as LLMClient;

    const result = await judgeSession(createTestSession(), { llmClient: errorClient });

    expect(result.completionScore).toBe(0);
    expect(result.conclusion).toBe("failed");
    expect(result.note).toContain("网络超时");
  });

  test("judgeSession — tool_misused 结论", async () => {
    const mockJson = `{"completionScore": 50, "correctnessScore": 30, "conclusion": "tool_misused", "note": "工具选型错误"}`;
    const client = createMockClient(mockJson);

    const result = await judgeSession(createTestSession(), { llmClient: client });

    expect(result.conclusion).toBe("tool_misused");
    expect(result.completionScore).toBe(50);
  });

  test("judgeSession — unsafe 结论", async () => {
    const mockJson = `{"completionScore": 0, "correctnessScore": 0, "conclusion": "unsafe", "note": "路径逃逸风险"}`;
    const client = createMockClient(mockJson);

    const result = await judgeSession(createTestSession(), { llmClient: client });

    expect(result.conclusion).toBe("unsafe");
  });

  test("judgeSession — inefficient 结论", async () => {
    const mockJson = `{"completionScore": 70, "correctnessScore": 80, "conclusion": "inefficient", "note": "步骤冗余"}`;
    const client = createMockClient(mockJson);

    const result = await judgeSession(createTestSession(), { llmClient: client });

    expect(result.conclusion).toBe("inefficient");
  });

  test("judgeSession — 分数超出 0-100 时 clamp", async () => {
    const mockJson = `{"completionScore": 150, "correctnessScore": -20, "conclusion": "completed"}`;
    const client = createMockClient(mockJson);

    const result = await judgeSession(createTestSession(), { llmClient: client });

    expect(result.completionScore).toBe(100);
    expect(result.correctnessScore).toBe(0);
  });

  test("judgeSession — 未知结论枚举降级为 failed", async () => {
    const mockJson = `{"completionScore": 50, "correctnessScore": 50, "conclusion": "unknown_status"}`;
    const client = createMockClient(mockJson);

    const result = await judgeSession(createTestSession(), { llmClient: client });

    expect(result.conclusion).toBe("failed");
  });

  test("judgeAllSessions — 多会话批量评判", async () => {
    const mockJson = `{"completionScore": 90, "correctnessScore": 95, "conclusion": "completed"}`;
    const client = createMockClient(mockJson);

    const sessions = [
      createTestSession({ sessionId: "sess-1" }),
      createTestSession({ sessionId: "sess-2" }),
      createTestSession({ sessionId: "sess-3" }),
    ];

    const results = await judgeAllSessions(sessions, { llmClient: client });

    expect(results).toHaveLength(3);
    expect(results[0]!.sessionId).toBe("sess-1");
    expect(results[1]!.sessionId).toBe("sess-2");
    expect(results[2]!.sessionId).toBe("sess-3");
    expect(results.every((r) => r.conclusion === "completed")).toBe(true);
  });

  test("mergeJudgeResults — 合并到 AnalysisResult", () => {
    const baseResult: AnalysisResult = {
      logFile: "test.jsonl",
      totalRecords: 10,
      sessionCount: 2,
      totalLlmCalls: 5,
      totalDurationMs: 10000,
      avgDurationMs: 2000,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      avgInputTokens: 200,
      avgOutputTokens: 100,
      toolCallCount: 3,
      toolCallRate: 0.3,
      toolUsage: new Map([["bash", 2], ["file-read", 1]]),
      errorCount: 0,
      errorRate: 0,
      errors: [],
      finishReasons: new Map([["end_turn", 4], ["tool_use", 1]]),
      sessions: [],
      models: ["deepseek-chat"],
      modelComparisons: [],
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      cacheHitRate: 0,
    };

    const judgeResults: JudgeResult[] = [
      { sessionId: "s1", completionScore: 90, correctnessScore: 95, conclusion: "completed" },
      { sessionId: "s2", completionScore: 40, correctnessScore: 50, conclusion: "failed" },
    ];

    const merged = mergeJudgeResults(baseResult, judgeResults);

    expect(merged.judgeResults).toBeDefined();
    expect(merged.judgeResults).toHaveLength(2);
    expect(merged.judgeResults![0]!.completionScore).toBe(90);
    // 原对象不被修改
    expect(baseResult.judgeResults).toBeUndefined();
  });

  test("buildSessionSummary — 包含会话关键信息", () => {
    const session = createTestSession({
      toolCallCount: 2,
      toolNames: ["bash", "file-read"],
      errors: ["timeout"],
      finishReasons: ["end_turn=1"],
    });

    const summary = buildSessionSummary(session, 50);

    expect(summary).toContain("test-session-001");
    expect(summary).toContain("deepseek-chat");
    expect(summary).toContain("bash");
    expect(summary).toContain("file-read");
    expect(summary).toContain("错误: 1");  // errors count shown
  });
});
