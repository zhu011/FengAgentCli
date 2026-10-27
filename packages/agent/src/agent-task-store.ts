/**
 * @fengagent/agent — 外派任务仓（事件溯源，SQLite）
 *
 * 「把任务派给本机其他 agent」的状态落盘层。两个刻意的设计选择：
 *
 * 1. **不塞进 `TaskStore` 的 `task_states`**：那张表的状态机服务于 Agent Loop
 *    （`task/pending` / 步级 checkpoint / 待结算工具），状态枚举是
 *    active/blocked/completed/aborted。外派任务是另一套 7 态语义
 *    （created → dispatched → running → replied / failed / cancelled / expired），
 *    硬塞会把已验收的 loop 状态机搅浑。这里用**同构**的做法：独立两张表 +
 *    同样的「seq 单调事件流 + 重放可重建状态」。
 * 2. **幂等靠唯一键**：`idempotency_key` 建唯一索引 —— 同一请求重复 POST
 *    在存储层就被挡住（`create()` 返回既有任务，`reused=true`），不依赖调用方自觉。
 *
 * 副作用去重仍在 AGE-29 的 `operation_ledger`（`TaskStore.ledger`）里做：
 * 每次 dispatch 是一个 `agent-task:<id>:attempt-<n>` 的副作用操作 —— 这是
 * 「崩溃后不重复执行」的那道闸，本仓只记业务状态与事件。
 */

import { Database } from "bun:sqlite";
import { expandTilde, generateId } from "@fengagent/shared/utils";

/** 外派任务状态（与 WebUI 的 `AgentTaskStatus` 同枚举，7 态） */
export type AgentTaskStatus =
  | "created"
  | "dispatched"
  | "running"
  | "replied"
  | "failed"
  | "cancelled"
  | "expired";

/** 外派任务事件类型（与 WebUI 的 `AgentTaskEvent["type"]` 同枚举） */
export type AgentTaskEventType =
  | "task/created"
  | "task/dispatched"
  | "task/accepted"
  | "task/running"
  | "task/stream-chunk"
  | "task/replied"
  | "task/failed"
  | "task/cancelled"
  | "task/expired"
  | "task/retried";

/** 终态集合 */
export const TERMINAL_TASK_STATUSES: readonly AgentTaskStatus[] = [
  "replied",
  "failed",
  "cancelled",
  "expired",
];

