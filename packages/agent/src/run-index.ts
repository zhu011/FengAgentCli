/**
 * @fengagent/agent — 统一运行索引（P0 只读聚合）
 *
 * 三种执行来源语义不同、存储也不同，但对「每个智能体能看到自己的运行历史」这件事，
 * 前端只该看到一张表：
 *
 * | 来源 | 原存储 | `kind` | 一次 run = |
 * |---|---|---|---|
 * | 会话（WebUI/CLI 聊天） | `sessions.db` 的 `sessions` + `messages` | `session` | 一个会话 |
 * | 派单（`dispatch_task` / `/api/agent-tasks`） | `agent-tasks.db` 的 `agent_tasks` | `dispatch` | 一个外派任务 |
 * | 群聊发言 | `groups.db` 的 `group_messages` | `group` | 一次 runtime 发言 |
 *
 * P0 刻意**不加表**（见 spec §5.1.4）：在内存里做三路 UNION + 时间排序 + keyset 分页。
 * 单机数据量小（万级），先跑通读模型，避免过早引入双写一致性负担；
 * P1 再落 `run` 表，把这里换成纯 SQL 分页（feature flag `FENG_RUN_INDEX=1`）。
 *
 * 归属规则（P0）：
 * - `dispatch`：`agent_tasks.agent_id`（新列）；老任务没有该列时，按 `runtime` 匹配
 *   绑定到同一 runtime 的 agent（向后兼容）。
 * - `group`：`group_messages.from_kind = 'runtime'` 且 `from_name` 等于 agent.id 或
 *   其绑定的 runtime 名。
 * - `session`：`sessions.agent_id`（P0 新增列；会话创建时带 `agent` 才归属）。
 *
 * 只读：三个库都以 readonly 打开；文件不存在/表不存在/缺列一律降级为空结果，
 * 不阻塞智能体列表与详情。
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 运行来源 */
export type RunKind = "session" | "dispatch" | "group";

/** 归一后的运行状态 */
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "expired";

/** 运行摘要（列表/概览用） */
export interface RunSummary {
  /** 全局唯一 id：`<kind>:<sourceId>`（派单也接受裸 taskId 查询） */
  id: string;
  kind: RunKind;
  agentId?: string;
  runtime?: string;
  status: RunStatus;
  title: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  usage?: { tokens?: number };
  error?: string;
}

/** 对话/事件消息（`seq` 在单个 run 内单调递增，用于增量拉取） */
export interface RunMessage {
  seq: number;
  at: number;
  type: "text" | "tool_use" | "tool_result" | "thinking" | "error" | "system";
  content: string;
  tool?: string;
  callId?: string;
  truncated?: boolean;
}

/** 列表过滤 */
export interface ListRunsOptions {
  agentId: string;
  /** agent 绑定的 runtime（老派单按它归属；未绑定传 null） */
  runtime?: string | null;
  kind?: RunKind | RunKind[];
  status?: RunStatus | RunStatus[];
  /** 起始时间（含） */
  from?: number;
  /** 结束时间（含） */
  to?: number;
  /** 默认 20，上限 200 */
  limit?: number;
  /** 上一页最后一条 run 的 id（`startedAt:id` 键集） */
  cursor?: string;
}

/** 索引选项 */
export interface RunIndexOptions {
  dataRoot: string;
  /** 覆盖三个库路径（测试用） */
  sessionsDb?: string;
  tasksDb?: string;
  groupsDb?: string;
  now?: () => number;
}

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 20;

/** 派单状态 → 归一状态 */
const TASK_STATUS: Record<string, RunStatus> = {
  created: "queued",
  dispatched: "running",
  running: "running",
  replied: "completed",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired",
};

/** 会话状态 → 归一状态 */
const SESSION_STATUS: Record<string, RunStatus> = {
  idle: "completed",
  running: "running",
  error: "failed",
};

interface TaskRow {
  id: string;
  runtime: string;
  content: string;
  agent_id?: string | null;
  status: string;
  created_at: number;
  dispatched_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  result: string | null;
  error: string | null;
}

