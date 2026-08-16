/**
 * @fengagent/cordis — 事件服务集成测试（Phase 1）
 *
 * 验证：
 * 1. feng.events 插件加载后 ctx.eventLog 可用（写路径/重放/自愈/注册表）；
 * 2. ctx.eventLog.register() 注册的自定义类型可 append（运行时校验走注册表）；
 * 3. isSessionEvent 走 ctx.eventLog 注册表；
 * 4. **生产级双写对账门槛**：真实 SQLite SessionStore（@fengagent/agent）+
 *    DualWriteSessionStore + EventStore → reconcile 逐条等价（绿）。
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@fengagent/agent/session";
import { createSession, createUserMessage } from "@fengagent/core";
import type { Message, Session } from "@fengagent/core";
import {
  DualWriteSessionStore,
  EventGraphStore,
  EventStore,
  reconcileAll,
  reconcileSession,
  verifyEventChain,
} from "@fengagent/events";
import { createRuntime } from "../runtime.ts";
import { BUILTIN_PLUGINS } from "../types.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 只加载事件插件的运行时（隔离测试） */
function createEventsRuntime(dir: string) {
  const runtime = createRuntime({
    workdir: ".",
    plugins: [{ id: BUILTIN_PLUGINS.EVENTS, config: { dir } }],
  });
  return runtime;
}

/** 模拟运行时 prompt() 写路径：一轮对话双写 */
function runOneTurn(
  dual: DualWriteSessionStore,
  session: Session,
  userText: string,
  assistantText: string,
  tokenCount: number,
) {
  session.status = "running";
  session.updatedAt = Date.now();
  dual.saveSession(session);

  const userMsg = createUserMessage(userText);
  session.messages.push(userMsg);
  session.updatedAt = Date.now();
  dual.saveSession(session);
  dual.saveMessage(session.id, userMsg);

  const assistantMsg: Message = {
    id: `a-${tokenCount}`,
    role: "assistant",
    content: [{ type: "text", text: assistantText }],
    createdAt: Date.now(),
  };
  session.messages.push(assistantMsg);
  session.tokenCount = tokenCount;
  session.updatedAt = Date.now();
  session.status = "idle";
  dual.saveSession(session);
  dual.saveMessages(session.id, session.messages);
}

