/**
 * @fengagent/agent — 任务状态仓 + 副作用台账（SQLite）
 *
 * 「任务可安全恢复」的落盘层，三张表：
 *
 * - `task_states`   —— 当前结构化任务状态（TaskState），带 `state_version` 乐观锁；
 * - `task_events`   —— `task/*` 事件流（seq 单调），重放它与实时状态对拍零差异；
 * - `operation_ledger` —— 副作用台账，**执行前** begin、执行后 complete。
 *
 * 与 `SessionStore` 共用同一个 SQLite 文件（同一 data root），但表名互不重叠，
 * 且建表全走 `CREATE TABLE IF NOT EXISTS` —— 老库直接开箱可用，无需迁移。
 */

import { Database } from "bun:sqlite";
import type {
  BeginOperationInput,
  OperationLedger,
  OperationRecord,
  OperationStatus,
  TaskEvent,
  TaskState,
} from "@fengagent/core";
import {
  TaskStateError,
  reduceTaskState,
  replayTaskState,
} from "@fengagent/core";
import { expandTilde } from "@fengagent/shared/utils";

// ──────────────────────────────────────────────
// 数据库行
// ──────────────────────────────────────────────

interface TaskStateRow {
  task_id: string;
  session_id: string;
  state_json: string;
  state_version: number;
}

interface TaskEventRow {
  seq: number;
  type: string;
  payload: string;
  at: number;
}

