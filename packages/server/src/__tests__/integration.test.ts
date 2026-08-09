/**
 * @fengagent/server — 端到端集成测试
 *
 * 覆盖 Stage 3c 要求的五大集成场景：
 * 1. CLI 模式：agent.prompt → 流式输出 → 工具调用
 * 2. WebUI 模式：HTTP API → 创建会话 → SSE 流
 * 3. 会话持久化：创建 → 对话 → 保存 → 加载 → 恢复
 * 4. 上下文压缩：长对话 → 触发压缩 → 验证摘要事件
 * 5. 权限系统：工具调用 → 权限请求 → 批准/拒绝
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMEvent,
} from "@fengagent/llm";
import type {
  Config,
  AgentEvent,
} from "@fengagent/core";
import { createToolRegistry, createToolExecutor } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { Agent } from "@fengagent/agent";
import { SessionStore } from "@fengagent/agent/session";
import { createApp } from "../server.ts";
import { SessionManager } from "../session-manager.ts";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ──────────────────────────────────────────────
// Mock LLM Client（复用项目既有模式）
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
      content: [{ type: "text", text: "这是压缩摘要。" }],
      usage: { inputTokens: 100, outputTokens: 50 },
      finishReason: "end_turn",
    };
  }
}

// ──────────────────────────────────────────────
// 测试辅助
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
function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), `feng-integration-${dbCounter++}-`));
  return join(dir, "test.db");
}

let tempDirs: string[] = [];

function createTestAgent(
  mockLLM: MockLLMClient,
  overrides?: Partial<Config>,
): { agent: Agent; mockLLM: MockLLMClient; config: Config; dbPath: string } {
  const config = createTestConfig(overrides);
  const dbPath = createTempDbPath();
  tempDirs.push(dbPath);

  const toolRegistry = createToolRegistry();
  // 注册 echo 工具（只读、并发安全）
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
  // 注册 destructive 工具（用于权限测试）
  const dangerTool = {
    name: "danger",
    description: "A destructive tool for testing permissions",
    inputSchema: z.object({ action: z.string() }),
    async execute(input: { action: string }) {
      return { content: `Executed: ${input.action}` };
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false,
    checkPermissions() {
      return { decision: "ask" as const, message: "This is destructive" };
    },
  };
  toolRegistry.register(dangerTool);

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

  return { agent, mockLLM, config, dbPath };
}

/** 收集所有 AgentEvent */
async function collectEvents(
  gen: AsyncGenerator<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// LLM 事件构建器
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

/** 从 SSE Response body 中解析 AgentEvent 列表 */
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
// 1. CLI 模式集成测试
// ──────────────────────────────────────────────

describe("集成测试：CLI 模式", () => {
  let mockLLM: MockLLMClient;
  let agent: Agent;

  beforeEach(() => {
    mockLLM = new MockLLMClient();
    const result = createTestAgent(mockLLM);
    agent = result.agent;
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(join(dir, ".."), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tempDirs = [];
  });

  test("输入消息 → 流式文本输出 → 验证 text-delta 事件", async () => {
    mockLLM.setResponses([
      [
        textDelta("Hello"),
        textDelta(", "),
        textDelta("world!"),
        usageEvent(10, 5),
        finish("end_turn"),
      ],
    ]);

    const events = await collectEvents(agent.prompt("Hi"));

    // 验证事件序列
    const types = events.map((e) => e.type);
    expect(types).toContain("session-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("usage");
    expect(types).toContain("turn-end");
    expect(types).toContain("session-end");

    // 验证文本内容
    const textDeltas = events.filter(
      (e): e is Extract<AgentEvent, { type: "text-delta" }> =>
        e.type === "text-delta",
    );
    const fullText = textDeltas.map((e) => e.text).join("");
    expect(fullText).toBe("Hello, world!");
  });

  test("输入消息 → 工具调用 → 工具执行 → LLM 二次回复", async () => {
    mockLLM.setResponses([
      [
        // 第一次 LLM 调用：发起工具调用
        toolCall("call-1", "echo", { text: "test-input" }),
        finish("tool_use"),
      ],
      [
        // 第二次 LLM 调用：基于工具结果回复
        textDelta("Tool returned: "),
        textDelta("Echo: test-input"),
        usageEvent(20, 10),
        finish("end_turn"),
      ],
    ]);

    const events = await collectEvents(agent.prompt("Use echo tool"));

    const types = events.map((e) => e.type);
    expect(types).toContain("tool-call-start");
    expect(types).toContain("tool-call-result");
    expect(types).toContain("turn-end");

    // 验证工具调用
    const toolStart = events.find(
      (e): e is Extract<AgentEvent, { type: "tool-call-start" }> =>
        e.type === "tool-call-start",
    );
    expect(toolStart).toBeDefined();
    expect(toolStart!.name).toBe("echo");
    expect(toolStart!.input).toEqual({ text: "test-input" });

    // 验证工具结果
    const toolResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool-call-result" }> =>
        e.type === "tool-call-result",
    );
    expect(toolResult).toBeDefined();
    // isError is optional; undefined means no error
    expect(toolResult!.result.isError ?? false).toBe(false);
  });

  test("流式输出验证 turn-end reason 为 end_turn", async () => {
    mockLLM.setResponses([
      [textDelta("Done."), finish("end_turn")],
    ]);

    const events = await collectEvents(agent.prompt("Test"));

    const turnEnd = events.find(
      (e): e is Extract<AgentEvent, { type: "turn-end" }> =>
        e.type === "turn-end",
    );
    expect(turnEnd).toBeDefined();
    expect(turnEnd!.reason).toBe("end_turn");
  });
});

// ──────────────────────────────────────────────
// 2. WebUI 模式集成测试（HTTP API + SSE）
// ──────────────────────────────────────────────

describe("集成测试：WebUI 模式（HTTP API + SSE）", () => {
  let mockLLM: MockLLMClient;
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(() => {
    mockLLM = new MockLLMClient();
    mockLLM.setResponses([
      [textDelta("Hello from server!"), usageEvent(15, 8), finish("end_turn")],
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
        rmSync(join(dir, ".."), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tempDirs = [];
  });

  test("GET /api/health — 健康检查", async () => {
    const res = await app.fetch(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.timestamp).toBeTypeOf("number");
  });

  test("POST /api/sessions — 创建会话", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Test Session" }),
      }),
    );
    expect(res.status).toBe(201);
    const session = await res.json();
    expect(session.id).toBeTruthy();
    expect(session.title).toBe("Test Session");
    expect(session.messages).toEqual([]);
  });

  test("GET /api/sessions — 列出会话", async () => {
    // 创建两个会话
    await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Session A" }),
      }),
    );
    await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Session B" }),
      }),
    );

    const res = await app.fetch(new Request("http://localhost/api/sessions"));
    expect(res.status).toBe(200);
    const sessions = await res.json();
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  });

  test("POST /api/sessions/:id/messages — 发送消息并接收 SSE 流", async () => {
    // 创建会话
    const createRes = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const session = await createRes.json();

    // 发送消息
    const msgRes = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Hello" }),
      }),
    );

    expect(msgRes.status).toBe(200);
    expect(msgRes.headers.get("content-type")).toContain("text/event-stream");

    // 解析 SSE 事件
    const events = await parseSSEResponse(msgRes);
    const types = events.map((e) => e.type);

    expect(types).toContain("session-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("session-end");

    // 验证文本内容
    const textDeltas = events.filter(
      (e): e is Extract<AgentEvent, { type: "text-delta" }> =>
        e.type === "text-delta",
    );
    const fullText = textDeltas.map((e) => e.text).join("");
    expect(fullText).toBe("Hello from server!");
  });

  test("GET /api/sessions/:id — 获取会话详情", async () => {
    const createRes = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Detail Test" }),
      }),
    );
    const session = await createRes.json();

    const res = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}`),
    );
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.id).toBe(session.id);
    expect(detail.title).toBe("Detail Test");
  });

  test("GET /api/sessions/:id — 不存在的会话返回 404", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/sessions/nonexistent"),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeDefined();
  });

  test("POST /api/sessions/:id/messages — 缺少 content 返回错误", async () => {
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

    // SSE 流中应包含 error 事件（或 HTTP 响应体中包含 error 信息）
    const text = await msgRes.text();
    expect(text).toContain("error");
    expect(text).toContain("content is required");
  });

  test("GET /api/models — 获取模型列表", async () => {
    const res = await app.fetch(new Request("http://localhost/api/models"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.models).toBeDefined();
    expect(Array.isArray(json.models)).toBe(true);
  });

  test("DELETE /api/sessions/:id — 销毁会话", async () => {
    const createRes = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
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

    // 验证已删除
    const getRes = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}`),
    );
    expect(getRes.status).toBe(404);
  });

  test("POST /api/sessions/:id/interrupt — 中断不存在的运行返回 404", async () => {
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
});

