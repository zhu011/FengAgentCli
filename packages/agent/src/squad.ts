/**
 * @fengagent/agent — SquadCoordinator（小队协调器）
 *
 * 管理多 Agent 小队的任务分配、失败追踪和自动转派。
 *
 * 核心机制：
 * 1. 任务提交后按优先级分配给空闲成员
 * 2. 成员每次失败累加 failureCount
 * 3. 当 failureCount >= maxFailuresBeforeReassign 时，成员进入冷却（cooldown），
 *    其当前任务自动转派给其他空闲成员
 * 4. 任务转派次数超过 maxReassignments 时标记为永久失败
 * 5. 冷却期结束后成员自动恢复为空闲状态（failureCount 重置）
 *
 * 参考 PRD F-14（多 Agent）和 ARCHITECTURE 第 3.4 节。
 */

import type {
  SquadMember,
  SquadTask,
  SquadConfig,
  SquadEvent,
  SquadTaskPriority,
  SquadStatus,
} from "@fengagent/core/squad";
import {
  DEFAULT_SQUAD_CONFIG,
  PRIORITY_WEIGHT,
  createSquadMember,
  createSquadTask,
} from "@fengagent/core/squad";
import { getEnvNumber } from "@fengagent/shared/utils";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

/** 失败报告后的转派结果 */
export interface ReassignmentResult {
  /** 转派动作类型 */
  action:
    | "retried" // 同一成员重试
    | "reassigned" // 转派到其他成员
    | "cooldown_reassign" // 因冷却触发的转派
    | "permanently_failed" // 永久失败
    | "queued"; // 无空闲成员，任务排队等待
  /** 任务 ID */
  taskId: string;
  /** 新分配的成员 ID（如有） */
  newAssigneeId?: string;
  /** 原因说明 */
  reason: string;
}

/** SquadCoordinator 构造选项 */
export interface SquadCoordinatorOptions {
  /** 配置覆盖 */
  config?: Partial<SquadConfig>;
  /** 事件回调（每个事件触发时调用） */
  onEvent?: (event: SquadEvent) => void;
}

// ──────────────────────────────────────────────
// SquadCoordinator
// ──────────────────────────────────────────────

export class SquadCoordinator {
  private readonly members = new Map<string, SquadMember>();
  private readonly tasks = new Map<string, SquadTask>();
  private readonly config: SquadConfig;
  private readonly onEvent?: (event: SquadEvent) => void;
  private readonly eventLog: SquadEvent[] = [];

  constructor(options?: SquadCoordinatorOptions) {
    // 合并默认配置 + 传入覆盖
    this.config = {
      ...DEFAULT_SQUAD_CONFIG,
      ...options?.config,
    };
    this.onEvent = options?.onEvent;

    // 环境变量覆盖（遵循 FENG_* 命名约定）
    this.config.maxFailuresBeforeReassign = getEnvNumber(
      "FENG_SQUAD_MAX_FAILURES",
      this.config.maxFailuresBeforeReassign,
    );
    this.config.maxReassignments = getEnvNumber(
      "FENG_SQUAD_MAX_REASSIGNMENTS",
      this.config.maxReassignments,
    );
    this.config.cooldownMs = getEnvNumber(
      "FENG_SQUAD_COOLDOWN_MS",
      this.config.cooldownMs,
    );
  }

  // ── 内部辅助 ──────────────────────────────

  private emit(event: SquadEvent): void {
    this.eventLog.push(event);
    this.onEvent?.(event);
  }

  /** 将任务分配给指定成员（内部，不做状态检查） */
  private assignToMember(task: SquadTask, member: SquadMember): void {
    task.assigneeId = member.id;
    task.status = "assigned";
    task.attempts++;
    member.status = "busy";
    member.currentTaskId = task.id;
    this.emit({ type: "task-assigned", taskId: task.id, memberId: member.id });
  }

