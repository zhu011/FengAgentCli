/**
 * @fengagent/cordis — 运行时集成测试
 *
 * 验证：
 * 1. createRuntime 按配置加载全部内置插件（模型/工具/策略/存储/上下文/loop/图）；
 * 2. ctx.loop 通过 Cordis 服务驱动 AgentLoop 跑通一轮对话（行为与既有循环一致）；
 * 3. 对话即节点：每轮对话沉淀为图节点（可溯源）；
 * 4. 节点回答不佳可回退：ctx.graph.rollbackPoorAnswer 长出分支。
 */

import { describe, expect, test } from "bun:test";
import type { LLMClient, LLMEvent } from "@fengagent/llm";
import type {
  Message,
  Session,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@fengagent/core";
import { createUserMessage } from "@fengagent/core";
import type { ContextManager } from "@fengagent/context";
import { createRuntime } from "../runtime.ts";
import { BUILTIN_PLUGINS } from "../types.ts";

/** 模拟 LLM：第一轮返回文本；带工具时返回工具调用 */
function createMockClient(options: { toolCall?: { name: string; input: unknown } } = {}): LLMClient {
  async function* stream(): AsyncGenerator<LLMEvent> {
    if (options.toolCall) {
      yield { type: "tool-call", id: "tc-1", name: options.toolCall.name, input: options.toolCall.input };
      yield { type: "finish", reason: "tool_use" };
    } else {
      yield { type: "text-delta", text: "你好，我是测试助手。" };
      yield { type: "finish", reason: "end_turn" };
    }
  }
  return {
    stream,
    async generate() {
      return {
        id: "mock",
        model: "mock",
        content: [{ type: "text", text: "ok" }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "end_turn",
      };
    },
  };
}

/** 模拟 ContextManager（复用真实 manager 的逻辑形状，但不依赖文件系统） */
function createMockContextManager(): ContextManager {
  return {
    async assemble(session: Session) {
      const system = "你是 FengAgent 测试助手。";
      return { system, messages: session.messages, tokenCount: system.length + 10 };
    },
    shouldCompact() {
      return false;
    },
    async compact(messages: Message[]) {
      return { summary: "", recent: messages };
    },
    estimateTokens(content: string | Message[]) {
      if (typeof content === "string") return content.length;
      return content.length * 10;
    },
    invalidateSystemPrompt() {
      // 测试桩：无需清理系统提示缓存
    },
  };
}

/** 简易内存会话存储（对齐 SessionStore 接口形状） */
function createMemorySessionStore() {
  const sessions = new Map<string, Session>();
  return {
    saveSession(s: Session) {
      sessions.set(s.id, s);
    },
    loadSession(id: string) {
      return sessions.get(id);
    },
    listSessions() {
      return [...sessions.values()];
    },
    deleteSession(id: string) {
      sessions.delete(id);
    },
  };
}

function makeSession(messages?: Message[]): Session {
  return {
    id: "session-cordis-test",
    title: "test",
    model: "mock-model",
    status: "idle",
    messages: messages ?? [],
    tokenCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** 构造一个完整插件列表的运行时（mock 模型 + 内存存储） */
function createTestRuntime(options: { toolCall?: { name: string; input: unknown }; tools?: ToolDefinition[] } = {}) {
  const mock = createMockClient(options.toolCall ? { toolCall: options.toolCall } : {});
  const manager = createMockContextManager();
  const sessionStore = createMemorySessionStore();
  const runtime = createRuntime({
    workdir: ".",
    plugins: [
      { id: BUILTIN_PLUGINS.MODEL, config: { provider: "mock", model: "mock-model", client: mock } },
      { id: BUILTIN_PLUGINS.TOOLS, config: { tools: options.tools ?? [] } },
      { id: BUILTIN_PLUGINS.STRATEGY },
      { id: BUILTIN_PLUGINS.CONTEXT, config: { manager } },
      { id: BUILTIN_PLUGINS.STORAGE, config: { sessionStore } },
      { id: BUILTIN_PLUGINS.GRAPH },
      {
        id: BUILTIN_PLUGINS.LOOP,
        config: { config: { maxTurns: 4, maxTokens: 1024, temperature: 0.7 }, workdir: "." },
      },
    ],
  });
  return { runtime, sessionStore, mock };
}

describe("createRuntime — Cordis 一等公民", () => {
  test("插件按配置加载，服务可注入", async () => {
    const { runtime } = createTestRuntime();
    await runtime.start();
    const ctx = runtime.ctx as any;

    expect(ctx.model).toBeDefined();
    expect(ctx.tools).toBeDefined();
    expect(ctx.strategy).toBeDefined();
    expect(ctx.context).toBeDefined();
    expect(ctx.storage).toBeDefined();
    expect(ctx.graph).toBeDefined();
    expect(ctx.loop).toBeDefined();
    expect(ctx.model.model).toBe("mock-model");

    // 模型服务可调用
    const response = await ctx.model.generate({ model: "mock", system: "", messages: [] });
    expect(response.content[0]?.type).toBe("text");

    await runtime.stop();
    expect(runtime.started).toBe(false);
  });

  test("ctx.loop 驱动一轮对话 + 对话即节点", async () => {
    const { runtime } = createTestRuntime();
    await runtime.start();
    const ctx = runtime.ctx as any;

    const session = makeSession([createUserMessage("你好")]);
    const events: string[] = [];
    for await (const event of ctx.loop.run(session)) {
      events.push(event.type);
    }

    // 一轮对话正常结束
    expect(events).toContain("message-start");
    expect(events).toContain("message-end");
    expect(events).toContain("turn-end");
    // 对话即节点：图中沉淀了 user + assistant 节点
    const nodes = ctx.graph.store.listNodes(session.id);
    expect(nodes.some((n: { type: string }) => n.type === "user")).toBe(true);
    expect(nodes.some((n: { type: string }) => n.type === "assistant")).toBe(true);
    // 可溯源：assistant 节点能追溯到 user 节点
    const assistant = nodes.find((n: { type: string }) => n.type === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant.parentId).toBeDefined();
    const chain = ctx.graph.store.getChain(assistant.id);
    expect(chain.length).toBeGreaterThanOrEqual(1);
    expect(chain[0]).toBeDefined();

    await runtime.stop();
  });

  test("工具调用链路 + 工具插件可注册新工具", async () => {
    const echoTool = {
      name: "echo",
      description: "回显输入",
      inputSchema: undefined,
      async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
        return { content: `echo:${(input as { text?: string }).text ?? ""}` };
      },
    } as unknown as ToolDefinition;
    const { runtime } = createTestRuntime({ toolCall: { name: "echo", input: { text: "hi" } }, tools: [echoTool] });
    await runtime.start();
    const ctx = runtime.ctx as any;

    expect(ctx.tools.get("echo")).toBeDefined();
    expect(ctx.tools.listNames()).toContain("echo");

    const session = makeSession([createUserMessage("回显 hi")]);
    let toolResultSeen = false;
    for await (const event of ctx.loop.run(session)) {
      if (event.type === "tool-call-result") {
        toolResultSeen = true;
        expect(String(event.result.content)).toBe("echo:hi");
      }
    }
    expect(toolResultSeen).toBe(true);
    // 工具结果已写入会话历史
    expect(
      session.messages.some((m) => m.content.some((c) => c.type === "tool-result")),
    ).toBe(true);

    await runtime.stop();
  });

  test("节点回答不佳可回退（Graph 机制）", async () => {
    const { runtime } = createTestRuntime();
    await runtime.start();
    const ctx = runtime.ctx as any;

    const session = makeSession([createUserMessage("你好")]);
    for await (const _ of ctx.loop.run(session)) {
      // 消费完一轮
    }

    const nodes = ctx.graph.store.listNodes(session.id);
    const assistant = nodes.find((n: { type: string }) => n.type === "assistant");
    expect(assistant).toBeDefined();

    // 用户觉得回答不佳 → 回退
    const ok = ctx.graph.rollbackPoorAnswer(assistant.id, "回答不够好，重来");
    expect(ok).toBe(true);
    const after = ctx.graph.store.listNodes(session.id);
    const branchPoint = after.find((n: { type: string }) => n.type === "branch-point");
    expect(branchPoint).toBeDefined();
    // 旧助手节点作废但保留（可溯源）
    const oldAssistant = ctx.graph.store.getNode(assistant.id);
    expect(oldAssistant.meta.rolledBack).toBe(true);
    expect(oldAssistant.meta.active).toBe(false);
    // 活跃 head 是分支点
    expect(ctx.graph.store.getActiveHead(session.id)?.id).toBe(branchPoint.id);

    await runtime.stop();
  });
});
