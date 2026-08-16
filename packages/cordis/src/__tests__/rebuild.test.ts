/**
 * @fengagent/cordis — 重建服务集成测试（Phase 3 ②）
 *
 * 验证生产装配（与 create-runtime-agent.ts 同形）：
 * 1. feng.events + feng.rebuild 插件加载后 ctx.rebuild 可用；
 * 2. 「以事件为准重建」：真实 SQLite SessionStore（裸读模型，不传双写）被
 *    摧毁后经 ctx.rebuild.session() 全量投影重写（title/status/meta，#3 不丢），
 *    重建后 reconcile 逐条等价（绿）；
 * 3. 重建绝不追加事件（ctx.eventLog 重放长度不变，脱双写依赖）；
 * 4. ctx.rebuild.all({prune:true}) 删除事件日志中不存在的遗留会话。
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@fengagent/agent/session";
import { createSession, createUserMessage } from "@fengagent/core";
import type { Message, Session } from "@fengagent/core";
import {
  DualWriteSessionStore,
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

/** 模拟运行时 prompt() 写路径：一轮对话双写（用户 → 助手） */
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

/** 与 create-runtime-agent.ts 同形的生产装配（EVENTS + REBUILD；sessionStore 传裸读模型） */
function createRebuildRuntime(dir: string, eventStore: EventStore, legacy: SessionStore) {
  return createRuntime({
    workdir: dir,
    plugins: [
      { id: BUILTIN_PLUGINS.EVENTS, config: { store: eventStore } },
      { id: BUILTIN_PLUGINS.REBUILD, config: { store: eventStore, sessionStore: legacy } },
    ],
  });
}

describe("ctx.rebuild 服务（Phase 3 ② 以事件为准重建）", () => {
  test("生产装配：读模型被摧毁后经 ctx.rebuild.session() 全量重建（#3 不丢），对账绿", async () => {
    const dir = tmpDir("cordis-rebuild-");
    const eventStore = new EventStore({ dir: join(dir, "events") });
    const legacy = new SessionStore(join(dir, "sessions.db"));
    cleanups.push(() => legacy.close());

    // 双写写路径（生产同链路）：两轮 + 标题变更
    const dual = new DualWriteSessionStore({ legacy, events: eventStore, model: "deepseek-chat" });
    const session = createSession("deepseek-chat", "初始标题");
    runOneTurn(dual, session, "第一问", "第一答", 60);
    runOneTurn(dual, session, "第二问", "第二答", 150);
    session.title = "重建后的标题";
    session.updatedAt = Date.now();
    dual.saveSession(session);

    const eventCountBefore = eventStore.replay(session.id).length;

    const runtime = createRebuildRuntime(dir, eventStore, legacy);
    await runtime.start();
    try {
      // 摧毁读模型（模拟 SQLite 丢失/损坏）— 只保留事件日志
      legacy.deleteSession(session.id);
      expect(legacy.loadSession(session.id)).toBeNull();

      // 以事件为准重建（经 ctx.rebuild，脱双写依赖）
      const r = runtime.ctx.rebuild.session(session.id);
      expect(r.ok).toBe(true);
      const restored = legacy.loadSession(session.id)!;
      expect(restored.title).toBe("重建后的标题");
      expect(restored.model).toBe("deepseek-chat");
      expect(restored.tokenCount).toBe(150);
      expect(restored.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

      // 重建即对账：投影 === 读模型（绿）
      const rc = reconcileSession(eventStore, legacy, session.id);
      expect(rc.diffs).toEqual([]);
      expect(rc.ok).toBe(true);
      expect(verifyEventChain(eventStore.replay(session.id))).toEqual([]);

      // 重建绝不追加事件（事件日志长度不变，脱双写依赖）
      expect(eventStore.replay(session.id).length).toBe(eventCountBefore);
    } finally {
      await runtime.stop();
    }
  });

  test("ctx.rebuild.all({prune:true})：删除事件日志中不存在的遗留会话，批量重建对账绿", async () => {
    const dir = tmpDir("cordis-rebuild-all-");
    const eventStore = new EventStore({ dir: join(dir, "events") });
    const legacy = new SessionStore(join(dir, "sessions.db"));
    cleanups.push(() => legacy.close());

    const dual = new DualWriteSessionStore({ legacy, events: eventStore, model: "m" });
    const session = createSession("m", "有事件");
    runOneTurn(dual, session, "问", "答", 10);
    // 遗留孤儿会话（无事件）
    const orphan = createSession("m", "孤儿");
    legacy.saveSession(orphan);

    const runtime = createRebuildRuntime(dir, eventStore, legacy);
    await runtime.start();
    try {
      const summary = runtime.ctx.rebuild.all({ prune: true });
      expect(summary.rebuilt).toContain(session.id);
      expect(summary.pruned).toContain(orphan.id);
      expect(legacy.loadSession(orphan.id)).toBeNull();
      expect(legacy.loadSession(session.id)).not.toBeNull();
      expect(reconcileAll(eventStore, legacy).ok).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  test("无事件会话：ctx.rebuild.session() → ok=false reason=no-events", async () => {
    const dir = tmpDir("cordis-rebuild-none-");
    const eventStore = new EventStore({ dir: join(dir, "events") });
    const legacy = new SessionStore(join(dir, "sessions.db"));
    cleanups.push(() => legacy.close());

    const runtime = createRebuildRuntime(dir, eventStore, legacy);
    await runtime.start();
    try {
      const r = runtime.ctx.rebuild.session("ghost-session");
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("no-events");
    } finally {
      await runtime.stop();
    }
  });
});
