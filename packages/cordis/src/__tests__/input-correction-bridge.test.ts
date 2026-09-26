/**
 * @fengagent/cordis — 改参事实桥接回归测试（AGE-29 图三件套 ③ 断链修复）
 *
 * 断链现场：`tool-call-result` 在 `loop.ts` 里 yield 的那一刻，助手消息（含
 * tool-use 块）**还没有**被 push 进会话历史（消息在回合内后续步骤才入历史），
 * 桥接原先用 `findToolCall(session, toolUseId)` 回查历史 → 必然 MISS →
 * `recordInputCorrection` 永不落盘 → 图节点 `meta.userCorrectedInput` /
 * `inputCorrections` 永不出现（WebUI「✏️ 已改参」标记永不出现）。
 *
 * 本测试走**生产装配**：`LoopServiceImpl`（`ctx.loop`）+ 真 `ToolExecutor`
 * （createToolExecutor，含入参校验/权限）+ 真 `EventGraphStore`（事件溯源图仓）
 * + `DualWriteSessionStore`（消息双写），跑一次改参工具调用后断言：
 * 1. 事件仓落下 `tool/corrected`，归属（messageId / toolName）与改参前后正确；
 * 2. 该会话的图投影节点带 `meta.userCorrectedInput` + `inputCorrections`；
 * 3. `graph` 来源与缺省 `hitl` 来源**都**能落盘（同一座桥服务两个入口）。
 */

import { describe, expect, test } from "bun:test";
import type { LLMClient, LLMEvent, LLMRequest, LLMResponse } from "@fengagent/llm";
import type { Message, Session, ToolContext, ToolDefinition, ToolResult } from "@fengagent/core";
import { createUserMessage } from "@fengagent/core";
import type { ContextManager } from "@fengagent/context";
import {
  DualWriteSessionStore,
  EventGraphStore,
  EventStore,
} from "@fengagent/events";
import { createToolExecutor } from "@fengagent/tools";
import { createRuntime } from "../runtime.ts";
import { BUILTIN_PLUGINS } from "../types.ts";

/** 确定性模型：第一轮发工具调用，第二轮收尾（不吃真模型波动） */
class ScriptedLLMClient implements LLMClient {
  private callIndex = 0;

  constructor(private readonly responses: LLMEvent[][]) {}

  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    const events = this.responses[this.callIndex] ?? [];
    this.callIndex++;
    for (const event of events) yield event;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    return {
      id: "mock-gen",
      model: request.model,
      content: [{ type: "text", text: "ok" }],
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "end_turn",
    };
  }
}

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

/** 轻量内存会话存储（消息事实仍以事件仓为准，此处只做 legacy 占位） */
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

