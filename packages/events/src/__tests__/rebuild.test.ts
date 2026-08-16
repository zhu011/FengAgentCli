/**
 * @fengagent/events — 「以事件为准重建」测试（Phase 3 ②）
 *
 * 覆盖：
 * 1. 纯事件重建：事件日志 → 全量投影 → 读模型（title/status/meta，#3 不丢）；
 * 2. 脱双写依赖：重建绝不追加事件（事件文件字节级不变）；
 * 3. 重建幂等：重复重建结果一致、对账仍绿；
 * 4. rollback/fork 会话重建：截断语义在重建后读模型正确；
 * 5. prune：删除事件日志中不存在的遗留会话（读模型完全以事件为准）；
 * 6. 无事件会话 → ok=false reason=no-events；
 * 7. 重建到全新读模型（迁移支撑：导入 → 重建 → 对账绿）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, Message, Session, SessionMeta } from "@fengagent/core";
import { createSession, createUserMessage } from "@fengagent/core";
import { EventStore } from "../event-store.ts";
import { EventGraphStore } from "../event-graph-store.ts";
import { DualWriteSessionStore, type SessionStorePort } from "../dual-write.ts";
import { rebuildAll, rebuildSession } from "../rebuild.ts";
import { reconcileAll, reconcileSession } from "../reconcile.ts";
import { verifyEventChain } from "../hash.ts";

/* ------------------------------ 旧存储：真实 SQLite（同 SessionStore schema） ------------------------------ */

