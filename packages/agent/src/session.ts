/**
 * @fengagent/agent — 会话持久化
 *
 * 基于 bun:sqlite 的会话存储。
 * 支持创建、保存、加载、列出、删除会话。
 * 参考 ARCHITECTURE.md 第 6.3 节。
 */

import { Database } from "bun:sqlite";
import type {
  Session,
  SessionMeta,
  Message,
  ContentBlock,
  SessionState,
} from "@fengagent/core";
import { expandTilde } from "@fengagent/shared/utils";

/** 数据库行类型（sessions 表） */
interface SessionRow {
  id: string;
  title: string;
  model: string;
  status: string;
  token_count: number;
  created_at: number;
  updated_at: number;
}

/** 数据库行类型（messages 表） */
interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: number;
}

/**
 * 会话存储器 — SQLite 持久化。
 *
 * 表结构：
 * - sessions: id, title, model, status, token_count, created_at, updated_at
 * - messages: id, session_id, role, content (JSON), created_at
 */
export class SessionStore {
  private db: Database;

  /**
   * @param dbPath - SQLite 数据库文件路径
   */
  constructor(dbPath: string) {
    const expanded = expandTilde(dbPath);
    this.db = new Database(expanded);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        model TEXT,
        status TEXT,
        token_count INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        role TEXT,
        content TEXT,
        created_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at);
    `);
  }

  /** 保存（或更新）会话元信息 */
  saveSession(session: Session): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO sessions
         (id, title, model, status, token_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.title,
        session.model,
        session.status,
        session.tokenCount,
        session.createdAt,
        session.updatedAt,
      );
  }

  /** 保存单条消息 */
  saveMessage(sessionId: string, message: Message): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO messages
         (id, session_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        sessionId,
        message.role,
        JSON.stringify(message.content),
        message.createdAt,
      );
  }

  /** 保存多条消息 */
  saveMessages(sessionId: string, messages: Message[]): void {
    for (const message of messages) {
      this.saveMessage(sessionId, message);
    }
  }

  /**
   * 让旧存储的会话消息集合收敛到「当前消息列表」（Phase 2 分支截断同步）。
   * 删除该会话中不在 keepMessageIds 内的残留消息行（rollback/fork 截断后旧分支
   * 消息不再属于当前读模型；会话整体删除仍走 deleteSession）。
   */
  deleteMessages(sessionId: string, keepMessageIds: string[]): void {
    const keep = [...new Set(keepMessageIds)];
    if (keep.length === 0) {
      this.db.query("DELETE FROM messages WHERE session_id = ?").run(sessionId);
      return;
    }
    // 分批执行（规避 SQLite 变量数上限）
    const CHUNK = 500;
    for (let i = 0; i < keep.length; i += CHUNK) {
      const chunk = keep.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      this.db
        .query(
          `DELETE FROM messages WHERE session_id = ? AND id NOT IN (${placeholders})`,
        )
        .run(sessionId, ...chunk);
    }
  }

  /** 加载完整会话（含所有消息） */
  loadSession(sessionId: string): Session | null {
    const row = this.db
      .query("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | null;

    if (!row) return null;

    const messageRows = this.db
      .query(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at",
      )
      .all(sessionId) as MessageRow[];

    return {
      id: row.id,
      title: row.title,
      model: row.model,
      status: row.status as SessionState,
      tokenCount: row.token_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: messageRows.map((m) => ({
        id: m.id,
        role: m.role as Message["role"],
        content: JSON.parse(m.content) as ContentBlock[],
        createdAt: m.created_at,
      })),
    };
  }

  /** 列出所有会话元信息（按更新时间降序） */
  listSessions(): SessionMeta[] {
    const rows = this.db
      .query(
        "SELECT id, title, model, status, token_count, created_at, updated_at FROM sessions ORDER BY updated_at DESC",
      )
      .all() as SessionRow[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      model: row.model,
      status: row.status as SessionState,
      tokenCount: row.token_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * 重命名会话（仅更新标题与更新时间）。
   *
   * @param sessionId - 会话 ID
   * @param title - 新标题（空白将被拒绝）
   * @returns 是否成功更新（会话存在且标题非空）
   */
  renameSession(sessionId: string, title: string): boolean {
    const trimmed = title.trim();
    if (!trimmed) return false;
    const res = this.db
      .query(
        "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
      )
      .run(trimmed, Date.now(), sessionId);
    return res.changes > 0;
  }

  /** 删除会话及其所有消息 */
  deleteSession(sessionId: string): void {
    this.db.query("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    this.db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }
}
