/**
 * @fengagent/agent — Agent Loop 端到端测试
 *
 * 使用 mock LLM 测试完整的 Agent Loop 流程：
 * 1. 输入 → LLM → 工具调用 → 工具执行 → LLM → 输出
 * 2. 上下文压缩触发
 * 3. 会话持久化和恢复
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
  Message,
} from "@fengagent/core";
import { createSession, createUserMessage } from "@fengagent/core";
import { createToolRegistry, createToolExecutor } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { AgentLoop } from "../loop.ts";
import type { AgentLoopOptions } from "../loop.ts";
import { Agent } from "../agent.ts";
import { SessionStore } from "../session.ts";
import { z } from "zod";

// ──────────────────────────────────────────────
// Mock LLM Client
// ──────────────────────────────────────────────

/**
 * 可编程的 Mock LLM Client。
 * 按调用顺序返回预设的响应序列。
 */
class MockLLMClient implements LLMClient {
  private responses: LLMEvent[][] = [];
  private callIndex = 0;
  public generateCalls: LLMRequest[] = [];

  /** 设置按顺序返回的流式响应序列 */
  setResponses(responses: LLMEvent[][]): void {
    this.responses = responses;
    this.callIndex = 0;
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
      content: [
        { type: "text", text: "这是压缩摘要。" },
      ],
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

function createTestSetup(overrides?: Partial<Config>) {
  const config = createTestConfig(overrides);
  const mockLLM = new MockLLMClient();

  const toolRegistry = createToolRegistry();
  // 注册一个简单的 echo 工具用于测试
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

  const options: AgentLoopOptions = {
    llmClient: mockLLM,
    toolRegistry,
    toolExecutor,
    contextManager,
    config,
    workdir: ".",
  };

  return { config, mockLLM, toolRegistry, toolExecutor, contextManager, options };
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

// ──────────────────────────────────────────────
// 流式事件辅助构建器
// ──────────────────────────────────────────────

function textDelta(text: string): LLMEvent {
  return { type: "text-delta", text };
}

function toolCall(id: string, name: string, input: unknown): LLMEvent {
  return { type: "tool-call", id, name, input };
}

function usageEvent(input: number, output: number): LLMEvent {
  return { type: "usage", inputTokens: input, outputTokens: output };
}

function finish(reason: "end_turn" | "tool_use" | "max_tokens"): LLMEvent {
  return { type: "finish", reason };
}

// ──────────────────────────────────────────────
// 测试：基本 Agent Loop
// ──────────────────────────────────────────────

describe("AgentLoop — 基本流程", () => {
  test("无工具调用：输入 → LLM 文本响应 → 结束", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;

    mockLLM.setResponses([
      [
        textDelta("Hello"),
        textDelta(" world!"),
        usageEvent(10, 5),
        finish("end_turn"),
      ],
    ]);

    const session = createSession("test-model");
    session.messages.push(createUserMessage("Hi"));

    const loop = new AgentLoop(options);
    const events = await collectEvents(loop.run(session));

    // 事件序列检查
    expect(events[0]!.type).toBe("message-start");
    expect(events[1]!.type).toBe("text-delta");
    expect((events[1] as { text: string }).text).toBe("Hello");
    expect(events[2]!.type).toBe("text-delta");
    expect((events[2] as { text: string }).text).toBe(" world!");
    expect(events.some((e) => e.type === "usage")).toBe(true);
    expect(events.some((e) => e.type === "message-end")).toBe(true);

    const turnEnd = events.find((e) => e.type === "turn-end");
    expect(turnEnd).toBeDefined();
    expect((turnEnd as { reason: string }).reason).toBe("end_turn");

    // 会话历史检查
    expect(session.messages).toHaveLength(2); // user + assistant
    const assistantMsg = session.messages[1]!;
    expect(assistantMsg.role).toBe("assistant");
    const textContent = assistantMsg.content.find((c) => c.type === "text");
    expect(textContent).toBeDefined();
    expect((textContent as { text: string }).text).toBe("Hello world!");
  });

  test("有工具调用：输入 → LLM → 工具调用 → 工具执行 → LLM → 输出", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;

    mockLLM.setResponses([
      // 第一轮：LLM 调用 echo 工具
      [
        textDelta("Let me echo that."),
        toolCall("call-1", "echo", { text: "test message" }),
        usageEvent(15, 10),
        finish("tool_use"),
      ],
      // 第二轮：LLM 基于工具结果生成最终回复
      [
        textDelta("The echo result is: Echo: test message"),
        usageEvent(25, 15),
        finish("end_turn"),
      ],
    ]);

    const session = createSession("test-model");
    session.messages.push(createUserMessage("Echo 'test message'"));

    const loop = new AgentLoop(options);
    const events = await collectEvents(loop.run(session));

    // 第一轮事件
    const firstMessageStart = events.filter((e) => e.type === "message-start");
    expect(firstMessageStart).toHaveLength(2); // 两轮各一个

    // 工具调用事件
    const toolCallStart = events.find((e) => e.type === "tool-call-start");
    expect(toolCallStart).toBeDefined();
    expect((toolCallStart as { name: string }).name).toBe("echo");
    expect((toolCallStart as { input: { text: string } }).input).toEqual({
      text: "test message",
    });

    // 工具结果事件
    const toolResult = events.find((e) => e.type === "tool-call-result");
    expect(toolResult).toBeDefined();
    const result = (toolResult as { result: { content: string } }).result;
    expect(result.content).toBe("Echo: test message");

    // 两个 turn-end
    const turnEnds = events.filter((e) => e.type === "turn-end");
    expect(turnEnds).toHaveLength(2);
    expect((turnEnds[0] as { reason: string }).reason).toBe("tool_use");
    expect((turnEnds[1] as { reason: string }).reason).toBe("end_turn");

    // 会话历史检查
    // user + assistant(tool-use) + user(tool-result) + assistant(text) = 4
    expect(session.messages).toHaveLength(4);
    expect(session.messages[0]!.role).toBe("user");
    expect(session.messages[1]!.role).toBe("assistant");
    expect(session.messages[1]!.content.some((c) => c.type === "tool-use")).toBe(true);
    expect(session.messages[2]!.role).toBe("user");
    expect(session.messages[2]!.content.some((c) => c.type === "tool-result")).toBe(true);
    expect(session.messages[3]!.role).toBe("assistant");
  });

  test("LLM 错误时终止循环并发送 error 事件", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;

    mockLLM.setResponses([
      [
        { type: "error", error: { message: "API rate limit", code: "rate_limit" } },
      ],
    ]);

    const session = createSession("test-model");
    session.messages.push(createUserMessage("Hi"));

    const loop = new AgentLoop(options);
    const events = await collectEvents(loop.run(session));

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { error: { message: string } }).error.message).toBe(
      "API rate limit",
    );

    const turnEnd = events.find((e) => e.type === "turn-end");
    expect(turnEnd).toBeDefined();
    expect((turnEnd as { reason: string }).reason).toBe("error");
  });

  test("达到 maxTurns 时退出并禁用工具", async () => {
    const { options } = createTestSetup({ maxTurns: 2 });
    const mockLLM = options.llmClient as MockLLMClient;

    // 两轮都调用工具，第二轮达到 maxTurns
    mockLLM.setResponses([
      [
        toolCall("call-1", "echo", { text: "first" }),
        finish("tool_use"),
      ],
      [
        toolCall("call-2", "echo", { text: "second" }),
        finish("tool_use"),
      ],
    ]);

    const session = createSession("test-model");
    session.messages.push(createUserMessage("Keep echoing"));

    const loop = new AgentLoop(options);
    const events = await collectEvents(loop.run(session));

    // 应该有两个 turn-end
    const turnEnds = events.filter((e) => e.type === "turn-end");
    expect(turnEnds).toHaveLength(2);

    // 第二个 turn-end 应该是 max_tokens（达到 maxTurns）
    // 注意：第二个 turn 的 reason 是 tool_use（因为有工具调用），
    // 但循环会在 step >= maxTurns 后额外发一个 max_tokens turn-end
    expect((turnEnds[1] as { reason: string }).reason).toBe("max_tokens");
  });
});

