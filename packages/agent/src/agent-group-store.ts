/**
 * @fengagent/agent — 群聊聚合根（`agent_groups` / `group_messages`）
 *
 * 群是**对话聚合**，任务仓是**生命周期聚合**，两者互引不互塞：
 *
 * - `agent_groups`：群 + 成员（human / runtime / coordinator）+ 收敛参数
 *   （`max_rounds` / `idle_timeout_ms`，G3 编排器用）+ 状态（open → concluded）；
 * - `group_messages`：群聊日志，`seq` 在群内单调递增（SSE 断线重连按 seq 补齐），
 *   `kind` 区分 chat / task_card（G2）/ decision（G3）/ system，
 *   `agent_task_id` 把一条消息挂到某次外派任务的深链上（G2 结果回群）。
 *
 * 为什么单开两张表而不是塞 `task_states`：任务有 7 态状态机与乐观锁，消息是 append-only
 * 时间线 —— 混在一起会让两边都变难（与 RSI 那次「不污染已验收 reducer」同一决策）。
 *
 * 字段口径对齐 KG 冻结的 G1 契约（`web-ui/src/api/types.ts` v1.0）：
 * 群对外只暴露 `open / concluded` 两态，成员对外只暴露 **runtime 名**（人隐含在场），
 * 群描述叫 `description`，消息时间是 `createdAt`。
 *
 * v1（协调者中转）语义：外部 runtime（kimi/dsh/claude）**不直接**往群里发消息，
 * 它们的产出由服务端代写（`from_kind="runtime"` + `agent_task_id`）；群内 fengagent
 * 成员持有全量群工具，因此能直接发言。
 */

import { Database } from "bun:sqlite";
import { expandTilde, generateId } from "@fengagent/shared/utils";

/** 群状态（契约 v1.0：只有 open / concluded） */
export type AgentGroupStatus = "open" | "concluded";

/** 消息种类（G2/G3 用 task_card / decision，G1 主要是 chat / system） */
export type GroupMessageKind = "chat" | "task_card" | "decision" | "system";

/** 群成员（存储侧比契约多保留 kind，对外只暴露 runtime 名） */
export interface GroupMember {
  /** 成员类型：人 / 外部 runtime / 协调者（本仓库的 fengagent） */
  kind: "human" | "runtime" | "coordinator";
  /** 展示名（唯一标识，群内不重复） */
  name: string;
  /** runtime 成员对应的注册表名（`kind="runtime"` 时必填） */
  runtime?: string;
}

/** 消息来源类型 */
export type GroupMessageFromKind = "human" | "runtime" | "coordinator" | "system";

