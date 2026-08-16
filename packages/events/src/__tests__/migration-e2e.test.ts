/**
 * @fengagent/events — 跨数据根 / 跨机迁移端到端测试（Phase 3 ③）
 *
 * 场景：数据根 A（源机）双写产生事件 → 导出可移植文件 → 数据根 B（新机/新根，
 * 事件日志与读模型全新）导入 → 「以事件为准重建」→ 投影与对账一致。
 *
 * 覆盖：
 * 1. 单会话端到端：导出 → 新根导入 → 重建 → 对账绿，两根读模型/投影全等；
 * 2. 跨机模拟：新根读模型为空，重建从零整写（SQLite 完全降级为读模型）；
 * 3. 幂等重跑：重复 导入+重建 无副作用，对账仍绿；
 * 4. 多会话全库迁移（含 rollback/fork 会话）：exportStoreEvents → importStoreEvents
 *    → rebuildAll → reconcileAll 绿，两根 listSessions 全等；
 * 5. 迁移后新根可继续写：续跑一轮对话，事件链无缝续接（seq 连续），对账仍绿。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, Message, Session, SessionMeta } from "@fengagent/core";
import { createSession, createUserMessage } from "@fengagent/core";
import { EventStore } from "../event-store.ts";
import { EventGraphStore } from "../event-graph-store.ts";
import { DualWriteSessionStore, type SessionStorePort } from "../dual-write.ts";
import {
  exportSessionEvents,
  importSessionEvents,
  exportStoreEvents,
  importStoreEvents,
} from "../migration.ts";
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

/* ------------------------------ 数据根装置 ------------------------------ */

/** 一个完整数据根：事件日志 + SQLite 读模型 */
function makeRoot(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const events = new EventStore({ dir: join(dir, "events") });
  const legacy = new SqliteLegacyStore(join(dir, "sessions.db"));
  const dual = new DualWriteSessionStore({ legacy, events, model: "deepseek-chat" });
  return { dir, events, legacy, dual };
}

const cleanups: Array<() => void> = [];
const legacyStores: SqliteLegacyStore[] = [];
afterEach(() => {
  while (legacyStores.length) legacyStores.pop()!.close();
  while (cleanups.length) cleanups.pop()!();
});

function trackRoot(root: ReturnType<typeof makeRoot>) {
  cleanups.push(() => rmSync(root.dir, { recursive: true, force: true }));
  legacyStores.push(root.legacy);
  return root;
}

/** 一轮对话双写（用户 → 助手；助手消息 id 全局唯一，避免跨会话 SQLite 主键冲突） */
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
    id: `msg-a-${crypto.randomUUID()}`,
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

