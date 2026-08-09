/**
 * @fengagent/server — 最终交付功能验证测试
 *
 * 覆盖 WebUI 模式的完整 API 端点验证：
 * - 健康检查端点
 * - 会话 CRUD 完整流程
 * - SSE 流式消息（文本 + 工具调用）
 * - 模型列表端点
 * - 权限请求/响应端点
 * - 会话导出端点
 * - 中断端点
 * - 错误处理（404、参数校验）
 * - 并发会话管理
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMEvent,
} from "@fengagent/llm";
import type { Config, AgentEvent } from "@fengagent/core";
import { createToolRegistry, createToolExecutor } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { Agent } from "@fengagent/agent";
import { SessionStore } from "@fengagent/agent/session";
import { createApp } from "../server.ts";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ──────────────────────────────────────────────
// Mock LLM Client
// ──────────────────────────────────────────────

class MockLLMClient implements LLMClient {
  private responses: LLMEvent[][] = [];
  private callIndex = 0;
  public generateCalls: LLMRequest[] = [];

  setResponses(responses: LLMEvent[][]): void {
    this.responses = responses;
    this.callIndex = 0;
    this.generateCalls = [];
  }

  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    const events = this.responses[this.callIndex] ?? [];
    this.callIndex++;
    for (const event of events) {
      yield event;
    }
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.generateCalls.push(request);
    return {
      id: `mock-gen-${this.generateCalls.length}`,
      model: request.model,
      content: [{ type: "text", text: "摘要内容。" }],
      usage: { inputTokens: 100, outputTokens: 50 },
      finishReason: "end_turn",
    };
  }
}

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

function createTestConfig(overrides?: Partial<Config>): Config {
  return {
    model: "test-model",
    smallModel: "test-small-model",
    provider: "anthropic",
    maxTokens: 4096,
    temperature: 1.0,
    contextWindow: 200_000,
    compactThreshold: 0.85,
    compactKeepTokens: 8000,
    compactBuffer: 20_000,
    disableCompact: false,
    toolOutputMaxChars: 2000,
    serverPort: 3000,
    serverHost: "127.0.0.1",
    corsOrigin: "*",
    autoApproveTools: true,
    allowedTools: "*",
    bashTimeout: 120_000,
    maxToolConcurrency: 10,
    maxTurns: 50,
    logLevel: "info",
    dataDir: "~/.fengagent",
    ...overrides,
  };
}

let dbCounter = 0;
let tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), `feng-verify-${dbCounter++}-`));
  tempDirs.push(dir);
  return join(dir, "test.db");
}

function createTestAgent(
  mockLLM: MockLLMClient,
  overrides?: Partial<Config>,
): { agent: Agent; mockLLM: MockLLMClient; config: Config } {
  const config = createTestConfig(overrides);
  const dbPath = createTempDbPath();

  const toolRegistry = createToolRegistry();
  const echoTool = {
    name: "echo",
    description: "Echo back the input text",
    inputSchema: z.object({ text: z.string() }),
    async execute(input: { text: string }) {
      return { content: `Echo: ${input.text}` };
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  };
  toolRegistry.register(echoTool);

  const toolExecutor = createToolExecutor();
  const contextManager = createContextManager({
    config: {
      contextWindow: config.contextWindow,
      compactThreshold: config.compactThreshold,
      compactKeepTokens: config.compactKeepTokens,
      disableCompact: config.disableCompact,
      smallModel: config.smallModel,
    },
    summaryGenerator: mockLLM,
    systemContextOptions: { workdir: "." },
  });

  const sessionStore = new SessionStore(dbPath);

  const agent = new Agent({
    llmClient: mockLLM,
    toolRegistry,
    toolExecutor,
    contextManager,
    config,
    workdir: ".",
    sessionStore,
  });

  return { agent, mockLLM, config };
}

function textDelta(text: string): LLMEvent {
  return { type: "text-delta", text };
}
function toolCall(id: string, name: string, input: unknown): LLMEvent {
  return { type: "tool-call", id, name, input };
}
function usageEvent(inp: number, out: number): LLMEvent {
  return { type: "usage", inputTokens: inp, outputTokens: out };
}
function finish(reason: "end_turn" | "tool_use" | "max_tokens"): LLMEvent {
  return { type: "finish", reason };
}

async function parseSSEResponse(res: Response): Promise<AgentEvent[]> {
  const text = await res.text();
  const events: AgentEvent[] = [];
  const frames = text.split("\n\n");
  for (const frame of frames) {
    const lines = frame.trim().split("\n");
    let dataLine = "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        dataLine += line.slice(6);
      }
    }
    if (dataLine) {
      try {
        events.push(JSON.parse(dataLine) as AgentEvent);
      } catch {
        // skip non-JSON frames
      }
    }
  }
  return events;
}

// ──────────────────────────────────────────────
// 测试：WebUI API 完整端点验证
// ──────────────────────────────────────────────

describe("WebUI 交付验证：API 端点全覆盖", () => {
  let mockLLM: MockLLMClient;
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(() => {
    mockLLM = new MockLLMClient();
    mockLLM.setResponses([
      [textDelta("Hello!"), usageEvent(10, 5), finish("end_turn")],
    ]);

    const config = createTestConfig();
    const { agent } = createTestAgent(mockLLM);

    const result = createApp({
      config,
      createAgent: () => agent,
    });
    app = result.app;
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tempDirs = [];
  });

  test("GET /api/health 返回 ok 状态和时间戳", async () => {
    const res = await app.fetch(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.timestamp).toBeTypeOf("number");
    expect(json.timestamp).toBeGreaterThan(0);
  });

  test("POST /api/sessions 创建带标题的会话", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "验证会话" }),
      }),
    );
    expect(res.status).toBe(201);
    const session = await res.json();
    expect(session.id).toBeTruthy();
    expect(session.title).toBe("验证会话");
    expect(session.messages).toEqual([]);
    expect(session.createdAt).toBeTypeOf("number");
  });

  test("POST /api/sessions 无标题时使用默认标题", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(201);
    const session = await res.json();
    expect(session.id).toBeTruthy();
    expect(session.title).toBeTruthy();
  });

  test("POST /api/sessions 无 body 也能创建会话", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(201);
    const session = await res.json();
    expect(session.id).toBeTruthy();
  });

  test("GET /api/sessions 列出所有会话", async () => {
    await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "A" }),
      }),
    );
    await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "B" }),
      }),
    );

    const res = await app.fetch(new Request("http://localhost/api/sessions"));
    expect(res.status).toBe(200);
    const sessions = await res.json();
    expect(sessions.length).toBe(2);
    expect(sessions.some((s: { title: string }) => s.title === "A")).toBe(true);
    expect(sessions.some((s: { title: string }) => s.title === "B")).toBe(true);
  });

  test("GET /api/sessions/:id 获取会话详情", async () => {
    const createRes = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "详情测试" }),
      }),
    );
    const session = await createRes.json();

    const res = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}`),
    );
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.id).toBe(session.id);
    expect(detail.title).toBe("详情测试");
  });

  test("GET /api/sessions/:id 不存在返回 404", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/sessions/nonexistent-id"),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeDefined();
    expect(json.error).toContain("not found");
  });

  test("POST /api/sessions/:id/messages SSE 流包含完整事件序列", async () => {
    const createRes = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const session = await createRes.json();

    const msgRes = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "你好" }),
      }),
    );

    expect(msgRes.status).toBe(200);
    expect(msgRes.headers.get("content-type")).toContain("text/event-stream");

    const events = await parseSSEResponse(msgRes);
    const types = events.map((e) => e.type);

    expect(types).toContain("session-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("usage");
    expect(types).toContain("turn-end");
    expect(types).toContain("session-end");

    const textDeltas = events.filter(
      (e): e is Extract<AgentEvent, { type: "text-delta" }> =>
        e.type === "text-delta",
    );
    const fullText = textDeltas.map((e) => e.text).join("");
    expect(fullText).toBe("Hello!");
  });

  test("POST /api/sessions/:id/messages content 为数组格式也能处理", async () => {
    const createRes = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const session = await createRes.json();

    const msgRes = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: [{ text: "数组消息" }] }),
      }),
    );

    expect(msgRes.status).toBe(200);
    const events = await parseSSEResponse(msgRes);
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
  });

  test("POST /api/sessions/:id/messages 缺少 content 返回错误事件", async () => {
    const createRes = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const session = await createRes.json();

    const msgRes = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    const text = await msgRes.text();
    expect(text).toContain("error");
    expect(text).toContain("content is required");
  });

  test("POST /api/sessions/:id/messages 不存在的会话返回错误", async () => {
    const msgRes = await app.fetch(
      new Request("http://localhost/api/sessions/nonexistent/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "test" }),
      }),
    );

    const text = await msgRes.text();
    expect(text).toContain("error");
  });

  test("POST /api/sessions/:id/messages 可指定 model", async () => {
    const createRes = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const session = await createRes.json();

    const msgRes = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "test", model: "custom-model" }),
      }),
    );

    expect(msgRes.status).toBe(200);
    const events = await parseSSEResponse(msgRes);
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
  });

  test("GET /api/models 返回模型列表", async () => {
    const res = await app.fetch(new Request("http://localhost/api/models"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.models).toBeDefined();
    expect(Array.isArray(json.models)).toBe(true);
    expect(json.models.length).toBeGreaterThanOrEqual(2);

    const defaultModel = json.models.find((m: { isDefault: boolean }) => m.isDefault);
    expect(defaultModel).toBeDefined();
    expect(defaultModel.id).toBe("test-model");
  });

  test("DELETE /api/sessions/:id 销毁会话后 GET 返回 404", async () => {
    const createRes = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "待删除" }),
      }),
    );
    const session = await createRes.json();

    const delRes = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}`, {
        method: "DELETE",
      }),
    );
    expect(delRes.status).toBe(200);
    const json = await delRes.json();
    expect(json.deleted).toBe(true);

    const getRes = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}`),
    );
    expect(getRes.status).toBe(404);
  });

  test("GET /api/sessions/:id/export 导出会话为 JSON", async () => {
    const createRes = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "导出测试" }),
      }),
    );
    const session = await createRes.json();

    const exportRes = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/export`),
    );
    expect(exportRes.status).toBe(200);
    const text = await exportRes.text();
    expect(text).toBeTruthy();

    const exported = JSON.parse(text);
    expect(exported.id).toBe(session.id);
  });

  test("GET /api/sessions/:id/export 不存在的会话返回 404", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/sessions/nonexistent/export"),
    );
    expect(res.status).toBe(404);
  });

  test("POST /api/sessions/:id/interrupt 无运行中任务返回 404", async () => {
    const createRes = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const session = await createRes.json();

    const res = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/interrupt`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.interrupted).toBe(false);
  });

  test("GET /api/sessions/:id/permissions 返回空权限列表", async () => {
    const createRes = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const session = await createRes.json();

    const res = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/permissions`),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json)).toBe(true);
  });

  test("CORS 头正确设置", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/health", {
        method: "OPTIONS",
      }),
    );
    // CORS 中间件应处理 OPTIONS 请求
    const corsHeader = res.headers.get("access-control-allow-origin");
    expect(corsHeader).toBeTruthy();
  });
});

// ──────────────────────────────────────────────
// 测试：WebUI 工具调用流式验证
// ──────────────────────────────────────────────

describe("WebUI 交付验证：工具调用 SSE 流", () => {
  let mockLLM: MockLLMClient;
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(() => {
    mockLLM = new MockLLMClient();
    const config = createTestConfig();
    const { agent } = createTestAgent(mockLLM);
    const result = createApp({ config, createAgent: () => agent });
    app = result.app;
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
    tempDirs = [];
  });

  test("SSE 流包含工具调用事件", async () => {
    mockLLM.setResponses([
      [toolCall("call-1", "echo", { text: "验证工具" }), finish("tool_use")],
      [textDelta("工具结果已收到"), usageEvent(20, 10), finish("end_turn")],
    ]);

    const createRes = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const session = await createRes.json();

    const msgRes = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "调用 echo 工具" }),
      }),
    );

    const events = await parseSSEResponse(msgRes);
    const types = events.map((e) => e.type);

    expect(types).toContain("tool-call-start");
    expect(types).toContain("tool-call-result");
    expect(types).toContain("text-delta");

    const toolStart = events.find(
      (e): e is Extract<AgentEvent, { type: "tool-call-start" }> =>
        e.type === "tool-call-start",
    );
    expect(toolStart).toBeDefined();
    expect(toolStart!.name).toBe("echo");
    expect(toolStart!.input).toEqual({ text: "验证工具" });
  });
});

// ──────────────────────────────────────────────
// 测试：并发会话管理
// ──────────────────────────────────────────────

describe("WebUI 交付验证：并发会话", () => {
  let mockLLM: MockLLMClient;
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(() => {
    mockLLM = new MockLLMClient();
    mockLLM.setResponses([
      [textDelta("并发响应"), finish("end_turn")],
    ]);
    const config = createTestConfig();
    const { agent } = createTestAgent(mockLLM);
    const result = createApp({ config, createAgent: () => agent });
    app = result.app;
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
    tempDirs = [];
  });

  test("创建多个会话互不干扰", async () => {
    const sessions: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: `并发会话 ${i}` }),
        }),
      );
      const session = await res.json();
      sessions.push(session.id);
    }

    // 验证每个会话都能独立获取
    for (const id of sessions) {
      const res = await app.fetch(
        new Request(`http://localhost/api/sessions/${id}`),
      );
      expect(res.status).toBe(200);
      const detail = await res.json();
      expect(detail.id).toBe(id);
    }

    // 验证列表包含全部会话
    const listRes = await app.fetch(new Request("http://localhost/api/sessions"));
    const list = await listRes.json();
    expect(list.length).toBe(5);
  });
});
