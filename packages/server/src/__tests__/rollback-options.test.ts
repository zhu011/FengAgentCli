/**
 * @fengagent/server — 回退/续跑增量选项的 HTTP 契约测试（AGE-29 图三件套 ①②）
 *
 * 覆盖：
 * 1. POST /rollback 带 `granularity: "step"` → 透传到 Agent 的 rollback 选项；
 * 2. POST /rollback-retry 带 `granularity: "step"` + `toolOverride` →
 *    透传为 `toolOverrides`（改参真正到达执行链路入口），且 SSE 正常收尾；
 * 3. 老客户端（不带任何新字段）→ 选项为空，行为与现状一致（向后兼容）。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { Agent } from "@fengagent/agent";
import type { Config, Session, SessionMeta, AgentEvent } from "@fengagent/core";
import { createUserMessage } from "@fengagent/core";
import { MemoryGraphStore } from "../../../graph/src/index.ts";
import type { ConversationNode } from "../../../graph/src/types.ts";
import type { RollbackRunOptions } from "../session-manager.ts";
import { createApp } from "../server.ts";

function createTestConfig(): Config {
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
  };
}

/** 记录回退选项的图后端假实现（复刻 RuntimeAgent 的图能力面） */
class RecordingGraphAgent {
  /** rollback 收到的选项（每次调用追加） */
  rollbackOptions: RollbackRunOptions[] = [];
  /** rollbackAndRetry 收到的选项 */
  retryOptions: Array<
    | {
        granularity?: "turn" | "step";
        mode?: "replay" | "resume";
        toolOverrides?: unknown[];
      }
    | undefined
  > = [];

  constructor(
    private store: MemoryGraphStore,
    private session: Session,
  ) {}

  createSession(): Session {
    return this.session;
  }

  loadSession(id: string): Session | null {
    return id === this.session.id ? this.session : null;
  }

  listSessions(): SessionMeta[] {
    return [
      {
        id: this.session.id,
        title: this.session.title,
        model: this.session.model,
        status: this.session.status,
        tokenCount: this.session.tokenCount,
        createdAt: this.session.createdAt,
        updatedAt: this.session.updatedAt,
      },
    ];
  }

  getToolNames(): string[] {
    return [];
  }

  getConfig(): Config {
    return createTestConfig();
  }

  async *prompt(): AsyncGenerator<AgentEvent> {
    yield { type: "session-start", session: this.session };
    yield { type: "session-end" };
  }

  async compactSession() {
    return { summary: "", recentCount: 0, beforeTokens: 0, afterTokens: 0 };
  }

  getGraphData(sessionId: string) {
    const nodes = this.store.listNodes(sessionId);
    const activePath = this.store.getActivePath(sessionId);
    const activeHead = this.store.getActiveHead(sessionId);
    const chain = activeHead ? this.store.getChain(activeHead.id) : [];
    return { nodes, activePath, activeHead, chain };
  }

  rollback(
    session: Session,
    nodeId?: string,
    _reason = "用户回退",
    options: RollbackRunOptions = {},
  ) {
    this.rollbackOptions.push(options);
    const target = nodeId
      ? this.store.getNode(nodeId)
      : [...this.store.getActivePath(session.id)].reverse().find((n) => n.type === "assistant");
    if (!target) return { ok: false, message: "没有可回退的节点。", granularity: "turn" as const, mode: "replay" as const };
    return {
      ok: true,
      message: "已回退（测试假实现）",
      target,
      rollbackToNode: target,
      truncatedToMessageId: target.messageId,
      granularity: options.granularity ?? ("turn" as const),
      mode: "replay" as const,
    };
  }

  async *rollbackAndRetry(
    session: Session,
    nodeId?: string,
    _reason = "用户回退并重答",
    options?: {
      granularity?: "turn" | "step";
      mode?: "replay" | "resume";
      toolOverrides?: unknown[];
    },
  ): AsyncGenerator<AgentEvent> {
    this.retryOptions.push(options);
    const rb = this.rollback(session, nodeId);
    if (!rb.ok) {
      yield { type: "error", error: { message: rb.message } };
      return;
    }
    yield { type: "session-start", session };
    yield { type: "message-start", messageId: "msg-1", role: "assistant" };
    yield { type: "text-delta", messageId: "msg-1", text: "重答（测试）" };
    yield { type: "message-end", messageId: "msg-1" };
    yield { type: "turn-end", reason: "end_turn" };
    yield { type: "session-end" };
  }
}