describe("跨数据根/跨机迁移端到端（Phase 3 ③）", () => {
  test("单会话端到端：导出(源根) → 导入(新根) → 重建 → 对账绿，两根读模型/投影全等", () => {
    // 源根 A：两轮 + 标题变更
    const rootA = trackRoot(makeRoot("e2e-a-"));
    const sessionA = createSession("deepseek-chat", "初始标题");
    runOneTurn(rootA.dual, sessionA, "第一问", [{ type: "text", text: "第一答" }], 60);
    runOneTurn(rootA.dual, sessionA, "第二问", [{ type: "text", text: "第二答" }], 150);
    sessionA.title = "迁移后的标题";
    sessionA.updatedAt = Date.now();
    rootA.dual.saveSession(sessionA);
    expect(reconcileSession(rootA.events, rootA.legacy, sessionA.id).ok).toBe(true);

    // 导出可移植文件
    const exportDir = mkdtempSync(join(tmpdir(), "e2e-export-"));
    cleanups.push(() => rmSync(exportDir, { recursive: true, force: true }));
    const filePath = join(exportDir, "session.fengevents.jsonl");
    exportSessionEvents(rootA.events, sessionA.id, filePath);

    // 新根 B（跨机：全新事件日志 + 全新读模型）
    const rootB = trackRoot(makeRoot("e2e-b-"));

    // 导入 → 以事件为准重建
    const outcome = importSessionEvents(rootB.events, filePath);
    expect(outcome.status).toBe("imported");
    const rebuild = rebuildSession(rootB.events, rootB.legacy, sessionA.id);
    expect(rebuild.ok).toBe(true);

    // 对账绿（新根）
    const rc = reconcileSession(rootB.events, rootB.legacy, sessionA.id);
    expect(rc.diffs).toEqual([]);
    expect(rc.ok).toBe(true);

    // 两根读模型全等（标题/状态/meta/消息逐条）
    expect(rootB.legacy.loadSession(sessionA.id)).toEqual(rootA.legacy.loadSession(sessionA.id));
    // 两根事件日志全等（含 #5 hash 链）
    expect(rootB.events.replay(sessionA.id)).toEqual(rootA.events.replay(sessionA.id));
    expect(verifyEventChain(rootB.events.replay(sessionA.id))).toEqual([]);
  });

  test("跨机模拟：新根读模型为空，重建从零整写（SQLite 完全降级为读模型）", () => {
    const rootA = trackRoot(makeRoot("e2e-clean-a-"));
    const sessionA = createSession("deepseek-chat", "干净迁移");
    runOneTurn(rootA.dual, sessionA, "问", [{ type: "text", text: "答" }], 42);

    const exportDir = mkdtempSync(join(tmpdir(), "e2e-clean-export-"));
    cleanups.push(() => rmSync(exportDir, { recursive: true, force: true }));
    const filePath = join(exportDir, "s.fengevents.jsonl");
    exportSessionEvents(rootA.events, sessionA.id, filePath);

    // 新根 B：事件日志导入前为空、读模型无任何行
    const rootB = trackRoot(makeRoot("e2e-clean-b-"));
    expect(rootB.legacy.listSessions()).toEqual([]);
    expect(rootB.events.listSessionIds()).toEqual([]);

    importSessionEvents(rootB.events, filePath);
    const r = rebuildSession(rootB.events, rootB.legacy, sessionA.id);
    expect(r.ok).toBe(true);
    // 从零整写完整会话（#3：title/status/model/tokenCount + messages）
    const restored = rootB.legacy.loadSession(sessionA.id)!;
    expect(restored).toEqual(rootA.legacy.loadSession(sessionA.id)!);
    expect(reconcileAll(rootB.events, rootB.legacy).ok).toBe(true);
  });

  test("幂等重跑：重复 导入+重建 无副作用，对账仍绿", () => {
    const rootA = trackRoot(makeRoot("e2e-idem-a-"));
    const sessionA = createSession("deepseek-chat", "幂等迁移");
    runOneTurn(rootA.dual, sessionA, "问", [{ type: "text", text: "答" }], 42);

    const exportDir = mkdtempSync(join(tmpdir(), "e2e-idem-export-"));
    cleanups.push(() => rmSync(exportDir, { recursive: true, force: true }));
    const filePath = join(exportDir, "s.fengevents.jsonl");
    exportSessionEvents(rootA.events, sessionA.id, filePath);

    const rootB = trackRoot(makeRoot("e2e-idem-b-"));
    // 第一遍
    importSessionEvents(rootB.events, filePath);
    rebuildSession(rootB.events, rootB.legacy, sessionA.id);
    const snapshot = rootB.legacy.loadSession(sessionA.id);
    const fileBytes = rootB.events.replay(sessionA.id);

    // 第二遍（重跑迁移）→ 导入 noop、重建幂等
    const again = importSessionEvents(rootB.events, filePath);
    expect(again.status).toBe("noop");
    rebuildSession(rootB.events, rootB.legacy, sessionA.id);
    expect(rootB.events.replay(sessionA.id)).toEqual(fileBytes);
    expect(rootB.legacy.loadSession(sessionA.id)).toEqual(snapshot);
    expect(reconcileSession(rootB.events, rootB.legacy, sessionA.id).ok).toBe(true);
  });

  test("多会话全库迁移（含 rollback/fork 会话）：exportStore → importStore → rebuildAll → reconcileAll 绿", () => {
    const rootA = trackRoot(makeRoot("e2e-store-a-"));
    const graphA = new EventGraphStore({ events: rootA.events });

    // 会话 1：普通两轮 + 标题变更
    const s1 = createSession("deepseek-chat", "普通会话");
    runOneTurn(rootA.dual, s1, "一", [{ type: "text", text: "一答" }], 30);
    runOneTurn(rootA.dual, s1, "二", [{ type: "text", text: "二答" }], 60);
    s1.title = "改名";
    s1.updatedAt = Date.now();
    rootA.dual.saveSession(s1);

    // 会话 2：rollback + 重答
    const s2 = createSession("deepseek-chat", "回退会话");
    runOneTurn(rootA.dual, s2, "第一问", [{ type: "text", text: "第一答" }], 50);
    runOneTurn(rootA.dual, s2, "第二问", [{ type: "text", text: "第二答" }], 90);
    const asst2 = graphA.listNodes(s2.id).filter((n) => n.type === "assistant")[1]!;
    graphA.markQuality(asst2.id, "poor", "不佳");
    const rbNodeId = asst2.parentId!;
    graphA.rollbackTo(rbNodeId, "不佳");
    const idx = s2.messages.findIndex((m) => m.id === graphA.getNode(rbNodeId)!.messageId);
    s2.messages = s2.messages.slice(0, idx + 1);
    s2.tokenCount = 20;
    const evs2 = rootA.events.replay(s2.id);
    s2.updatedAt = Date.parse(evs2[evs2.length - 1]!.timestamp);
    rootA.dual.saveSession(s2);
    rootA.dual.saveMessages(s2.id, s2.messages);
    const retry: Message = { id: "a-retry", role: "assistant", content: [{ type: "text", text: "重答" }], createdAt: Date.now() };
    s2.messages.push(retry);
    s2.tokenCount = 120;
    s2.updatedAt = Date.now();
    rootA.dual.saveSession(s2);
    rootA.dual.saveMessages(s2.id, s2.messages);

    // 会话 3：fork（截断到分叉点 + 双写同步，镜像生产 /fork 链路）
    const s3 = createSession("deepseek-chat", "分叉会话");
    runOneTurn(rootA.dual, s3, "一", [{ type: "text", text: "一答" }], 30);
    const user1 = graphA.listNodes(s3.id).filter((n) => n.type === "user")[0]!;
    graphA.fork(user1.id, "explore-x");
    const idx3 = s3.messages.findIndex((m) => m.id === user1.messageId);
    s3.messages = s3.messages.slice(0, idx3 + 1);
    s3.tokenCount = 20;
    const evs3 = rootA.events.replay(s3.id);
    s3.updatedAt = Date.parse(evs3[evs3.length - 1]!.timestamp);
    rootA.dual.saveSession(s3);
    rootA.dual.saveMessages(s3.id, s3.messages);

    // 源根全绿
    expect(reconcileAll(rootA.events, rootA.legacy).ok).toBe(true);

    // 全库导出 → 新根全库导入 → 全量重建
    const exportDir = mkdtempSync(join(tmpdir(), "e2e-store-export-"));
    cleanups.push(() => rmSync(exportDir, { recursive: true, force: true }));
    const written = exportStoreEvents(rootA.events, exportDir);
    expect(written.length).toBe(3);

    const rootB = trackRoot(makeRoot("e2e-store-b-"));
    const summary = importStoreEvents(rootB.events, exportDir);
    expect(summary.imported).toBe(3);
    expect(summary.failed).toBe(0);

    const rebuilt = rebuildAll(rootB.events, rootB.legacy);
    expect(rebuilt.failed).toEqual([]);
    expect(rebuilt.rebuilt.sort()).toEqual(rootA.events.listSessionIds().sort());

    // 新根对账全绿 + 两根 listSessions 全等
    expect(reconcileAll(rootB.events, rootB.legacy).ok).toBe(true);
    expect(rootB.legacy.listSessions()).toEqual(rootA.legacy.listSessions());
    // 事件日志逐会话全等（hash 链完整）
    for (const sid of rootA.events.listSessionIds()) {
      expect(rootB.events.replay(sid)).toEqual(rootA.events.replay(sid));
      expect(verifyEventChain(rootB.events.replay(sid))).toEqual([]);
    }
  });

  test("迁移后新根可继续写：续跑一轮对话，事件链无缝续接（seq 连续），对账仍绿", () => {
    const rootA = trackRoot(makeRoot("e2e-cont-a-"));
    const sessionA = createSession("deepseek-chat", "续写会话");
    runOneTurn(rootA.dual, sessionA, "第一问", [{ type: "text", text: "第一答" }], 60);

    const exportDir = mkdtempSync(join(tmpdir(), "e2e-cont-export-"));
    cleanups.push(() => rmSync(exportDir, { recursive: true, force: true }));
    const filePath = join(exportDir, "s.fengevents.jsonl");
    exportSessionEvents(rootA.events, sessionA.id, filePath);
    const importedCount = rootA.events.replay(sessionA.id).length;

    // 迁移到新根 B
    const rootB = trackRoot(makeRoot("e2e-cont-b-"));
    importSessionEvents(rootB.events, filePath);
    rebuildSession(rootB.events, rootB.legacy, sessionA.id);

    // 新根 B 继续写（生产路径：加载读模型 → 双写续跑）
    const sessionB = rootB.legacy.loadSession(sessionA.id)!;
    runOneTurn(rootB.dual, sessionB, "第二问", [{ type: "text", text: "第二答" }], 150);

    // 事件链无缝续接：seq 连续、hash 链完整（seq 从 1 到 N 连续）
    const continued = rootB.events.replay(sessionA.id);
    expect(continued.length).toBeGreaterThan(importedCount);
    expect(verifyEventChain(continued)).toEqual([]);
    // 续写后消息顺序正确（第一问…第二答）
    expect(continued[importedCount - 1]!.seq).toBe(importedCount);
    expect(continued[importedCount]!.seq).toBe(importedCount + 1);
    // 新根对账仍绿（含续写回合）
    const rc = reconcileSession(rootB.events, rootB.legacy, sessionA.id);
    expect(rc.diffs).toEqual([]);
    expect(rc.ok).toBe(true);
    expect(rc.projected!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});