interface SessionRow {
  id: string;
  title: string | null;
  status: string | null;
  token_count: number | null;
  created_at: number | null;
  updated_at: number | null;
  agent_id?: string | null;
}

interface GroupRow {
  id: string;
  group_id: string;
  seq: number;
  from_kind: string;
  from_name: string;
  content: string;
  created_at: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: number;
}

interface EventRow {
  seq: number;
  at: number;
  type: string;
  detail: string | null;
}

/** 首行截断（列表标题） */
function titleOf(content: string, fallback: string): string {
  const line = content.split(/\r?\n/).find((item) => item.trim() !== "")?.trim() ?? "";
  if (line === "") return fallback;
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/** 编码分页游标：`<startedAt>:<id>`（id 自身含冒号，按第一个冒号切） */
function encodeCursor(run: RunSummary): string {
  return `${run.startedAt}:${run.id}`;
}

/** 解析游标 */
function decodeCursor(cursor: string): { startedAt: number; id: string } | null {
  const index = cursor.indexOf(":");
  if (index <= 0) return null;
  const startedAt = Number(cursor.slice(0, index));
  const id = cursor.slice(index + 1);
  if (!Number.isFinite(startedAt) || id === "") return null;
  return { startedAt, id };
}

/**
 * 统一运行索引。
 *
 * ```ts
 * const index = new RunIndex({ dataRoot });
 * const page = index.list({ agentId: "coder", runtime: "claude", limit: 20 });
 * const messages = index.messages(page.runs[0].id);
 * ```
 */
export class RunIndex {
  private readonly sessionsPath: string;
  private readonly tasksPath: string;
  private readonly groupsPath: string;
  private readonly now: () => number;
  private readonly snapshots = new Map<string, Database | null>();
  private readonly columns = new Map<string, Set<string>>();

  constructor(options: RunIndexOptions) {
    this.sessionsPath = options.sessionsDb ?? join(options.dataRoot, "sessions.db");
    this.tasksPath = options.tasksDb ?? join(options.dataRoot, "agent-tasks.db");
    this.groupsPath = options.groupsDb ?? join(options.dataRoot, "groups.db");
    this.now = options.now ?? Date.now;
  }

  /**
   * 列出某个智能体的运行历史（`startedAt DESC, id DESC` 键集分页）。
   *
   * @param options - agentId 必填；kind/status/时间窗可选
   */
  list(options: ListRunsOptions): { runs: RunSummary[]; nextCursor?: string } {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const runtime = options.runtime ?? null;
    const all: RunSummary[] = [
      ...this.dispatchRuns(options.agentId, runtime),
      ...this.sessionRuns(options.agentId),
      ...this.groupRuns(options.agentId, runtime),
    ];

    const kinds = options.kind === undefined ? null : new Set(Array.isArray(options.kind) ? options.kind : [options.kind]);
    const statuses =
      options.status === undefined
        ? null
        : new Set(Array.isArray(options.status) ? options.status : [options.status]);

    let filtered = all.filter((run) => {
      if (kinds && !kinds.has(run.kind)) return false;
      if (statuses && !statuses.has(run.status)) return false;
      if (options.from !== undefined && run.startedAt < options.from) return false;
      if (options.to !== undefined && run.startedAt > options.to) return false;
      return true;
    });
    filtered.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));

    if (options.cursor !== undefined && options.cursor !== "") {
      const cursor = decodeCursor(options.cursor);
      if (cursor) {
        filtered = filtered.filter(
          (run) =>
            run.startedAt < cursor.startedAt ||
            (run.startedAt === cursor.startedAt && run.id < cursor.id),
        );
      }
    }

    const runs = filtered.slice(0, limit);
    const last = runs[runs.length - 1];
    if (filtered.length <= limit || !last) return { runs };
    return { runs, nextCursor: encodeCursor(last) };
  }

  /** 取单次运行（接受 `dispatch:<taskId>` 或裸 taskId） */
  get(runId: string): RunSummary | null {
    if (runId.startsWith("dispatch:")) return this.dispatchRun(runId.slice("dispatch:".length));
    if (runId.startsWith("session:")) return this.sessionRun(runId.slice("session:".length));
    if (runId.startsWith("group:")) return this.groupRun(runId.slice("group:".length));
    // 兼容：直接把 taskId 当 run id（既有 /api/agent-tasks 调用方）
    return this.dispatchRun(runId);
  }

  /**
   * 读一次运行的对话/事件（`seq > since`，按 `seq` 升序）。
   *
   * @param runId - run id
   * @param since - 只返回 seq 大于它的消息（增量拉取）
   * @param limit - 默认 500，上限 2000
   */
  messages(runId: string, since = 0, limit = 500): RunMessage[] {
    const capped = Math.min(Math.max(limit, 1), 2000);
    if (runId.startsWith("session:")) {
      return this.sessionMessages(runId.slice("session:".length), since, capped);
    }
    if (runId.startsWith("group:")) {
      return this.groupMessages(runId.slice("group:".length), since);
    }
    const taskId = runId.startsWith("dispatch:") ? runId.slice("dispatch:".length) : runId;
    return this.dispatchMessages(taskId, since, capped);
  }

  /** 关闭只读连接 */
  close(): void {
    for (const db of this.snapshots.values()) {
      try {
        db?.close();
      } catch {
        // 已关闭
      }
    }
    this.snapshots.clear();
  }

  // ──────────────────────────────────────────────
  // 派单
  // ──────────────────────────────────────────────

  private dispatchRuns(agentId: string, runtime: string | null): RunSummary[] {
    const db = this.open(this.tasksPath);
    if (!db) return [];
    const hasAgentColumn = this.tableColumns(db, "agent_tasks").has("agent_id");
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (hasAgentColumn && runtime) {
      where.push("(agent_id = ? OR (agent_id IS NULL AND runtime = ?))");
      params.push(agentId, runtime);
    } else if (hasAgentColumn) {
      where.push("agent_id = ?");
      params.push(agentId);
    } else {
      if (!runtime) return [];
      where.push("runtime = ?");
      params.push(runtime);
    }
    const rows = this.query<TaskRow>(
      db,
      `SELECT * FROM agent_tasks WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
      params,
    );
    return rows.map((row) => this.taskToRun(row));
  }

  private dispatchRun(taskId: string): RunSummary | null {
    const db = this.open(this.tasksPath);
    if (!db) return null;
    const row = this.query<TaskRow>(db, "SELECT * FROM agent_tasks WHERE id = ?", [taskId])[0];
    return row ? this.taskToRun(row) : null;
  }

  private taskToRun(row: TaskRow): RunSummary {
    const startedAt = row.dispatched_at ?? row.started_at ?? row.created_at;
    const endedAt = row.finished_at ?? undefined;
    const run: RunSummary = {
      id: `dispatch:${row.id}`,
      kind: "dispatch",
      ...(row.agent_id ? { agentId: row.agent_id } : {}),
      runtime: row.runtime,
      status: TASK_STATUS[row.status] ?? "running",
      title: titleOf(row.content, `外派任务 ${row.id}`),
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt, durationMs: Math.max(0, endedAt - startedAt) }),
      ...(row.error ? { error: row.error } : {}),
    };
    return run;
  }

  private dispatchMessages(taskId: string, since: number, limit: number): RunMessage[] {
    const db = this.open(this.tasksPath);
    if (!db) return [];
    const task = this.query<TaskRow>(db, "SELECT * FROM agent_tasks WHERE id = ?", [taskId])[0];
    if (!task) return [];
    const events = this.query<EventRow>(
      db,
      "SELECT seq, at, type, detail FROM agent_task_events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      [taskId, since, limit],
    );

    const messages: RunMessage[] = [];
    const chunks: string[] = [];
    let streamedText = "";
    let firstChunkSeq = 0;
    let firstChunkAt = 0;
    let seq = since;

    const flushChunks = (): void => {
      if (chunks.length === 0) return;
      const text = chunks.join("");
      streamedText += text;
      messages.push({
        seq: firstChunkSeq,
        at: firstChunkAt,
        type: "text",
        content: text,
      });
      chunks.length = 0;
    };

    for (const event of events) {
      if (event.type === "task/stream-chunk") {
        const detail = event.detail ?? "";
        if (detail.startsWith("[permission]")) {
          flushChunks();
          messages.push({
            seq: event.seq,
            at: event.at,
            type: "system",
            content: detail,
          });
          seq = event.seq;
          continue;
        }
        if (chunks.length === 0) {
          firstChunkSeq = event.seq;
          firstChunkAt = event.at;
        }
        chunks.push(detail);
        seq = event.seq;
        continue;
      }
      flushChunks();
      seq = event.seq;
      if (event.type === "task/failed") {
        messages.push({
          seq: event.seq,
          at: event.at,
          type: "error",
          content: task.error ?? event.detail ?? "任务失败",
        });
      } else if (event.type === "task/created" || event.type === "task/dispatched") {
        messages.push({
          seq: event.seq,
          at: event.at,
          type: "system",
          content: event.detail ?? event.type,
        });
      }
    }
    flushChunks();
    // 终态结果：流式 chunk 已覆盖时不再重复追加
    if (task.result !== null && task.result !== "" && seq >= 0) {
      const already =
        task.result === streamedText ||
        streamedText.includes(task.result) ||
        task.result.includes(streamedText);
      if (!already) {
        messages.push({
          seq: seq + 1,
          at: task.finished_at ?? this.now(),
          type: "text",
          content: task.result,
        });
      }
    }
    return messages.filter((message) => message.seq > since);
  }

  // ──────────────────────────────────────────────
  // 会话
  // ──────────────────────────────────────────────

  private sessionRuns(agentId: string): RunSummary[] {
    const db = this.open(this.sessionsPath);
    if (!db) return [];
    if (!this.tableColumns(db, "sessions").has("agent_id")) return [];
    const rows = this.query<SessionRow>(
      db,
      "SELECT * FROM sessions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 500",
      [agentId],
    );
    return rows.map((row) => this.sessionToRun(row));
  }

  private sessionRun(sessionId: string): RunSummary | null {
    const db = this.open(this.sessionsPath);
    if (!db) return null;
    if (!this.tableColumns(db, "sessions").has("agent_id")) return null;
    const row = this.query<SessionRow>(db, "SELECT * FROM sessions WHERE id = ?", [sessionId])[0];
    if (!row || !row.agent_id) return null;
    return this.sessionToRun(row);
  }

  private sessionToRun(row: SessionRow): RunSummary {
    const startedAt = row.created_at ?? 0;
    const endedAt = row.updated_at ?? undefined;
    return {
      id: `session:${row.id}`,
      kind: "session",
      ...(row.agent_id ? { agentId: row.agent_id } : {}),
      status: SESSION_STATUS[row.status ?? "idle"] ?? "completed",
      title: (row.title ?? "").trim() === "" ? `会话 ${row.id.slice(0, 8)}` : row.title!,
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt, durationMs: Math.max(0, endedAt - startedAt) }),
      ...(row.token_count ? { usage: { tokens: row.token_count } } : {}),
    };
  }

  private sessionMessages(sessionId: string, since: number, limit: number): RunMessage[] {
    const db = this.open(this.sessionsPath);
    if (!db) return [];
    const rows = this.query<MessageRow>(
      db,
      "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, id LIMIT ?",
      [sessionId, limit],
    );
    const messages: RunMessage[] = [];
    let seq = 0;
    for (const row of rows) {
      for (const block of parseBlocks(row.content)) {
        seq += 1;
        messages.push({ ...block, seq, at: row.created_at });
      }
    }
    return messages.filter((message) => message.seq > since);
  }

  // ──────────────────────────────────────────────
  // 群聊
  // ──────────────────────────────────────────────

  private groupRuns(agentId: string, runtime: string | null): RunSummary[] {
    const db = this.open(this.groupsPath);
    if (!db) return [];
    const params: string[] = [agentId];
    let where = "from_kind = 'runtime' AND from_name = ?";
    if (runtime) {
      where = "from_kind = 'runtime' AND (from_name = ? OR from_name = ?)";
      params.push(runtime);
    }
    const rows = this.query<GroupRow>(
      db,
      `SELECT * FROM group_messages WHERE ${where} ORDER BY created_at DESC LIMIT 500`,
      params,
    );
    return rows.map((row) => ({
      id: `group:${row.id}`,
      kind: "group",
      agentId,
      runtime: row.from_name,
      status: "completed",
      title: titleOf(row.content, `群发言 ${row.seq}`),
      startedAt: row.created_at,
      endedAt: row.created_at,
      durationMs: 0,
    }));
  }

  private groupRun(messageId: string): RunSummary | null {
    const db = this.open(this.groupsPath);
    if (!db) return null;
    const row = this.query<GroupRow>(db, "SELECT * FROM group_messages WHERE id = ?", [messageId])[0];
    if (!row) return null;
    return {
      id: `group:${row.id}`,
      kind: "group",
      runtime: row.from_name,
      status: "completed",
      title: titleOf(row.content, `群发言 ${row.seq}`),
      startedAt: row.created_at,
      endedAt: row.created_at,
      durationMs: 0,
    };
  }

  private groupMessages(messageId: string, since: number): RunMessage[] {
    const db = this.open(this.groupsPath);
    if (!db) return [];
    const row = this.query<GroupRow>(db, "SELECT * FROM group_messages WHERE id = ?", [messageId])[0];
    if (!row || since >= 1) return [];
    return [{ seq: 1, at: row.created_at, type: "text", content: row.content }];
  }

  // ──────────────────────────────────────────────
  // 基础设施
  // ──────────────────────────────────────────────

  /** 惰性打开只读库（文件不存在 → null） */
  private open(path: string): Database | null {
    if (this.snapshots.has(path)) return this.snapshots.get(path) ?? null;
    let db: Database | null = null;
    try {
      if (existsSync(path)) db = new Database(path, { readonly: true });
    } catch {
      db = null;
    }
    this.snapshots.set(path, db);
    return db;
  }

  /** 表字段（缓存；表不存在 → 空集合） */
  private tableColumns(db: Database, table: string): Set<string> {
    const key = table;
    const cached = this.columns.get(key);
    if (cached) return cached;
    let columns = new Set<string>();
    try {
      const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      columns = new Set(rows.map((row) => row.name));
    } catch {
      // 表不存在
    }
    this.columns.set(key, columns);
    return columns;
  }

  /** 查询容错：缺表/缺列/坏库 → 空结果（列表不该因一个来源坏掉而 500） */
  private query<T>(db: Database, sql: string, params: Array<string | number>): T[] {
    try {
      return db.query(sql).all(...params) as T[];
    } catch {
      return [];
    }
  }
}

/** 会话消息 content（JSON ContentBlock[]）→ 拍平消息 */
function parseBlocks(content: string): Array<Omit<RunMessage, "seq" | "at">> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [{ type: "text", content }];
  }
  if (typeof parsed === "string") return [{ type: "text", content: parsed }];
  if (!Array.isArray(parsed)) return [];
  const out: Array<Omit<RunMessage, "seq" | "at">> = [];
  for (const block of parsed as Array<Record<string, unknown>>) {
    const type = String(block["type"] ?? "");
    if (type === "text") {
      out.push({ type: "text", content: String(block["text"] ?? "") });
    } else if (type === "tool-use" || type === "tool_use") {
      out.push({
        type: "tool_use",
        content: JSON.stringify(block["input"] ?? {}),
        tool: String(block["name"] ?? ""),
        callId: String(block["id"] ?? ""),
      });
    } else if (type === "tool-result" || type === "tool_result") {
      const raw = block["content"];
      out.push({
        type: "tool_result",
        content: typeof raw === "string" ? raw : JSON.stringify(raw ?? ""),
        callId: String(block["toolUseId"] ?? block["tool_use_id"] ?? ""),
        ...(block["isError"] === true || block["is_error"] === true ? { tool: "error" } : {}),
      });
    } else if (type === "thinking") {
      out.push({ type: "thinking", content: String(block["thinking"] ?? block["text"] ?? "") });
    } else if (type === "image") {
      out.push({ type: "text", content: "[image]" });
    }
  }
  return out;
}
