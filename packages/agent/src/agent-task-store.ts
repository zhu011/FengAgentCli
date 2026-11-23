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

/** 外派任务状态（与 WebUI 的 `AgentTaskStatus` 同枚举，8 态） */
export type AgentTaskStatus =
  | "created"
  /** P3-1：任务池里被某个 agent 原子认领（非终态，带租约） */
  | "claimed"
  | "dispatched"
  | "running"
  | "replied"
  | "failed"
  | "cancelled"
  | "expired";

/** 认领策略（P3-1）：`assigned`=点名派发（默认，语义零变化）；`pool`=开放任务池 */
export type AgentTaskClaimPolicy = "assigned" | "pool";

/** 认领失败原因（服务层 → 路由层映射 HTTP 状态用） */
export type ClaimFailureCode =
  | "not_found"
  | "not_pool"
  | "not_claimable"
  | "already_claimed"
  | "agent_busy";

/** 认领失败（携带机器可读原因，路由 409/404 靠它分类） */
export interface ClaimFailure {
  ok: false;
  code: ClaimFailureCode;
  message: string;
  /** 失败时的任务快照（不存在时为 null） */
  task: AgentTaskRecord | null;
}

/** 认领成功（`changes === 1` 的那个赢家才拿得到） */
export interface ClaimSuccess {
  ok: true;
  task: AgentTaskRecord;
  event: AgentTaskEventRow;
}

/** 外派任务事件类型（与 WebUI 的 `AgentTaskEvent["type"]` 同枚举） */
export type AgentTaskEventType =
  | "task/created"
  /** P3-1：原子认领成功（detail 带 agent 与租约到期时间） */
  | "task/claimed"
  /** P3-1：租约过期/崩溃恢复 → 退回池子（claimed → created），不判死 */
  | "task/requeued"
  | "task/dispatched"
  | "task/accepted"
  | "task/running"
  | "task/stream-chunk"
  /** 旁路事件：任务进入等待审批（不改 7 态状态机，时间线可见） */
  | "task/blocked"
  /** 旁路事件：裁决回来、续跑（与 task/blocked 成对） */
  | "task/unblocked"
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

/** 合法转移（8 态表；越界转移直接抛错，避免状态被写坏） */
const ALLOWED_TRANSITIONS: Record<AgentTaskStatus, readonly AgentTaskStatus[]> = {
  created: ["claimed", "dispatched", "cancelled", "expired", "failed"],
  // 认领后只能往前派发或被取消；回池（claimed → created）走 requeue()，
  // 因为那一步要清掉认领人/租约并写 `task/requeued`，不是普通状态推进。
  claimed: ["dispatched", "cancelled", "failed"],
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
  /** 派单方智能体 id（P0：`{agent:"coder"}` 派单时写入；直接按 runtime 派单为 undefined） */
  agentId?: string;
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
  /** 认领策略（P3-1）：默认 `assigned`（点名派发）；`pool` 进任务池等认领 */
  claimPolicy: AgentTaskClaimPolicy;
  /** 池范围（小队 id；空 = 全局池）——只有 `claimPolicy='pool'` 才有意义 */
  poolScope?: string;
  /** 池内技能标签过滤提示（roster skill 名；认领人须已挂载这些技能） */
  skillTags?: string[];
  /** 认领人（= `agentId`；`claimedAt` 有值才表示这次是认领来的） */
  claimedAt?: number;
  /** 租约到期（毫秒；过期由租约回收退回池子，不判死） */
  leaseExpiresAt?: number;
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
  /** 派单方智能体 id（P0；缺省 = 按 runtime 直接派发） */
  agentId?: string;
  content: string;
  cwd: string;
  fromSession?: string;
  /** 群内派发（G2）：结果回群时按它定位 */
  groupId?: string;
  idempotencyKey?: string;
  /** P3-1：认领策略（默认 assigned） */
  claimPolicy?: AgentTaskClaimPolicy;
  /** P3-1：池范围（小队 id；空 = 全局池） */
  poolScope?: string;
  /** P3-1：池内技能标签（认领人须已挂载这些技能） */
  skillTags?: string[];
  at?: number;
}

