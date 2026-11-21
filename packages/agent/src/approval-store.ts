/**
 * @fengagent/agent — 审批（负责人确认）仓（P2，SQLite）
 *
 * 三张表，语义分开：
 * - `approval_request`：一次「需要批准的操作」= 一行。状态机 `pending → approved | denied |
 *   escalated`（escalated 之后仍可 approved/denied，由人类发起人裁决）。
 * - `approval_grant`：批准后产生的**授权**，`scope` 决定它管多久 ——
 *   `once`（一次性，用掉即失效）/ `session`（绑定一次小队任务，任务结束即失效）/
 *   `permanent`（长期有效，可撤销）。
 * - `approval_audit`：append-only 审计。**每笔请求、裁决、上抛、消费都写一行**
 *   （谁、批的是哪次请求、什么 scope、留了什么话），供 UI 与事后追责。
 *
 * 与 Multica 的差异：Multica 的审批是「任务 invocation 的目标」+ 评论流；本地没有评论流，
 * 所以这里用「队长裁决工具 + 人类 REST 裁决」两条入口，审计表自建（结论见 P2 调研）。
 */

import { Database } from "bun:sqlite";
import { expandTilde } from "@fengagent/shared/utils";

/** 审批状态 */
export type ApprovalStatus = "pending" | "approved" | "denied" | "escalated" | "expired";

/** 授权范围 */
export type ApprovalScope = "once" | "session" | "permanent";

/** 裁决人（队长 / 人类发起人 / 系统） */
export interface ApprovalActor {
  type: "agent" | "member" | "system";
  id: string;
}

/** 审批请求 */
export interface ApprovalRequest {
  id: string;
  squadId?: string;
  squadTaskId?: string;
  /** 发起请求的成员（agent id） */
  agentId: string;
  toolName: string;
  /** 该次工具调用的入参摘要（截断，审计用，不落敏感正文） */
  toolInput: string;
  reason: string;
  status: ApprovalStatus;
  /** 该找谁裁决：leader（队长）| human（人类发起人） */
  targetType: "leader" | "human";
  targetId?: string;
  createdAt: number;
  resolvedAt?: number;
  resolvedByType?: ApprovalActor["type"];
  resolvedById?: string;
  /** 裁决附言 */
  note?: string;
}

/** 授权 */
export interface ApprovalGrant {
  id: string;
  approvalId?: string;
  agentId: string;
  toolName: string;
  scope: ApprovalScope;
  /** session scope 绑定的对象（这里用 squad_task id：一次小队子任务 = 一个执行会话） */
  sessionRef?: string;
  createdAt: number;
  expiresAt?: number;
  grantedByType: ApprovalActor["type"];
  grantedById: string;
  /** once 授权被消费的时间（非空即失效） */
  consumedAt?: number;
}

/** 审计动作 */
export type ApprovalAuditAction = "request" | "approve" | "deny" | "escalate" | "consume" | "expire";

/** 审计行 */
export interface ApprovalAuditEntry {
  id: string;
  approvalId: string;
  action: ApprovalAuditAction;
  actorType: ApprovalActor["type"];
  actorId: string;
  scope?: ApprovalScope;
  note?: string;
  at: number;
}

/** 审批仓错误码（路由层映射 HTTP 状态） */
export class ApprovalStoreError extends Error {
  readonly code: "bad_request" | "not_found" | "conflict";

  constructor(code: "bad_request" | "not_found" | "conflict", message: string) {
    super(message);
    this.name = "ApprovalStoreError";
    this.code = code;
  }
}

/** 建仓选项 */
export interface ApprovalStoreOptions {
  db?: Database;
  now?: () => number;
  idFactory?: () => string;
}

/** 建请求入参 */
export interface CreateApprovalInput {
  squadId?: string;
  squadTaskId?: string;
  agentId: string;
  toolName: string;
  toolInput?: string;
  reason?: string;
  targetType?: "leader" | "human";
  targetId?: string;
}

/** 裁决入参 */
export interface ResolveApprovalInput {
  decision: "approve" | "deny";
  /** 缺省 `once`（最小授权：一次一批） */
  scope?: ApprovalScope;
  actor: ApprovalActor;
  note?: string;
  sessionRef?: string;
}