  /**
   * 尝试将任务转派给另一个空闲成员（排除指定成员）。
   * 检查 maxReassignments 限制。
   */
  private tryReassignToAnother(
    task: SquadTask,
    excludeMemberId: string,
    reason: string,
  ): ReassignmentResult {
    // 检查转派次数上限
    if (task.reassignmentCount >= this.config.maxReassignments) {
      task.status = "failed";
      task.assigneeId = null;
      this.emit({
        type: "task-permanently-failed",
        taskId: task.id,
        reason: `转派次数超限（${this.config.maxReassignments} 次）`,
      });
      return {
        action: "permanently_failed",
        taskId: task.id,
        reason: `任务永久失败：转派次数超限（${this.config.maxReassignments} 次）`,
      };
    }

    // 查找其他空闲成员
    const idleOthers = this.getIdleMembers().filter(
      (m) => m.id !== excludeMemberId,
    );

    if (idleOthers.length === 0) {
      // 无空闲成员，任务排队等待
      task.status = "pending";
      task.assigneeId = null;
      return {
        action: "queued",
        taskId: task.id,
        reason: "无空闲成员可转派，任务排队等待",
      };
    }

    const newMember = idleOthers[0]!;
    task.reassignmentCount++;
    this.assignToMember(task, newMember);
    this.emit({
      type: "task-reassigned",
      taskId: task.id,
      fromMemberId: excludeMemberId,
      toMemberId: newMember.id,
      reason,
    });
    return {
      action: "cooldown_reassign",
      taskId: task.id,
      newAssigneeId: newMember.id,
      reason,
    };
  }

  // ── 成员管理 ──────────────────────────────

  /** 注册新成员 */
  registerMember(id: string, name?: string): SquadMember {
    if (this.members.has(id)) {
      throw new Error(`成员 "${id}" 已注册`);
    }
    const member = createSquadMember(id, name);
    this.members.set(id, member);
    return member;
  }

  /** 注销成员（如有正在执行的任务则自动转派） */
  unregisterMember(id: string): void {
    const member = this.members.get(id);
    if (!member) return;

    if (member.currentTaskId) {
      this.reassignTask(
        member.currentTaskId,
        `成员 "${id}" 已注销`,
      );
    }
    this.members.delete(id);
  }

  /** 获取成员 */
  getMember(id: string): SquadMember | undefined {
    return this.members.get(id);
  }

  /** 获取所有成员 */
  getMembers(): SquadMember[] {
    return [...this.members.values()];
  }

  /** 获取空闲成员列表 */
  getIdleMembers(): SquadMember[] {
    return this.getMembers().filter((m) => m.status === "idle");
  }

  // ── 任务管理 ──────────────────────────────

  /** 提交新任务 */
  submitTask(
    description: string,
    options?: {
      prompt?: string;
      priority?: SquadTaskPriority;
      maxAttempts?: number;
    },
  ): SquadTask {
    const task = createSquadTask(description, options);
    this.tasks.set(task.id, task);
    this.emit({
      type: "task-submitted",
      taskId: task.id,
      description: task.description,
    });
    return task;
  }

  /** 获取任务 */
  getTask(id: string): SquadTask | undefined {
    return this.tasks.get(id);
  }

  /** 获取所有任务 */
  getTasks(): SquadTask[] {
    return [...this.tasks.values()];
  }