function makeSession(id: string): Session {
  return {
    id,
    title: "改参桥接回归",
    model: "mock-model",
    status: "idle",
    messages: [],
    tokenCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** 造一个可被改参的工具（executor 会记录它真正收到的入参） */
function createEchoTool(executed: Array<{ text: string }>): ToolDefinition {
  return {
    name: "echo",
    description: "回显输入",
    inputSchema: { parse: (value: unknown) => value },
    async execute(input: { text: string }, _context: ToolContext): Promise<ToolResult> {
      executed.push(input);
      return { content: `echo:${input.text}` };
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  } as unknown as ToolDefinition;
}

/** 生产形态装配：真 executor + 事件溯源图仓 + 消息双写 */
async function setup() {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "cordis-correction-bridge-"));
  mkdirSync(join(dir, "events"), { recursive: true });

  const eventStore = new EventStore({ dir: join(dir, "events") });
  const dual = new DualWriteSessionStore({
    legacy: createMemorySessionStore(),
    events: eventStore,
    model: "mock-model",
  });
  const graph = new EventGraphStore({ events: eventStore });

  const executed: Array<{ text: string }> = [];
  const mock = new ScriptedLLMClient([
    [
      { type: "tool-call", id: "call-1", name: "echo", input: { text: "模型原参" } },
      { type: "finish", reason: "tool_use" },
    ],
    [
      { type: "text-delta", text: "完成" },
      { type: "finish", reason: "end_turn" },
    ],
  ]);

  const runtime = createRuntime({
    workdir: dir,
    plugins: [
      { id: BUILTIN_PLUGINS.MODEL, config: { provider: "mock", model: "mock-model", client: mock } },
      { id: BUILTIN_PLUGINS.TOOLS, config: { tools: [createEchoTool(executed)] } },
      { id: BUILTIN_PLUGINS.STRATEGY },
      { id: BUILTIN_PLUGINS.CONTEXT, config: { manager: createMockContextManager() } },
      { id: BUILTIN_PLUGINS.EVENTS, config: { store: eventStore } },
      { id: BUILTIN_PLUGINS.STORAGE, config: { sessionStore: dual, graph } },
      { id: BUILTIN_PLUGINS.GRAPH, config: { store: graph } },
      {
        id: BUILTIN_PLUGINS.LOOP,
        config: {
          config: { maxTurns: 4, maxTokens: 1024, temperature: 0.7 },
          workdir: dir,
          // 真 executor：入参校验 / 权限 / inputOverrides 改写在此生效
          toolExecutor: createToolExecutor(),
        },
      },
    ],
  });
  await runtime.start();

  return {
    runtime,
    eventStore,
    graph,
    executed,
    cleanup: async () => {
      await runtime.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 会话就绪（镜像 RuntimeAgent.prompt 的首写 + 用户消息写路径） */
function primeSession(ctx: any, session: Session, text: string): void {
  session.status = "running";
  ctx.storage.saveSession(session);
  const userMsg = createUserMessage(text);
  session.messages.push(userMsg);
  ctx.storage.saveSession(session);
  ctx.storage.saveMessage(session.id, userMsg);
}

describe("cordis 改参事实桥接 — tool-call-result → tool/corrected → 图节点", () => {
  test("图上改参（source=graph）：事件仓落 tool/corrected，投影节点标「已改参」", async () => {
    const { runtime, eventStore, graph, executed, cleanup } = await setup();
    try {
      const ctx = runtime.ctx as any;
      const session = makeSession("s-bridge-graph");
      primeSession(ctx, session, "回显一下");

      const seen: Array<{ messageId: string; toolName?: string }> = [];
      for await (const event of ctx.loop.run(session, {
        inputOverrides: [{ toolName: "echo", to: { text: "图上新参" } }],
        correctionSource: "graph",
      })) {
        if (event.type === "tool-call-result") {
          seen.push({ messageId: String(event.messageId), toolName: event.toolName });
        }
      }
      session.status = "idle";
      session.updatedAt = Date.now();
      ctx.storage.saveSession(session);

      // 工具真的以新入参执行
      expect(executed).toEqual([{ text: "图上新参" }]);

      // 事件自带归属（桥接不再依赖「历史里已有 tool-use 块」的时序假设）
      expect(seen).toHaveLength(1);
      expect(typeof seen[0]!.messageId).toBe("string");
      expect(seen[0]!.toolName).toBe("echo");

      // ① 事件仓落下改参事实（断链时这里恒为空）
      const events = eventStore.replay(session.id);
      const corrected = events.filter((e) => e.type === "tool/corrected");
      expect(corrected).toHaveLength(1);
      const payload = corrected[0]!.payload as {
        messageId: string;
        toolUseId: string;
        toolName: string;
        originalInput: unknown;
        correctedInput: unknown;
        source?: string;
      };
      expect(payload.messageId).toBe(seen[0]!.messageId);
      expect(payload.toolUseId).toBe("call-1");
      expect(payload.toolName).toBe("echo");
      expect(payload.originalInput).toEqual({ text: "模型原参" });
      expect(payload.correctedInput).toEqual({ text: "图上新参" });
      expect(payload.source).toBe("graph");

      // ② 图投影节点带上改参标记 + 改参前后（节点由回合收尾的事件派生，
      //    晚于改参事实 —— 投影必须与事件顺序无关）
      const assistant = graph
        .listNodes(session.id)
        .find((n) => n.type === "assistant");
      expect(assistant).toBeDefined();
      expect(assistant!.messageId).toBe(seen[0]!.messageId);
      expect(assistant!.meta.userCorrectedInput).toBe(true);
      const corrections = assistant!.meta.inputCorrections ?? [];
      expect(corrections).toHaveLength(1);
      expect(corrections[0]!.toolName).toBe("echo");
      expect(corrections[0]!.originalInput).toEqual({ text: "模型原参" });
      expect(corrections[0]!.correctedInput).toEqual({ text: "图上新参" });
      expect(corrections[0]!.source).toBe("graph");
      expect(typeof corrections[0]!.seq).toBe("number");
    } finally {
      await cleanup();
    }
  });

  test("HITL 改参（source 缺省）：同一座桥同样落事实（默认 hitl）", async () => {
    const { runtime, eventStore, graph, cleanup } = await setup();
    try {
      const ctx = runtime.ctx as any;
      const session = makeSession("s-bridge-hitl");
      primeSession(ctx, session, "回显一下");

      for await (const _ of ctx.loop.run(session, {
        inputOverrides: [{ toolName: "echo", to: { text: "审批改的新参" } }],
        // correctionSource 缺省 → hitl（审批弹窗改参入口）
      })) {
        // 消费完一轮
      }
      session.status = "idle";
      ctx.storage.saveSession(session);

      const corrected = eventStore
        .replay(session.id)
        .filter((e) => e.type === "tool/corrected");
      expect(corrected).toHaveLength(1);
      expect((corrected[0]!.payload as { source?: string }).source).toBe("hitl");

      const assistant = graph
        .listNodes(session.id)
        .find((n) => n.type === "assistant");
      expect(assistant?.meta.userCorrectedInput).toBe(true);
      expect(assistant?.meta.inputCorrections?.[0]?.source).toBe("hitl");
    } finally {
      await cleanup();
    }
  });

  test("未改参的普通轮次：零额外事实（不落 tool/corrected，节点不误标）", async () => {
    const { runtime, eventStore, graph, cleanup } = await setup();
    try {
      const ctx = runtime.ctx as any;
      const session = makeSession("s-bridge-plain");
      primeSession(ctx, session, "回显一下");

      for await (const _ of ctx.loop.run(session)) {
        // 消费完一轮
      }
      session.status = "idle";
      ctx.storage.saveSession(session);

      expect(eventStore.replay(session.id).filter((e) => e.type === "tool/corrected")).toHaveLength(0);
      const assistant = graph
        .listNodes(session.id)
        .find((n) => n.type === "assistant");
      expect(assistant?.meta.userCorrectedInput).toBeUndefined();
      expect(assistant?.meta.inputCorrections).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
