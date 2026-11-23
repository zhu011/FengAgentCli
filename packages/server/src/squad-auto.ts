/**
 * @fengagent/server — auto 模式接线层（P2 第二阶段）
 *
 * `packages/agent/src/squad.ts` 里的 `SquadCoordinator` 是一套**纯内存**算法：
 * 按优先级取待分配任务、按失败次数冷却成员、冷却到期恢复、转派次数超限判永久失败。
 * 本文件把它接到真实世界：
 *
 * ```
 *   SquadCoordinator（优先级/冷却/转派）
 *        │  ▲
 *        │  └── 终态回报（成功 → 释放；失败 → 冷却/换人/排队）
 *        ▼
 *   SquadStore（squad_task / squad_run / squad_member_state）── 重启后重建协调器
 *        │
 *        └──▶ AgentTaskService（真派发，非阻塞；终态回调上面那条箭头）
 * ```
 *
 * 三条约定：
 *
 * 1. **队长缺席也能跑**：auto 模式不建 leader 任务、不要求队长在场；成员候选里
 *    队长排在最后（先把活分给队员，队长只在无人可用时兜底）。
 * 2. **持久化不是缓存**：任务的优先级/转派次数/正文、成员失败次数/冷却截止时间
 *    都落盘（`squad_member_state` 新表 + `squad_task` 新列），重启后按盘重建，
 *    排队中的任务不会因为进程重启而丢。
 * 3. **状态两层不混用**：协调器的 `assigned` 对应小队任务的 `running`；
 *    `pending` 是「排队等空闲成员」；`waiting_approval` 是等裁决的非终态，
 *    裁决后回到 `running` 续跑（见 `SquadService`）。
 */

import {
  SquadCoordinator,
  isTerminalTaskStatus as isTerminalAgentTaskStatus,
  type SquadMemberRuntimeStatus,
  type SquadMode,
  type SquadStore,
  type SquadTaskStatus,
} from "@fengagent/agent";
import type {
  SquadEvent,
  SquadTask as CoordinatorTask,
  SquadTaskPriority,
} from "@fengagent/core/squad";
import { createLogger } from "@fengagent/shared";
import type { AgentTaskDto, AgentTaskService } from "./agent-task-service.ts";

const log = createLogger("squad-auto");

/** auto 模式派单结果（runId/agentTaskId 在「排队中」时为空串） */
export interface SquadAutoDispatchResult {
  taskId: string;
  runId: string;
  agentTaskId: string;
  assigneeId: string | null;
  status: SquadTaskStatus;
  mode: "auto";
}

/** 成员运行态 DTO（前端「成员」区直接渲染） */
export interface SquadAutoMemberDto {
  memberId: string;
  status: SquadMemberRuntimeStatus;
  failureCount: number;
  successCount: number;
  currentTaskId: string | null;
  /** ISO；非冷却态为 null */
  cooldownUntil: string | null;
  lastError: string | null;
}