describe("ctx.eventLog 服务（Phase 1 写路径/重放/自愈/注册表）", () => {
  test("feng.events 插件加载后 ctx.eventLog 可用，append/replay 落 events/{sessionId}.jsonl", async () => {
    const dir = tmpDir("cordis-events-");
    const runtime = createEventsRuntime(dir);
    await runtime.start();
    try {
      const ev = runtime.ctx.eventLog.append({
        sessionId: "s1",
        type: "session/created",
        payload: { title: "t", status: "created" },
        timestamp: "2026-08-16T00:00:00.000Z",
      });
      expect(ev.seq).toBe(1);
      expect(runtime.ctx.eventLog.pathFor("s1")).toBe(join(dir, "s1.jsonl"));
      expect(runtime.ctx.eventLog.replay("s1")).toHaveLength(1);
      expect(runtime.ctx.eventLog.store.registry.has("session/created")).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  test("ctx.eventLog.register() 注册自定义类型后 append 放行（#1 运行时注册表）", async () => {
    const dir = tmpDir("cordis-events-reg-");
    const runtime = createEventsRuntime(dir);
    await runtime.start();
    try {
      // 未注册 → 拒绝
      expect(() =>
        runtime.ctx.eventLog.append({ sessionId: "s1", type: "plugin/foo", payload: {} }),
      ).toThrow(/未注册或校验失败/);
      // 经 ctx.eventLog.register() 注册 → 放行
      runtime.ctx.eventLog.register("plugin/foo", (e) => e.payload !== null);
      const ev = runtime.ctx.eventLog.append({ sessionId: "s1", type: "plugin/foo", payload: { ok: true } });
      expect(ev.seq).toBe(1);
      expect(runtime.ctx.eventLog.isSessionEvent(ev)).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  test("ctx.eventLog.healTail 自愈尾部半行", async () => {
    const dir = tmpDir("cordis-events-heal-");
    const runtime = createEventsRuntime(dir);
    await runtime.start();
    try {
      runtime.ctx.eventLog.append({ sessionId: "s1", type: "session/created", payload: { title: "t", status: "created" } });
      const { appendFileSync } = await import("node:fs");
      appendFileSync(runtime.ctx.eventLog.pathFor("s1"), '{"partial":', "utf8");
      expect(runtime.ctx.eventLog.healTail("s1")).toBeGreaterThan(0);
      expect(runtime.ctx.eventLog.replay("s1")).toHaveLength(1);
    } finally {
      await runtime.stop();
    }
  });

  test("生产级双写对账门槛：真实 SQLite SessionStore + 事件日志逐条等价（绿）", async () => {
    const dir = tmpDir("cordis-gate-");
    const runtime = createEventsRuntime(join(dir, "events"));
    await runtime.start();
    try {
      const legacy = new SessionStore(join(dir, "sessions.db"));
      cleanups.push(() => legacy.close());
      const dual = new DualWriteSessionStore({
        legacy,
        events: runtime.ctx.eventLog.store,
        model: "deepseek-chat",
      });

      // 模拟两轮对话（含标题变更）
      const session = createSession("deepseek-chat", "初始会话");
      runOneTurn(dual, session, "第一问", "第一答", 60);
      runOneTurn(dual, session, "第二问", "第二答", 150);
      session.title = "改名";
      session.updatedAt = Date.now();
      dual.saveSession(session);

      // 门槛：投影 === 旧 SQLite 逐条等价（绿）
      const r = reconcileSession(runtime.ctx.eventLog.store, legacy, session.id);
      expect(r.diffs).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.projected!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(r.projected!.title).toBe("改名");
      expect(r.projected!.tokenCount).toBe(150);
      expect(verifyEventChain(runtime.ctx.eventLog.replay(session.id))).toEqual([]);

      // 批量对账（真实 SessionStore.listSessions）
      const all = reconcileAll(runtime.ctx.eventLog.store, legacy);
      expect(all.ok).toBe(true);
      expect(all.total).toBe(1);
    } finally {
      await runtime.stop();
    }
  });

  test("Phase 2 生产装配：STORAGE 双写 + EventGraphStore 装配，rollback 后对账仍绿 + graph.jsonl 派生视图", async () => {
    const dir = tmpDir("cordis-phase2-");
    const dataDir = join(dir, "data");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dataDir, { recursive: true });
    const eventStore = new EventStore({ dir: join(dataDir, "events") });
    const legacy = new SessionStore(join(dataDir, "sessions.db"));
    cleanups.push(() => legacy.close());
    const dual = new DualWriteSessionStore({
      legacy,
      events: eventStore,
      model: "deepseek-chat",
    });
    const graph = new EventGraphStore({
      events: eventStore,
      persistPath: join(dataDir, "graph.jsonl"),
    });

    // 与 create-runtime-agent.ts 相同的插件装配（STORAGE 包一层 DualWrite + EventGraphStore）
    const runtime = createRuntime({
      workdir: dir,
      plugins: [
        { id: BUILTIN_PLUGINS.EVENTS, config: { store: eventStore } },
        {
          id: BUILTIN_PLUGINS.STORAGE,
          config: { sessionStore: dual, graph },
        },
        { id: BUILTIN_PLUGINS.GRAPH, config: { store: graph } },
      ],
    });
    await runtime.start();
    try {
      const ctx = runtime.ctx;
      const session = createSession("deepseek-chat", "装配会话");

      // 模拟 prompt 写路径：首写 → 用户消息 → 回合末整批消息
      session.status = "running";
      session.updatedAt = Date.now();
      ctx.storage.saveSession(session);
      const userMsg = createUserMessage("第一问");
      session.messages.push(userMsg);
      session.updatedAt = Date.now();
      ctx.storage.saveSession(session);
      ctx.storage.saveMessage?.(session.id, userMsg);
      const asstMsg: Message = {
        id: "asst-1",
        role: "assistant",
        content: [{ type: "text", text: "第一答" }],
        createdAt: Date.now(),
      };
      session.messages.push(asstMsg);
      session.tokenCount = 60;
      session.updatedAt = Date.now();
      session.status = "idle";
      ctx.storage.saveSession(session);
      ctx.storage.saveMessages?.(session.id, session.messages);

      // 事件溯源图：节点由消息事件派生
      const userNode = graph.listNodes(session.id).find((n) => n.type === "user");
      const asstNode = graph.listNodes(session.id).find((n) => n.type === "assistant");
      expect(userNode).toBeDefined();
      expect(asstNode).toBeDefined();
      expect(asstNode!.parentId).toBe(userNode!.id);

      // rollback（经 ctx.graph.store，与 RuntimeAgent.rollback 同链路）
      ctx.graph.store.markQuality(asstNode!.id, "poor", "回答不佳");
      const rb = ctx.graph.store.rollbackTo(userNode!.id, "回答不佳");
      expect(rb).toBeDefined();
      expect(rb!.branchPoint.type).toBe("branch-point");
      expect(rb!.superseded).toEqual([asstNode!.id]);

      // 截断消息 + 事件日志为准对齐 updatedAt + 双写（镜像 RuntimeAgent.rollback）
      session.messages = session.messages.slice(0, 1);
      session.tokenCount = 10;
      const evs = ctx.eventLog.replay(session.id);
      session.updatedAt = Date.parse(evs[evs.length - 1]!.timestamp);
      ctx.storage.saveSession(session);
      ctx.storage.saveMessages?.(session.id, session.messages);

      // 门槛：投影 === 旧 SQLite（绿），事件链完整
      const r = reconcileSession(eventStore, legacy, session.id);
      expect(r.diffs).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.projected!.messages.map((m) => m.role)).toEqual(["user"]);
      expect(verifyEventChain(evs)).toEqual([]);

      // 图派生态：旧回答作废、分支点为 head
      expect(graph.getNode(asstNode!.id)!.meta.rolledBack).toBe(true);
      expect(graph.getActiveHead(session.id)?.type).toBe("branch-point");

      // flush → graph.jsonl 派生视图（确定性 id + rolledBack 标记）
      await ctx.storage.flush();
      expect(existsSync(join(dataDir, "graph.jsonl"))).toBe(true);
      const content = readFileSync(join(dataDir, "graph.jsonl"), "utf8");
      expect(content).toContain(userNode!.id);
      expect(content).toContain(asstNode!.id);
      expect(content).toContain('"rolledBack":true');
    } finally {
      await runtime.stop();
    }
  });
});
