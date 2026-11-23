/**
 * @fengagent/core — 结构化任务状态（TaskState）
 *
 * 历史消息只是「原始记录」：任务目标、当前子任务、待调用工具、已完成动作都埋在
 * 自然语言里，模型每轮都要重新从上下文里「猜」进度，崩溃恢复时更无从判断
 * 哪一步已经落过副作用。本模块把任务状态提升为一等公民：
 *
 * - `coreIntent` 是**只读锚点** —— 创建后任何事件都不能改写（见 reduceTaskState）；
 * - `currentSubtask` / `pendingTools` / `completedSteps` / `contextSnapshot`
 *   是结构化字段，恢复时直接读，不需重新推理；
 * - 状态只能经 `task/*` 事件推进（事件溯源），`replayTaskState` 重放事件得到的
 *   状态与实时状态**逐字节一致**（纯函数、无 Date.now、无随机）；
 * - `stateVersion` 单调递增，是 checkpoint 的乐观锁版本（陈旧写入必须被拒）。
 *
 * 最小可恢复单位 = 一个 LLM 步 + 它发起的那个工具批次：
 * 步前写 `task/pending`（intent），步后写 `task/step-completed`（outcome）。
 *
 * 本文件零运行时依赖。
 */

import type { SideEffectKind } from "./operation-ledger.ts";

/**
 * 任务生命周期状态。
 *
 * - `active`：可继续推进；
 * - `waiting_approval`：**非终态**等待态 —— 任务卡在负责人/队长的一次审批上，
 *   裁决后由 `task/unblocked` 放回 `active` 续跑（不是判死整轮，也不进 failed）；
 * - `blocked`：需要外部条件（典型是「副作用结果 unknown，等待人工核对」）。
 *   注意与 issue 的 `blocked` 状态不是一回事：这里只描述 Agent Loop 的任务，
 *   审批等待一律走 `waiting_approval`，不要拿 `blocked` 兼职；
 * - `completed` / `aborted`：终态。
 */
export type TaskStatus = "active" | "waiting_approval" | "blocked" | "completed" | "aborted";

/** 终态集合（等待态不是终态：还能被 task/unblocked 拉回去） */
export const TERMINAL_TASK_STATE_STATUSES: readonly TaskStatus[] = ["completed", "aborted"];

/** 该任务状态是否终态 */
export function isTerminalTaskStateStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATE_STATUSES.includes(status);
}

/** checkpoint 相位：一个可恢复单位的前后两半 */
export type CheckpointPhase = "intent" | "outcome";

/**
 * 待执行工具调用 — **在工具真正执行之前**写入。
 *
 * 这是崩溃恢复的关键：进程在「工具已执行、turn 未落盘」窗口挂掉后，重放状态里
 * 仍留有这条记录，恢复逻辑据此判定「可能已经发生过副作用」，而不是当成没发生过。
 */
export interface PendingToolCall {
  /** 模型给出的工具调用 id */
  toolUseId: string;
  toolName: string;
  input: unknown;
  /** 副作用类别（无副作用工具为 "none"） */
  sideEffect: SideEffectKind;
  /** 副作用操作键（仅 sideEffect !== "none" 时存在），台账按它去重 */
  operationKey?: string;
  /** 该调用所属的步 id */
  stepId: string;
  /** 写入时间（事件时间，非墙钟推断） */
  startedAt: number;
}

/** 已完成步骤 — 步后写入（outcome） */
export interface CompletedStep {
  stepId: string;
  /** 该步的意图（intent 阶段写下的一句话） */
  intent: string;
  /** 该步的结果摘要 */
  outcome: string;
  /** 该步发起的工具调用 id 列表 */
  toolUseIds: string[];
  finishReason?: string;
  startedAt: number;
  finishedAt: number;
}

/** checkpoint 记录（落盘的最小可恢复单位标记） */
export interface Checkpoint {
  stepId: string;
  phase: CheckpointPhase;
  /** 应用该 checkpoint 事件之后的状态版本 */
  stateVersion: number;
  at: number;
}

/**
 * 结构化任务状态。
 *
 * 所有字段 JSON 可序列化；`stateVersion` 为乐观锁版本。
 */