/** 列表过滤 */
export interface ListAgentTasksFilter {
  status?: AgentTaskStatus | AgentTaskStatus[];
  runtime?: string;
  /** 只看某个智能体派出的任务（P0） */
  agentId?: string;
  /** 只看某个群派出的任务（G2） */
  groupId?: string;
  /** 只看某个认领策略（P3-1） */
  claimPolicy?: AgentTaskClaimPolicy;
  /** 只看某个池范围（P3-1） */
  poolScope?: string;
  /** 默认 50，上限 200 */
  limit?: number;
  /** 上一页最后一条的 `id`（简单键集分页：按 created_at DESC, id DESC） */
  cursor?: string;
}

interface TaskRow {
  id: string;
  runtime: string;
  /** P0 新增列：老库可能没有（migration 补齐） */
  agent_id?: string | null;
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
  /** P3-1 新增列（老库 migration 补齐） */
  claim_policy?: string | null;
  pool_scope?: string | null;
  skill_tags?: string | null;
  claimed_at?: number | null;
  lease_expires_at?: number | null;
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
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
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
    claimPolicy: (row.claim_policy === "pool" ? "pool" : "assigned") as AgentTaskClaimPolicy,
    ...(row.pool_scope === null || row.pool_scope === undefined
      ? {}
      : { poolScope: row.pool_scope }),
    ...(row.skill_tags === null || row.skill_tags === undefined || row.skill_tags === ""
      ? {}
      : { skillTags: parseSkillTags(row.skill_tags) }),
    ...(row.claimed_at === null || row.claimed_at === undefined
      ? {}
      : { claimedAt: row.claimed_at }),
    ...(row.lease_expires_at === null || row.lease_expires_at === undefined
      ? {}
      : { leaseExpiresAt: row.lease_expires_at }),
  };
}