// ──────────────────────────────────────────────
// 测试：上下文压缩
// ──────────────────────────────────────────────

describe("AgentLoop — 上下文压缩", () => {
  test("接近 Token 上限时触发压缩", async () => {
    // 设置极小的上下文窗口和阈值，让压缩更容易触发
    const { options } = createTestSetup({
      contextWindow: 200,
      compactThreshold: 0.5,
      compactKeepTokens: 50,
    });
    const mockLLM = options.llmClient as MockLLMClient;

    mockLLM.setResponses([
      [textDelta("Response after compaction."), finish("end_turn")],
    ]);

    const session = createSession("test-model");

    // 添加足够多的消息使 token 超过阈值
    for (let i = 0; i < 10; i++) {
      session.messages.push({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: [
          {
            type: "text",
            text: `Message ${i} with some content to fill up the context window. `.repeat(5),
          },
        ],
        createdAt: Date.now() + i,
      });
    }

    const loop = new AgentLoop(options);
    const events = await collectEvents(loop.run(session));

    // 应该有 compaction-start 和 compaction-end 事件
    const compactionStart = events.find((e) => e.type === "compaction-start");
    expect(compactionStart).toBeDefined();

    const compactionEnd = events.find((e) => e.type === "compaction-end");
    expect(compactionEnd).toBeDefined();
    expect((compactionEnd as { summary: string }).summary).toContain("压缩摘要");

    // mockLLM.generate 应该被调用（用于生成摘要）
    expect(mockLLM.generateCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("disableCompact 为 true 时不压缩", async () => {
    const { options } = createTestSetup({
      contextWindow: 200,
      compactThreshold: 0.5,
      disableCompact: true,
    });
    const mockLLM = options.llmClient as MockLLMClient;

    mockLLM.setResponses([
      [textDelta("No compaction."), finish("end_turn")],
    ]);

    const session = createSession("test-model");
    for (let i = 0; i < 10; i++) {
      session.messages.push({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: [
          {
            type: "text",
            text: `Message ${i} with lots of content to fill context. `.repeat(5),
          },
        ],
        createdAt: Date.now() + i,
      });
    }

    const loop = new AgentLoop(options);
    const events = await collectEvents(loop.run(session));

    expect(events.some((e) => e.type === "compaction-start")).toBe(false);
    expect(mockLLM.generateCalls.length).toBe(0);
  });
});

// ──────────────────────────────────────────────
// 测试：Agent 类
// ──────────────────────────────────────────────

describe("Agent — 入口类", () => {
  test("prompt() 创建新会话并运行", async () => {
    const setup = createTestSetup();
    const mockLLM = setup.mockLLM;

    mockLLM.setResponses([
      [textDelta("Hello!"), finish("end_turn")],
    ]);

    const agent = new Agent({
      ...setup.options,
      sessionStore: undefined,
    });

    const events = await collectEvents(agent.prompt("Hi"));

    // session-start → message-start → text-delta → message-end → turn-end → session-end
    expect(events[0]!.type).toBe("session-start");
    const sessionStart = events[0] as { session: { id: string; messages: Message[] } };
    // session-start 时会话 ID 应已生成
    expect(sessionStart.session.id).toBeDefined();

    expect(events[events.length - 1]!.type).toBe("session-end");

    // 最终 session 应有 user + assistant 消息
    expect(sessionStart.session.messages.length).toBeGreaterThanOrEqual(2);
  });

  test("prompt() 使用已有会话", async () => {
    const setup = createTestSetup();
    const mockLLM = setup.mockLLM;

    mockLLM.setResponses([
      [textDelta("Continued!"), finish("end_turn")],
    ]);

    const session = createSession("test-model", "Existing Session");
    session.messages.push(createUserMessage("Previous message"));

    const agent = new Agent(setup.options);

    const events = await collectEvents(agent.prompt("New message", session));

    const sessionStart = events[0] as {
      session: { title: string; id: string };
    };
    expect(sessionStart.session.title).toBe("Existing Session");
    // 应使用已有会话的 ID
    expect(sessionStart.session.id).toBe(session.id);
  });
});

// ──────────────────────────────────────────────
// 测试：会话持久化
// ──────────────────────────────────────────────

describe("SessionStore — SQLite 持久化", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  });

  afterEach(() => {
    try {
      const fs = require("fs");
      fs.unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("保存和加载会话", () => {
    const store = new SessionStore(dbPath);

    const session = createSession("test-model", "Test Session");
    const msg1 = createUserMessage("Hello");
    const msg2: Message = {
      id: "msg-2",
      role: "assistant",
      content: [{ type: "text", text: "Hi there!" }],
      createdAt: Date.now(),
    };

    store.saveSession(session);
    store.saveMessage(session.id, msg1);
    store.saveMessage(session.id, msg2);

    const loaded = store.loadSession(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);
    expect(loaded!.title).toBe("Test Session");
    expect(loaded!.model).toBe("test-model");
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0]!.role).toBe("user");
    expect(loaded!.messages[0]!.content[0]!.type).toBe("text");
    expect((loaded!.messages[0]!.content[0] as { text: string }).text).toBe("Hello");
    expect(loaded!.messages[1]!.role).toBe("assistant");

    store.close();
  });

  test("列出会话", () => {
    const store = new SessionStore(dbPath);

    const session1 = createSession("model-1", "Session 1");
    const session2 = createSession("model-2", "Session 2");

    store.saveSession(session1);
    store.saveSession(session2);

    const list = store.listSessions();
    expect(list).toHaveLength(2);

    store.close();
  });

  test("删除会话", () => {
    const store = new SessionStore(dbPath);

    const session = createSession("test-model", "To Delete");
    store.saveSession(session);
    store.saveMessage(session.id, createUserMessage("msg"));

    store.deleteSession(session.id);

    const loaded = store.loadSession(session.id);
    expect(loaded).toBeNull();

    store.close();
  });

  test("加载不存在的会话返回 null", () => {
    const store = new SessionStore(dbPath);
    const loaded = store.loadSession("nonexistent-id");
    expect(loaded).toBeNull();
    store.close();
  });

  test("Agent 通过 SessionStore 持久化和恢复", async () => {
    const setup = createTestSetup();
    const mockLLM = setup.mockLLM;

    mockLLM.setResponses([
      [textDelta("Saved response!"), finish("end_turn")],
    ]);

    const store = new SessionStore(dbPath);
    const agent = new Agent({
      ...setup.options,
      sessionStore: store,
    });

    const events = await collectEvents(agent.prompt("Save this"));
    const sessionStart = events[0] as { session: { id: string } };
    const sessionId = sessionStart.session.id;

    // 从存储加载
    const loaded = store.loadSession(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBeGreaterThanOrEqual(2);
    expect(loaded!.messages[0]!.role).toBe("user");
    expect(loaded!.messages[loaded!.messages.length - 1]!.role).toBe("assistant");

    store.close();
  });
});