// ──────────────────────────────────────────────
// 3. 会话持久化集成测试
// ──────────────────────────────────────────────

describe("集成测试：会话持久化", () => {
  let mockLLM: MockLLMClient;
  let agent: Agent;
  let dbPath: string;

  beforeEach(() => {
    mockLLM = new MockLLMClient();
    const result = createTestAgent(mockLLM);
    agent = result.agent;
    dbPath = result.dbPath;
  });

  afterEach(() => {
    tempDirs = [];
  });

  test("创建会话 → 对话 → 保存 → 重新加载 → 验证消息历史", async () => {
    mockLLM.setResponses([
      [textDelta("Response 1"), finish("end_turn")],
    ]);

    // 第一次对话
    const events = await collectEvents(agent.prompt("Hello"));
    const sessionStart = events.find(
      (e): e is Extract<AgentEvent, { type: "session-start" }> =>
        e.type === "session-start",
    );
    const sessionId = sessionStart!.session.id;

    // 从存储重新加载会话
    const loaded = agent.loadSession(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(sessionId);
    // 应包含用户消息 + 助手消息
    expect(loaded!.messages.length).toBeGreaterThanOrEqual(2);

    // 验证用户消息
    const userMsg = loaded!.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();

    // 验证助手消息
    const assistantMsg = loaded!.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
  });

  test("恢复已有会话 → 继续对话 → 验证历史完整性", async () => {
    mockLLM.setResponses([
      [textDelta("First response"), finish("end_turn")],
      [textDelta("Second response"), finish("end_turn")],
    ]);

    // 第一次对话
    const events1 = await collectEvents(agent.prompt("First message"));
    const sessionStart = events1.find(
      (e): e is Extract<AgentEvent, { type: "session-start" }> =>
        e.type === "session-start",
    );
    const sessionId = sessionStart!.session.id;

    // 恢复会话并继续对话
    const loaded = agent.loadSession(sessionId)!;
    await collectEvents(agent.prompt("Second message", loaded));

    // 再次加载验证消息历史
    const reloaded = agent.loadSession(sessionId)!;
    // 第一轮 2 条 + 第二轮 2 条 = 4 条
    expect(reloaded.messages.length).toBe(4);

    // 验证消息顺序
    expect(reloaded.messages[0]?.role).toBe("user");
    expect(reloaded.messages[1]?.role).toBe("assistant");
    expect(reloaded.messages[2]?.role).toBe("user");
    expect(reloaded.messages[3]?.role).toBe("assistant");
  });

  test("列出会话 → 验证元信息", async () => {
    mockLLM.setResponses([
      [textDelta("Response"), finish("end_turn")],
    ]);

    await collectEvents(agent.prompt("Test message"));

    const sessions = agent.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    const meta = sessions.find((s) => s.title !== "");
    expect(meta).toBeDefined();
    expect(meta!.id).toBeTruthy();
    expect(meta!.createdAt).toBeTypeOf("number");
    expect(meta!.updatedAt).toBeTypeOf("number");
  });

  test("关闭后重新打开数据库 → 会话数据持久", async () => {
    mockLLM.setResponses([
      [textDelta("Persisted response"), finish("end_turn")],
    ]);

    // 对话
    const events = await collectEvents(agent.prompt("Save me"));
    const sessionStart = events.find(
      (e): e is Extract<AgentEvent, { type: "session-start" }> =>
        e.type === "session-start",
    );
    const sessionId = sessionStart!.session.id;

    // 使用新的 SessionStore 打开同一数据库
    const newStore = new SessionStore(dbPath);
    const loaded = newStore.loadSession(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBeGreaterThanOrEqual(2);
    newStore.close();
  });
});

// ──────────────────────────────────────────────
// 4. 上下文压缩集成测试
// ──────────────────────────────────────────────

describe("集成测试：上下文压缩", () => {
  let mockLLM: MockLLMClient;
  let agent: Agent;

  beforeEach(() => {
    mockLLM = new MockLLMClient();
  });

  afterEach(() => {
    tempDirs = [];
  });

  test("长对话 → 触发压缩 → 验证 compaction 事件", async () => {
    // 使用极小的 contextWindow 触发压缩
    const config = createTestConfig({
      contextWindow: 200, // 极小窗口
      compactThreshold: 0.5, // 100 tokens 即触发
      compactKeepTokens: 50, // 保留少量 token
      smallModel: "test-small-model",
    });

    const dbPath = createTempDbPath();
    tempDirs.push(dbPath);

    const toolRegistry = createToolRegistry();
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
    agent = new Agent({
      llmClient: mockLLM,
      toolRegistry,
      toolExecutor,
      contextManager,
      config,
      workdir: ".",
      sessionStore,
    });

    // 第一轮：产生较长文本（超过 contextWindow 的一半）
    mockLLM.setResponses([
      [
        textDelta("This is a long response that will fill up the context window quickly. ".repeat(5)),
        usageEvent(50, 30),
        finish("end_turn"),
      ],
      // 第二轮：上下文已超阈值 → 触发压缩 → 然后正常回复
      [
        textDelta("After compaction response."),
        usageEvent(20, 10),
        finish("end_turn"),
      ],
    ]);

    // 第一轮对话
    const events1 = await collectEvents(agent.prompt("First long message"));
    const sessionStart = events1.find(
      (e): e is Extract<AgentEvent, { type: "session-start" }> =>
        e.type === "session-start",
    );
    const session = sessionStart!.session;

    // 第二轮对话（应触发压缩）
    const events2 = await collectEvents(agent.prompt("Second message", session));

    const types2 = events2.map((e) => e.type);
    // 验证压缩事件
    expect(types2).toContain("compaction-start");
    expect(types2).toContain("compaction-end");

    // 验证压缩后的摘要
    const compactionEnd = events2.find(
      (e): e is Extract<AgentEvent, { type: "compaction-end" }> =>
        e.type === "compaction-end",
    );
    expect(compactionEnd).toBeDefined();
    expect(compactionEnd!.summary).toBeTruthy();

    // 验证 mockLLM.generate 被调用（用于生成摘要）
    expect(mockLLM.generateCalls.length).toBeGreaterThanOrEqual(1);

    // 验证第二轮仍然有正常回复
    const textDeltas = events2.filter(
      (e): e is Extract<AgentEvent, { type: "text-delta" }> =>
        e.type === "text-delta",
    );
    const fullText = textDeltas.map((e) => e.text).join("");
    expect(fullText).toContain("After compaction response.");
  });

  test("disableCompact=true → 不触发压缩", async () => {
    const config = createTestConfig({
      contextWindow: 200,
      compactThreshold: 0.5,
      compactKeepTokens: 50,
      disableCompact: true,
    });

    const dbPath = createTempDbPath();
    tempDirs.push(dbPath);

    const toolRegistry = createToolRegistry();
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
    agent = new Agent({
      llmClient: mockLLM,
      toolRegistry,
      toolExecutor,
      contextManager,
      config,
      workdir: ".",
      sessionStore,
    });

    mockLLM.setResponses([
      [
        textDelta("Long response ".repeat(10)),
        finish("end_turn"),
      ],
      [
        textDelta("Second response"),
        finish("end_turn"),
      ],
    ]);

    const events1 = await collectEvents(agent.prompt("First message"));
    const sessionStart = events1.find(
      (e): e is Extract<AgentEvent, { type: "session-start" }> =>
        e.type === "session-start",
    );

    const events2 = await collectEvents(
      agent.prompt("Second message", sessionStart!.session),
    );

    const types2 = events2.map((e) => e.type);
    expect(types2).not.toContain("compaction-start");
    expect(types2).not.toContain("compaction-end");
  });
});

// ──────────────────────────────────────────────
// 5. 权限系统集成测试
// ──────────────────────────────────────────────

describe("集成测试：权限系统", () => {
  let mockLLM: MockLLMClient;
  let sessionManager: SessionManager;

  afterEach(() => {
    tempDirs = [];
  });

  test("destructive 工具调用 → 权限请求 → 批准 → 工具执行", async () => {
    mockLLM = new MockLLMClient();
    const { agent } = createTestAgent(mockLLM, {
      autoApproveTools: false,
    });

    sessionManager = new SessionManager({
      createAgent: () => agent,
    });

    mockLLM.setResponses([
      // 第一次 LLM 调用：发起 destructive 工具调用
      [toolCall("call-1", "danger", { action: "delete" }), finish("tool_use")],
      // 第二次 LLM 调用：工具执行后正常回复
      [textDelta("Action completed."), finish("end_turn")],
    ]);

    const session = sessionManager.createSession("Permission Test");

    // 使用 Promise 捕获权限请求
    let permissionResolve: (req: { reqId: string; toolName: string; input: unknown }) => void;
    const permissionPromise = new Promise<{ reqId: string; toolName: string; input: unknown }>(
      (resolve) => {
        permissionResolve = resolve;
      },
    );

    sessionManager.subscribePermissions(session.id, (req) => {
      permissionResolve({
        reqId: req.reqId,
        toolName: req.toolName,
        input: req.input,
      });
    });

    // 启动消息发送（后台收集事件）
    const events: AgentEvent[] = [];
    const collectPromise = (async () => {
      for await (const event of sessionManager.sendMessage(session.id, "Do something dangerous")) {
        events.push(event);
      }
    })();

    // 等待权限请求
    const permReq = await permissionPromise;

    // 验证权限请求内容
    expect(permReq.toolName).toBe("danger");
    expect(permReq.input).toEqual({ action: "delete" });

    // 批准权限
    const responded = sessionManager.respondPermission(
      session.id,
      permReq.reqId,
      { decision: "allow" },
    );
    expect(responded).toBe(true);

    // 等待事件流完成
    await collectPromise;

    // 验证事件流包含工具调用和结果
    const types = events.map((e) => e.type);
    expect(types).toContain("tool-call-start");
    expect(types).toContain("tool-call-result");

    // 验证工具结果不是错误（被批准执行）
    const toolResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool-call-result" }> =>
        e.type === "tool-call-result",
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.result.isError ?? false).toBe(false);

    // 验证最终有文本回复
    const textDeltas = events.filter(
      (e): e is Extract<AgentEvent, { type: "text-delta" }> =>
        e.type === "text-delta",
    );
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  test("destructive 工具调用 → 权限请求 → 拒绝 → 工具返回错误", async () => {
    mockLLM = new MockLLMClient();
    const { agent } = createTestAgent(mockLLM, {
      autoApproveTools: false,
    });

    sessionManager = new SessionManager({
      createAgent: () => agent,
    });

    mockLLM.setResponses([
      // LLM 发起 destructive 工具调用
      [toolCall("call-1", "danger", { action: "delete" }), finish("tool_use")],
      // 工具被拒绝后 LLM 回复
      [textDelta("Action was denied."), finish("end_turn")],
    ]);

    const session = sessionManager.createSession("Permission Deny Test");

    let permissionResolve: (req: { reqId: string }) => void;
    const permissionPromise = new Promise<{ reqId: string }>((resolve) => {
      permissionResolve = resolve;
    });

    sessionManager.subscribePermissions(session.id, (req) => {
      permissionResolve({ reqId: req.reqId });
    });

    // 启动消息发送（后台收集事件）
    const events: AgentEvent[] = [];
    const collectPromise = (async () => {
      for await (const event of sessionManager.sendMessage(session.id, "Do something dangerous")) {
        events.push(event);
      }
    })();

    // 等待权限请求
    const permReq = await permissionPromise;

    // 拒绝权限
    const responded = sessionManager.respondPermission(
      session.id,
      permReq.reqId,
      { decision: "deny", reason: "User denied" },
    );
    expect(responded).toBe(true);

    // 等待事件流完成
    await collectPromise;

    // 验证工具调用结果为错误
    const toolResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool-call-result" }> =>
        e.type === "tool-call-result",
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.result.isError).toBe(true);
  });

  test("GET /api/sessions/:id/permissions — 初始无权限请求", async () => {
    mockLLM = new MockLLMClient();
    const { agent } = createTestAgent(mockLLM);
    const config = createTestConfig();

    const result = createApp({
      config,
      createAgent: () => agent,
    });

    const session = result.sessionManager.createSession("Test");

    const res = await result.app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/permissions`),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });

  test("POST /api/sessions/:id/permissions/:reqId — 响应不存在的请求返回 404", async () => {
    mockLLM = new MockLLMClient();
    const { agent } = createTestAgent(mockLLM);
    const config = createTestConfig();

    const result = createApp({
      config,
      createAgent: () => agent,
    });

    const session = result.sessionManager.createSession("Test");

    const res = await result.app.fetch(
      new Request(
        `http://localhost/api/sessions/${session.id}/permissions/nonexistent-req`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "allow" }),
        },
      ),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.responded).toBe(false);
  });
});
