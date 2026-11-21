/**
 * @fengagent/agent — 小队实体仓（P2，SQLite）
 *
 * 三张表 + 一条 DB 级约束：
 * - `squad` / `squad_member`：小队与成员（成员可以是 agent，也可以是人占位）；
 * - `squad_task` / `squad_run`：一次小队派单 = 一条 leader 任务 + N 条 worker 任务，
 *   每条任务对应一条 run（`squad_run.parent_run_id` 指向 leader run，形成运行树）；
 * - **`leader_id` 必须是成员**：靠 `(id, leader_id) → squad_member(squad_id, member_id)`
 *   的 `DEFERRABLE INITIALLY DEFERRED` 外键在 **COMMIT 时**校验 —— 建队时「先插 squad、
 *   再插成员」也能过，而把队长移出成员 / 把队长改成非成员会被 SQLite 直接拒绝（不是只靠
 *   应用层 if）。`PRAGMA foreign_keys = ON` 在构造时显式打开，不依赖引擎默认值。
 *
 * 为什么单独一个仓而不是塞进 `AgentTaskStore`：小队是「编排层」概念，任务是「执行层」
 * 概念，两者生命周期不同（任务可清、小队要长期存在），表也不重叠。
 */

import { Database } from "bun:sqlite";
import { expandTilde } from "@fengagent/shared/utils";

/** 小队执行模式：leader = 队长软编排（默认）；auto = 算法分配（P2 第二阶段） */
export type SquadMode = "leader" | "auto";

/** 成员类型：agent = 智能体；member = 人占位 */
export type SquadMemberType = "agent" | "member";

/** 小队成员 */
export interface SquadMember {
  memberType: SquadMemberType;
  memberId: string;
  /** 自由文本（不做枚举：枚举会立刻不够用） */
  role: string;
}

/** 小队记录（不含成员） */
export interface SquadRecord {
  id: string;
  name: string;
  description: string;
  leaderId: string;
  mode: SquadMode;
  instructions: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

/** 小队详情（含成员，成员顺序 = 加入顺序） */
export interface SquadDetail extends SquadRecord {
  members: SquadMember[];
}

/** 小队任务状态（编排层；与 AgentTask 的 7 态是两层，不混用） */
export type SquadTaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** 小队任务（leader 一条 + worker N 条） */
export interface SquadTaskRecord {
  id: string;
  squadId: string;
  /** worker → leader 任务的 id；leader 任务为 undefined */
  parentId?: string;
  isLeader: boolean;
  assigneeId: string;
  /** 对应 squad_run.id */
  runId?: string;
  /** 对应 AgentTaskService 的任务 id（真正跑执行的那条） */
  agentTaskId?: string;
  title: string;
  status: SquadTaskStatus;
  attempt: number;
  result?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

/** 小队运行节点（运行树：leader 父 + worker 子） */
export interface SquadRunRecord {
  id: string;
  squadId: string;
  squadTaskId: string;
  agentId: string;
  parentRunId?: string;
  status: string;
  title: string;
  startedAt: number;
  endedAt?: number;
}

/** 错误码（路由层映射 HTTP 状态；与既有 runtimes/skills 契约同风格） */
export type SquadErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "cannot_remove_squad_leader"
  | "leader_not_member"
  | "squad_archived";

/** 小队仓错误 */
export class SquadStoreError extends Error {
  readonly code: SquadErrorCode;