interface OperationRow {
  operation_id: string;
  operation_key: string;
  tool_name: string;
  session_id: string;
  task_id: string | null;
  step_id: string | null;
  input_json: string;
  status: string;
  result_digest: string | null;
  result_json: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

/** 行 → OperationRecord */
function rowToRecord(row: OperationRow): OperationRecord {
  return {
    operationId: row.operation_id,
    operationKey: row.operation_key,
    toolName: row.tool_name,
    sessionId: row.session_id,
    taskId: row.task_id ?? undefined,
    stepId: row.step_id ?? undefined,
    input: safeParse(row.input_json),
    status: row.status as OperationStatus,
    resultDigest: row.result_digest ?? undefined,
    resultJson: row.result_json === null ? undefined : safeParse(row.result_json),
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ──────────────────────────────────────────────
// 副作用台账（SQLite 实现）
// ──────────────────────────────────────────────

/**
 * SQLite 副作用台账。
 *
 * `begin()` 使用 `INSERT OR IGNORE` + 唯一索引 `operation_key`：
 * 同一幂等键并发进入时只有第一条能落成 pending，其余读到既有记录，
 * 因此「同一副作用只发生一次」在存储层就已经成立，不依赖调用方自觉。
 */
export class SqliteOperationLedger implements OperationLedger {
  constructor(private readonly db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operation_ledger (
        operation_id TEXT PRIMARY KEY,
        operation_key TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT,
        step_id TEXT,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL,
        result_digest TEXT,
        result_json TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_operation_status
        ON operation_ledger(status);
    `);
    // 幂等键唯一 —— INSERT OR IGNORE 才能真正挡住「同一副作用并发进入两次」，
    // 去重因此落在存储层，不依赖调用方自觉（也便于并发测试反证）。
    try {
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_key_unique ON operation_ledger(operation_key);",
      );
    } catch {
      // 老库里已存在重复键（历史数据）时退化为普通索引：查表仍按最新一条，
      // 但不会因为建索引失败而拒绝启动。
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_operation_key ON operation_ledger(operation_key, started_at DESC);",
      );
    }
  }

  begin(entry: BeginOperationInput): OperationRecord {
    this.db
      .query(
        `INSERT OR IGNORE INTO operation_ledger
         (operation_id, operation_key, tool_name, session_id, task_id, step_id,
          input_json, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        entry.operationId,
        entry.operationKey,
        entry.toolName,
        entry.sessionId,
        entry.taskId ?? null,
        entry.stepId ?? null,
        JSON.stringify(entry.input ?? null),
        entry.startedAt,
      );
    // 命中一条 failed 记录并重新执行时，把它重新置为 pending：
    // 「失败」不是终态，而「pending」才是「已开始、结果未知」的唯一表达。
    // succeeded / unknown 不会被这里改写 —— 那两类必须由恢复决策处理。
    this.db
      .query(
        `UPDATE operation_ledger
         SET status = 'pending', error = NULL, started_at = ?, step_id = ?, task_id = ?
         WHERE operation_key = ? AND status = 'failed'`,
      )
      .run(
        entry.startedAt,
        entry.stepId ?? null,
        entry.taskId ?? null,
        entry.operationKey,
      );
    const stored = this.lookup(entry.operationKey);
    // INSERT OR IGNORE 未插入（键已存在）时返回既有记录 —— 调用方据此走恢复决策
    return stored ?? {
      operationId: entry.operationId,
      operationKey: entry.operationKey,
      toolName: entry.toolName,
      sessionId: entry.sessionId,
      taskId: entry.taskId,
      stepId: entry.stepId,
      input: entry.input,
      status: "pending",
      startedAt: entry.startedAt,
    };
  }

  complete(
    operationId: string,
    result: { digest: string; json?: unknown; finishedAt: number },
  ): void {
    this.db
      .query(
        `UPDATE operation_ledger
         SET status = 'succeeded', result_digest = ?, result_json = ?, finished_at = ?
         WHERE operation_id = ?`,
      )
      .run(
        result.digest,
        result.json === undefined ? null : JSON.stringify(result.json),
        result.finishedAt,
        operationId,
      );
  }

  fail(operationId: string, error: string, finishedAt: number): void {
    this.db
      .query(
        `UPDATE operation_ledger
         SET status = 'failed', error = ?, finished_at = ?
         WHERE operation_id = ?`,
      )
      .run(error, finishedAt, operationId);
  }

  markUnknown(operationId: string): void {
    this.db
      .query(
        `UPDATE operation_ledger SET status = 'unknown'
         WHERE operation_id = ? AND status = 'pending'`,
      )
      .run(operationId);
  }

  lookup(operationKey: string): OperationRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM operation_ledger WHERE operation_key = ?
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(operationKey) as OperationRow | null;
    return row ? rowToRecord(row) : null;
  }

  get(operationId: string): OperationRecord | null {
    const row = this.db
      .query("SELECT * FROM operation_ledger WHERE operation_id = ?")
      .get(operationId) as OperationRow | null;
    return row ? rowToRecord(row) : null;
  }

  listPending(): OperationRecord[] {
    const rows = this.db
      .query(
        "SELECT * FROM operation_ledger WHERE status IN ('pending','unknown') ORDER BY started_at",
      )
      .all() as OperationRow[];
    return rows.map(rowToRecord);
  }

  /** 列出某会话的全部台账（验收/对拍用） */
  listBySession(sessionId: string): OperationRecord[] {
    const rows = this.db
      .query(
        "SELECT * FROM operation_ledger WHERE session_id = ? ORDER BY started_at",
      )
      .all(sessionId) as OperationRow[];
    return rows.map(rowToRecord);
  }
}

// ──────────────────────────────────────────────
// 任务状态仓
// ──────────────────────────────────────────────

/** 任务状态仓选项 */
export interface TaskStoreOptions {
  /** 复用既有数据库连接（默认按 dbPath 自建） */
  db?: Database;
}

/**
 * 任务状态仓。
 *
 * 所有状态推进都必须经 `applyEvent(taskId, expectedVersion, event)`：
 * 版本不匹配直接抛 {@link TaskStateError}（`stale_state_version`），
 * 陈旧写入被拒而不是静默覆盖 —— 这是 checkpoint 乐观锁语义的可反证形态。
 */
export class TaskStore {
  private db: Database;
  private ownsDb: boolean;
  readonly ledger: SqliteOperationLedger;

  constructor(dbPath: string, options?: TaskStoreOptions) {
    if (options?.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      this.db = new Database(expandTilde(dbPath));
      this.ownsDb = true;
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_states (
        task_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        state_version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_states_session
        ON task_states(session_id);

      CREATE TABLE IF NOT EXISTS task_events (
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (task_id, seq)
      );
    `);
    this.ledger = new SqliteOperationLedger(this.db);
  }

  // ── 创建 / 读取 ──────────────────────────────

  /**
   * 创建任务（core_intent 只读锚点）。
   *
   * @throws {TaskStateError} 该 taskId 已存在
   */
  createTask(input: {
    taskId: string;
    sessionId: string;
    coreIntent: string;
    at?: number;
  }): TaskState {
    const at = input.at ?? Date.now();
    const event: TaskEvent = {
      type: "task/created",
      taskId: input.taskId,
      sessionId: input.sessionId,
      coreIntent: input.coreIntent,
      at,
    };
    if (this.getTask(input.taskId)) {
      throw new TaskStateError(
        `task ${input.taskId} already exists`,
        "task_already_created",
      );
    }
    return this.applyEvent(input.taskId, 0, event);
  }

  /** 取任务（不存在返回 null） */
  getTask(taskId: string): TaskState | null {
    const row = this.db
      .query("SELECT * FROM task_states WHERE task_id = ?")
      .get(taskId) as TaskStateRow | null;
    return row ? (safeParse(row.state_json) as TaskState) : null;
  }

  /** 按会话取任务（一个会话一个可恢复任务；多任务时取最新） */
  getTaskBySession(sessionId: string): TaskState | null {
    const row = this.db
      .query(
        `SELECT s.* FROM task_states s
         JOIN (SELECT task_id, MAX(seq) AS max_seq FROM task_events
               WHERE task_id IN (SELECT task_id FROM task_states WHERE session_id = ?)
               GROUP BY task_id) e ON e.task_id = s.task_id
         WHERE s.session_id = ?
         ORDER BY e.max_seq DESC LIMIT 1`,
      )
      .get(sessionId, sessionId) as TaskStateRow | null;
    return row ? (safeParse(row.state_json) as TaskState) : null;
  }

  /** 列出某会话的全部任务 */
  listTasksBySession(sessionId: string): TaskState[] {
    const rows = this.db
      .query("SELECT * FROM task_states WHERE session_id = ? ORDER BY state_version")
      .all(sessionId) as TaskStateRow[];
    return rows.map((r) => safeParse(r.state_json) as TaskState);
  }

  // ── 状态推进（乐观锁）────────────────────────

  /**
   * 应用一条任务事件。
   *
   * @param taskId - 任务 id
   * @param expectedVersion - 调用方看到的版本（0 = 期望任务尚不存在）
   * @param event - 任务事件
   * @returns 推进后的状态
   * @throws {TaskStateError} 版本陈旧
   */
  applyEvent(
    taskId: string,
    expectedVersion: number,
    event: TaskEvent,
  ): TaskState {
    const current = this.getTask(taskId);
    const currentVersion = current?.stateVersion ?? 0;
    if (currentVersion !== expectedVersion) {
      throw new TaskStateError(
        `stale state_version for task ${taskId}: expected ${expectedVersion}, stored ${currentVersion}`,
        "stale_state_version",
      );
    }
    const next = reduceTaskState(current, event);
    this.persist(next, event);
    return next;
  }

  /**
   * 便捷推进：承接当前版本（读取 → 应用），失败即抛。
   *
   * 并发写入下后到的一方可被 `stale_state_version` 拒绝。
   */
  appendEvent(taskId: string, event: TaskEvent): TaskState {
    const current = this.getTask(taskId);
    return this.applyEvent(taskId, current?.stateVersion ?? 0, event);
  }

  private persist(state: TaskState, event: TaskEvent): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO task_states
         (task_id, session_id, state_json, state_version) VALUES (?, ?, ?, ?)`,
      )
      .run(
        state.taskId,
        state.sessionId,
        JSON.stringify(state),
        state.stateVersion,
      );
    const maxRow = this.db
      .query("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM task_events WHERE task_id = ?")
      .get(state.taskId) as { max_seq: number };
    this.db
      .query(
        `INSERT INTO task_events (task_id, seq, type, payload, at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        state.taskId,
        maxRow.max_seq + 1,
        event.type,
        JSON.stringify(event),
        event.at,
      );
  }

  // ── 事件流 / 重放 ────────────────────────────

  /** 读取任务事件流（seq 升序） */
  events(taskId: string): TaskEvent[] {
    const rows = this.db
      .query("SELECT * FROM task_events WHERE task_id = ? ORDER BY seq")
      .all(taskId) as TaskEventRow[];
    return rows.map((r) => safeParse(r.payload) as TaskEvent);
  }

  /**
   * 重放事件流重建状态 —— 与 `getTask` 对拍应当零差异。
   */
  replay(taskId: string): TaskState | null {
    return replayTaskState(this.events(taskId));
  }

  /** 关闭自建连接（复用的连接由调用方负责） */
  close(): void {
    if (this.ownsDb) this.db.close();
  }
}
