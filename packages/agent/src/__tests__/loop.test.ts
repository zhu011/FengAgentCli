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
import { createToolRegistry, createToolExecutor, fileRead } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { AgentLoop } from "../loop.ts";
import type { AgentLoopOptions } from "../loop.ts";
import { Agent } from "../agent.ts";
import { SessionStore } from "../session.ts";
import { z } from "zod";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
// 测试：连续工具失败死循环防护（AGE-29）
// ──────────────────────────────────────────────

describe("AgentLoop — 连续工具失败防护", () => {
  /** 注册一个总是返回错误的工具 */
  function registerFailTool(toolRegistry: ReturnType<typeof createToolRegistry>) {
    toolRegistry.register({
      name: "fail-tool",
      description: "Always fails",
      inputSchema: z.object({}),
      async execute() {
        return { content: "Error: boom", isError: true };
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });
  }

  test("连续 3 轮工具全部失败 → 抛出错误并终止循环（不再空耗到 maxTurns）", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;
    registerFailTool(options.toolRegistry);

    // 模型每轮都调用 fail-tool（模拟陷入失败重试循环，如 AGE-29 的 task 参数名错误）
    mockLLM.setResponses([
      [toolCall("c1", "fail-tool", {}), finish("tool_use")],
      [toolCall("c2", "fail-tool", {}), finish("tool_use")],
      [toolCall("c3", "fail-tool", {}), finish("tool_use")],
      // 第 4 轮不应到达（防护在 3 轮后触发）
      [textDelta("should not reach here"), finish("end_turn")],
    ]);

    const session = createSession("test-model");
    session.messages.push(createUserMessage("do it"));

    const loop = new AgentLoop(options);
    const events = await collectEvents(loop.run(session));

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { error: { message: string } }).error.message).toContain("全部失败");

    // 循环已终止：第 4 轮的文本未产生
    expect(
      events.some(
        (e) => e.type === "text-delta" && (e as { text: string }).text.includes("should not reach"),
      ),
    ).toBe(false);

    // 恰好 3 轮：user + (assistant + tool-result) × 3 = 7 条消息
    expect(session.messages).toHaveLength(7);
    const turnEnds = events.filter((e) => e.type === "turn-end");
    expect(turnEnds).toHaveLength(3);
    expect((turnEnds[2] as { reason: string }).reason).toBe("error");
  });

  test("失败轮后出现成功轮 → 计数重置，不触发防护", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;
    registerFailTool(options.toolRegistry);

    // 第 1 轮失败、第 2 轮成功、第 3 轮正常结束 — 不应触发防护
    mockLLM.setResponses([
      [toolCall("c1", "fail-tool", {}), finish("tool_use")],
      [toolCall("c2", "echo", { text: "ok" }), finish("tool_use")],
      [textDelta("done"), finish("end_turn")],
    ]);

    const session = createSession("test-model");
    session.messages.push(createUserMessage("do it"));

    const loop = new AgentLoop(options);
    const events = await collectEvents(loop.run(session));

    expect(events.some((e) => e.type === "error")).toBe(false);
    const turnEnds = events.filter((e) => e.type === "turn-end");
    expect((turnEnds[turnEnds.length - 1] as { reason: string }).reason).toBe("end_turn");
  });
});

// ──────────────────────────────────────────────
// 测试：用户改参后执行（human-in-the-loop 入参修正）
// ──────────────────────────────────────────────