/** 是否终态 */
export function isTerminalTaskStatus(status: AgentTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/** 合法转移（7 态表；越界转移直接抛错，避免状态被写坏） */
const ALLOWED_TRANSITIONS: Record<AgentTaskStatus, readonly AgentTaskStatus[]> = {
  created: ["dispatched", "cancelled", "expired", "failed"],
  dispatched: ["running", "replied", "failed", "cancelled", "expired"],
  running: ["replied", "failed", "cancelled"],
  replied: [],
  failed: [],
  cancelled: [],
  expired: [],
};

/** 任务记录（时间戳为毫秒；API 层再转 ISO 字符串） */
export interface AgentTaskRecord {
  id: string;
  runtime: string;
  content: string;
  cwd: string;
  /** 派发来源会话 id（界面发起的任务在 API 层显示为 `dashboard`） */
  fromSession: string;
  status: AgentTaskStatus;
  /** 第几次尝试（retry = 新 attempt，同一 taskId） */
  attempt: number;
  createdAt: number;
  dispatchedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  /** 最终回复（replied 后才有） */
  result?: string;
  error?: string;
  /** 目标侧 ACP sessionId（诊断/续聊用） */
  acpSessionId?: string;
  /** 所属群（G2 群内派发；结果回群靠它定位） */
  groupId?: string;
  idempotencyKey?: string;
}

/** 事件行 */
export interface AgentTaskEventRow {
  seq: number;
  at: number;
  type: AgentTaskEventType;
  detail?: string;
}

/** 建任务入参 */
export interface CreateAgentTaskInput {
  runtime: string;
  content: string;
  cwd: string;
  fromSession?: string;
  /** 群内派发（G2）：结果回群时按它定位 */
  groupId?: string;
  idempotencyKey?: string;
  at?: number;
}

/** 列表过滤 */
export interface ListAgentTasksFilter {
  status?: AgentTaskStatus | AgentTaskStatus[];
  runtime?: string;
  /** 只看某个群派出的任务（G2） */
  groupId?: string;
  /** 默认 50，上限 200 */
  limit?: number;
  /** 上一页最后一条的 `id`（简单键集分页：按 created_at DESC, id DESC） */
  cursor?: string;
}

interface TaskRow {
  id: string;
  runtime: string;
  content: string;
  cwd: string;
  from_session: string;
  status: string;
  attempt: number;
  created_at: number;
  dispatched_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  result: string | null;
  error: string | null;
  acp_session_id: string | null;
  group_id: string | null;
  idempotency_key: string | null;
}

interface EventRow {
  seq: number;
  at: number;
  type: string;
  detail: string | null;
}

function rowToTask(row: TaskRow): AgentTaskRecord {
  return {
    id: row.id,
    runtime: row.runtime,
    content: row.content,
    cwd: row.cwd,
    fromSession: row.from_session,
    status: row.status as AgentTaskStatus,
    attempt: row.attempt,
    createdAt: row.created_at,
    ...(row.dispatched_at === null ? {} : { dispatchedAt: row.dispatched_at }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.acp_session_id === null ? {} : { acpSessionId: row.acp_session_id }),
    ...(row.group_id === null ? {} : { groupId: row.group_id }),
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
  };
}

/**
 * 从事件流重放状态（`task/<状态>` 事件决定当前状态）。
 *
 * 与实时状态对拍应当零差异 —— 崩溃恢复时用它验证落盘状态没被写坏。
 *
 * @param events - 按 seq 升序的事件
 * @returns 重放得到的状态（无事件时 null）
 */
export function replayAgentTaskStatus(
  events: readonly Pick<AgentTaskEventRow, "type">[],
): AgentTaskStatus | null {
  const byEvent: Partial<Record<AgentTaskEventType, AgentTaskStatus>> = {
    "task/created": "created",
    "task/dispatched": "dispatched",
    "task/running": "running",
    "task/replied": "replied",
    "task/failed": "failed",
    "task/cancelled": "cancelled",
    "task/expired": "expired",
  };
  let status: AgentTaskStatus | null = null;
  for (const event of events) {
    const next = byEvent[event.type];
    if (next) status = next;
  }
  return status;
}

/** 外派任务仓 */
export class AgentTaskStore {
  private db: Database;
  private ownsDb: boolean;
  private now: () => number;

  constructor(dbPath: string, options?: { db?: Database; now?: () => number }) {
    if (options?.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      this.db = new Database(expandTilde(dbPath));
      this.ownsDb = true;
    }
    this.now = options?.now ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        content TEXT NOT NULL,
        cwd TEXT NOT NULL,
        from_session TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        started_at INTEGER,
        finished_at INTEGER,
        result TEXT,
        error TEXT,
        acp_session_id TEXT,
        group_id TEXT,
        idempotency_key TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_runtime ON agent_tasks(runtime, created_at DESC);

      CREATE TABLE IF NOT EXISTS agent_task_events (
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        detail TEXT,
        at INTEGER NOT NULL,
        PRIMARY KEY (task_id, seq)
      );
    `);
    // 老库迁移（G2）：`group_id` 是后加的列，CREATE TABLE IF NOT EXISTS 不会补列。
    const columns = this.db
      .query("PRAGMA table_info(agent_tasks)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "group_id")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN group_id TEXT");
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_agent_tasks_group ON agent_tasks(group_id, created_at DESC)",
    );
    try {
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_idempotency ON agent_tasks(idempotency_key);",
      );
    } catch {
      // 历史数据里已有重复键：退化为普通索引（查表取最新一条），不阻塞启动。
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_tasks_idempotency ON agent_tasks(idempotency_key, created_at DESC);",
      );
    }
  }

  /**
   * 建任务（幂等键命中时返回既有任务）。
   *
   * @param input - 建任务入参
   * @returns 任务 + 是否复用了既有任务
   */
  create(input: CreateAgentTaskInput): { task: AgentTaskRecord; reused: boolean } {
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return { task: existing, reused: true };
    }
    const at = input.at ?? this.now();
    const id = generateId();
    this.db
      .query(
        `INSERT INTO agent_tasks
         (id, runtime, content, cwd, from_session, status, attempt, created_at, group_id, idempotency_key)
         VALUES (?, ?, ?, ?, ?, 'created', 1, ?, ?, ?)`,
      )
      .run(
        id,
        input.runtime,
        input.content,
        input.cwd,
        input.fromSession ?? "dashboard",
        at,
        input.groupId ?? null,
        input.idempotencyKey ?? null,
      );
    this.appendEvent(
      id,
      "task/created",
      `runtime=${input.runtime}${input.groupId === undefined ? "" : ` group=${input.groupId}`}`,
      at,
    );
    return { task: this.get(id)!, reused: false };
  }

  /** 取任务（不存在返回 null） */
  get(id: string): AgentTaskRecord | null {
    const row = this.db
      .query("SELECT * FROM agent_tasks WHERE id = ?")
      .get(id) as TaskRow | null;
    return row ? rowToTask(row) : null;
  }

  /** 按幂等键取任务 */
  findByIdempotencyKey(key: string): AgentTaskRecord | null {
    const row = this.db
      .query(
        "SELECT * FROM agent_tasks WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(key) as TaskRow | null;
    return row ? rowToTask(row) : null;
  }

  /**
   * 列表（created_at DESC；键集分页）。
   *
   * @param filter - 状态/运行时/limit/cursor
   */
  list(filter: ListAgentTasksFilter = {}): AgentTaskRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (statuses.length > 0) {
        where.push(`status IN (${statuses.map(() => "?").join(",")})`);
        params.push(...statuses);
      }
    }
    if (filter.runtime !== undefined && filter.runtime !== "") {
      where.push("runtime = ?");
      params.push(filter.runtime);
    }
    if (filter.groupId !== undefined && filter.groupId !== "") {
      where.push("group_id = ?");
      params.push(filter.groupId);
    }
    if (filter.cursor !== undefined && filter.cursor !== "") {
      const cursorTask = this.get(filter.cursor);
      if (cursorTask) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(cursorTask.createdAt, cursorTask.createdAt, cursorTask.id);
      }
    }
    const sql =
      `SELECT * FROM agent_tasks${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}` +
      " ORDER BY created_at DESC, id DESC LIMIT ?";
    const rows = this.db.query(sql).all(...params, limit) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** 非终态任务（启动恢复用） */
  listNonTerminal(): AgentTaskRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM agent_tasks
         WHERE status IN ('created','dispatched','running')
         ORDER BY created_at`,
      )
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  /** 某 runtime 在 `sinceMs` 之后创建的任务数（24h 统计用） */
  countSince(runtime: string, sinceMs: number): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS n FROM agent_tasks WHERE runtime = ? AND created_at >= ?",
      )
      .get(runtime, sinceMs) as { n: number } | null;
    return row?.n ?? 0;
  }

  /**
   * 推进状态（写行 + 写事件，二者同一事务）。
   *
   * @param id - 任务 id
   * @param next - 目标状态
   * @param patch - 附带字段（结果/错误/sessionId/attempt 等）
   * @param at - 事件时间（默认 now）
   * @returns 推进后的任务
   * @throws {Error} 任务不存在或转移非法
   */
  setStatus(
    id: string,
    next: AgentTaskStatus,
    patch: {
      detail?: string;
      result?: string;
      error?: string;
      acpSessionId?: string;
      attempt?: number;
    } = {},
    at?: number,
  ): AgentTaskRecord {
    return this.transition(id, next, patch, at).task;
  }

  /**
   * 推进状态并**把新产生的事件一起返回**（实时推送要用它）。
   *
   * `setStatus()` 是它的薄包装；服务层用这个版本把 `task/<status>` 事件帧推给 SSE
   * 订阅者，避免「状态变了但时间线里没有对应事件」。
   *
   * @param id - 任务 id
   * @param next - 目标状态
   * @param patch - 附带字段
   * @param at - 事件时间（默认 now）
   * @returns 推进后的任务 + 本次新增的事件（状态未变时为 undefined）
   * @throws {Error} 任务不存在或转移非法
   */
  transition(
    id: string,
    next: AgentTaskStatus,
    patch: {
      detail?: string;
      result?: string;
      error?: string;
      acpSessionId?: string;
      attempt?: number;
    } = {},
    at?: number,
  ): { task: AgentTaskRecord; event?: AgentTaskEventRow } {
    const current = this.get(id);
    if (!current) throw new Error(`agent task ${id} not found`);
    if (current.status !== next && !ALLOWED_TRANSITIONS[current.status].includes(next)) {
      throw new Error(`非法状态转移：${current.status} → ${next}（task ${id}）`);
    }
    const when = at ?? this.now();
    const sets: string[] = ["status = ?"];
    const params: Array<string | number | null> = [next];

    if (next === "dispatched" && current.dispatchedAt === undefined) {
      sets.push("dispatched_at = ?");
      params.push(when);
    }
    if (next === "running" && current.startedAt === undefined) {
      sets.push("started_at = ?");
      params.push(when);
    }
    if (isTerminalTaskStatus(next)) {
      sets.push("finished_at = ?");
      params.push(when);
    }
    if (patch.result !== undefined) {
      sets.push("result = ?");
      params.push(patch.result);
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      params.push(patch.error);
    }
    if (patch.acpSessionId !== undefined) {
      sets.push("acp_session_id = ?");
      params.push(patch.acpSessionId);
    }
    if (patch.attempt !== undefined) {
      sets.push("attempt = ?");
      params.push(patch.attempt);
    }
    params.push(id);
    this.db.query(`UPDATE agent_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const event =
      current.status === next
        ? undefined
        : this.appendEvent(id, `task/${next}` as AgentTaskEventType, patch.detail, when);
    return {
      task: this.get(id)!,
      ...(event === undefined ? {} : { event }),
    };
  }

  /**
   * 补记目标会话 id（不改状态、不写事件）。
   *
   * claude 这类「跑完才知道 `session_id`」的协议用：结果落库时把 id 记上，
   * 下一次 retry 才能 `--resume` 续聊。
   *
   * @param id - 任务 id
   * @param sessionId - 目标侧会话 id
   */
  setAcpSessionId(id: string, sessionId: string): void {
    this.db.query("UPDATE agent_tasks SET acp_session_id = ? WHERE id = ?").run(sessionId, id);
  }

  /**
   * 重试：终态（failed / cancelled / expired）→ 新 attempt（同一 taskId）。
   *
   * 7 态表把这三个状态标为终态，因此这里**显式**打断终态：先写 `task/retried`
   * 事件留痕（attempt 递增在事件 detail 与行字段里都可见），再由调用方派发。
   * 不做静默自动重试 —— 每次重试都必须是显式的一条事件。
   *
   * 注意：`acp_session_id` **保留**（其余尝试态字段清空）—— 重试时若目标声明了
   * resume 能力，服务层会用这个 id 续聊同一个目标会话，而不是新开一个。
   *
   * @param id - 任务 id
   * @param detail - 重试原因（写进事件 detail）
   * @returns 重置后的任务（status=created，attempt+1）
   * @throws {Error} 任务不存在 / 非终态 / 终态不允许重试
   */
  resetForRetry(id: string, detail?: string): AgentTaskRecord {
    const current = this.get(id);
    if (!current) throw new Error(`agent task ${id} not found`);
    if (!isTerminalTaskStatus(current.status)) {
      throw new Error(`任务 ${id} 尚未结束（${current.status}），不能重试`);
    }
    const when = this.now();
    const attempt = current.attempt + 1;
    this.appendEvent(
      id,
      "task/retried",
      detail ?? `第 ${attempt} 次尝试（上一状态 ${current.status}）`,
      when,
    );
    this.db
      .query(
        `UPDATE agent_tasks
         SET status = 'created', attempt = ?, dispatched_at = NULL, started_at = NULL,
             finished_at = NULL, result = NULL, error = NULL
         WHERE id = ?`,
      )
      .run(attempt, id);
    return this.get(id)!;
  }

  /** 只写事件（不改状态；用于 accepted / stream-chunk / retried 这类旁路事实） */
  appendEvent(
    id: string,
    type: AgentTaskEventType,
    detail?: string,
    at?: number,
  ): AgentTaskEventRow {
    const when = at ?? this.now();
    const max = this.db
      .query("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM agent_task_events WHERE task_id = ?")
      .get(id) as { max_seq: number };
    const seq = max.max_seq + 1;
    this.db
      .query(
        "INSERT INTO agent_task_events (task_id, seq, type, detail, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, seq, type, detail ?? null, when);
    return { seq, at: when, type, ...(detail === undefined ? {} : { detail }) };
  }

  /** 读事件流（seq 升序） */
  events(id: string, afterSeq = 0): AgentTaskEventRow[] {
    const rows = this.db
      .query(
        "SELECT seq, at, type, detail FROM agent_task_events WHERE task_id = ? AND seq > ? ORDER BY seq",
      )
      .all(id, afterSeq) as EventRow[];
    return rows.map((row) => ({
      seq: row.seq,
      at: row.at,
      type: row.type as AgentTaskEventType,
      ...(row.detail === null ? {} : { detail: row.detail }),
    }));
  }

  /** 事件流重放出的状态（对拍用） */
  replayStatus(id: string): AgentTaskStatus | null {
    return replayAgentTaskStatus(this.events(id));
  }

  /** 关闭自建连接（复用的连接由调用方负责） */
  close(): void {
    if (this.ownsDb) this.db.close();
  }
}