/** 群记录 */
export interface AgentGroupRecord {
  id: string;
  name: string;
  description: string;
  status: AgentGroupStatus;
  members: GroupMember[];
  /** 协调者成员名（v1 = 发起的主会话 agent，通常 `fengagent`） */
  coordinator: string;
  /** 收敛预算：最多几轮（G3；G1 只落字段） */
  maxRounds: number;
  /** 静默超时（毫秒，G3） */
  idleTimeoutMs: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

/** 群消息 */
export interface GroupMessageRecord {
  id: string;
  groupId: string;
  /** 群内单调序号（1 起） */
  seq: number;
  fromKind: GroupMessageFromKind;
  fromName: string;
  content: string;
  kind: GroupMessageKind;
  /** 关联的外派任务（G2 结果回群） */
  agentTaskId?: string;
  createdAt: number;
}

/** 建群入参 */
export interface CreateAgentGroupInput {
  name: string;
  description?: string;
  members?: GroupMember[];
  coordinator?: string;
  maxRounds?: number;
  idleTimeoutMs?: number;
  createdBy?: string;
  at?: number;
}

/** 更新群入参（全部可选） */
export interface UpdateAgentGroupInput {
  name?: string;
  description?: string;
  status?: AgentGroupStatus;
  members?: GroupMember[];
  coordinator?: string;
  maxRounds?: number;
  idleTimeoutMs?: number;
  at?: number;
}

/** 写消息入参 */
export interface AppendGroupMessageInput {
  groupId: string;
  content: string;
  fromKind?: GroupMessageFromKind;
  fromName?: string;
  kind?: GroupMessageKind;
  agentTaskId?: string;
  at?: number;
}

/** 列表过滤 */
export interface ListAgentGroupsFilter {
  status?: AgentGroupStatus | AgentGroupStatus[];
  /** 默认 50，上限 200 */
  limit?: number;
}

/** 消息读取选项 */
export interface ListGroupMessagesOptions {
  /** 只取 seq > after 的消息（SSE 重连补齐） */
  after?: number;
  /** 默认 100，上限 500 */
  limit?: number;
}

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

interface GroupRow {
  id: string;
  name: string;
  description: string;
  status: string;
  members_json: string;
  coordinator: string;
  max_rounds: number;
  idle_timeout_ms: number;
  created_at: number;
  updated_at: number;
  created_by: string;
}

interface MessageRow {
  id: string;
  group_id: string;
  seq: number;
  from_kind: string;
  from_name: string;
  content: string;
  kind: string;
  agent_task_id: string | null;
  created_at: number;
}

function rowToGroup(row: GroupRow): AgentGroupRecord {
  let members: GroupMember[] = [];
  try {
    const parsed = JSON.parse(row.members_json) as GroupMember[];
    if (Array.isArray(parsed)) members = parsed;
  } catch {
    members = [];
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as AgentGroupStatus,
    members,
    coordinator: row.coordinator,
    maxRounds: row.max_rounds,
    idleTimeoutMs: row.idle_timeout_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

function rowToMessage(row: MessageRow): GroupMessageRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    seq: row.seq,
    fromKind: row.from_kind as GroupMessageFromKind,
    fromName: row.from_name,
    content: row.content,
    kind: row.kind as GroupMessageKind,
    ...(row.agent_task_id === null ? {} : { agentTaskId: row.agent_task_id }),
    createdAt: row.created_at,
  };
}

/** 群存储（SQLite；与其它仓共用数据根，表名不重叠） */
export class AgentGroupStore {
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
      CREATE TABLE IF NOT EXISTS agent_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        members_json TEXT NOT NULL DEFAULT '[]',
        coordinator TEXT NOT NULL DEFAULT '',
        max_rounds INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_ROUNDS},
        idle_timeout_ms INTEGER NOT NULL DEFAULT ${DEFAULT_IDLE_TIMEOUT_MS},
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'dashboard'
      );
      CREATE INDEX IF NOT EXISTS idx_agent_groups_status
        ON agent_groups(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS group_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        from_kind TEXT NOT NULL,
        from_name TEXT NOT NULL,
        content TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'chat',
        agent_task_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_group_messages_seq
        ON group_messages(group_id, seq);
      CREATE INDEX IF NOT EXISTS idx_group_messages_task
        ON group_messages(agent_task_id);
    `);
  }

  // ──────────────────────────────────────────────
  // 群
  // ──────────────────────────────────────────────

  /**
   * 建群。
   *
   * @param input - 群名（必填）/ 描述 / 成员 / 协调者 / 预算参数
   * @throws {Error} 群名为空、成员重名
   */
  create(input: CreateAgentGroupInput): AgentGroupRecord {
    const name = input.name.trim();
    if (name === "") throw new Error("群名不能为空");
    const members = normalizeMembers(input.members ?? []);
    const at = input.at ?? this.now();
    const id = generateId();
    this.db
      .query(
        `INSERT INTO agent_groups
         (id, name, description, status, members_json, coordinator, max_rounds, idle_timeout_ms,
          created_at, updated_at, created_by)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        input.description?.trim() ?? "",
        JSON.stringify(members),
        input.coordinator?.trim() ?? "",
        positiveInt(input.maxRounds, DEFAULT_MAX_ROUNDS),
        positiveInt(input.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS),
        at,
        at,
        input.createdBy?.trim() || "dashboard",
      );
    return this.get(id)!;
  }

  /** 取群（不存在返回 null） */
  get(id: string): AgentGroupRecord | null {
    const row = this.db.query("SELECT * FROM agent_groups WHERE id = ?").get(id) as GroupRow | null;
    return row ? rowToGroup(row) : null;
  }

  /** 列表（按最近更新倒序） */
  list(filter: ListAgentGroupsFilter = {}): AgentGroupRecord[] {
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
    const sql =
      `SELECT * FROM agent_groups${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}` +
      " ORDER BY updated_at DESC, id DESC LIMIT ?";
    const rows = this.db.query(sql).all(...params, limit) as GroupRow[];
    return rows.map(rowToGroup);
  }

  /**
   * 更新群（部分字段；`status:"concluded"` 即关群）。
   *
   * @param id - 群 id
   * @param patch - 待更新字段
   * @throws {Error} 群不存在 / 群名为空 / 成员重名
   */
  update(id: string, patch: UpdateAgentGroupInput): AgentGroupRecord {
    const current = this.get(id);
    if (!current) throw new Error(`群不存在: ${id}`);
    const at = patch.at ?? this.now();
    const sets: string[] = ["updated_at = ?"];
    const params: Array<string | number> = [at];

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name === "") throw new Error("群名不能为空");
      sets.push("name = ?");
      params.push(name);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      params.push(patch.description.trim());
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.members !== undefined) {
      sets.push("members_json = ?");
      params.push(JSON.stringify(normalizeMembers(patch.members)));
    }
    if (patch.coordinator !== undefined) {
      sets.push("coordinator = ?");
      params.push(patch.coordinator.trim());
    }
    if (patch.maxRounds !== undefined) {
      sets.push("max_rounds = ?");
      params.push(positiveInt(patch.maxRounds, DEFAULT_MAX_ROUNDS));
    }
    if (patch.idleTimeoutMs !== undefined) {
      sets.push("idle_timeout_ms = ?");
      params.push(positiveInt(patch.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS));
    }
    params.push(id);
    this.db.query(`UPDATE agent_groups SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.get(id)!;
  }

  // ──────────────────────────────────────────────
  // 消息
  // ──────────────────────────────────────────────

  /**
   * 追加一条消息（群内 seq 由存储层分配，单调递增）。
   *
   * @param input - 群 id + 内容 + 来源 + 种类
   * @throws {Error} 群不存在 / 内容为空 / 群已关（concluded）
   */
  appendMessage(input: AppendGroupMessageInput): GroupMessageRecord {
    const group = this.get(input.groupId);
    if (!group) throw new Error(`群不存在: ${input.groupId}`);
    if (group.status === "concluded") throw new Error(`群已关闭，不能继续发言: ${group.id}`);
    const content = input.content.trim();
    if (content === "") throw new Error("消息内容不能为空");

    const at = input.at ?? this.now();
    const max = this.db
      .query("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM group_messages WHERE group_id = ?")
      .get(group.id) as { max_seq: number };
    const seq = max.max_seq + 1;
    const id = generateId();
    const fromKind = input.fromKind ?? "human";
    const kind = input.kind ?? (fromKind === "system" ? "system" : "chat");
    this.db
      .query(
        `INSERT INTO group_messages
         (id, group_id, seq, from_kind, from_name, content, kind, agent_task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        group.id,
        seq,
        fromKind,
        input.fromName ?? "user",
        content,
        kind,
        input.agentTaskId ?? null,
        at,
      );
    // 有新消息 → 群的 updated_at 前移（列表按活跃排序）
    this.db.query("UPDATE agent_groups SET updated_at = ? WHERE id = ?").run(at, group.id);
    return {
      id,
      groupId: group.id,
      seq,
      fromKind,
      fromName: input.fromName ?? "user",
      content,
      kind,
      ...(input.agentTaskId === undefined ? {} : { agentTaskId: input.agentTaskId }),
      createdAt: at,
    };
  }

  /**
   * 读消息（seq 升序；`after` 用于 SSE 重连补齐）。
   *
   * @param groupId - 群 id
   * @param options - after / limit
   */
  messages(groupId: string, options: ListGroupMessagesOptions = {}): GroupMessageRecord[] {
    const after = options.after ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = this.db
      .query(
        `SELECT * FROM group_messages WHERE group_id = ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(groupId, after, limit) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * 最近 N 条消息（详情页首屏：取尾部再按 seq 升序返回）。
   *
   * @param groupId - 群 id
   * @param limit - 取多少条（默认 50，上限 500）
   */
  recentMessages(groupId: string, limit = 50): GroupMessageRecord[] {
    const size = Math.min(Math.max(limit, 1), 500);
    const rows = this.db
      .query(
        `SELECT * FROM group_messages WHERE group_id = ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(groupId, size) as MessageRow[];
    return rows.map(rowToMessage).reverse();
  }

  /** 消息总数 */
  messageCount(groupId: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ?")
      .get(groupId) as { n: number } | null;
    return row?.n ?? 0;
  }

  /** 最后一条消息（列表页摘要用） */
  lastMessage(groupId: string): GroupMessageRecord | null {
    const row = this.db
      .query("SELECT * FROM group_messages WHERE group_id = ? ORDER BY seq DESC LIMIT 1")
      .get(groupId) as MessageRow | null;
    return row ? rowToMessage(row) : null;
  }

  /** 最大 seq（SSE `?after` 默认值） */
  lastSeq(groupId: string): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(seq), 0) AS seq FROM group_messages WHERE group_id = ?")
      .get(groupId) as { seq: number } | null;
    return row?.seq ?? 0;
  }

  /** 关闭自建连接（复用的连接由调用方负责） */
  close(): void {
    if (this.ownsDb) this.db.close();
  }
}

/** 成员规范化 + 校验（名字去重） */
function normalizeMembers(members: readonly GroupMember[]): GroupMember[] {
  const seen = new Set<string>();
  const result: GroupMember[] = [];
  for (const member of members) {
    const name = member.name.trim();
    if (name === "") continue;
    if (seen.has(name)) throw new Error(`成员重名: ${name}`);
    seen.add(name);
    result.push({
      kind: member.kind,
      name,
      ...(member.runtime === undefined || member.runtime === ""
        ? {}
        : { runtime: member.runtime }),
    });
  }
  return result;
}

/** 正整数兜底（非法值回退默认） */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