function makeSession(): Session {
  return {
    id: "session-rollback-options",
    title: "rollback options",
    model: "test-model",
    status: "idle",
    messages: [],
    tokenCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeApp(session: Session) {
  const store = new MemoryGraphStore();
  const graphAgent = new RecordingGraphAgent(store, session);
  const { app, sessionManager } = createApp({
    config: createTestConfig(),
    createAgent: () => graphAgent as unknown as Agent,
  });
  sessionManager.createSession("rollback options");
  return { app, sessionManager, store, graphAgent };
}

/** 建一轮带工具步的图：q → a1（工具步）→ t1（工具结果） */
function seedRound(
  store: MemoryGraphStore,
  session: Session,
): { question: ConversationNode; step: ConversationNode; toolResult: ConversationNode } {
  const userMsg = createUserMessage("查目录");
  session.messages.push(userMsg);
  const question = store.createRootNode(session.id, userMsg.id, "user");
  const step = store.createNode(session.id, "msg-a1", "assistant", { model: "test-model" });
  const toolResult = store.createNode(session.id, "msg-t1", "user");
  return { question, step, toolResult };
}

describe("回退/续跑端点 — 增量选项透传", () => {
  let session: Session;

  beforeEach(() => {
    session = makeSession();
  });

  test("POST /rollback 带 granularity=step → 透传到 Agent（默认仍是 turn）", async () => {
    const { app, store, graphAgent } = makeApp(session);
    const { step } = seedRound(store, session);

    const res = await app.request(`/api/sessions/${session.id}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: step.id, granularity: "step" }),
    });

    expect(res.status).toBe(200);
    expect(graphAgent.rollbackOptions).toEqual([{ granularity: "step" }]);
  });

  test("POST /rollback 不带新字段 → 选项为空（向后兼容）", async () => {
    const { app, store, graphAgent } = makeApp(session);
    const { step } = seedRound(store, session);

    await app.request(`/api/sessions/${session.id}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: step.id }),
    });

    expect(graphAgent.rollbackOptions).toEqual([{}]);
  });

  test("POST /rollback-retry 带 toolOverride → 透传为 toolOverrides，改参到达执行链路入口", async () => {
    const { app, store, graphAgent } = makeApp(session);
    const { step } = seedRound(store, session);

    const res = await app.request(`/api/sessions/${session.id}/rollback-retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: step.id,
        granularity: "step",
        toolOverride: {
          toolName: "bash",
          from: { command: "ls" },
          to: { command: "ls -la" },
        },
      }),
    });

    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).toContain("event: session-end");

    expect(graphAgent.retryOptions).toHaveLength(1);
    expect(graphAgent.retryOptions[0]!.granularity).toBe("step");
    expect(graphAgent.retryOptions[0]!.toolOverrides).toEqual([
      { toolName: "bash", from: { command: "ls" }, to: { command: "ls -la" } },
    ]);
  });

  test("POST /rollback-retry 带 mode=replay → 透传（改参重放必须重放该步）", async () => {
    const { app, store, graphAgent } = makeApp(session);
    const { step } = seedRound(store, session);

    await app.request(`/api/sessions/${session.id}/rollback-retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: step.id,
        granularity: "step",
        mode: "replay",
        toolOverride: { toolName: "bash", to: { command: "pwd" } },
      }),
    });

    expect(graphAgent.retryOptions[0]!.granularity).toBe("step");
    expect(graphAgent.retryOptions[0]!.mode).toBe("replay");
  });

  test("POST /rollback-retry 非法 toolOverride（缺 to）→ 忽略而非报错", async () => {    const { app, store, graphAgent } = makeApp(session);
    const { step } = seedRound(store, session);

    const res = await app.request(`/api/sessions/${session.id}/rollback-retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: step.id, toolOverride: { toolName: "bash" } }),
    });

    expect(res.status).toBe(200);
    expect(graphAgent.retryOptions[0]!.toolOverrides).toBeUndefined();
  });
});