/** 原始行 */
interface RequestRow {
  id: string;
  squad_id: string | null;
  squad_task_id: string | null;
  agent_id: string;
  tool_name: string;
  tool_input: string;
  reason: string;
  status: string;
  target_type: string;
  target_id: string | null;
  created_at: number;
  resolved_at: number | null;
  resolved_by_type: string | null;
  resolved_by_id: string | null;
  note: string | null;
}

interface GrantRow {
  id: string;
  approval_id: string | null;
  agent_id: string;
  tool_name: string;
  scope: string;
  session_ref: string | null;
  created_at: number;
  expires_at: number | null;
  granted_by_type: string;
  granted_by_id: string;
  consumed_at: number | null;
}

interface AuditRow {
  id: string;
  approval_id: string;
  action: string;
  actor_type: string;
  actor_id: string;
  scope: string | null;
  note: string | null;
  at: number;
}

/** 入参摘要上限（避免把整个文件正文写进审计） */
const MAX_TOOL_INPUT = 400;

/** 审批仓 */
export class ApprovalStore {
  private readonly db: Database;
  private readonly ownsDb: boolean;
  private readonly now: () => number;
  private readonly idFactory: (prefix: string) => string;

  constructor(dbPath: string, options: ApprovalStoreOptions = {}) {
    if (options.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      this.db = new Database(expandTilde(dbPath));
      this.ownsDb = true;
    }
    this.now = options.now ?? Date.now;
    const custom = options.idFactory;
    this.idFactory = custom
      ? (prefix) => `${prefix}_${custom()}`
      : (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_request (
        id TEXT PRIMARY KEY,
        squad_id TEXT,
        squad_task_id TEXT,
        agent_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        target_type TEXT NOT NULL DEFAULT 'leader',
        target_id TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_by_type TEXT,
        resolved_by_id TEXT,
        note TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_approval_request_status ON approval_request(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_approval_request_squad ON approval_request(squad_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS approval_grant (
        id TEXT PRIMARY KEY,
        approval_id TEXT,
        agent_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        scope TEXT NOT NULL,
        session_ref TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        granted_by_type TEXT NOT NULL,
        granted_by_id TEXT NOT NULL,
        consumed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_approval_grant_lookup ON approval_grant(agent_id, tool_name, consumed_at);

      CREATE TABLE IF NOT EXISTS approval_audit (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        scope TEXT,
        note TEXT,
        at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_approval_audit_request ON approval_audit(approval_id, at ASC);
    `);
  }

  /**
   * 建一条待裁决的审批请求，并写 `request` 审计。
   *
   * 同 (agent, tool, squadTask) 已有 `pending` 请求时直接复用 —— 成员重试同一个工具
   * 不应该刷出一串重复请求（队长会被同样的东西吵 N 次）。
   */
  request(input: CreateApprovalInput): ApprovalRequest {
    const agentId = input.agentId?.trim() ?? "";
    const toolName = input.toolName?.trim() ?? "";
    if (agentId === "") throw new ApprovalStoreError("bad_request", "agentId 不能为空");
    if (toolName === "") throw new ApprovalStoreError("bad_request", "toolName 不能为空");
    const existing = this.findPending(agentId, toolName, input.squadTaskId);
    if (existing) return existing;
    const id = this.idFactory("apr");
    const at = this.now();
    this.db
      .query(
        `INSERT INTO approval_request (id, squad_id, squad_task_id, agent_id, tool_name, tool_input, reason, status, target_type, target_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        input.squadId ?? null,
        input.squadTaskId ?? null,
        agentId,
        toolName,
        (input.toolInput ?? "").slice(0, MAX_TOOL_INPUT),
        input.reason ?? "",
        input.targetType ?? "leader",
        input.targetId ?? null,
        at,
      );
    this.audit(id, "request", { type: "agent", id: agentId }, undefined, input.reason);
    return this.get(id)!;
  }

  /** 单条请求 */
  get(id: string): ApprovalRequest | undefined {
    const row = this.db.query("SELECT * FROM approval_request WHERE id = ?").get(id) as RequestRow | null;
    return row ? toRequest(row) : undefined;
  }

  /** 列表（新 → 旧；可过滤） */
  list(
    filter: {
      status?: ApprovalStatus;
      squadId?: string;
      agentId?: string;
      targetType?: "leader" | "human";
    } = {},
  ): ApprovalRequest[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.status !== undefined) {
      where.push("status = ?");
      args.push(filter.status);
    }
    if (filter.squadId !== undefined) {
      where.push("squad_id = ?");
      args.push(filter.squadId);
    }
    if (filter.agentId !== undefined) {
      where.push("agent_id = ?");
      args.push(filter.agentId);
    }
    if (filter.targetType !== undefined) {
      where.push("target_type = ?");
      args.push(filter.targetType);
    }
    const sql =
      "SELECT * FROM approval_request" +
      (where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`) +
      " ORDER BY created_at DESC";
    const rows = this.db.query(sql).all(...args) as RequestRow[];
    return rows.map(toRequest);
  }

  /**
   * 裁决（队长或人类发起人都走这里）。
   *
   * `approve` 会按 `scope` 落一条授权：`once` 一次性、`session` 绑本次小队任务、
   * `permanent` 长期。`deny` 不产出授权。
   */
  resolve(id: string, input: ResolveApprovalInput): ApprovalRequest {
    const existing = this.get(id);
    if (!existing) throw new ApprovalStoreError("not_found", `审批请求不存在: ${id}`);
    if (existing.status !== "pending" && existing.status !== "escalated") {
      throw new ApprovalStoreError("conflict", `审批请求已终态（${existing.status}），不能重复裁决`);
    }
    const scope = input.scope ?? "once";
    if (scope !== "once" && scope !== "session" && scope !== "permanent") {
      throw new ApprovalStoreError("bad_request", "scope 只能是 once / session / permanent");
    }
    const at = this.now();
    const status: ApprovalStatus = input.decision === "approve" ? "approved" : "denied";
    this.db
      .query(
        `UPDATE approval_request
            SET status = ?, resolved_at = ?, resolved_by_type = ?, resolved_by_id = ?, note = ?
          WHERE id = ?`,
      )
      .run(status, at, input.actor.type, input.actor.id, input.note ?? null, id);
    this.audit(id, input.decision === "approve" ? "approve" : "deny", input.actor, scope, input.note);
    if (status === "approved") {
      this.db
        .query(
          `INSERT INTO approval_grant (id, approval_id, agent_id, tool_name, scope, session_ref, created_at, expires_at, granted_by_type, granted_by_id, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
        )
        .run(
          this.idFactory("gr"),
          id,
          existing.agentId,
          existing.toolName,
          scope,
          scope === "session" ? (input.sessionRef ?? existing.squadTaskId ?? null) : null,
          at,
          input.actor.type,
          input.actor.id,
        );
    }
    return this.get(id)!;
  }

  /** 上抛人类发起人（队长拿不准时调用） */
  escalate(id: string, input: { actor: ApprovalActor; note?: string; humanId?: string }): ApprovalRequest {
    const existing = this.get(id);
    if (!existing) throw new ApprovalStoreError("not_found", `审批请求不存在: ${id}`);
    if (existing.status !== "pending" && existing.status !== "escalated") {
      throw new ApprovalStoreError("conflict", `审批请求已终态（${existing.status}），不能上抛`);
    }
    this.db
      .query("UPDATE approval_request SET status = 'escalated', target_type = 'human', target_id = ? WHERE id = ?")
      .run(input.humanId ?? null, id);
    this.audit(id, "escalate", input.actor, undefined, input.note);
    return this.get(id)!;
  }

  /**
   * 判断某成员能否执行某工具（**命中即放行**，once 授权当场消费）。
   *
   * 优先级：permanent > session（同 sessionRef）> once；过期与已消费的不算。
   */
  allows(agentId: string, toolName: string, options: { sessionRef?: string } = {}): boolean {
    const now = this.now();
    const rows = this.db
      .query(
        `SELECT * FROM approval_grant
          WHERE agent_id = ? AND tool_name = ? AND consumed_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY CASE scope WHEN 'permanent' THEN 0 WHEN 'session' THEN 1 ELSE 2 END, created_at ASC`,
      )
      .all(agentId, toolName, now) as GrantRow[];
    for (const row of rows) {
      const scope = toScope(row.scope);
      if (scope === "session" && (options.sessionRef ?? "") !== (row.session_ref ?? "")) continue;
      if (scope === "once") {
        this.db.query("UPDATE approval_grant SET consumed_at = ? WHERE id = ?").run(now, row.id);
        if (row.approval_id !== null) {
          this.audit(row.approval_id, "consume", { type: "system", id: "permission-gate" }, "once", undefined);
        }
      }
      return true;
    }
    return false;
  }

  /** 撤销某成员某工具的授权（`permanent` 收回）；返回撤销条数 */
  revoke(agentId: string, toolName?: string): number {
    const now = this.now();
    const result =
      toolName === undefined
        ? this.db.query("UPDATE approval_grant SET consumed_at = ? WHERE agent_id = ? AND consumed_at IS NULL").run(now, agentId)
        : this.db
            .query("UPDATE approval_grant SET consumed_at = ? WHERE agent_id = ? AND tool_name = ? AND consumed_at IS NULL")
            .run(now, agentId, toolName);
    return result.changes;
  }

  /** 某请求的审计（按时间升序） */
  auditFor(approvalId: string): ApprovalAuditEntry[] {
    const rows = this.db
      .query("SELECT * FROM approval_audit WHERE approval_id = ? ORDER BY at ASC")
      .all(approvalId) as AuditRow[];
    return rows.map(toAudit);
  }

  /** 全量审计（最近 N 条，UI 审计页用） */
  recentAudit(limit = 100): ApprovalAuditEntry[] {
    const rows = this.db
      .query("SELECT * FROM approval_audit ORDER BY at DESC LIMIT ?")
      .all(limit) as AuditRow[];
    return rows.map(toAudit);
  }

  /** 关库（注入的共享连接不关） */
  close(): void {
    if (this.ownsDb) this.db.close();
  }

  /** 同 (agent, tool, task) 的 pending 请求 */
  private findPending(agentId: string, toolName: string, squadTaskId?: string): ApprovalRequest | undefined {
    const row = this.db
      .query(
        `SELECT * FROM approval_request
          WHERE agent_id = ? AND tool_name = ? AND status = 'pending'
            AND (squad_task_id IS ? OR squad_task_id = ?)
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(agentId, toolName, squadTaskId ?? null, squadTaskId ?? null) as RequestRow | null;
    return row ? toRequest(row) : undefined;
  }

  /** 写一行审计 */
  private audit(
    approvalId: string,
    action: ApprovalAuditAction,
    actor: ApprovalActor,
    scope: ApprovalScope | undefined,
    note: string | undefined,
  ): void {
    this.db
      .query(
        `INSERT INTO approval_audit (id, approval_id, action, actor_type, actor_id, scope, note, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.idFactory("aud"),
        approvalId,
        action,
        actor.type,
        actor.id,
        scope ?? null,
        note ?? null,
        this.now(),
      );
  }
}

function toScope(value: string): ApprovalScope {
  return value === "permanent" || value === "session" ? value : "once";
}

function toRequest(row: RequestRow): ApprovalRequest {
  return {
    id: row.id,
    ...(row.squad_id === null ? {} : { squadId: row.squad_id }),
    ...(row.squad_task_id === null ? {} : { squadTaskId: row.squad_task_id }),
    agentId: row.agent_id,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    reason: row.reason,
    status: toStatus(row.status),
    targetType: row.target_type === "human" ? "human" : "leader",
    ...(row.target_id === null ? {} : { targetId: row.target_id }),
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    ...(row.resolved_by_type === null
      ? {}
      : { resolvedByType: row.resolved_by_type as ApprovalActor["type"] }),
    ...(row.resolved_by_id === null ? {} : { resolvedById: row.resolved_by_id }),
    ...(row.note === null ? {} : { note: row.note }),
  };
}

function toStatus(value: string): ApprovalStatus {
  switch (value) {
    case "approved":
    case "denied":
    case "escalated":
    case "expired":
      return value;
    default:
      return "pending";
  }
}

function toAudit(row: AuditRow): ApprovalAuditEntry {
  return {
    id: row.id,
    approvalId: row.approval_id,
    action: row.action as ApprovalAuditAction,
    actorType: row.actor_type as ApprovalActor["type"],
    actorId: row.actor_id,
    ...(row.scope === null ? {} : { scope: toScope(row.scope) }),
    ...(row.note === null ? {} : { note: row.note }),
    at: row.at,
  };
}
