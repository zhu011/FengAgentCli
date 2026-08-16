/**
 * @fengagent/server — 对话图 / 回退 端点测试（Phase 3/4）
 *
 * 验证：
 * 1. GET /api/sessions/:id/graph — 返回节点/分支/溯源链（分支可视化数据源）；
 * 2. POST /api/sessions/:id/rollback — 回退到目标节点，旧分支作废保留、会话截断；
 * 3. 未接入 Graph 机制的 Agent（普通 Agent）→ graph 端点返回 404。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { Agent } from "@fengagent/agent";
import type { Config, Session, SessionMeta, AgentEvent } from "@fengagent/core";
import { createUserMessage } from "@fengagent/core";
import { MemoryGraphStore } from "../../../graph/src/index.ts";
import type { ConversationNode } from "../../../graph/src/types.ts";
import { createApp } from "../server.ts";

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

/** 图后端 Agent 假实现 — 复刻 RuntimeAgent 的 getGraphData / rollback（服务器管线路由） */
class GraphBackedAgent {
  constructor(
    private store: MemoryGraphStore,
    private session: Session,
  ) {}

  createSession(_title?: string): Session {
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

  async compactSession(_session: Session) {
    return { summary: "", recentCount: 0, beforeTokens: 0, afterTokens: 0 };
  }

  getGraphData(sessionId: string) {
    const nodes = this.store.listNodes(sessionId);
    const activePath = this.store.getActivePath(sessionId);
    const activeHead = this.store.getActiveHead(sessionId);
    const chain = activeHead ? this.store.getChain(activeHead.id) : [];
    return { nodes, activePath, activeHead, chain };
  }

  rollback(session: Session, nodeId?: string, reason = "用户回退") {
    let target: ConversationNode | undefined;
    if (nodeId) {
      target = this.store.getNode(nodeId);
      if (!target || target.conversationId !== session.id) {
        return { ok: false, message: `节点 ${nodeId} 不存在或不属于当前会话。` };
      }
    } else {
      const active = this.store.getActivePath(session.id);
      target = [...active].reverse().find((n) => n.type === "assistant");
      if (!target) return { ok: false, message: "没有可回退的助手回答节点。" };
    }
    const rollbackTargetId =
      target.type === "assistant" || target.type === "tool" ? target.parentId : target.id;
    if (!rollbackTargetId) return { ok: false, message: "该节点没有父节点可回退。" };
    this.store.markQuality(target.id, "poor", reason);
    const result = this.store.rollbackTo(rollbackTargetId, reason);
    if (!result) return { ok: false, message: "回退失败。" };
    let truncatedToMessageId: string | undefined;
    const idx = session.messages.findIndex((m) => m.id === result.target.messageId);
    if (idx !== -1) {
      session.messages = session.messages.slice(0, idx + 1);
      truncatedToMessageId = result.target.messageId;
    }
    return {
      ok: true,
      message: "已回退（测试假实现）",
      target,
      rollbackToNode: result.target,
      truncatedToMessageId,
    };
  }
}

/** 通过 createApp 构造测试用 Hono app + SessionManager */
function makeApp(session: Session) {
  const store = new MemoryGraphStore();
  const graphAgent = new GraphBackedAgent(store, session);
  const config = createTestConfig();
  const { app, sessionManager } = createApp({
    config,
    createAgent: () => graphAgent as unknown as Agent,
  });
  return { app, sessionManager, store, graphAgent };
}

function makeSession(): Session {
  return {
    id: "session-graph-test",
    title: "graph test",
    model: "test-model",
    status: "idle",
    messages: [],
    tokenCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("对话图 / 回退 端点（Phase 3/4）", () => {
  let session: Session;

  beforeEach(() => {
    session = makeSession();
  });

  test("GET /api/sessions/:id/graph 返回图数据（节点/活跃路径/溯源链）", async () => {
    const { app, sessionManager, store } = makeApp(session);
    sessionManager.createSession("graph test");

    const userMsg = createUserMessage("你好");
    session.messages.push(userMsg);
    const userNode = store.createRootNode(session.id, userMsg.id, "user");
    const assistantNode = store.createNode(session.id, "msg-assistant-1", "assistant", {
      model: "test-model",
      quality: "unrated",
    });

    const res = await app.request(`/api/sessions/${session.id}/graph`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: ConversationNode[];
      activePath: ConversationNode[];
      activeHead: ConversationNode | undefined;
      chain: ConversationNode[];
    };
    expect(body.nodes.length).toBe(2);
    expect(body.nodes.some((n) => n.type === "user")).toBe(true);
    expect(body.nodes.some((n) => n.type === "assistant")).toBe(true);
    expect(body.activeHead?.id).toBe(assistantNode.id);
    // 溯源链：user → assistant
    expect(body.chain.map((n) => n.id)).toEqual([userNode.id, assistantNode.id]);
  });

  test("POST /api/sessions/:id/rollback 回退到父节点（旧分支保留 + 会话截断）", async () => {
    const { app, sessionManager, store } = makeApp(session);
    sessionManager.createSession("graph test");

    const userMsg = createUserMessage("回答我");
    session.messages.push(userMsg);
    store.createRootNode(session.id, userMsg.id, "user");
    const assistantNode = store.createNode(session.id, "msg-assistant-1", "assistant");

    // 回退该 assistant 节点 → 其父节点（用户提问处）
    const res = await app.request(`/api/sessions/${session.id}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: assistantNode.id, reason: "回答不好" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      rollbackToNode?: ConversationNode;
      graph?: { nodes: ConversationNode[]; activeHead?: ConversationNode };
    };
    expect(body.ok).toBe(true);
    expect(body.rollbackToNode?.type).toBe("user");
    // 会话被截断到用户提问
    expect(session.messages.length).toBe(1);
    // 图中出现分支点，旧 assistant 作废保留
    expect(body.graph?.nodes.some((n) => n.type === "branch-point")).toBe(true);
    const oldAssistant = body.graph?.nodes.find((n) => n.id === assistantNode.id);
    expect(oldAssistant?.meta.rolledBack).toBe(true);
    expect(oldAssistant?.meta.active).toBe(false);
    // 活跃 head 是分支点
    expect(body.graph?.activeHead?.type).toBe("branch-point");
  });

  test("普通 Agent（无 Graph 机制）→ graph 端点 404", async () => {
    // 不带任何 graph 能力的 agent 工厂
    const config = createTestConfig();
    const { app: plainApp } = createApp({
      config,
      createAgent: () =>
        ({
          createSession: () => makeSession(),
          getGraphData: undefined,
          rollback: undefined,
        }) as unknown as Agent,
    });
    const res1 = await plainApp.request(`/api/sessions/some-session/graph`);
    expect(res1.status).toBe(404);
  });
});