describe("AgentLoop — 用户改参后执行（tool-call-result 携带实际入参 + 历史同步）", () => {
  test("executor 标记 userCorrectedInput → 事件带实际入参、历史 tool-use 块同步为新参数", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;

    // 第一轮 LLM 想以错误参数调用 echo；executor 经用户改参后以修正参数执行
    mockLLM.setResponses([
      [
        toolCall("call-1", "echo", { text: "orig" }),
        usageEvent(15, 10),
        finish("tool_use"),
      ],
      [
        textDelta("done"),
        usageEvent(5, 3),
        finish("end_turn"),
      ],
    ]);

    // 桩 executor：模拟「用户把参数从 orig 改为 corrected 后放行」
    const stubExecutor = {
      async executeMany() {
        return [
          {
            toolName: "echo",
            input: { text: "corrected" },
            result: {
              content: "executed with corrected",
              metadata: { userCorrectedInput: true },
            },
          },
        ];
      },
      async execute() {
        return { content: "x" };
      },
      getHookRegistry() {
        return {
          register: () => {},
          unregister: () => false,
          getHandlers: () => [],
        };
      },
    } as unknown as typeof options.toolExecutor;
    options.toolExecutor = stubExecutor;

    const session = createSession("test-model");
    session.messages.push(createUserMessage("echo something"));

    const loop = new AgentLoop(options);
    const events = await collectEvents(loop.run(session));

    // tool-call-result 事件携带实际执行入参（用户修正后的参数）
    const toolResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool-call-result" }> =>
        e.type === "tool-call-result",
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.input).toEqual({ text: "corrected" });

    // 历史中 assistant 消息的 tool-use 块同步为实际执行入参
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const toolUse = assistantMsg!.content.find((c) => c.type === "tool-use");
    expect(toolUse).toBeDefined();
    expect((toolUse as { input: unknown }).input).toEqual({
      text: "corrected",
    });
  });

  test("无改参标记 → 事件不带 input、历史保持模型原始入参", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;

    mockLLM.setResponses([
      [
        toolCall("call-1", "echo", { text: "orig" }),
        finish("tool_use"),
      ],
      [textDelta("done"), finish("end_turn")],
    ]);

    // 普通 executor 结果（无 userCorrectedInput 标记）
    const stubExecutor = {
      async executeMany() {
        return [
          {
            toolName: "echo",
            input: { text: "orig" },
            result: { content: "ok" },
          },
        ];
      },
      async execute() {
        return { content: "x" };
      },
      getHookRegistry() {
        return {
          register: () => {},
          unregister: () => false,
          getHandlers: () => [],
        };
      },
    } as unknown as typeof options.toolExecutor;
    options.toolExecutor = stubExecutor;

    const session = createSession("test-model");
    session.messages.push(createUserMessage("echo something"));

    const loop = new AgentLoop(options);
    const events = await collectEvents(loop.run(session));

    const toolResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool-call-result" }> =>
        e.type === "tool-call-result",
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.input).toBeUndefined();

    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    const toolUse = assistantMsg!.content.find((c) => c.type === "tool-use");
    expect((toolUse as { input: unknown }).input).toEqual({ text: "orig" });
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

// ──────────────────────────────────────────────
// 测试：空转 / 死循环防护增强（AGE-29 现场：25 步、42 次工具、end_turn 正常结束）
//
// 现场特征：失败**不连续**（bash requires-approval ×3、file-read 参数错、skill-not-found
// 分散在各步），中间夹大量「成功但零进展」的调用（反复 glob 只回一个文件、反复读同一
// 截断文件）。旧的「连续 3 轮全失败」防护永远攒不满，25 步也远不到 maxTurns=50。
// ──────────────────────────────────────────────