class SqliteLegacyStore implements SessionStorePort {
  private db: Database;
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT, model TEXT, status TEXT, token_count INTEGER,
        created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT, role TEXT, content TEXT, created_at INTEGER
      );
    `);
  }
  saveSession(session: Session): void {
    this.db.query(
      `INSERT OR REPLACE INTO sessions (id, title, model, status, token_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(session.id, session.title, session.model, session.status, session.tokenCount, session.createdAt, session.updatedAt);
  }
  saveMessage(sessionId: string, message: Message): void {
    this.db.query(
      `INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(message.id, sessionId, message.role, JSON.stringify(message.content), message.createdAt);
  }
  saveMessages(sessionId: string, messages: Message[]): void {
    for (const m of messages) this.saveMessage(sessionId, m);
  }
  deleteMessages(sessionId: string, keepMessageIds: string[]): void {
    const keep = new Set(keepMessageIds);
    const rows = this.db.query("SELECT id FROM messages WHERE session_id = ?").all(sessionId) as Array<{ id: string }>;
    for (const row of rows) {
      if (!keep.has(row.id)) {
        this.db.query("DELETE FROM messages WHERE id = ?").run(row.id);
      }
    }
  }
  loadSession(id: string): Session | null {
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const rows = this.db.query("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at").all(id) as Array<Record<string, unknown>>;
    return {
      id: row.id as string,
      title: row.title as string,
      model: row.model as string,
      status: row.status as Session["status"],
      tokenCount: row.token_count as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      messages: rows.map((m) => ({
        id: m.id as string,
        role: m.role as Message["role"],
        content: JSON.parse(m.content as string) as ContentBlock[],
        createdAt: m.created_at as number,
      })),
    };
  }
  deleteSession(id: string): void {
    this.db.query("DELETE FROM messages WHERE session_id = ?").run(id);
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
  }
  listSessions(): SessionMeta[] {
    const rows = this.db.query("SELECT * FROM sessions ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      model: r.model as string,
      status: r.status as Session["status"],
      tokenCount: r.token_count as number,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    }));
  }
  close(): void {
    this.db.close();
  }
}

const cleanups: Array<() => void> = [];
const legacyStores: SqliteLegacyStore[] = [];
afterEach(() => {
  while (legacyStores.length) legacyStores.pop()!.close();
  while (cleanups.length) cleanups.pop()!();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(prefix = "rebuild-") {
  const dir = tmpDir(prefix);
  const events = new EventStore({ dir: join(dir, "events") });
  const legacy = new SqliteLegacyStore(join(dir, "sessions.db"));
  legacyStores.push(legacy);
  return { dir, events, legacy };
}

/** 模拟运行时 prompt() 写路径：一轮对话双写 */
function runOneTurn(
  dual: DualWriteSessionStore,
  session: Session,
  userText: string,
  assistantContent: ContentBlock[],
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
    id: `msg-a-${tokenCount}`,
    role: "assistant",
    content: assistantContent,
    createdAt: Date.now(),
  };
  session.messages.push(assistantMsg);
  session.tokenCount = tokenCount;
  session.updatedAt = Date.now();
  session.status = "idle";
  dual.saveSession(session);
  dual.saveMessages(session.id, session.messages);
}

describe("「以事件为准重建」（Phase 3 ②）", () => {
  test("纯事件重建：事件日志 → 全量投影 → 读模型（title/status/meta，#3 不丢）", () => {
    const { events, legacy } = setup();
    const dual = new DualWriteSessionStore({ legacy, events, model: "deepseek-chat" });
    const session = createSession("deepseek-chat", "初始标题");
    runOneTurn(dual, session, "第一问", [{ type: "text", text: "第一答" }], 60);
    runOneTurn(dual, session, "第二问", [{ type: "text", text: "第二答" }], 150);
    // 标题/状态变更（#3 元数据事件）
    session.title = "重建后标题";
    session.status = "running";
    session.updatedAt = Date.now();
    dual.saveSession(session);
    session.status = "idle";
    session.updatedAt = Date.now();
    dual.saveSession(session);

    // 摧毁读模型（模拟 SQLite 丢失/损坏）— 只保留事件日志
    legacy.deleteSession(session.id);

    // 以事件为准重建
    const r = rebuildSession(events, legacy, session.id);
    expect(r.ok).toBe(true);
    expect(r.session!.title).toBe("重建后标题");
    expect(r.session!.status).toBe("idle");
    expect(r.session!.model).toBe("deepseek-chat");
    expect(r.session!.tokenCount).toBe(150);
    expect(r.session!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    // 重建即对账：投影 === 读模型（绿）
    const rc = reconcileSession(events, legacy, session.id);
    expect(rc.diffs).toEqual([]);
    expect(rc.ok).toBe(true);
    expect(verifyEventChain(events.replay(session.id))).toEqual([]);
  });

  test("脱双写依赖：重建绝不追加事件（事件文件字节级不变）", () => {
    const { events, legacy } = setup();
    const dual = new DualWriteSessionStore({ legacy, events, model: "m" });
    const session = createSession("m", "只读事件");
    runOneTurn(dual, session, "问", [{ type: "text", text: "答" }], 42);

    const path = events.pathFor(session.id);
    const before = readFileSync(path, "utf8");
    rebuildSession(events, legacy, session.id);
    rebuildSession(events, legacy, session.id);
    const after = readFileSync(path, "utf8");
    expect(after).toBe(before);
  });

  test("重建幂等：重复重建结果一致，对账仍绿", () => {
    const { events, legacy } = setup();
    const dual = new DualWriteSessionStore({ legacy, events, model: "m" });
    const session = createSession("m", "幂等");
    runOneTurn(dual, session, "问", [{ type: "text", text: "答" }], 42);

    rebuildSession(events, legacy, session.id);
    const first = legacy.loadSession(session.id)!;
    rebuildSession(events, legacy, session.id);
    const second = legacy.loadSession(session.id)!;
    expect(second).toEqual(first);
    expect(reconcileSession(events, legacy, session.id).ok).toBe(true);
  });

  test("rollback 会话重建：截断语义在重建后读模型正确（对账绿）", () => {
    const { events, legacy } = setup();
    const dual = new DualWriteSessionStore({ legacy, events, model: "m" });
    const graph = new EventGraphStore({ events });
    const session = createSession("m", "回退重建");
    runOneTurn(dual, session, "第一问", [{ type: "text", text: "第一答" }], 60);
    runOneTurn(dual, session, "第二问", [{ type: "text", text: "第二答" }], 150);

    // 回退（截断到第二问）+ 重答
    const asst2 = graph.listNodes(session.id).filter((n) => n.type === "assistant")[1]!;
    graph.markQuality(asst2.id, "poor", "不佳");
    const rbNodeId = asst2.parentId!;
    graph.rollbackTo(rbNodeId, "不佳");
    const idx = session.messages.findIndex((m) => m.id === graph.getNode(rbNodeId)!.messageId);
    session.messages = session.messages.slice(0, idx + 1);
    session.tokenCount = 20;
    const evs = events.replay(session.id);
    session.updatedAt = Date.parse(evs[evs.length - 1]!.timestamp);
    dual.saveSession(session);
    dual.saveMessages(session.id, session.messages);
    const retry: Message = { id: "a-retry", role: "assistant", content: [{ type: "text", text: "重答" }], createdAt: Date.now() };
    session.messages.push(retry);
    session.tokenCount = 120;
    session.updatedAt = Date.now();
    dual.saveSession(session);
    dual.saveMessages(session.id, session.messages);

    // 摧毁读模型 → 以事件重建
    legacy.deleteSession(session.id);
    const r = rebuildSession(events, legacy, session.id);
    expect(r.ok).toBe(true);
    expect(r.session!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(r.session!.messages[3]!.id).toBe("a-retry");
    expect(r.session!.tokenCount).toBe(120);
    // 重建即对账绿
    expect(reconcileSession(events, legacy, session.id).diffs).toEqual([]);
  });

  test("prune：删除事件日志中不存在的遗留会话（读模型完全以事件为准）", () => {
    const { events, legacy } = setup();
    const dual = new DualWriteSessionStore({ legacy, events, model: "m" });
    const session = createSession("m", "有事件");
    runOneTurn(dual, session, "问", [{ type: "text", text: "答" }], 10);

    // 遗留孤儿会话（旧数据，事件日志无记录）
    const orphan = createSession("m", "孤儿");
    legacy.saveSession(orphan);

    const summary = rebuildAll(events, legacy, { prune: true });
    expect(summary.rebuilt).toContain(session.id);
    expect(summary.pruned).toContain(orphan.id);
    expect(legacy.loadSession(orphan.id)).toBeNull();
    expect(legacy.loadSession(session.id)).not.toBeNull();
    expect(reconcileAll(events, legacy).ok).toBe(true);
  });

  test("prune=false（默认）：遗留孤儿会话保留", () => {
    const { events, legacy } = setup();
    const dual = new DualWriteSessionStore({ legacy, events, model: "m" });
    const session = createSession("m", "有事件");
    runOneTurn(dual, session, "问", [{ type: "text", text: "答" }], 10);
    const orphan = createSession("m", "孤儿");
    legacy.saveSession(orphan);

    const summary = rebuildAll(events, legacy);
    expect(summary.pruned).toEqual([]);
    expect(legacy.loadSession(orphan.id)).not.toBeNull();
  });

  test("无事件会话 → ok=false reason=no-events；read 模型不动", () => {
    const { events, legacy } = setup();
    const ghost = createSession("m", "幽灵");
    legacy.saveSession(ghost);
    const r = rebuildSession(events, legacy, ghost.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-events");
    // 读模型原样保留（未删未改）
    expect(legacy.loadSession(ghost.id)).not.toBeNull();
  });

  test("重建到全新读模型（迁移支撑：新根导入后重建 → 对账绿）", () => {
    // 源根：双写产生事件
    const { events: srcEvents, legacy: srcLegacy } = setup("rebuild-mig-src-");
    const dual = new DualWriteSessionStore({ legacy: srcLegacy, events: srcEvents, model: "m" });
    const session = createSession("m", "迁移重建");
    runOneTurn(dual, session, "问", [{ type: "text", text: "答" }], 42);
    const srcProjected = srcLegacy.loadSession(session.id)!;

    // 新根：全新事件日志（模拟导出→导入后）— 直接把源事件逐字复制过去
    const { events: dstEvents, legacy: dstLegacy } = setup("rebuild-mig-dst-");
    dstEvents.importEvents(srcEvents.replay(session.id));

    // 新根重建（无任何双写/旧数据）
    const r = rebuildSession(dstEvents, dstLegacy, session.id);
    expect(r.ok).toBe(true);
    // 新根读模型与源读模型一致
    expect(dstLegacy.loadSession(session.id)).toEqual(srcProjected);
    // 新根对账绿
    expect(reconcileSession(dstEvents, dstLegacy, session.id).diffs).toEqual([]);
  });
});