export interface TaskState {
  taskId: string;
  sessionId: string;
  /** 只读锚点 —— 任务的核心意图，创建后不可改写 */
  coreIntent: string;
  /** 当前子任务（模型每步可更新） */
  currentSubtask: string | null;
  /** 尚未结算的工具调用（intent 已写、outcome 未写） */
  pendingTools: PendingToolCall[];
  /** 已完成步骤（按时间顺序） */
  completedSteps: CompletedStep[];
  /** 上下文快照（结构化摘要，恢复时直接可用） */
  contextSnapshot: Record<string, unknown>;
  status: TaskStatus;
  /**
   * 进入 `waiting_approval` / `blocked` 的原因（正常态恒为 null）。
   *
   * 落盘后 UI 直接显示，不需要再从事件流里反推「它在等什么」。
   */
  blockedReason: string | null;
  /**
   * 等待对象的引用：审批等待时是 `approval_request.id`，其他阻塞可为空。
   * 裁决回来时据此校验「放行的是不是它等的那一笔」。
   */
  blockedRef: string | null;
  /** 单调递增状态版本 */
  stateVersion: number;
  createdAt: number;
  updatedAt: number;
}

// ──────────────────────────────────────────────
// 事件
// ──────────────────────────────────────────────

/** `task/*` 事件词汇（与 packages/events 的会话事件词汇同名同形） */
export const TASK_EVENT_TYPES = [
  "task/created",
  "task/subtask",
  "task/pending",
  "task/step-completed",
  "task/context",
  "task/status",
  "task/checkpoint",
  "task/blocked",
  "task/unblocked",
] as const;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

/** 任务事件联合（判别式：type ↔ payload） */
export type TaskEvent =
  | {
      type: "task/created";
      taskId: string;
      sessionId: string;
      coreIntent: string;
      at: number;
    }
  | { type: "task/subtask"; taskId: string; subtask: string | null; at: number }
  | {
      type: "task/pending";
      taskId: string;
      stepId: string;
      pending: PendingToolCall[];
      at: number;
    }
  | {
      type: "task/step-completed";
      taskId: string;
      step: CompletedStep;
      at: number;
    }
  | {
      type: "task/context";
      taskId: string;
      snapshot: Record<string, unknown>;
      at: number;
    }
  | { type: "task/status"; taskId: string; status: TaskStatus; at: number }
  | { type: "task/checkpoint"; taskId: string; checkpoint: Checkpoint; at: number }
  | {
      type: "task/blocked";
      taskId: string;
      /** 阻塞原因（UI 直接显示） */
      reason: string;
      /** 阻塞类型：缺省 `waiting_approval`（负责人/队长审批）；`blocked` 留给外部条件 */
      status?: "waiting_approval" | "blocked";
      /** 等待对象引用（审批等待时 = approval_request.id） */
      ref?: string;
      at: number;
    }
  | {
      type: "task/unblocked";
      taskId: string;
      /** 解除方式：approve/deny 裁决续跑，resumed 是手动恢复 */
      resolution?: "approved" | "denied" | "resumed";
      note?: string;
      at: number;
    };

/** 该类型事件是否属于 `task/*` 词汇 */
export function isTaskEventType(type: string): type is TaskEventType {
  return (TASK_EVENT_TYPES as readonly string[]).includes(type);
}

/** 任务状态错误（非法推进 / 版本冲突） */
export class TaskStateError extends Error {
  constructor(
    message: string,
    readonly code:
      | "core_intent_immutable"
      | "task_not_created"
      | "task_already_created"
      | "task_id_mismatch"
      | "stale_state_version"
      | "illegal_transition",
  ) {
    super(message);
    this.name = "TaskStateError";
  }
}

/**
 * 创建任务初始状态（等价于应用一条 `task/created`）。
 *
 * @param taskId - 任务 id
 * @param sessionId - 所属会话 id
 * @param coreIntent - 核心意图（只读锚点）
 * @param at - 创建时间
 */