/** 注册一个「总是成功且输出固定」的工具（用于制造纯空转） */
function registerFixedTool(
  toolRegistry: ReturnType<typeof createToolRegistry>,
  name: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  toolRegistry.register({
    name,
    description: `Always returns fixed content`,
    inputSchema: z.object({ text: z.string() }).passthrough(),
    async execute() {
      return { content };
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    ...extra,
  });
}

/** 注册一个每次返回不同内容、但始终失败的工具（永不重复 → 只可能被「无进展」捕获） */
function registerDriftingFailTool(
  toolRegistry: ReturnType<typeof createToolRegistry>,
) {
  let n = 0;
  toolRegistry.register({
    name: "drift-fail",
    description: "Always fails with drifting content",
    inputSchema: z.object({ text: z.string() }).passthrough(),
    async execute() {
      n++;
      return { content: `Error: boom #${n}`, isError: true };
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
}

describe("AgentLoop — 空转防护（重复调用 / 无进展 / 重复读 / wall-clock）", () => {
  test("同参数同结果的重复调用达到上限 → 终止并给出可定位原因", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;

    // 模型反复读同一个截断文件：入参与结果逐字节相同
    mockLLM.setResponses([
      [toolCall("c1", "read-fixed", { text: "AGENTS.md" }), finish("tool_use")],
      [toolCall("c2", "read-fixed", { text: "AGENTS.md" }), finish("tool_use")],
      [toolCall("c3", "read-fixed", { text: "AGENTS.md" }), finish("tool_use")],
      [textDelta("should not reach here"), finish("end_turn")],
    ]);
    registerFixedTool(options.toolRegistry, "read-fixed", "1: <!-- BEGIN -->\n2: # Runtime");

    const loop = new AgentLoop(options);
    const session = createSession("test-model");
    session.messages.push(createUserMessage("看看工作区"));

    const events = await collectEvents(loop.run(session));

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    const message = (errors[0] as { error: { message: string } }).error.message;
    expect(message).toContain("重复工具调用");
    expect(message).toContain("read-fixed");
    // 单行化：宿主按行采集，多行消息会被切碎
    expect(message.includes("\n")).toBe(false);

    // 第 4 轮不再执行
    expect(
      events.some(
        (e) =>
          e.type === "text-delta" &&
          (e as { text: string }).text.includes("should not reach"),
      ),
    ).toBe(false);
    const turnEnds = events.filter((e) => e.type === "turn-end");
    expect((turnEnds[turnEnds.length - 1] as { reason: string }).reason).toBe("error");
  });

  test("连续无进展步（错误 + 历史重复结果，但非「连续全失败」）→ 终止", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;

    registerFixedTool(options.toolRegistry, "read-fixed", "constant content");
    registerDriftingFailTool(options.toolRegistry);

    // 每步：一个「成功但重复」的调用 + 一个「失败但内容不同」的调用
    // → allToolsFailed 为 false（连续失败防护攒不满），但整步零新信息
    const step = (id: string): LLMEvent[] => [
      toolCall(`${id}-a`, "read-fixed", { text: "same" }),
      toolCall(`${id}-b`, "drift-fail", { text: `attempt-${id}` }),
      finish("tool_use"),
    ];
    mockLLM.setResponses([step("1"), step("2"), step("3"), step("4")]);

    const loop = new AgentLoop({
      ...options,
      // 收紧阈值、放宽重复调用检测，隔离出「无进展」这一条规则
      guards: {
        maxIdenticalToolResults: 99,
        maxSameTargetReads: 99,
        maxNoProgressSteps: 2,
        maxWallClockMs: 0,
      },
    });
    const session = createSession("test-model");
    session.messages.push(createUserMessage("干活"));

    const events = await collectEvents(loop.run(session));

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(
      (errors[0] as { error: { message: string } }).error.message,
    ).toContain("没有任何新进展");
  });

  test("只读工具反复读同一文件（每次结果不同）→ 终止", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;

    // 每次 offset 不同 → 结果不同，躲得过「重复结果」检测
    let n = 0;
    options.toolRegistry.register({
      name: "read-chunk",
      description: "Reads a chunk of a file",
      inputSchema: z.object({ filePath: z.string(), offset: z.number() }).passthrough(),
      async execute() {
        n++;
        return { content: `chunk ${n}` };
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });

    const chunk = (id: string, offset: number): LLMEvent[] => [
      toolCall(id, "read-chunk", { filePath: "AGENTS.md", offset }),
      finish("tool_use"),
    ];
    mockLLM.setResponses([
      chunk("c1", 0),
      chunk("c2", 10),
      chunk("c3", 20),
      chunk("c4", 30),
    ]);

    const loop = new AgentLoop({
      ...options,
      guards: {
        maxIdenticalToolResults: 99,
        maxNoProgressSteps: 99,
        maxSameTargetReads: 3,
        maxWallClockMs: 0,
      },
    });
    const session = createSession("test-model");
    session.messages.push(createUserMessage("读文件"));

    const events = await collectEvents(loop.run(session));

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    const message = (errors[0] as { error: { message: string } }).error.message;
    expect(message).toContain("同一文件被重复读取");
    expect(message).toContain("AGENTS.md");
  });

  test("成功的写入会重置同文件读取计数 → 不误伤正常的「读-改-读」", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;

    let reads = 0;
    options.toolRegistry.register({
      name: "read-chunk",
      description: "Reads a chunk of a file",
      inputSchema: z.object({ filePath: z.string(), offset: z.number() }).passthrough(),
      async execute() {
        reads++;
        return { content: `chunk ${reads}` };
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });
    let writes = 0;
    options.toolRegistry.register({
      name: "write-file",
      description: "Writes a file",
      inputSchema: z.object({ filePath: z.string() }).passthrough(),
      async execute() {
        writes++;
        return { content: `wrote #${writes}` };
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    });

    mockLLM.setResponses([
      [toolCall("c1", "read-chunk", { filePath: "a.ts", offset: 0 }), finish("tool_use")],
      [toolCall("c2", "read-chunk", { filePath: "a.ts", offset: 1 }), finish("tool_use")],
      [toolCall("c3", "write-file", { filePath: "a.ts" }), finish("tool_use")],
      [toolCall("c4", "read-chunk", { filePath: "a.ts", offset: 0 }), finish("tool_use")],
      [toolCall("c5", "read-chunk", { filePath: "a.ts", offset: 1 }), finish("tool_use")],
      [textDelta("改完了"), finish("end_turn")],
    ]);

    const loop = new AgentLoop({
      ...options,
      guards: { maxSameTargetReads: 3, maxWallClockMs: 0 },
    });
    const session = createSession("test-model");
    session.messages.push(createUserMessage("改文件"));

    const events = await collectEvents(loop.run(session));

    expect(events.some((e) => e.type === "error")).toBe(false);
    const turnEnds = events.filter((e) => e.type === "turn-end");
    expect((turnEnds[turnEnds.length - 1] as { reason: string }).reason).toBe("end_turn");
  });

  test("整体 wall-clock 超时 → 终止（步数与工具调用看起来都正常）", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;

    options.toolRegistry.register({
      name: "slow-tool",
      description: "Takes a while",
      inputSchema: z.object({ text: z.string() }).passthrough(),
      async execute() {
        await Bun.sleep(30);
        return { content: `slow #${Date.now()}` };
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    });

    mockLLM.setResponses([
      [toolCall("c1", "slow-tool", { text: "a" }), finish("tool_use")],
      [toolCall("c2", "slow-tool", { text: "b" }), finish("tool_use")],
      [textDelta("should not reach here"), finish("end_turn")],
    ]);

    const loop = new AgentLoop({
      ...options,
      guards: { maxWallClockMs: 5 },
    });
    const session = createSession("test-model");
    session.messages.push(createUserMessage("慢活"));

    const events = await collectEvents(loop.run(session));

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(
      (errors[0] as { error: { message: string } }).error.message,
    ).toContain("wall-clock");
  });

  test("无权限回调的审批拒绝（不可恢复）→ 立即结算，不把该轮喂回模型空转", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;

    // 破坏性 + 非只读 + 无权限回调 → 权限层返回 unrecoverable deny
    // （这里直接由 checkPermissions 复刻该决策，隔离出 loop 层的行为）
    options.toolRegistry.register({
      name: "bash-like",
      description: "Destructive shell command",
      inputSchema: z.object({ command: z.string() }).passthrough(),
      async execute(input: { command: string }) {
        return { content: `ran: ${input.command}` };
      },
      isReadOnly: () => false,
      isDestructive: () => true,
      isConcurrencySafe: () => false,
      checkPermissions: () => ({
        decision: "deny" as const,
        reason:
          'Tool "bash-like" is destructive and no permission callback available',
        unrecoverable: true,
      }),
    });

    mockLLM.setResponses([
      [toolCall("c1", "bash-like", { command: "ls -la" }), finish("tool_use")],
      [toolCall("c2", "bash-like", { command: "ls -la" }), finish("tool_use")],
      [textDelta("should not reach here"), finish("end_turn")],
    ]);

    const loop = new AgentLoop(options);
    const session = createSession("test-model");
    session.messages.push(createUserMessage("跑个命令"));

    const events = await collectEvents(loop.run(session));

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    const message = (errors[0] as { error: { message: string } }).error.message;
    expect(message).toContain("不可恢复");
    // 第 1 步就结算，不再有第 2 步
    expect(events.filter((e) => e.type === "turn-end")).toHaveLength(1);
    expect(
      events.some(
        (e) =>
          e.type === "text-delta" &&
          (e as { text: string }).text.includes("should not reach"),
      ),
    ).toBe(false);
  });

  test("防护阈值可注入：放宽后同样的空转不再触发（默认值才是防线）", async () => {
    const { options } = createTestSetup();
    const mockLLM = options.llmClient as MockLLMClient;
    registerFixedTool(options.toolRegistry, "read-fixed", "constant content");

    mockLLM.setResponses([
      [toolCall("c1", "read-fixed", { text: "x" }), finish("tool_use")],
      [toolCall("c2", "read-fixed", { text: "x" }), finish("tool_use")],
      [toolCall("c3", "read-fixed", { text: "x" }), finish("tool_use")],
      [textDelta("done"), finish("end_turn")],
    ]);

    const loop = new AgentLoop({
      ...options,
      guards: {
        maxIdenticalToolResults: 99,
        maxNoProgressSteps: 99,
        maxSameTargetReads: 99,
        maxWallClockMs: 0,
      },
    });
    const session = createSession("test-model");
    session.messages.push(createUserMessage("随便"));

    const events = await collectEvents(loop.run(session));
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

// ──────────────────────────────────────────────
// 测试：现场形态复现（真实 file-read 工具 + 真工作目录）
//
// AGE-29 现场：`read_file` 对**同一个文件**连续读了 8 次，每次 offset 不同（工具
// 返回不同片段，所以「同结果」检测抓不到），中间没有任何写入。这正是「反复读同一
// 截断文件的不同片段」的形态，由「同文件反复读取」护栏兜住。
// ──────────────────────────────────────────────

describe("AgentLoop — 现场形态复现（反复读同一文件的不同片段）", () => {
  test("真实 file-read 读同一文件 6 次（offset 不同）→ 护栏终止", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fengagent-age29-"));
    try {
      const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
      writeFileSync(join(dir, "AGENTS.md"), lines.join("\n"), "utf-8");

      const { options } = createTestSetup();
      const mockLLM = options.llmClient as MockLLMClient;
      options.toolRegistry.register(fileRead);

      // 每步读同一文件的相邻片段（offset 不同 → 结果不同）
      mockLLM.setResponses([
        ...Array.from({ length: 6 }, (_, i) => [
          toolCall(`c${i + 1}`, "file-read", {
            filePath: "AGENTS.md",
            offset: i * 10,
            limit: 10,
          }),
          finish("tool_use" as const),
        ]),
        [textDelta("should not reach here"), finish("end_turn")],
      ]);

      const loop = new AgentLoop({
        ...options,
        workdir: dir,
        // 隔离出「同文件反复读取」这一条规则
        guards: {
          maxIdenticalToolResults: 99,
          maxNoProgressSteps: 99,
          maxSameTargetReads: 5,
          maxWallClockMs: 0,
        },
      });
      const session = createSession("test-model");
      session.messages.push(createUserMessage("看看工作区"));

      const events = await collectEvents(loop.run(session));

      const errors = events.filter((e) => e.type === "error");
      expect(errors).toHaveLength(1);
      const message = (errors[0] as { error: { message: string } }).error.message;
      expect(message).toContain("同一文件被重复读取");
      expect(message).toContain("AGENTS.md");
      // 第 7 轮不再执行
      expect(
        events.some(
          (e) =>
            e.type === "text-delta" &&
            (e as { text: string }).text.includes("should not reach"),
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