  /** 获取待分配任务（按优先级降序、创建时间升序） */
  getPendingTasks(): SquadTask[] {
    return this.getTasks()
      .filter((t) => t.status === "pending" || t.status === "reassigned")
      .sort(
        (a, b) =>
          PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority] ||
          a.createdAt - b.createdAt,
      );
  }

  // ── 任务分配 ──────────────────────────────

  /**
   * 分配下一个待处理任务给空闲成员。
   * @returns 被分配的任务，无则返回 null
   */
  assignNext(): SquadTask | null {
    const pending = this.getPendingTasks();
    if (pending.length === 0) return null;

    const idle = this.getIdleMembers();
    if (idle.length === 0) return null;

    const task = pending[0]!;
    const member = idle[0]!;
    this.assignToMember(task, member);
    return task;
  }

  /**
   * 分配指定任务给指定成员（或自动选择空闲成员）。
   * @returns 是否成功分配
   */
  assignTask(taskId: string, memberId?: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status !== "pending" && task.status !== "reassigned") {
      return false;
    }

    let member: SquadMember | undefined;
    if (memberId) {
      member = this.members.get(memberId);
      if (!member || member.status !== "idle") return false;
    } else {
      const idle = this.getIdleMembers();
      if (idle.length === 0) return false;
      member = idle[0]!;
    }

    this.assignToMember(task, member);
    return true;
  }

  // ── 结果报告 ──────────────────────────────

  /** 报告任务成功 */
  reportSuccess(taskId: string, result?: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "assigned") return;

    const memberId = task.assigneeId!;
    const member = this.members.get(memberId);

    // 释放成员
    if (member) {
      member.status = "idle";
      member.currentTaskId = null;
      member.successCount++;
    }

    // 更新任务状态
    task.status = "completed";
    task.history.push({
      attempt: task.attempts,
      memberId,
      result: "success",
      timestamp: Date.now(),
    });

    this.emit({
      type: "task-succeeded",
      taskId: task.id,
      memberId,
      result,
    });
  }

  /**
   * 报告任务失败，触发重试或转派逻辑。
   *
   * 决策流程：
   * 1. 记录失败，释放成员，累加 failureCount
   * 2. 若 failureCount >= maxFailuresBeforeReassign → 成员冷却，任务转派
   * 3. 若 attempts >= maxAttempts → 任务转派到其他成员
   * 4. 否则 → 尝试转派到其他空闲成员（优先换人），无则同成员重试
   */
  reportFailure(taskId: string, error: string): ReassignmentResult {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "assigned") {
      return {
        action: "queued",
        taskId,
        reason: "任务不存在或不在已分配状态",
      };
    }

    const memberId = task.assigneeId!;
    const member = this.members.get(memberId);

    // 记录失败历史
    task.history.push({
      attempt: task.attempts,
      memberId,
      result: "failure",
      error,
      timestamp: Date.now(),
    });

    // 释放成员并累加失败计数
    if (member) {
      member.currentTaskId = null;
      member.failureCount++;
      member.lastError = error;
    }

    this.emit({
      type: "task-failed",
      taskId: task.id,
      memberId,
      error,
      attempt: task.attempts,
    });

    // ── 情况 1：成员失败次数达到阈值 → 冷却 + 转派 ──
    if (member && member.failureCount >= this.config.maxFailuresBeforeReassign) {
      member.status = "cooldown";
      member.cooldownUntil = Date.now() + this.config.cooldownMs;
      this.emit({
        type: "member-cooldown",
        memberId: member.id,
        failureCount: member.failureCount,
        cooldownUntil: member.cooldownUntil,
      });

      return this.tryReassignToAnother(
        task,
        memberId,
        `成员 "${memberId}" 失败 ${member.failureCount} 次后进入冷却`,
      );
    }

    // ── 情况 2：任务尝试次数耗尽 → 转派到其他成员 ──
    if (task.attempts >= task.maxAttempts) {
      // 先把成员设回空闲（它还没到冷却阈值）
      if (member) {
        member.status = "idle";
      }
      return this.tryReassignToAnother(
        task,
        memberId,
        `任务在成员 "${memberId}" 上已尝试 ${task.attempts} 次未成功`,
      );
    }

    // ── 情况 3：普通重试 ──
    // 优先转派到其他空闲成员（换人重试）
    const idleOthers = this.getIdleMembers().filter(
      (m) => m.id !== memberId,
    );

    if (idleOthers.length > 0) {
      // 检查转派次数
      if (task.reassignmentCount < this.config.maxReassignments) {
        // 把原成员设回空闲
        if (member) {
          member.status = "idle";
        }
        const newMember = idleOthers[0]!;
        task.reassignmentCount++;
        this.assignToMember(task, newMember);
        this.emit({
          type: "task-reassigned",
          taskId: task.id,
          fromMemberId: memberId,
          toMemberId: newMember.id,
          reason: `失败后转派重试（第 ${task.attempts} 次尝试）`,
        });
        return {
          action: "reassigned",
          taskId: task.id,
          newAssigneeId: newMember.id,
          reason: `转派到 "${newMember.id}" 重试`,
        };
      }
    }

    // 回退：同一成员重试
    if (member) {
      member.status = "idle";
      this.assignToMember(task, member);
      return {
        action: "retried",
        taskId: task.id,
        newAssigneeId: member.id,
        reason: "无其他空闲成员，同一成员重试",
      };
    }

    // 无成员可用，排队等待
    task.status = "pending";
    task.assigneeId = null;
    return {
      action: "queued",
      taskId: task.id,
      reason: "无空闲成员，任务排队等待",
    };
  }

  /**
   * 手动转派任务（不记录失败）。
   * 用于成员注销、手动调度等场景。
   */
  reassignTask(taskId: string, reason: string): ReassignmentResult {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { action: "queued", taskId, reason: "任务不存在" };
    }

    const fromMemberId = task.assigneeId ?? "unknown";

    // 释放当前成员
    if (task.assigneeId) {
      const member = this.members.get(task.assigneeId);
      if (member) {
        member.currentTaskId = null;
        member.status = "idle";
      }
    }

    return this.tryReassignToAnother(task, fromMemberId, reason);
  }

  // ── 冷却管理 ──────────────────────────────

  /**
   * 时钟推进：检查冷却成员是否到期，到期则恢复。
   * 同时尝试分配排队中的任务。
   * @returns 本次 tick 产生的事件列表
   */
  tick(): SquadEvent[] {
    const emitted: SquadEvent[] = [];
    const now = Date.now();

    for (const member of this.members.values()) {
      if (
        member.status === "cooldown" &&
        member.cooldownUntil !== null &&
        now >= member.cooldownUntil
      ) {
        member.status = "idle";
        member.cooldownUntil = null;
        member.failureCount = 0; // 冷却结束后重置失败计数
        const event: SquadEvent = {
          type: "member-reactivated",
          memberId: member.id,
        };
        this.emit(event);
        emitted.push(event);
      }
    }

    // 尝试分配排队任务
    this.assignNext();

    return emitted;
  }

  /** 手动恢复成员（从冷却或禁用状态） */
  reactivateMember(memberId: string): void {
    const member = this.members.get(memberId);
    if (!member) return;
    member.status = "idle";
    member.cooldownUntil = null;
    member.failureCount = 0;
    this.emit({ type: "member-reactivated", memberId: member.id });
  }

  /** 禁用成员（其当前任务自动转派） */
  disableMember(memberId: string, reason?: string): void {
    const member = this.members.get(memberId);
    if (!member) return;

    if (member.currentTaskId) {
      this.reassignTask(
        member.currentTaskId,
        `成员 "${memberId}" 被禁用：${reason ?? "未知原因"}`,
      );
    }

    member.status = "disabled";
    member.currentTaskId = null;
    member.cooldownUntil = null;
    this.emit({
      type: "member-disabled",
      memberId: member.id,
      reason: reason ?? "手动禁用",
    });
  }

  // ── 状态查询 ──────────────────────────────

  /** 获取小队状态概览 */
  getStatus(): SquadStatus {
    const members = this.getMembers();
    const tasks = this.getTasks();
    return {
      totalMembers: members.length,
      idleMembers: members.filter((m) => m.status === "idle").length,
      busyMembers: members.filter((m) => m.status === "busy").length,
      cooldownMembers: members.filter((m) => m.status === "cooldown").length,
      disabledMembers: members.filter((m) => m.status === "disabled").length,
      totalTasks: tasks.length,
      pendingTasks: this.getPendingTasks().length,
      completedTasks: tasks.filter((t) => t.status === "completed").length,
      failedTasks: tasks.filter((t) => t.status === "failed").length,
    };
  }

  /** 获取事件日志 */
  getEvents(): SquadEvent[] {
    return [...this.eventLog];
  }

  /** 清空事件日志 */
  clearEvents(): void {
    this.eventLog.length = 0;
  }
}