export function createTaskState(
  taskId: string,
  sessionId: string,
  coreIntent: string,
  at: number,
): TaskState {
  return {
    taskId,
    sessionId,
    coreIntent,
    currentSubtask: null,
    pendingTools: [],
    completedSteps: [],
    contextSnapshot: {},
    status: "active",
    blockedReason: null,
    blockedRef: null,
    stateVersion: 1,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * 老库兼容：把缺少新字段的状态补齐（`blockedReason` / `blockedRef`）。
 *
 * 读盘时统一走它，重放对拍才不会因为「老行没有新键」而报差异。
 */
export function normalizeTaskState(state: TaskState): TaskState {
  return {
    ...state,
    blockedReason: state.blockedReason ?? null,
    blockedRef: state.blockedRef ?? null,
  };
}

/** 深拷贝（reducer 保持纯函数语义，避免调用方持有的引用被改写） */function cloneState(state: TaskState): TaskState {
  return {
    ...state,
    pendingTools: state.pendingTools.map((p) => ({ ...p })),
    completedSteps: state.completedSteps.map((s) => ({
      ...s,
      toolUseIds: [...s.toolUseIds],
    })),
    contextSnapshot: { ...state.contextSnapshot },
  };
}

/**
 * 纯函数 reducer —— 应用一条任务事件，返回**新的**状态。
 *
 * 不读墙钟、不读随机数：同一串事件必然得到同一状态（重放对拍的前提）。
 * 每次应用都会把 `stateVersion` 加一（`task/created` 建到 1）。
 *
 * @param state - 当前状态（null = 尚未创建；此时只接受 `task/created`）
 * @param event - 任务事件
 * @returns 新状态
 * @throws {TaskStateError} 事件与状态不匹配，或试图改写只读锚点
 */
export function reduceTaskState(
  state: TaskState | null,
  event: TaskEvent,
): TaskState {
  if (event.type === "task/created") {
    if (state) {
      throw new TaskStateError(
        `task ${state.taskId} already created; core_intent is a read-only anchor`,
        "task_already_created",
      );
    }
    return createTaskState(
      event.taskId,
      event.sessionId,
      event.coreIntent,
      event.at,
    );
  }

  if (!state) {
    throw new TaskStateError(
      `cannot apply ${event.type} before task/created`,
      "task_not_created",
    );
  }
  if (state.taskId !== event.taskId) {
    throw new TaskStateError(
      `event taskId ${event.taskId} does not match state taskId ${state.taskId}`,
      "task_id_mismatch",
    );
  }

  const next = cloneState(state);
  next.stateVersion = state.stateVersion + 1;
  next.updatedAt = event.at;

  switch (event.type) {
    case "task/subtask":
      next.currentSubtask = event.subtask ?? null;
      break;
    case "task/pending":
      // 覆盖写：一个步只对应一个批次（重复写同一 stepId 视为重放同一意图）
      next.pendingTools = event.pending.map((p) => ({ ...p }));
      break;
    case "task/step-completed": {
      next.completedSteps.push({
        ...event.step,
        toolUseIds: [...event.step.toolUseIds],
      });
      // 该步的 pending 已结算 —— 只清掉属于该步的条目
      next.pendingTools = next.pendingTools.filter(
        (p) => p.stepId !== event.step.stepId,
      );
      break;
    }
    case "task/context":
      next.contextSnapshot = { ...event.snapshot };
      break;
    case "task/status":
      next.status = event.status;
      // 直接切到正常态等同于解除等待（原因必须一起清掉，否则 UI 会显示「在等」但状态已跑）
      if (event.status === "active" || event.status === "completed" || event.status === "aborted") {
        next.blockedReason = null;
        next.blockedRef = null;
      }
      break;
    case "task/checkpoint":
      // checkpoint 是「落盘标记」事实，不改变业务字段；版本 +1 已在上方统一处理
      break;
    case "task/blocked": {
      if (isTerminalTaskStateStatus(state.status)) {
        throw new TaskStateError(
          `cannot block task ${state.taskId} in terminal status ${state.status}`,
          "illegal_transition",
        );
      }
      // 缺省进「等待审批」而不是 blocked：审批等待是独立状态，别拿 blocked 兼职
      next.status = event.status ?? "waiting_approval";
      next.blockedReason = event.reason;
      next.blockedRef = event.ref ?? null;
      break;
    }
    case "task/unblocked": {
      if (isTerminalTaskStateStatus(state.status)) {
        throw new TaskStateError(
          `cannot unblock task ${state.taskId} in terminal status ${state.status}`,
          "illegal_transition",
        );
      }
      // 裁决后**续跑**：回到 active，等待原因清空；重复 unblocked 是幂等的
      next.status = "active";
      next.blockedReason = null;
      next.blockedRef = null;
      break;
    }
  }

  return next;
}

/**
 * 重放任务事件流，重建状态。
 *
 * @param events - 按 seq 升序的事件
 * @returns 重建的状态（事件为空时返回 null）
 */
export function replayTaskState(events: readonly TaskEvent[]): TaskState | null {
  let state: TaskState | null = null;
  for (const event of events) {
    state = reduceTaskState(state, event);
  }
  return state;
}

/**
 * 状态对拍：两份状态是否**逐字节**一致（重放一致性断言用）。
 *
 * @param a - 左值
 * @param b - 右值
 * @returns 完全一致时 true
 */
export function taskStateEquals(a: TaskState | null, b: TaskState | null): boolean {
  if (a === null || b === null) return a === b;
  return stableJson(a) === stableJson(b);
}

/** 稳定序列化（对象键排序），用于对拍与指纹 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
    .join(",")}}`;
}