/** 协调器状态 DTO（GET /api/squads/:id/coordinator） */
export interface SquadAutoStatusDto {
  squadId: string;
  mode: SquadMode;
  members: SquadAutoMemberDto[];
  tasks: {
    total: number;
    pending: number;
    assigned: number;
    running: number;
    waitingApproval: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  /** 最近一个冷却到期时间（ISO；没有冷却成员为 null） */
  nextCooldownAt: string | null;
  /** 协调器事件流（最近 50 条，按发生顺序） */
  events: SquadEvent[];
}

/** 接线层选项 */
export interface SquadAutoCoordinatorOptions {
  store: SquadStore;
  tasks: AgentTaskService;
  /** 成员 prompt 装配（instructions + 技能）；由装配方注入 */
  composeMemberPrompt: (agentId: string, content: string) => string;
  /** 等成员终态的上限（只是后台观察，不影响派单返回） */
  waitTimeoutMs?: number;
  now?: () => number;
}

/** 小队任务是否终态 */
export function isTerminalSquadTaskStatus(status: SquadTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** auto 模式接线层（每个 SquadService 一个实例） */
export class SquadAutoCoordinator {
  private readonly store: SquadStore;
  private readonly tasks: AgentTaskService;
  private readonly composeMemberPrompt: (agentId: string, content: string) => string;
  private readonly waitTimeoutMs: number;
  private readonly now: () => number;
  /** squadId → 协调器（进程内；按盘重建） */
  private readonly coordinators = new Map<string, SquadCoordinator>();
  /** squadTaskId → 正文（换人重派要按原文，不能靠截断的标题猜） */
  private readonly contents = new Map<string, string>();

  constructor(options: SquadAutoCoordinatorOptions) {
    this.store = options.store;
    this.tasks = options.tasks;
    this.composeMemberPrompt = options.composeMemberPrompt;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30 * 60_000;
    this.now = options.now ?? Date.now;
  }

  // ──────────────────────────────────────────────
  // 派单
  // ──────────────────────────────────────────────

  /**
   * 派一次 auto 任务：建任务行 → 协调器按优先级/空闲状态分配 → 真派发。
   *
   * 没有空闲成员时任务停在 `pending`（排队），返回空 runId/agentTaskId；
   * 成员终态或冷却到期（{@link tick}）时自动补派。
   */
  async dispatch(
    squadId: string,
    input: { content: string; priority?: SquadTaskPriority },
  ): Promise<SquadAutoDispatchResult> {
    const squad = this.store.getSquad(squadId);
    if (!squad) throw new Error(`小队不存在: ${squadId}`);
    const content = input.content.trim();
    const record = this.store.createTask({
      squadId,
      isLeader: false,
      assigneeId: "",
      title: titleOf(content),
      content,
      status: "pending",
      ...(input.priority === undefined ? {} : { priority: input.priority }),
    });
    this.contents.set(record.id, content);
    const coordinator = this.coordinatorFor(squadId);
    coordinator.submitTask(content, {
      id: record.id,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
    });
    const launched = await this.drain(squadId);
    const mine = launched.find((item) => item.taskId === record.id);
    if (mine) return mine;
    // 全员忙/冷却：排队等 tick 或成员释放
    return {
      taskId: record.id,
      runId: "",
      agentTaskId: "",
      assigneeId: null,
      status: "pending",
      mode: "auto",
    };
  }

  /**
   * 推进一格时钟：冷却到期成员恢复、失败计数清零，然后把排队任务补派出去。
   *
   * 没有定时器也能用：前端/运维调 `POST /coordinator/tick`，或每次成员终态后自动 drain。
   */
  async tick(
    squadId: string,
  ): Promise<{ reactivated: string[]; launched: SquadAutoDispatchResult[] }> {
    const coordinator = this.coordinatorFor(squadId);
    const events = coordinator.tickCooldowns();
    this.persistMembers(squadId);
    const launched = await this.drain(squadId);
    const reactivated = events
      .filter((event): event is Extract<SquadEvent, { type: "member-reactivated" }> =>
        event.type === "member-reactivated",
      )
      .map((event) => event.memberId);
    return { reactivated, launched };
  }

  /**
   * 重启对账：把「库里非终态、执行侧已终态」的任务结算掉，仍在跑的重挂观察。
   *
   * @returns 被结算的小队任务 id
   */
  async reconcile(squadId: string): Promise<string[]> {
    this.coordinatorFor(squadId);
    const settled: string[] = [];
    for (const task of this.store.listTasks(squadId)) {
      if (task.isLeader) continue;
      if (task.status === "waiting_approval" || isTerminalSquadTaskStatus(task.status)) continue;
      if (task.agentTaskId === undefined || task.runId === undefined) continue;
      const agentTask = this.tasks.getTask(task.agentTaskId);
      if (!agentTask) continue;
      if (isTerminalAgentTaskStatus(agentTask.status)) {
        await this.applyTerminal(squadId, task.id, agentTask, task.runId);
        settled.push(task.id);
      } else {
        this.track(squadId, task.id, task.agentTaskId, task.runId);
      }
    }
    await this.drain(squadId);
    return settled;
  }

  /** 协调器状态（成员运行态 + 任务计数 + 事件流） */
  status(squadId: string): SquadAutoStatusDto {
    const squad = this.store.getSquad(squadId);
    if (!squad) throw new Error(`小队不存在: ${squadId}`);
    const coordinator = this.coordinatorFor(squadId);
    const tasks = this.store.listTasks(squadId).filter((task) => !task.isLeader);
    const cooldowns = coordinator
      .getMembers()
      .map((member) => member.cooldownUntil)
      .filter((value): value is number => typeof value === "number");
    return {
      squadId,
      mode: squad.mode,
      members: coordinator.getMembers().map((member) => ({
        memberId: member.id,
        status: member.status,
        failureCount: member.failureCount,
        successCount: member.successCount,
        currentTaskId: member.currentTaskId,
        cooldownUntil:
          member.cooldownUntil === null ? null : new Date(member.cooldownUntil).toISOString(),
        lastError: member.lastError,
      })),
      tasks: {
        total: tasks.length,
        pending: tasks.filter((task) => task.status === "pending").length,
        assigned: tasks.filter((task) => task.status === "assigned").length,
        running: tasks.filter((task) => task.status === "running").length,
        waitingApproval: tasks.filter((task) => task.status === "waiting_approval").length,
        completed: tasks.filter((task) => task.status === "completed").length,
        failed: tasks.filter((task) => task.status === "failed").length,
        cancelled: tasks.filter((task) => task.status === "cancelled").length,
      },
      nextCooldownAt:
        cooldowns.length === 0 ? null : new Date(Math.min(...cooldowns)).toISOString(),
      events: coordinator.getEvents().slice(-50),
    };
  }

  // ──────────────────────────────────────────────
  // 内部：协调器重建
  // ──────────────────────────────────────────────

  /**
   * 取（或按盘重建）某小队的协调器。
   *
   * 重建顺序有意义：**先注册非队长成员、队长最后** —— 协调器「取第一个空闲成员」，
   * 这个顺序就是 auto 模式的兜底优先级（队长只在无人可用时接活）。
   */
  private coordinatorFor(squadId: string): SquadCoordinator {
    const existing = this.coordinators.get(squadId);
    if (existing) return existing;
    const squad = this.store.getSquad(squadId);
    if (!squad) throw new Error(`小队不存在: ${squadId}`);

    const coordinator = new SquadCoordinator();
    const agents = squad.members.filter((member) => member.memberType === "agent");
    const ordered = [
      ...agents.filter((member) => member.memberId !== squad.leaderId),
      ...agents.filter((member) => member.memberId === squad.leaderId),
    ];
    for (const member of ordered) coordinator.registerMember(member.memberId);

    // 成员运行态（失败次数/冷却）优先用盘上的，没有记录的就是 idle
    for (const state of this.store.listMemberStates(squadId)) {
      coordinator.restoreMember(state.memberId, {
        status: state.status,
        failureCount: state.failureCount,
        successCount: state.successCount,
        currentTaskId: state.currentTaskId ?? null,
        cooldownUntil: state.cooldownUntil ?? null,
        lastError: state.lastError ?? null,
      });
    }

    // 任务：终态与等待裁决的不归协调器管（后者由审批流程负责续跑）
    for (const task of this.store.listTasks(squadId)) {
      if (task.isLeader) continue;
      if (task.status === "waiting_approval" || isTerminalSquadTaskStatus(task.status)) continue;
      const content = task.content ?? task.title;
      this.contents.set(task.id, content);
      coordinator.restoreTask({
        id: task.id,
        description: task.title,
        prompt: content,
        // 有 run 才算「真的派出去过」；否则退回排队，避免重启后永远卡在 assigned
        assigneeId: task.runId === undefined ? null : task.assigneeId || null,
        status: task.runId === undefined ? "pending" : "assigned",
        priority: task.priority,
        attempts: task.attempt,
        maxAttempts: 3,
        reassignmentCount: task.reassignmentCount,
        createdAt: task.createdAt,
        history: [],
      });
    }

    this.coordinators.set(squadId, coordinator);
    return coordinator;
  }

  /** 把协调器的成员运行态刷回盘（一次状态变化一次 upsert，量级很小） */
  private persistMembers(squadId: string): void {
    const coordinator = this.coordinators.get(squadId);
    if (!coordinator) return;
    for (const member of coordinator.getMembers()) {
      this.store.upsertMemberState(squadId, {
        memberId: member.id,
        status: member.status,
        failureCount: member.failureCount,
        successCount: member.successCount,
        currentTaskId: member.currentTaskId,
        cooldownUntil: member.cooldownUntil,
        lastError: member.lastError,
      });
    }
  }

  // ──────────────────────────────────────────────
  // 内部：派发与终态
  // ──────────────────────────────────────────────

  /** 反复把「待分配」任务派出去（协调器每次只分配一个，这里抽干队列） */
  private async drain(squadId: string): Promise<SquadAutoDispatchResult[]> {
    const coordinator = this.coordinators.get(squadId);
    if (!coordinator) return [];
    const launched: SquadAutoDispatchResult[] = [];
    for (let guard = 0; guard < 100; guard++) {
      const task = coordinator.assignNext();
      if (!task?.assigneeId) break;
      const content =
        this.contents.get(task.id) ?? this.store.getTask(task.id)?.content ?? task.prompt;
      launched.push(await this.launch(squadId, task, task.assigneeId, content));
    }
    return launched;
  }

  /** 建 run + 真派发 + 挂终态观察（不 await 成员跑完） */
  private async launch(
    squadId: string,
    task: CoordinatorTask,
    memberId: string,
    content: string,
    parentRunId?: string,
  ): Promise<SquadAutoDispatchResult> {
    const storeTask = this.store.getTask(task.id);
    const run = this.store.createRun({
      squadId,
      squadTaskId: task.id,
      agentId: memberId,
      title: storeTask?.title ?? titleOf(content),
      ...(parentRunId === undefined ? {} : { parentRunId }),
    });
    this.store.updateTask(task.id, {
      status: "running",
      assigneeId: memberId,
      runId: run.id,
      attempt: task.attempts,
      priority: task.priority,
      reassignmentCount: task.reassignmentCount,
      blockedReason: null,
      finishedAt: null,
    });
    this.persistMembers(squadId);

    let agentTask: AgentTaskDto;
    try {
      agentTask = await this.tasks.submit({
        agent: memberId,
        content: this.composeMemberPrompt(memberId, content),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.updateRun(run.id, { status: "failed", endedAt: this.now() });
      this.store.updateTask(task.id, { status: "failed", error: message, finishedAt: this.now() });
      this.persistMembers(squadId);
      throw err;
    }

    this.store.updateTask(task.id, { agentTaskId: agentTask.id, status: "running" });
    this.track(squadId, task.id, agentTask.id, run.id);
    log.info("auto", `小队 ${squadId} auto 派单 ${task.id} → ${memberId}（run ${run.id}）`);
    return {
      taskId: task.id,
      runId: run.id,
      agentTaskId: agentTask.id,
      assigneeId: memberId,
      status: "running",
      mode: "auto",
    };
  }

  /** 后台观察一条 auto 任务（不阻塞调用方） */
  private track(squadId: string, squadTaskId: string, agentTaskId: string, runId: string): void {
    void this.tasks
      .waitForTerminal(agentTaskId, this.waitTimeoutMs)
      .then((done) => this.applyTerminal(squadId, squadTaskId, done, runId))
      .catch((err: unknown) => {
        log.warn(
          "track",
          `auto 任务 ${squadTaskId} 跟踪失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /** 结算一条成员的执行终态（成功释放 / 失败冷却换人 / 排队） */
  private async applyTerminal(
    squadId: string,
    squadTaskId: string,
    done: AgentTaskDto,
    runId: string,
  ): Promise<void> {
    const task = this.store.getTask(squadTaskId);
    if (!task) return;
    if (task.agentTaskId !== undefined && done.id !== task.agentTaskId) return;
    // 等裁决：不判死，交给审批流程续跑（run 也保持等待态，UI 才显示「等待审批」）
    if (task.status === "waiting_approval") {
      this.store.updateRun(runId, { status: "waiting_approval" });
      return;
    }
    if (isTerminalSquadTaskStatus(task.status)) return;
    const coordinator = this.coordinators.get(squadId);
    const finishedAt = this.now();

    if (done.status === "replied") {
      coordinator?.reportSuccess(squadTaskId, done.result);
      this.store.updateTask(squadTaskId, {
        status: "completed",
        result: done.result ?? "",
        error: null,
        blockedReason: null,
        finishedAt,
      });
      this.store.updateRun(runId, { status: "completed", endedAt: finishedAt });
    } else if (done.status === "cancelled") {
      coordinator?.restoreMember(task.assigneeId, { status: "idle", currentTaskId: null });
      this.store.updateTask(squadTaskId, { status: "cancelled", finishedAt });
      this.store.updateRun(runId, { status: "cancelled", endedAt: finishedAt });
    } else {
      const error = done.error ?? `成员 ${task.assigneeId} 执行失败（${done.status}）`;
      this.store.updateRun(runId, { status: "failed", endedAt: finishedAt });
      const outcome = coordinator?.reportFailure(squadTaskId, error);
      if (!outcome) {
        this.store.updateTask(squadTaskId, { status: "failed", error, finishedAt });
      } else {
        await this.applyFailureOutcome(squadId, squadTaskId, outcome, error, runId);
      }
    }
    this.persistMembers(squadId);
    await this.drain(squadId);
  }

  /** 失败后按协调器的裁决落库：永久失败 / 排队 / 换人（或同人）重试 */
  private async applyFailureOutcome(
    squadId: string,
    squadTaskId: string,
    outcome: { action: string; newAssigneeId?: string; reason: string },
    error: string,
    previousRunId: string,
  ): Promise<void> {
    const coordinator = this.coordinators.get(squadId);
    const live = coordinator?.getTask(squadTaskId);
    const finishedAt = this.now();

    if (outcome.action === "permanently_failed") {
      this.store.updateTask(squadTaskId, { status: "failed", error: outcome.reason, finishedAt });
      return;
    }
    if (outcome.action === "queued") {
      this.store.updateTask(squadTaskId, {
        status: "pending",
        assigneeId: "",
        error,
        blockedReason: null,
        finishedAt: null,
      });
      return;
    }
    if (!live || !outcome.newAssigneeId) return;

    this.store.updateTask(squadTaskId, {
      status: "assigned",
      assigneeId: outcome.newAssigneeId,
      error,
      attempt: live.attempts,
      reassignmentCount: live.reassignmentCount,
      finishedAt: null,
    });
    this.persistMembers(squadId);
    const content = this.contents.get(squadTaskId) ?? this.store.getTask(squadTaskId)?.content ?? "";
    this.contents.set(squadTaskId, content);
    // 转派链用 parentRunId 串起来：运行树里能看出「上一轮失败 → 换人重试」
    await this.launch(squadId, live, outcome.newAssigneeId, content, previousRunId);
  }
}

/** 任务标题 = 正文首行，截断避免 UI 撑爆 */
function titleOf(content: string): string {
  const first = content.trim().split(/\r?\n/, 1)[0] ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}
