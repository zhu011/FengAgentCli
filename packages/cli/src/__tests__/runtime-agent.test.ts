/**
 * @fengagent/cli — RuntimeAgent（createRuntime 装配）测试（Phase 2/4 覆盖验收）
 *
 * 验证：
 * 1. prompt 经 ctx.loop：对话沉淀为图节点（可溯源）；
 * 2. rollback：回退到父节点、旧分支作废保留、会话消息截断；
 * 3. rollbackAndRetry：回退后自动重答，新回答挂在分支点下；
 * 4. reloadProvider 经 ctx.model.switchProvider 热切换（/model、/provider 底座）。
 */

import { describe, expect, test, afterEach } from "bun:test";
import type { LLMClient, LLMEvent } from "@fengagent/llm";
import type { Message, Session, ToolDefinition } from "@fengagent/core";
import { ConfigSchema, createUserMessage } from "@fengagent/core";
import type { ContextManager } from "@fengagent/context";
import { createToolRegistry } from "@fengagent/tools";
import { createPermissionChecker, createHookRegistry, createToolExecutor } from "@fengagent/tools";
import { createRuntime } from "../../../cordis/src/runtime.ts";
import { BUILTIN_PLUGINS } from "../../../cordis/src/types.ts";
import { MemoryGraphStore } from "../../../graph/src/index.ts";
import { RuntimeAgent, reloadProvider, createRuntimeAgent } from "../create-runtime-agent.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "feng-runtime-agent-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs.length = 0;
});

