/**
 * @fengagent/server — 可观测性 + 评测模块路由测试
 *
 * 覆盖：
 * - GET /api/observability/traces（列表）
 * - GET /api/observability/traces/:date（指标分析，Map 序列化）
 * - GET /api/observability/traces/:date/callchain（调用链重建 + 工具结果回填）
 * - GET /api/eval/overview（报告/建议/测试集清单）
 * - GET /api/eval/reports/:date、/optimizations/:date、/testsets/:name
 * - 日期格式校验与 404 行为
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server.ts";
import { buildCallChains, extractLiveSession } from "../routes/observability.ts";
import type { TraceRecord } from "@fengagent/eval";

// ──────────────────────────────────────────────
// Fixture：临时数据根（llm-trace + 评测报告 + 优化建议 + 测试集）
// ──────────────────────────────────────────────

const FIXTURE_DATE = "2026-08-22";

const TRACE_RECORDS: TraceRecord[] = [
  {
    timestamp: "2026-08-22T10:00:00.000Z",
    sessionId: "sess-1",
    direction: "request",
    model: "model-a",
    hasToolCalls: false,
    messages: [
      { role: "user", content: [{ type: "text", text: "分析项目结构" }] },
    ],
    tools: ["bash"],
  },
  {
    timestamp: "2026-08-22T10:00:03.000Z",
    sessionId: "sess-1",
    direction: "response",
    model: "model-a",
    durationMs: 3000,
    inputTokens: 500,
    outputTokens: 100,
    cacheReadTokens: 100,
    cacheCreationTokens: 50,
    hasToolCalls: true,
    toolCalls: [{ name: "bash", input: { command: "ls -la" } }],
    finishReason: "tool_use",
    error: null,
    responseText: "我将运行 bash 查看目录",
  },
  {
    timestamp: "2026-08-22T10:00:05.000Z",
    sessionId: "sess-1",
    direction: "request",
    model: "model-a",
    hasToolCalls: false,
    messages: [
      { role: "user", content: [{ type: "text", text: "分析项目结构" }] },
      { role: "assistant", content: [{ type: "text", text: "我将运行 bash" }] },
      { role: "user", content: [{ type: "text", text: "继续" }] },
    ],
    tools: ["bash"],
  },
  {
    timestamp: "2026-08-22T10:00:06.000Z",
    sessionId: "sess-1",
    direction: "response",
    model: "model-a",
    durationMs: 1000,
    inputTokens: 600,
    outputTokens: 200,
    hasToolCalls: false,
    finishReason: "end_turn",
    error: null,
    responseText: "分析完成",
  },
  {
    timestamp: "2026-08-22T10:01:00.000Z",
    sessionId: "sess-2",
    direction: "request",
    model: "model-b",
    hasToolCalls: false,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
  },
  {
    timestamp: "2026-08-22T10:01:01.000Z",
    sessionId: "sess-2",
    direction: "response",
    model: "model-b",
    durationMs: 1000,
    inputTokens: 50,
    outputTokens: 10,
    hasToolCalls: false,
    finishReason: "end_turn",
    error: null,
    responseText: "hi",
  },
];

const EVAL_REPORT_MD = `# 评测报告 ${FIXTURE_DATE}

## 概览
- 会话数: 2
- LLM 调用: 3
`;

const OPTIMIZATION_MD = `# 自优化建议 ${FIXTURE_DATE}

## 建议
1. 任务完成率偏低，建议优化系统提示词
`;

const TESTSET_JSON = JSON.stringify(
  {
    name: "demo-bench",
    description: "演示测试集（AgentBench 风格）",
    items: [
      { input: "任务1", expected: "结果1" },
      { input: "任务2", expected: "结果2" },
    ],
  },
  null,
  2,
);

let dataRoot: string;
let app: ReturnType<typeof createApp>["app"];

/** 模拟实时会话消息（用于工具结果回填） */
const liveMessages = [
  {
    role: "assistant",
    content: [
      { type: "tool-use", id: "tu-1", name: "bash", input: { command: "ls -la" } },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool-result", toolUseId: "tu-1", content: "src/  packages/  docs/", isError: false }],
  },
];

beforeAll(() => {
  dataRoot = join(tmpdir(), `fengagent-obs-test-${Date.now()}`);
  const logsDir = join(dataRoot, "logs");
  const optimizationsDir = join(dataRoot, "optimizations");
  const testsetsDir = join(dataRoot, "testsets");
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(optimizationsDir, { recursive: true });
  mkdirSync(testsetsDir, { recursive: true });

  writeFileSync(
    join(logsDir, `llm-trace-${FIXTURE_DATE}.jsonl`),
    TRACE_RECORDS.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );
  writeFileSync(join(logsDir, `eval-report-${FIXTURE_DATE}.md`), EVAL_REPORT_MD, "utf-8");
  writeFileSync(join(optimizationsDir, `optimization-${FIXTURE_DATE}.md`), OPTIMIZATION_MD, "utf-8");
  writeFileSync(join(testsetsDir, "demo-bench.json"), TESTSET_JSON, "utf-8");

  // 数据根通过环境变量注入（resolveLogsDir 优先级最高）
  process.env.FENG_DATA_DIR = dataRoot;

  const { app: createdApp } = createApp({
    config: {
      model: "test-model",
      smallModel: "test-small-model",
      provider: "anthropic",
      maxTokens: 4096,
      temperature: 1.0,
      contextWindow: 200_000,
      serverHost: "127.0.0.1",
      serverPort: 0,
      corsOrigin: "*",
    } as never,
    createAgent: () => ({}) as never,
    sessionStore: undefined,
  });
  app = createdApp;
});

afterAll(() => {
  delete process.env.FENG_DATA_DIR;
  rmSync(dataRoot, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// 单元测试：调用链重建
// ──────────────────────────────────────────────

describe("buildCallChains", () => {
  test("按会话重建 用户→LLM→工具 调用链", () => {
    const chains = buildCallChains(TRACE_RECORDS);
    const sess1 = chains.find((c) => c.sessionId === "sess-1");
    expect(sess1).toBeDefined();
    expect(sess1!.steps.map((s) => s.kind)).toEqual(["user", "llm", "user", "llm"]);
    expect(sess1!.toolCallCount).toBe(1);
    expect(sess1!.errorCount).toBe(0);

    const llm0 = sess1!.steps[1]!;
    expect(llm0.llm?.durationMs).toBe(3000);
    expect(llm0.llm?.finishReason).toBe("tool_use");
    expect(llm0.tools).toHaveLength(1);
    expect(llm0.tools[0]!.name).toBe("bash");
    // 工具耗时估算 = 本次回复 → 下一次记录
    expect(llm0.tools[0]!.durationMs).toBe(2000);
  });

  test("实时会话消息可回填工具返回结果", () => {
    const chains = buildCallChains(TRACE_RECORDS, () => extractLiveSession(liveMessages as never));
    const sess1 = chains.find((c) => c.sessionId === "sess-1");
    const tool = sess1!.steps[1]!.tools[0]!;
    expect(tool.result?.content).toContain("src/");
    expect(tool.result?.isError).toBe(false);
  });

  test("无配对 request 的孤立 response 不崩溃", () => {
    const orphan: TraceRecord[] = [
      { timestamp: "t1", sessionId: "x", direction: "response", model: "m", hasToolCalls: false },
    ];
    const chains = buildCallChains(orphan);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.steps).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────
// 可观测性路由
// ──────────────────────────────────────────────

describe("GET /api/observability", () => {
  test("traces 列出日志文件与规模", async () => {
    const res = await app.request("/api/observability/traces");
    expect(res.status).toBe(200);
    const traces = (await res.json()) as Array<Record<string, unknown>>;
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ date: FIXTURE_DATE, records: 6, sessions: 2 });
    expect((traces[0]!.models as string[]).sort()).toEqual(["model-a", "model-b"]);
  });

  test("traces/:date 返回序列化分析结果（Map → 对象）", async () => {
    const res = await app.request(`/api/observability/traces/${FIXTURE_DATE}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { analysis: Record<string, unknown> };
    expect(body.analysis.sessionCount).toBe(2);
    expect(body.analysis.totalLlmCalls).toBe(3);
    expect(body.analysis.errorRate).toBe(0);
    // Map 已序列化为普通对象
    expect(body.analysis.finishReasons).toEqual({ tool_use: 1, end_turn: 2 });
    expect(body.analysis.toolUsage).toEqual({ bash: 1 });
    expect(body.analysis.modelComparisons).toHaveLength(2);
  });

  test("traces/:date 对不存在的日期返回 404", async () => {
    const res = await app.request("/api/observability/traces/1999-01-01");
    expect(res.status).toBe(404);
  });

  test("traces/:date 对非法日期返回 404（防路径穿越）", async () => {
    const res = await app.request("/api/observability/traces/..%2F..%2Fetc");
    expect(res.status).toBe(404);
  });

  test("traces/:date/callchain 返回完整调用链", async () => {
    const res = await app.request(`/api/observability/traces/${FIXTURE_DATE}/callchain`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ sessionId: string; steps: unknown[] }> };
    expect(body.sessions).toHaveLength(2);
    const sess1 = body.sessions.find((s) => s.sessionId === "sess-1");
    expect(sess1!.steps).toHaveLength(4);
  });
});

// ──────────────────────────────────────────────
// 评测模块路由
// ──────────────────────────────────────────────

describe("GET /api/eval", () => {
  test("overview 返回报告/建议/测试集清单", async () => {
    const res = await app.request("/api/eval/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reports: Array<{ date: string }>;
      optimizations: Array<{ date: string }>;
      testsets: Array<{ name: string; records: number; valid: boolean }>;
    };
    expect(body.reports.map((r) => r.date)).toContain(FIXTURE_DATE);
    expect(body.optimizations.map((o) => o.date)).toContain(FIXTURE_DATE);
    expect(body.testsets).toHaveLength(1);
    expect(body.testsets[0]).toMatchObject({ name: "demo-bench", records: 2, valid: true });
  });

  test("reports/:date 返回 Markdown 内容", async () => {
    const res = await app.request(`/api/eval/reports/${FIXTURE_DATE}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toContain("评测报告");
  });

  test("optimizations/:date 返回 Markdown 内容", async () => {
    const res = await app.request(`/api/eval/optimizations/${FIXTURE_DATE}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toContain("自优化建议");
  });

  test("testsets/:name 返回原始 JSON", async () => {
    const res = await app.request("/api/eval/testsets/demo-bench");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });

  test("缺失资源返回 404，非法日期返回 400", async () => {
    expect((await app.request("/api/eval/reports/1999-01-01")).status).toBe(404);
    expect((await app.request("/api/eval/reports/not-a-date")).status).toBe(400);
    expect((await app.request("/api/eval/testsets/..%2F..%2Fsecret")).status).toBe(400);
  });
});
