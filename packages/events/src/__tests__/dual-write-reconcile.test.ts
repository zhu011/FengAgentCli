/**
 * @fengagent/events — 双写 + 对账门槛测试（Phase 1 末尾门槛）
 *
 * 用真实 SQLite（bun:sqlite，schema 与 @fengagent/agent SessionStore 一致）
 * 作为「旧存储」，DualWriteSessionStore 双写（旧存储 + 事件日志），然后：
 * - reconcileSession：事件投影产物 === 旧 SQLite 逐条等价（绿）；
 * - 篡改旧存储 → 对账红并给出逐条 diff；
 * - reconcileAll 批量对账；
 * - verifyEventChain：seq 连续 + #5 hash 链完整；
 * - 幂等：重复 saveSession/saveMessages 不重复落事件；
 * - 尾部半行自愈后对账仍绿。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, Message, Session, SessionMeta } from "@fengagent/core";
import { createSession, createUserMessage } from "@fengagent/core";
import { EventStore } from "../event-store.ts";
import { DualWriteSessionStore, type SessionStorePort } from "../dual-write.ts";
import { reconcileAll, reconcileSession, verifyEventChain } from "../reconcile.ts";

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

/* ------------------------------ 测试装置 ------------------------------ */

const cleanups: Array<() => void> = [];
const legacyStores: SqliteLegacyStore[] = [];
afterEach(() => {
  while (legacyStores.length) legacyStores.pop()!.close();
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dw-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const events = new EventStore({ dir: join(dir, "events") });
  const legacy = new SqliteLegacyStore(join(dir, "sessions.db"));
  legacyStores.push(legacy);
  const dual = new DualWriteSessionStore({ legacy, events, model: "deepseek-chat" });
  return { dir, events, legacy, dual };
}

/** 模拟运行时 prompt() 的写路径：一轮对话（用户 → 助手，含工具块） */
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
  userMsg.createdAt = Date.now();
  session.messages.push(userMsg);
  session.updatedAt = Date.now();
  dual.saveSession(session);
  dual.saveMessage(session.id, userMsg);

  const assistantMsg: Message = {
    id: `msg-assistant-${tokenCount}`,
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

describe("双写对账门槛（旧 SQLite 逐条等价）", () => {
  test("一轮完整对话：投影 === 旧 SQLite（绿），hash 链完整", () => {
    const { events, legacy, dual } = setup();
    const session = createSession("deepseek-chat", "初始会话");
    runOneTurn(
      dual,
      session,
      "你好，帮我看看",
      [
        { type: "text", text: "好的，我来看看。" },
        { type: "tool-use", id: "tool-1", name: "read", input: { path: "a.txt" } },
        { type: "tool-result", toolUseId: "tool-1", content: "file content", isError: false },
        { type: "text", text: "这是结果。" },
      ],
      128,
    );

    // 门槛：投影 === 旧 SQLite 逐条等价
    const r = reconcileSession(events, legacy, session.id);
    expect(r.diffs).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.projected!.messages).toHaveLength(2);
    expect(r.projected!.messages[1]!.content).toEqual([
      { type: "text", text: "好的，我来看看。" },
      { type: "tool-use", id: "tool-1", name: "read", input: { path: "a.txt" } },
      { type: "tool-result", toolUseId: "tool-1", content: "file content", isError: false },
      { type: "text", text: "这是结果。" },
    ]);

    // 批量对账
    const all = reconcileAll(events, legacy);
    expect(all.ok).toBe(true);
    expect(all.total).toBe(1);

    // 事件日志完整性（seq 连续 + hash 链）
    expect(verifyEventChain(events.replay(session.id))).toEqual([]);
  });

  test("多轮对话 + 状态/标题变更后仍逐条等价", () => {
    const { events, legacy, dual } = setup();
    const session = createSession("deepseek-chat", "初始");
    runOneTurn(dual, session, "第一问", [{ type: "text", text: "第一答" }], 60);
    runOneTurn(dual, session, "第二问", [{ type: "text", text: "第二答" }], 150);

    // 标题变更
    session.title = "改名后的会话";
    session.updatedAt = Date.now();
    dual.saveSession(session);

    const r = reconcileSession(events, legacy, session.id);
    expect(r.ok).toBe(true);
    expect(r.diffs).toEqual([]);
    expect(r.projected!.title).toBe("改名后的会话");
    expect(r.projected!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(r.projected!.tokenCount).toBe(150);
  });

  test("篡改旧存储 → 对账红，给出逐条 diff", () => {
    const { events, legacy, dual } = setup();
    const session = createSession("deepseek-chat", "初始");
    runOneTurn(dual, session, "问", [{ type: "text", text: "答" }], 42);

    // 篡改旧存储（模拟手工改动 SQLite）
    legacy.saveSession({ ...session, title: "被篡改的标题" });

    const r = reconcileSession(events, legacy, session.id);
    expect(r.ok).toBe(false);
    expect(r.diffs.some((d) => d.field === "title")).toBe(true);

    // 篡改消息内容
    const tampered = legacy.loadSession(session.id)!;
    tampered.messages[1]!.content = [{ type: "text", text: "被篡改的回答" }];
    legacy.saveSession(tampered);
    legacy.saveMessages(session.id, tampered.messages);
    const r2 = reconcileSession(events, legacy, session.id);
    expect(r2.ok).toBe(false);
    expect(r2.diffs.some((d) => d.field.startsWith("messages[1].content"))).toBe(true);

    // 批量对账红
    const all = reconcileAll(events, legacy);
    expect(all.ok).toBe(false);
    expect(all.failed).toContain(session.id);
  });

  test("幂等：重复 saveSession/saveMessages 不重复落事件", () => {
    const { events, legacy, dual } = setup();
    const session = createSession("deepseek-chat", "初始");
    runOneTurn(dual, session, "问", [{ type: "text", text: "答" }], 42);
    const before = events.replay(session.id).length;

    // 原样重复保存（运行时高频路径）
    dual.saveSession(session);
    dual.saveSession(session);
    dual.saveMessages(session.id, session.messages);
    dual.saveMessages(session.id, session.messages);

    const after = events.replay(session.id).length;
    expect(after).toBe(before);
    expect(reconcileSession(events, legacy, session.id).ok).toBe(true);
    expect(verifyEventChain(events.replay(session.id))).toEqual([]);
  });

  test("事件日志尾部半行（崩溃残留）自愈后对账仍绿", () => {
    const { events, legacy, dual } = setup();
    const session = createSession("deepseek-chat", "初始");
    runOneTurn(dual, session, "问", [{ type: "text", text: "答" }], 42);

    // 模拟崩溃残留：尾部半行
    const path = events.pathFor(session.id);
    appendFileSync(path, '{"version":1,"sessionId":"' + session.id + '","seq":99,"ty', "utf8");

    // 自愈 + 对账
    expect(events.healTail(session.id)).toBeGreaterThan(0);
    expect(reconcileSession(events, legacy, session.id).ok).toBe(true);
    expect(verifyEventChain(events.replay(session.id))).toEqual([]);
  });

  test("无事件 / 无旧存储的会话两侧一致；孤儿旧会话对账红", () => {
    const { events, legacy } = setup();
    // 两侧都无 → 一致
    expect(reconcileSession(events, legacy, "ghost").ok).toBe(true);

    // 只有旧存储没有事件 → 红
    const session = createSession("deepseek-chat", "孤儿");
    legacy.saveSession(session);
    const r = reconcileSession(events, legacy, session.id);
    expect(r.ok).toBe(false);
    expect(r.diffs[0]!.field).toBe("session");
  });

  test("deleteSession 只作用于旧存储（事件日志 append-only 保留历史）", () => {
    const { events, legacy, dual } = setup();
    const session = createSession("deepseek-chat", "初始");
    runOneTurn(dual, session, "问", [{ type: "text", text: "答" }], 42);
    dual.deleteSession(session.id);
    expect(legacy.loadSession(session.id)).toBeNull();
    // 事件日志仍可重放（历史不可变）
    expect(events.replay(session.id).length).toBeGreaterThan(0);
    // 批量对账按旧存储枚举 → 会话已删，不再参与，批量仍绿
    expect(reconcileAll(events, legacy).ok).toBe(true);
    // 单会话对账：投影仍在而旧存储缺失 → 红（删除语义未入事件词汇，属已知边界）
    const r = reconcileSession(events, legacy, session.id);
    expect(r.ok).toBe(false);
    expect(r.diffs[0]!.field).toBe("session");
  });
});
