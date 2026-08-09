/**
 * @fengagent/core — Squad（小队）类型定义
 *
 * 多 Agent 协作的小队成员、任务、配置和事件类型。
 * 参考 PRD F-14（多 Agent）和 ARCHITECTURE 第 3.4 节。
 *
 * 失败转派机制：当某个成员累计失败次数达到阈值后进入冷却，
 * 其任务自动转派给其他空闲成员。
 */

import {
  SQUAD_COOLDOWN_MS,
  SQUAD_MAX_FAILURES,
  SQUAD_MAX_REASSIGNMENTS,
} from "@fengagent/shared";

/** 小队成员状态 */
export type SquadMemberStatus = "idle" | "busy" | "cooldown" | "disabled";

/** 小队任务状态 */
export type SquadTaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "reassigned";

/** 任务优先级（数字越大优先级越高） */
export type SquadTaskPriority = "low" | "normal" | "high" | "urgent";

/** 小队成员 */
export interface SquadMember {
  /** 成员唯一标识 */
  id: string;
  /** 成员名称（展示用） */
  name: string;
  /** 当前状态 */
  status: SquadMemberStatus;
  /** 累计失败次数（成功后不重置，冷却后重置） */
  failureCount: number;
  /** 累计成功次数 */
  successCount: number;
  /** 当前分配的任务 ID（无则为 null） */
  currentTaskId: string | null;
  /** 最后一次错误信息 */
  lastError: string | null;
  /** 冷却结束时间戳（ms），cooldown 状态时有效 */
  cooldownUntil: number | null;
}

/** 小队任务 */
export interface SquadTask {
  /** 任务唯一标识 */
  id: string;
  /** 任务描述 */
  description: string;
  /** 任务提示词（传给子 Agent） */
  prompt: string;
  /** 当前分配的成员 ID（无则为 null） */
  assigneeId: string | null;
  /** 任务状态 */
  status: SquadTaskStatus;
  /** 优先级 */
  priority: SquadTaskPriority;
  /** 已尝试次数（跨所有成员） */
  attempts: number;
  /** 最大尝试次数 */
  maxAttempts: number;
  /** 已转派次数（移动到不同成员的次数） */
  reassignmentCount: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 任务历史记录（每次尝试） */
  history: SquadTaskAttempt[];
}

/** 任务尝试记录 */
export interface SquadTaskAttempt {
  /** 尝试序号 */
  attempt: number;
  /** 执行成员 ID */
  memberId: string;
  /** 结果 */
  result: "success" | "failure";
  /** 错误信息（失败时） */
  error?: string;
  /** 时间戳 */
  timestamp: number;
}

/** 小队配置 */
export interface SquadConfig {
  /** 成员连续失败多少次后进入冷却并触发转派 */
  maxFailuresBeforeReassign: number;
  /** 单个任务最大转派次数（超过则永久失败） */
  maxReassignments: number;
  /** 冷却时长（毫秒） */
  cooldownMs: number;
}

/** 默认小队配置（可被环境变量覆盖） */
export const DEFAULT_SQUAD_CONFIG: SquadConfig = {
  maxFailuresBeforeReassign: SQUAD_MAX_FAILURES,
  maxReassignments: SQUAD_MAX_REASSIGNMENTS,
  cooldownMs: SQUAD_COOLDOWN_MS,
};

/** 优先级排序权重 */
export const PRIORITY_WEIGHT: Record<SquadTaskPriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/** 小队事件联合类型 */
export type SquadEvent =
  | { type: "task-submitted"; taskId: string; description: string }
  | { type: "task-assigned"; taskId: string; memberId: string }
  | { type: "task-succeeded"; taskId: string; memberId: string; result?: string }
  | {
      type: "task-failed";
      taskId: string;
      memberId: string;
      error: string;
      attempt: number;
    }
  | {
      type: "task-reassigned";
      taskId: string;
      fromMemberId: string;
      toMemberId: string;
      reason: string;
    }
  | { type: "task-permanently-failed"; taskId: string; reason: string }
  | {
      type: "member-cooldown";
      memberId: string;
      failureCount: number;
      cooldownUntil: number;
    }
  | { type: "member-reactivated"; memberId: string }
  | { type: "member-disabled"; memberId: string; reason: string };

/** 小队状态概览 */
export interface SquadStatus {
  totalMembers: number;
  idleMembers: number;
  busyMembers: number;
  cooldownMembers: number;
  disabledMembers: number;
  totalTasks: number;
  pendingTasks: number;
  completedTasks: number;
  failedTasks: number;
}

/** 创建小队成员的工厂 */
export function createSquadMember(id: string, name?: string): SquadMember {
  return {
    id,
    name: name ?? id,
    status: "idle",
    failureCount: 0,
    successCount: 0,
    currentTaskId: null,
    lastError: null,
    cooldownUntil: null,
  };
}

/** 创建小队任务的工厂 */
export function createSquadTask(
  description: string,
  options?: {
    prompt?: string;
    priority?: SquadTaskPriority;
    maxAttempts?: number;
  },
): SquadTask {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    description,
    prompt: options?.prompt ?? description,
    assigneeId: null,
    status: "pending",
    priority: options?.priority ?? "normal",
    attempts: 0,
    maxAttempts: options?.maxAttempts ?? 3,
    reassignmentCount: 0,
    createdAt: now,
    history: [],
  };
}