/** 模拟 LLM：文本回复 */
function createMockClient(): LLMClient {
  async function* stream(): AsyncGenerator<LLMEvent> {
    yield { type: "text-delta", text: "运行时助手回复" };
    yield { type: "finish", reason: "end_turn" };
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

function createMockContextManager(): ContextManager {
  return {
    async assemble(session: Session) {
      return { system: "你是测试助手。", messages: session.messages, tokenCount: 10 };
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
    invalidateSystemPrompt() {},
  };
}

function makeMemoryStore() {
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
    id: "session-runtime-agent-test",
    title: "test",
    model: "mock-model",
    status: "idle",
    messages: messages ?? [],
    tokenCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** 构造 RuntimeAgent（mock 模型 + 内存存储 + 图） */
function makeRuntimeAgent(opts: { toolCall?: { name: string; input: unknown }; tools?: ToolDefinition[] } = {}) {
  const workdir = makeTempDir();
  const config = ConfigSchema.parse({});
  const mock = createMockClient();
  const manager = createMockContextManager();
  const sessionStore = makeMemoryStore();
  const graphStore = new MemoryGraphStore();
  const toolRegistry = createToolRegistry();
  for (const t of opts.tools ?? []) toolRegistry.register(t);
  const permissionChecker = createPermissionChecker(workdir);
  const hookRegistry = createHookRegistry();
  const toolExecutor = createToolExecutor(permissionChecker, hookRegistry);

  const runtime = createRuntime({
    workdir,
    plugins: [
      { id: BUILTIN_PLUGINS.MODEL, config: { provider: "mock", model: "mock-model", client: mock } },
      { id: BUILTIN_PLUGINS.TOOLS, config: { registry: toolRegistry } },
      { id: BUILTIN_PLUGINS.STRATEGY },
      { id: BUILTIN_PLUGINS.CONTEXT, config: { manager } },
      { id: BUILTIN_PLUGINS.STORAGE, config: { sessionStore, graph: graphStore } },
      { id: BUILTIN_PLUGINS.GRAPH, config: { store: graphStore } },
      {
        id: BUILTIN_PLUGINS.LOOP,
        config: { config: { maxTurns: 4, maxTokens: 1024, temperature: 0.7 }, workdir },
      },
    ],
  });

  const agent = new RuntimeAgent(runtime, config, {
    llmClient: mock,
    toolRegistry,
    toolExecutor,
    contextManager: manager,
    workdir,
    sessionStore: undefined,
  });
  return { agent, runtime, graphStore, sessionStore, config };
}

describe("RuntimeAgent — 经 createRuntime 装配", () => {
  test("prompt 经 ctx.loop：对话即节点 + 会话持久化", async () => {
    const { agent, runtime } = makeRuntimeAgent();
    await runtime.start();
    const session = makeSession();

    const events: string[] = [];
    for await (const event of agent.prompt("你好", session)) {
      events.push(event.type);
    }

    expect(events).toContain("session-start");
    expect(events).toContain("message-start");
    expect(events).toContain("message-end");
    expect(events).toContain("session-end");

    // 对话即节点：user + assistant 节点沉淀，可溯源
    const graph = agent.getGraphData(session.id);
    expect(graph.nodes.some((n) => n.type === "user")).toBe(true);
    const assistant = graph.nodes.find((n) => n.type === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.parentId).toBeDefined();
    // 溯源链
    expect(graph.chain.length).toBeGreaterThanOrEqual(2);

    // /graph 文本摘要
    expect(agent.formatGraph(session.id)).toContain("对话图节点");
    expect(agent.formatGraph(session.id)).toContain("溯源链");

    // 会话持久化经 ctx.storage
    expect(agent.loadSession(session.id)).not.toBeNull();

    await runtime.stop();
  });

  test("rollback：回退到父节点 + 旧分支作废保留 + 会话截断", async () => {
    const { agent, runtime } = makeRuntimeAgent();
    await runtime.start();
    const session = makeSession();
    for await (const _ of agent.prompt("第一次提问", session)) {
      // 消费一轮
    }

    const graph = agent.getGraphData(session.id);
    const assistant = graph.nodes.find((n) => n.type === "assistant");
    expect(assistant).toBeDefined();
    const messagesBefore = session.messages.length;
    expect(messagesBefore).toBeGreaterThan(0);

    // 回退到该 assistant 节点的父节点（用户提问处）
    const rb = agent.rollback(session, assistant!.id, "回答不好");
    expect(rb.ok).toBe(true);
    expect(rb.rollbackToNode?.type).toBe("user");
    expect(rb.truncatedToMessageId).toBeDefined();

    // 会话消息被截断到用户提问（保留 1 条）
    expect(session.messages.length).toBe(1);
    expect(session.messages[0]!.content.some((b) => b.type === "text")).toBe(true);

    // 旧分支作废但保留（可溯源）
    const after = agent.getGraphData(session.id);
    expect(after.nodes.some((n) => n.type === "branch-point")).toBe(true);
    const oldAssistant = after.nodes.find((n) => n.id === assistant!.id);
    expect(oldAssistant?.meta.rolledBack).toBe(true);
    expect(oldAssistant?.meta.active).toBe(false);
    // 活跃 head 是分支点
    expect(after.activeHead?.type).toBe("branch-point");

    await runtime.stop();
  });

  test("rollbackAndRetry：回退到父节点重答，新回答挂在分支点下", async () => {
    const { agent, runtime } = makeRuntimeAgent();
    await runtime.start();
    const session = makeSession([createUserMessage("再讲一次")]);
    for await (const _ of agent.prompt("再讲一次", session)) {
      // 消费一轮
    }

    const graph1 = agent.getGraphData(session.id);
    const assistant1 = graph1.nodes.find((n) => n.type === "assistant");
    expect(assistant1).toBeDefined();

    // 回退并自动重答
    const retryEvents: string[] = [];
    for await (const event of agent.rollbackAndRetry(session, assistant1!.id, "用户不满意")) {
      retryEvents.push(event.type);
    }
    expect(retryEvents).toContain("session-start");
    expect(retryEvents).toContain("message-start");
    expect(retryEvents).toContain("session-end");

    // 新回答长出分支：两个 assistant 节点，新节点父节点是分支点
    const graph2 = agent.getGraphData(session.id);
    const assistants = graph2.nodes.filter((n) => n.type === "assistant");
    expect(assistants.length).toBe(2);
    const branchPoint = graph2.nodes.find((n) => n.type === "branch-point");
    expect(branchPoint).toBeDefined();
    const newAssistant = assistants.find((n) => n.id !== assistant1!.id);
    expect(newAssistant!.parentId).toBe(branchPoint!.id);
    // 活跃路径上的节点是 用户 → 分支点 → 新回答（可溯源）
    const activeTypes = graph2.activePath.map((n) => n.type);
    expect(activeTypes).toContain("branch-point");
    expect(activeTypes[activeTypes.length - 1]).toBe("assistant");

    await runtime.stop();
  });

  test("reloadProvider 经 ctx.model.switchProvider 热切换（/model、/provider 底座）", async () => {
    const workdir = makeTempDir();
    const env = {
      FENG_PROVIDER: "openai-compatible",
      FENG_MODEL: "model-a",
      OPENAI_COMPATIBLE_API_KEY: "sk-original",
      OPENAI_COMPATIBLE_BASE_URL: "https://api.original.com",
      OPENAI_COMPATIBLE_MODEL: "model-a",
      FENG_MAX_TOKENS: "1024",
    };
    const result = await createRuntimeAgent({
      env,
      workdir,
      enableSessionStore: false,
      cliArgs: { dataDir: workdir },
    });
    await result.runtime.start();

    const originalClient = result.llmClient.getClient();
    const ctx = result.runtime.ctx as unknown as {
      model: { provider: string; model: string };
    };
    expect(ctx.model.provider).toBe("openai-compatible");
    expect(ctx.model.model).toBe("model-a");

    // /model、/provider 同一条链路：reloadProvider → ctx.model.switchProvider
    const newConfig = reloadProvider({
      provider: "openai-compatible",
      openaiCompatibleApiKey: "sk-new-key-123456",
      openaiCompatibleBaseUrl: "https://api.new.com",
      openaiCompatibleModel: "model-b",
      model: "model-b",
    });
    expect(newConfig).not.toBeNull();
    expect(newConfig!.model).toBe("model-b");

    // ctx.model 服务状态同步更新（switchProvider 同步落地）
    expect(ctx.model.provider).toBe("openai-compatible");
    expect(ctx.model.model).toBe("model-b");

    // 底层 LLM Client 已被替换（热加载），Agent 无需重建
    expect(result.llmClient.getClient()).not.toBe(originalClient);

    await result.runtime.stop();
  });
});