/** skill_tags 列（JSON 数组字符串）→ 名字数组；坏数据按空数组处理，不让一行脏数据拖垮列表 */
function parseSkillTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  } catch {
    return [];
  }
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
    // 认领回池也是一次「回到 created」——重放必须能还原，否则崩溃恢复对拍会误判写坏
    "task/requeued": "created",
    "task/claimed": "claimed",
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
        agent_id TEXT,
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
        idempotency_key TEXT,
        claim_policy TEXT NOT NULL DEFAULT 'assigned',
        pool_scope TEXT,
        skill_tags TEXT,
        claimed_at INTEGER,
        lease_expires_at INTEGER
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
    // 老库迁移（P0）：`agent_id` 是绑定的归属列，缺失即补（历史任务保持 NULL）。
    if (!columns.some((column) => column.name === "agent_id")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN agent_id TEXT");
    }
    // 老库迁移（P3-1）：任务池认领五列。`claim_policy` 必须 NOT NULL DEFAULT，
    // 否则历史任务读出来是 NULL，`claim_policy='pool'` 的条件 UPDATE 会静默不匹配。
    this.ensureColumn("claim_policy", "TEXT NOT NULL DEFAULT 'assigned'");
    this.ensureColumn("pool_scope", "TEXT");
    this.ensureColumn("skill_tags", "TEXT");
    this.ensureColumn("claimed_at", "INTEGER");
    this.ensureColumn("lease_expires_at", "INTEGER");
    // 池查询索引放在补列之后：老库上先建索引会因缺列直接抛错，整个构造失败。
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_agent_tasks_pool ON agent_tasks(claim_policy, pool_scope, created_at DESC)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent ON agent_tasks(agent_id, created_at DESC)",
    );
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
   * 老库补列（`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列）。
   *
   * @param name - 列名
   * @param ddl - 列定义（含默认值）
   */
  private ensureColumn(name: string, ddl: string): void {
    const columns = this.db
      .query("PRAGMA table_info(agent_tasks)")
      .all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === name)) return;
    this.db.exec(`ALTER TABLE agent_tasks ADD COLUMN ${name} ${ddl}`);
  }

  /**
   * 建任务（幂等键命中时返回既有任务）。
   *
   * P3-1：`claimPolicy='pool'` 时不派发、也不要求 runtime —— 任务停在 `created`
   * 等池子里的人认领（认领时才按认领人的绑定解析 runtime）。
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
    const claimPolicy: AgentTaskClaimPolicy = input.claimPolicy === "pool" ? "pool" : "assigned";
    const skillTags = (input.skillTags ?? [])
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "");
    this.db
      .query(
        `INSERT INTO agent_tasks
         (id, runtime, agent_id, content, cwd, from_session, status, attempt, created_at, group_id, idempotency_key,
          claim_policy, pool_scope, skill_tags)
         VALUES (?, ?, ?, ?, ?, ?, 'created', 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runtime,
        input.agentId ?? null,
        input.content,
        input.cwd,
        input.fromSession ?? "dashboard",
        at,
        input.groupId ?? null,
        input.idempotencyKey ?? null,
        claimPolicy,
        input.poolScope ?? null,
        skillTags.length === 0 ? null : JSON.stringify(skillTags),
      );
    this.appendEvent(
      id,
      "task/created",
      `runtime=${input.runtime}` +
        (input.agentId === undefined ? "" : ` agent=${input.agentId}`) +
        (input.groupId === undefined ? "" : ` group=${input.groupId}`) +
        (claimPolicy === "pool" ? ` pool=${input.poolScope ?? "*"}` : ""),
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
    if (filter.agentId !== undefined && filter.agentId !== "") {
      where.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter.groupId !== undefined && filter.groupId !== "") {
      where.push("group_id = ?");
      params.push(filter.groupId);
    }
    if (filter.claimPolicy !== undefined) {
      where.push("claim_policy = ?");
      params.push(filter.claimPolicy);
    }
    if (filter.poolScope !== undefined && filter.poolScope !== "") {
      where.push("pool_scope = ?");
      params.push(filter.poolScope);
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

  /** 非终态任务（启动恢复用；含池里被认领但还没派发的 `claimed`） */
  listNonTerminal(): AgentTaskRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM agent_tasks
         WHERE status IN ('created','claimed','dispatched','running')
         ORDER BY created_at`,
      )
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * 池里可认领的任务（P3-1）：`claim_policy='pool'` 且还没人认领（`created`）。
   *
   * @param filter.squad - 只看某个小队的池（传了才加 `pool_scope` 条件）
   * @param filter.limit - 默认 50，上限 200
   * @returns 按 created_at 升序（先进先出，不会有任务永远沉底）
   */
  listClaimable(filter: { squad?: string; limit?: number } = {}): AgentTaskRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const where = ["claim_policy = 'pool'", "status = 'created'"];
    const params: string[] = [];
    if (filter.squad !== undefined && filter.squad !== "") {
      where.push("pool_scope = ?");
      params.push(filter.squad);
    }
    const rows = this.db
      .query(
        `SELECT * FROM agent_tasks WHERE ${where.join(" AND ")} ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(...params, limit) as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * 池视图（P3-1）：某个池里**所有状态**的任务（含已被认领/租约中的），供前端展示。
   *
   * @param filter.squad - 池范围（小队 id；空 = 全局池也一起看）
   * @param filter.limit - 默认 50，上限 200
   */
  listPool(filter: { squad?: string; limit?: number } = {}): AgentTaskRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const where = ["claim_policy = 'pool'"];
    const params: string[] = [];
    if (filter.squad !== undefined && filter.squad !== "") {
      where.push("pool_scope = ?");
      params.push(filter.squad);
    }
    const rows = this.db
      .query(
        `SELECT * FROM agent_tasks WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit) as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * 某 agent 当前在飞的任务（per-agent 串行的可读入口）。
   *
   * @param agentId - 智能体 id
   */
  findInflightByAgent(agentId: string): AgentTaskRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM agent_tasks
         WHERE agent_id = ? AND status IN ('claimed','dispatched','running')
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(agentId) as TaskRow | null;
    return row ? rowToTask(row) : null;
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
   * **原子认领**（P3-1）：一条条件 UPDATE 定胜负，`changes === 1` 才算赢。
   *
   * 刻意不写成「先 SELECT 再 UPDATE」：两个 agent 同时认领同一条任务时，
   * 读-判-写之间会被对方插进来，两边都以为自己赢；把「池任务 + 仍是 created +
   * 这个 agent 手上没有别的在飞任务」全塞进 WHERE，让数据库写锁替我们裁决。
   *
   * 两道保险之一（per-agent 串行）：`NOT EXISTS` 子查询保证同一个 agent 同时只有
   * 一条 `claimed` / `dispatched` / `running` 任务 —— 池任务不抢单、不并发囤活。
   *
   * @param id - 任务 id
   * @param agentId - 认领人
   * @param options.leaseMs - 租约时长（到期由 {@link requeueExpired} 退回池子）
   * @param options.runtime - 任务没写死 runtime 时，按认领人绑定解析出的 runtime
   * @param options.now - 覆盖当前时间（测试用）
   * @returns 赢家拿 `{ok:true, task, event}`；输家拿机器可读的失败原因
   */
  claim(
    id: string,
    agentId: string,
    options: { leaseMs: number; runtime?: string; now?: number },
  ): ClaimSuccess | ClaimFailure {
    const at = options.now ?? this.now();
    const leaseExpiresAt = at + Math.max(1, options.leaseMs);
    const normalizedAgent = agentId.trim();
    if (normalizedAgent === "") {
      return {
        ok: false,
        code: "not_found",
        message: "认领人不能为空",
        task: this.get(id),
      };
    }
    const result = this.db
      .query(
        `UPDATE agent_tasks
         SET status = 'claimed', agent_id = ?, claimed_at = ?, lease_expires_at = ?,
             runtime = CASE WHEN runtime = '' AND ? IS NOT NULL THEN ? ELSE runtime END
         WHERE id = ?
           AND claim_policy = 'pool'
           AND status = 'created'
           AND NOT EXISTS (
             SELECT 1 FROM agent_tasks busy
             WHERE busy.agent_id = ?
               AND busy.id <> agent_tasks.id
               AND busy.status IN ('claimed','dispatched','running')
           )`,
      )
      .run(
        normalizedAgent,
        at,
        leaseExpiresAt,
        options.runtime ?? null,
        options.runtime ?? null,
        id,
        normalizedAgent,
      );
    if (result.changes === 1) {
      const task = this.get(id)!;
      const event = this.appendEvent(
        id,
        "task/claimed",
        `agent=${normalizedAgent} lease_until=${new Date(leaseExpiresAt).toISOString()}`,
        at,
      );
      return { ok: true, task, event };
    }
    // 输了才做诊断读：只为给调用方一个准确原因（不参与胜负判定）。
    const task = this.get(id);
    if (!task) {
      return { ok: false, code: "not_found", message: `任务不存在: ${id}`, task: null };
    }
    if (task.claimPolicy !== "pool") {
      return {
        ok: false,
        code: "not_pool",
        message: `任务 ${id} 不是池任务（claim_policy=${task.claimPolicy}），按点名派发执行`,
        task,
      };
    }
    if (task.status !== "created") {
      const taken = task.status === "claimed" || task.status === "dispatched" || task.status === "running";
      return {
        ok: false,
        code: taken ? "already_claimed" : "not_claimable",
        message: taken
          ? `任务 ${id} 已被认领（status=${task.status}${task.agentId === undefined ? "" : `，agent=${task.agentId}`}）`
          : `任务 ${id} 已结束（status=${task.status}），不能认领`,
        task,
      };
    }
    const inflight = this.findInflightByAgent(normalizedAgent);
    return {
      ok: false,
      code: "agent_busy",
      message:
        `agent ${normalizedAgent} 手上还有在飞任务` +
        (inflight === null ? "" : `（${inflight.id} / ${inflight.status}）`) +
        "，同一 agent 同时只能有一条 claimed/dispatched/running",
      task,
    };
  }

  /**
   * 退回池子（`claimed` → `created`）：租约过期、崩溃恢复、显式释放都走它。
   *
   * 与 assigned 任务的恢复口径不同：池任务没派出去就不算失败，退回池子让别人捡，
   * 只有真的派发过（dispatched/running）才按原来的 failed/expired 收尾。
   *
   * @param id - 任务 id
   * @param detail - 事件 detail（为什么退回）
   * @param at - 事件时间
   * @returns 退回后的任务 + 事件；任务已不在 claimed 状态时返回 null（输给并发）
   */
  requeue(
    id: string,
    detail?: string,
    at?: number,
  ): { task: AgentTaskRecord; event: AgentTaskEventRow } | null {
    const when = at ?? this.now();
    const result = this.db
      .query(
        `UPDATE agent_tasks
         SET status = 'created', agent_id = NULL, claimed_at = NULL, lease_expires_at = NULL
         WHERE id = ? AND status = 'claimed'`,
      )
      .run(id);
    if (result.changes !== 1) return null;
    const task = this.get(id)!;
    const event = this.appendEvent(id, "task/requeued", detail ?? "退回任务池", when);
    return { task, event };
  }

  /**
   * 租约回收（P3-1 第二道保险）：把过期未派发的认领退回池子。
   *
   * 条件 UPDATE 逐条做（`WHERE id=? AND status='claimed' AND lease_expires_at<=?`），
   * 谁先退谁算；与「认领人刚好在这一刻派发成功」竞争时不会把 running 的任务拽回池子。
   *
   * @param now - 当前时间（默认 this.now()）
   * @returns 被退回的任务（含事件），供服务层推 SSE
   */
  requeueExpired(now?: number): Array<{ task: AgentTaskRecord; event: AgentTaskEventRow }> {
    const when = now ?? this.now();
    const rows = this.db
      .query(
        `SELECT id, lease_expires_at FROM agent_tasks
         WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
         ORDER BY lease_expires_at ASC`,
      )
      .all(when) as Array<{ id: string; lease_expires_at: number }>;
    const requeued: Array<{ task: AgentTaskRecord; event: AgentTaskEventRow }> = [];
    for (const row of rows) {
      const result = this.db
        .query(
          `UPDATE agent_tasks
           SET status = 'created', agent_id = NULL, claimed_at = NULL, lease_expires_at = NULL
           WHERE id = ? AND status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        )
        .run(row.id, when);
      if (result.changes !== 1) continue;
      const task = this.get(row.id)!;
      const event = this.appendEvent(
        row.id,
        "task/requeued",
        `租约过期（lease_until=${new Date(row.lease_expires_at).toISOString()}），退回任务池`,
        when,
      );
      requeued.push({ task, event });
    }
    return requeued;
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
    // 池任务重试 = 重新回池等认领（认领人/租约清掉），不保留上一轮的归属，
    // 否则它虽然 status=created 却已经「名花有主」，别人永远认领不到。
    const poolReset = current.claimPolicy === "pool";
    this.db
      .query(
        `UPDATE agent_tasks
         SET status = 'created', attempt = ?, dispatched_at = NULL, started_at = NULL,
             finished_at = NULL, result = NULL, error = NULL
             ${poolReset ? ", agent_id = NULL, claimed_at = NULL, lease_expires_at = NULL" : ""}
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