  constructor(code: SquadErrorCode, message: string) {
    super(message);
    this.name = "SquadStoreError";
    this.code = code;
  }
}

/** 建仓选项 */
export interface SquadStoreOptions {
  /** 复用既有连接（与 SessionStore 同库时传进来，避免多连接写锁） */
  db?: Database;
  now?: () => number;
  /** 测试注入可预测 id */
  idFactory?: () => string;
}

/** 建队入参 */
export interface CreateSquadInput {
  id?: string;
  name: string;
  description?: string;
  leaderId: string;
  mode?: SquadMode;
  instructions?: string;
  /** 除队长外的初始成员（队长会被自动加入；memberType 缺省 = agent） */
  members?: Array<{ memberType?: SquadMemberType; memberId: string; role?: string }>;
}

/** 改队入参 */
export interface UpdateSquadInput {
  name?: string;
  description?: string;
  instructions?: string;
  mode?: SquadMode;
}

/** 原始行（SQLite） */
interface SquadRow {
  id: string;
  name: string;
  description: string;
  leader_id: string;
  mode: string;
  instructions: string;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

interface MemberRow {
  squad_id: string;
  member_type: string;
  member_id: string;
  role: string;
}

interface TaskRow {
  id: string;
  squad_id: string;
  parent_id: string | null;
  is_leader: number;
  assignee_id: string;
  run_id: string | null;
  agent_task_id: string | null;
  title: string;
  status: string;
  attempt: number;
  result: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

interface RunRow {
  id: string;
  squad_id: string;
  squad_task_id: string;
  agent_id: string;
  parent_run_id: string | null;
  status: string;
  title: string;
  started_at: number;
  ended_at: number | null;
}

/** 小队 id 合法形态（kebab-case / snake_case 均可，与 spec 示例 `sq_frontend` 一致） */
const SQUAD_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** 小队实体仓 */
export class SquadStore {
  private readonly db: Database;
  private readonly ownsDb: boolean;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(dbPath: string, options: SquadStoreOptions = {}) {
    if (options.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      this.db = new Database(expandTilde(dbPath));
      this.ownsDb = true;
    }
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `sq_${Math.random().toString(36).slice(2, 10)}`);
    // 外键默认关闭的引擎（原生 sqlite3）也必须校验队长约束
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS squad_member (
        squad_id TEXT NOT NULL,
        member_type TEXT NOT NULL,
        member_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (squad_id, member_type, member_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_squad_member_uid ON squad_member(squad_id, member_id);

      CREATE TABLE IF NOT EXISTS squad (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        leader_id TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'leader',
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        -- DB 级约束：队长必须在该小队的成员表里（延迟到 COMMIT 校验，建队与换队长都走它）
        FOREIGN KEY (id, leader_id) REFERENCES squad_member(squad_id, member_id)
          DEFERRABLE INITIALLY DEFERRED
      );

      CREATE TABLE IF NOT EXISTS squad_task (
        id TEXT PRIMARY KEY,
        squad_id TEXT NOT NULL,
        parent_id TEXT,
        is_leader INTEGER NOT NULL DEFAULT 0,
        assignee_id TEXT NOT NULL,
        run_id TEXT,
        agent_task_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        attempt INTEGER NOT NULL DEFAULT 1,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_squad_task_squad ON squad_task(squad_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_squad_task_parent ON squad_task(parent_id);

      CREATE TABLE IF NOT EXISTS squad_run (
        id TEXT PRIMARY KEY,
        squad_id TEXT NOT NULL,
        squad_task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        parent_run_id TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        title TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_squad_run_squad ON squad_run(squad_id, started_at ASC);
    `);
  }

  // ──────────────────────────────────────────────
  // 小队
  // ──────────────────────────────────────────────

  /**
   * 建队（队长自动入成员）。
   *
   * 整段在一个事务里：squad 先插、成员后插，队长外键在 COMMIT 时校验。
   */
  createSquad(input: CreateSquadInput): SquadDetail {
    const name = input.name?.trim() ?? "";
    if (name === "") throw new SquadStoreError("bad_request", "name 不能为空");
    const leaderId = input.leaderId?.trim() ?? "";
    if (leaderId === "") throw new SquadStoreError("bad_request", "leaderId 不能为空");
    const mode: SquadMode = input.mode ?? "leader";
    if (mode !== "leader" && mode !== "auto") {
      throw new SquadStoreError("bad_request", "mode 只能是 leader 或 auto");
    }
    const id = (input.id?.trim() ?? "") === "" ? this.idFactory() : input.id!.trim();
    if (!SQUAD_ID_PATTERN.test(id)) {
      throw new SquadStoreError("bad_request", `小队 id 不合法: ${id}`);
    }
    if (this.getSquad(id)) throw new SquadStoreError("conflict", `小队已存在: ${id}`);

    const at = this.now();
    const members: SquadMember[] = [];
    const seen = new Set<string>();
    for (const member of input.members ?? []) {
      const memberType: SquadMemberType = member.memberType ?? "agent";
      if (memberType !== "agent" && memberType !== "member") {
        throw new SquadStoreError("bad_request", "memberType 只能是 agent 或 member");
      }
      const memberId = member.memberId?.trim() ?? "";
      if (memberId === "") throw new SquadStoreError("bad_request", "成员 id 不能为空");
      if (seen.has(memberId)) continue;
      seen.add(memberId);
      members.push({ memberType, memberId, role: member.role?.trim() ?? "" });
    }
    const leaderMember = members.find((member) => member.memberId === leaderId);
    if (leaderMember) {
      leaderMember.memberType = "agent";
      if (leaderMember.role === "") leaderMember.role = "leader";
    } else {
      members.unshift({ memberType: "agent", memberId: leaderId, role: "leader" });
    }

    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO squad (id, name, description, leader_id, instructions, mode, archived_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, name, input.description ?? "", leaderId, input.instructions ?? "", mode, at, at);
      for (const member of members) {
        this.db
          .query(
            `INSERT INTO squad_member (squad_id, member_type, member_id, role, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(id, member.memberType, member.memberId, member.role, at);
      }
    });
    tx();
    return this.getSquad(id)!;
  }

  /** 小队详情（归档的也返回，带 archived 标记）；不存在返回 undefined */
  getSquad(id: string): SquadDetail | undefined {
    const row = this.db.query("SELECT * FROM squad WHERE id = ?").get(id) as SquadRow | null;
    if (!row) return undefined;
    return { ...toSquad(row), members: this.listMembers(id) };
  }

  /** 小队列表（默认不含归档；按创建时间倒序） */
  listSquads(options: { includeArchived?: boolean } = {}): SquadDetail[] {
    const rows = (
      options.includeArchived === true
        ? this.db.query("SELECT * FROM squad ORDER BY created_at DESC").all()
        : this.db.query("SELECT * FROM squad WHERE archived_at IS NULL ORDER BY created_at DESC").all()
    ) as SquadRow[];
    return rows.map((row) => ({ ...toSquad(row), members: this.listMembers(row.id) }));
  }

  /** 改队（只改名称/描述/指令/模式；成员与队长各有专口） */
  updateSquad(id: string, patch: UpdateSquadInput): SquadDetail {
    const existing = this.requireSquad(id);
    if (existing.archivedAt !== undefined) {
      throw new SquadStoreError("squad_archived", `小队「${id}」已归档`);
    }
    if (patch.mode !== undefined && patch.mode !== "leader" && patch.mode !== "auto") {
      throw new SquadStoreError("bad_request", "mode 只能是 leader 或 auto");
    }
    const name = patch.name === undefined ? existing.name : patch.name.trim();
    if (name === "") throw new SquadStoreError("bad_request", "name 不能为空");
    this.db
      .query("UPDATE squad SET name = ?, description = ?, instructions = ?, mode = ?, updated_at = ? WHERE id = ?")
      .run(
        name,
        patch.description ?? existing.description,
        patch.instructions ?? existing.instructions,
        patch.mode ?? existing.mode,
        this.now(),
        id,
      );
    return this.getSquad(id)!;
  }

  /** 归档（软删，历史保留）；归档后派单返回 `squad_archived` */
  archiveSquad(id: string): SquadDetail {
    this.requireSquad(id);
    this.db.query("UPDATE squad SET archived_at = ?, updated_at = ? WHERE id = ?").run(this.now(), this.now(), id);
    return this.getSquad(id)!;
  }

  /** 成员列表（加入顺序） */
  listMembers(squadId: string): SquadMember[] {
    const rows = this.db
      .query("SELECT * FROM squad_member WHERE squad_id = ? ORDER BY rowid ASC")
      .all(squadId) as MemberRow[];
    return rows.map(toMember);
  }

  /** 加成员（已存在 → conflict；不改既有 role） */
  addMember(squadId: string, member: SquadMember): SquadDetail {
    this.requireActive(squadId);
    const memberId = member.memberId?.trim() ?? "";
    if (memberId === "") throw new SquadStoreError("bad_request", "memberId 不能为空");
    if (member.memberType !== "agent" && member.memberType !== "member") {
      throw new SquadStoreError("bad_request", "memberType 只能是 agent 或 member");
    }
    const exists = this.db
      .query("SELECT 1 FROM squad_member WHERE squad_id = ? AND member_type = ? AND member_id = ?")
      .get(squadId, member.memberType, memberId);
    if (exists) throw new SquadStoreError("conflict", `成员已存在: ${memberId}`);
    this.db
      .query("INSERT INTO squad_member (squad_id, member_type, member_id, role, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(squadId, member.memberType, memberId, member.role?.trim() ?? "", this.now());
    this.touch(squadId);
    return this.getSquad(squadId)!;
  }

  /** 移除成员（现任队长 → 409 `cannot_remove_squad_leader`，必须先换队长） */
  removeMember(squadId: string, memberType: SquadMemberType, memberId: string): SquadDetail {
    const squad = this.requireActive(squadId);
    if (memberType === "agent" && memberId === squad.leaderId) {
      throw new SquadStoreError("cannot_remove_squad_leader", "不能移除现任队长，请先设置新队长");
    }
    const result = this.db
      .query("DELETE FROM squad_member WHERE squad_id = ? AND member_type = ? AND member_id = ?")
      .run(squadId, memberType, memberId);
    if (result.changes === 0) throw new SquadStoreError("not_found", `成员不存在: ${memberId}`);
    this.touch(squadId);
    return this.getSquad(squadId)!;
  }

  /** 换队长（必须是成员，否则 `leader_not_member`；DB 外键兜底） */
  setLeader(squadId: string, leaderId: string): SquadDetail {
    this.requireActive(squadId);
    const id = leaderId?.trim() ?? "";
    if (id === "") throw new SquadStoreError("bad_request", "leaderId 不能为空");
    const member = this.db
      .query("SELECT member_type FROM squad_member WHERE squad_id = ? AND member_id = ?")
      .get(squadId, id) as { member_type: string } | null;
    if (!member) throw new SquadStoreError("leader_not_member", `队长必须是成员: ${id}`);
    if (member.member_type !== "agent") {
      throw new SquadStoreError("leader_not_member", "队长必须是 agent 成员（人占位不能当队长）");
    }
    this.db.query("UPDATE squad SET leader_id = ?, updated_at = ? WHERE id = ?").run(id, this.now(), squadId);
    return this.getSquad(squadId)!;
  }

  /** 是否成员（agent 维度） */
  hasAgentMember(squadId: string, agentId: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM squad_member WHERE squad_id = ? AND member_type = 'agent' AND member_id = ?")
      .get(squadId, agentId);
    return row !== null && row !== undefined;
  }

  // ──────────────────────────────────────────────
  // 任务与运行树
  // ──────────────────────────────────────────────

  /** 建小队任务（不建 run；run 由 createRun 单独建，便于先拿 runId） */
  createTask(input: {
    id?: string;
    squadId: string;
    parentId?: string;
    isLeader: boolean;
    assigneeId: string;
    title: string;
    status?: SquadTaskStatus;
    runId?: string;
    agentTaskId?: string;
  }): SquadTaskRecord {
    const id = input.id ?? `sqt_${Math.random().toString(36).slice(2, 10)}`;
    const at = this.now();
    this.db
      .query(
        `INSERT INTO squad_task (id, squad_id, parent_id, is_leader, assignee_id, run_id, agent_task_id, title, status, attempt, result, error, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, NULL)`,
      )
      .run(
        id,
        input.squadId,
        input.parentId ?? null,
        input.isLeader ? 1 : 0,
        input.assigneeId,
        input.runId ?? null,
        input.agentTaskId ?? null,
        input.title,
        input.status ?? "pending",
        at,
      );
    return this.getTask(id)!;
  }

  /** 单条任务 */
  getTask(id: string): SquadTaskRecord | undefined {
    const row = this.db.query("SELECT * FROM squad_task WHERE id = ?").get(id) as TaskRow | null;
    return row ? toTask(row) : undefined;
  }

  /** 小队任务列表（新 → 旧） */
  listTasks(squadId: string): SquadTaskRecord[] {
    const rows = this.db
      .query("SELECT * FROM squad_task WHERE squad_id = ? ORDER BY created_at ASC")
      .all(squadId) as TaskRow[];
    return rows.map(toTask);
  }

  /** 某 leader 任务的直接子任务 */
  listChildren(leaderTaskId: string): SquadTaskRecord[] {
    const rows = this.db
      .query("SELECT * FROM squad_task WHERE parent_id = ? ORDER BY created_at ASC")
      .all(leaderTaskId) as TaskRow[];
    return rows.map(toTask);
  }

  /** 更新任务（只允许显式字段，避免误改 squad/parent） */
  updateTask(
    id: string,
    patch: {
      status?: SquadTaskStatus;
      result?: string | null;
      error?: string | null;
      runId?: string;
      agentTaskId?: string;
      attempt?: number;
      finishedAt?: number | null;
    },
  ): SquadTaskRecord {
    const existing = this.getTask(id);
    if (!existing) throw new SquadStoreError("not_found", `小队任务不存在: ${id}`);
    const finishedAt =
      patch.finishedAt === undefined ? (existing.finishedAt ?? null) : patch.finishedAt;
    this.db
      .query(
        `UPDATE squad_task
            SET status = ?, result = ?, error = ?, run_id = ?, agent_task_id = ?, attempt = ?, finished_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.status ?? existing.status,
        patch.result === undefined ? (existing.result ?? null) : patch.result,
        patch.error === undefined ? (existing.error ?? null) : patch.error,
        patch.runId ?? existing.runId ?? null,
        patch.agentTaskId ?? existing.agentTaskId ?? null,
        patch.attempt ?? existing.attempt,
        finishedAt,
        id,
      );
    return this.getTask(id)!;
  }

  /** 建 run（运行树节点） */
  createRun(input: {
    id?: string;
    squadId: string;
    squadTaskId: string;
    agentId: string;
    parentRunId?: string;
    title: string;
    status?: string;
  }): SquadRunRecord {
    const id = input.id ?? `run_${Math.random().toString(36).slice(2, 10)}`;
    this.db
      .query(
        `INSERT INTO squad_run (id, squad_id, squad_task_id, agent_id, parent_run_id, status, title, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.squadId,
        input.squadTaskId,
        input.agentId,
        input.parentRunId ?? null,
        input.status ?? "running",
        input.title,
        this.now(),
      );
    return this.getRun(id)!;
  }

  /** 单条 run */
  getRun(id: string): SquadRunRecord | undefined {
    const row = this.db.query("SELECT * FROM squad_run WHERE id = ?").get(id) as RunRow | null;
    return row ? toRun(row) : undefined;
  }

  /** 小队运行树（按开始时间升序，父在子前） */
  listRuns(squadId: string): SquadRunRecord[] {
    const rows = this.db
      .query("SELECT * FROM squad_run WHERE squad_id = ? ORDER BY started_at ASC")
      .all(squadId) as RunRow[];
    return rows.map(toRun);
  }

  /** 更新 run 状态（收口用） */
  updateRun(id: string, patch: { status?: string; endedAt?: number | null }): SquadRunRecord {
    const existing = this.getRun(id);
    if (!existing) throw new SquadStoreError("not_found", `小队运行不存在: ${id}`);
    const endedAt = patch.endedAt === undefined ? (existing.endedAt ?? null) : patch.endedAt;
    this.db
      .query("UPDATE squad_run SET status = ?, ended_at = ? WHERE id = ?")
      .run(patch.status ?? existing.status, endedAt, id);
    return this.getRun(id)!;
  }

  /** 关库（注入的共享连接不关） */
  close(): void {
    if (this.ownsDb) this.db.close();
  }

  private requireSquad(id: string): SquadDetail {
    const squad = this.getSquad(id);
    if (!squad) throw new SquadStoreError("not_found", `小队不存在: ${id}`);
    return squad;
  }

  private requireActive(id: string): SquadDetail {
    const squad = this.requireSquad(id);
    if (squad.archivedAt !== undefined) {
      throw new SquadStoreError("squad_archived", `小队「${id}」已归档`);
    }
    return squad;
  }

  private touch(id: string): void {
    this.db.query("UPDATE squad SET updated_at = ? WHERE id = ?").run(this.now(), id);
  }
}

/** 行 → 小队 */
function toSquad(row: SquadRow): SquadRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    leaderId: row.leader_id,
    mode: row.mode === "auto" ? "auto" : "leader",
    instructions: row.instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
  };
}

/** 行 → 成员 */
function toMember(row: MemberRow): SquadMember {
  return {
    memberType: row.member_type === "member" ? "member" : "agent",
    memberId: row.member_id,
    role: row.role,
  };
}

/** 行 → 任务 */
function toTask(row: TaskRow): SquadTaskRecord {
  return {
    id: row.id,
    squadId: row.squad_id,
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    isLeader: row.is_leader === 1,
    assigneeId: row.assignee_id,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.agent_task_id === null ? {} : { agentTaskId: row.agent_task_id }),
    title: row.title,
    status: toTaskStatus(row.status),
    attempt: row.attempt,
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  };
}

/** 状态归一（未知值按 failed，避免 UI 显示空白） */
function toTaskStatus(value: string): SquadTaskStatus {
  switch (value) {
    case "pending":
    case "assigned":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "failed";
  }
}

/** 行 → run */
function toRun(row: RunRow): SquadRunRecord {
  return {
    id: row.id,
    squadId: row.squad_id,
    squadTaskId: row.squad_task_id,
    agentId: row.agent_id,
    ...(row.parent_run_id === null ? {} : { parentRunId: row.parent_run_id }),
    status: row.status,
    title: row.title,
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  };
}
