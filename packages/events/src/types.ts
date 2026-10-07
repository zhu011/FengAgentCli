/**
 * @fengagent/events — 事件溯源类型与常量（Phase 0 定稿，Phase 1 沿用）
 *
 * 本模块只声明类型/常量，不含运行时行为：
 * 1. 事件名常量数组（SESSION_EVENT_TYPES）— 核心事件集合
 * 2. 事件类型（SessionEvent 判别联合）— 含 #5 的 hash/prevHash 信封
 * 3. 运行时注册表接口（SessionEventRegistry）— #1 契约
 *
 * 编译期扩展（declare module 模式，仅管类型、两者解耦）：
 * 插件包可在自己的 .d.ts / .ts 中增补负载类型：
 * ```ts
 * declare module "@fengagent/events" {
 *   interface SessionEventPayloads {
 *     "my/custom": { foo: string };
 *   }
 * }
 * ```
 * 运行时则用 registry.registerEventType("my/custom", validator) 注册校验器。
 */

/** 会话状态（#3 会话生命周期入词汇） */
export type SessionStatus = "created" | "running" | "idle" | "closed";

/**
 * 核心会话事件类型（#2/#3/#6 词汇）。
 * 运行时注册表对自定义类型开放（registerEventType 接受 string）。
 */
export const SESSION_EVENT_TYPES = [
  // #3 会话生命周期
  "session/created",
  "session/title",
  "session/status",
  // 消息
  "user/message",
  // #2 复现语义
  "step/start",
  "step/end",
  "assistant/chunk",
  "assistant/message",
  // 工具入参被用户改写后执行的事实（HITL 审批改参 / 图上改参重放）
  "tool/corrected",
  "turn/end",
  // #6 图导入事实（quality 为事实；active/rolledBack/branch 为派生态）
  "node/quality",
  // #4 head 确定式推导
  "rollback",
  "fork",
  // 结构化任务状态（任务可安全恢复）：TaskState 只能经这些事件推进
  "task/created",
  "task/subtask",
  "task/pending",
  "task/step-completed",
  "task/context",
  "task/status",
  "task/checkpoint",
] as const;

/** 核心会话事件类型（编译期已知集合） */
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * 事件信封基类（#5：hash/prevHash 链，Phase 3 导出/导入校验直接可用，不留空项）。
 *
 * hash = sha-256(prevHash + "|" + seq + "|" + type + "|" + canonical(payload))；
 * 首事件 prevHash = null，按空串参与哈希。
 */
export interface SessionEventBase {
  version: 1;
  sessionId: string;
  /** 会话内单调递增序号（head 推导与重放的顺序依据） */
  seq: number;
  type: SessionEventType;
  /** ISO-8601 时间戳 */
  timestamp: string;
  /** 本事件哈希（见类注释） */
  hash: string;
  /** 前序事件哈希（null = 会话首事件） */
  prevHash: string | null;
}

/** 各事件类型的负载（type ↔ payload 联动；插件经 declare module 扩展） */
export interface SessionEventPayloads {
  "session/created": {
    title: string;
    status: SessionStatus;
    initialModel?: string;
  };
  "session/title": { title: string };
  "session/status": { status: SessionStatus };
  "user/message": { messageId: string; content: unknown };
  "step/start": {
    messageId: string;
    model?: string;
    tools?: string[];
    maxTokens?: number;
    temperature?: number;
    /** FENG_EVENT_FULL_REQUEST=1 时附组装上下文（字节级） */
    fullRequest?: unknown;
  };
  "step/end": { messageId: string; finishReason?: string; tokenCount?: number };
  "assistant/chunk": { messageId: string; index: number; delta: unknown };
  /** #2：默认不单独落事实，由 assistant/chunk 投影组装；FENG_EVENT_FULL_REQUEST=1 时落 assembled */
  "assistant/message": { messageId: string; assembled: unknown };
  /**
   * 工具入参被用户改写后执行的事实（改参可溯源）。
   *
   * 两个入口共用本事实：审批弹窗改参（hitl）、图上改参重放（graph）。
   * 原始入参必须显式落在这里 —— 会话消息里该 tool-use 块会被同步覆写为
   * 实际执行入参，不落此事实则「改参前后」再也追不回来。
   */
  "tool/corrected": {
    /** 产生该工具调用的助手消息 id（图节点归属） */
    messageId: string;
    /** 工具调用 id */
    toolUseId: string;
    /** 工具名 */
    toolName: string;
    /** 模型给出的原始入参 */
    originalInput: unknown;
    /** 用户改写后实际执行的入参 */
    correctedInput: unknown;
    /** 改参来源：hitl=审批弹窗改参；graph=图上改参重放 */
    source?: "hitl" | "graph";
  };
  "turn/end": { messageId: string; tokenCount?: number; assembled?: unknown };
  /** #6：事实事件（quality/note）；active/rolledBack/branch 由投影重算，不字面写入 */
  "node/quality": {
    nodeId: string;
    quality: "good" | "poor" | "unrated";
    note?: string;
  };
  "rollback": {
    targetNodeId: string;
    reason?: string;
    supersededNodeIds: string[];
    /** 回退粒度：turn=轮级（缺省/历史事件）；step=步级续跑 */
    granularity?: "turn" | "step";
    /** 回退后的续跑语义：replay=重放该步；resume=从该步之后续跑 */
    mode?: "replay" | "resume";
  };
  "fork": { parentNodeId: string; branch: string };

  // ── 结构化任务状态（TaskState 事件溯源词汇）──────────────────────────
  // 语义与 @fengagent/core 的 TaskEvent 一一对应：投影这些事件得到 TaskState。
  // 最小可恢复单位 = 一个 LLM 步 + 它的工具批次：步前 task/pending，
  // 步后 task/step-completed，两侧各有一条 task/checkpoint 落盘标记。
  "task/created": {
    taskId: string;
    sessionId: string;
    /** 只读锚点：任务核心意图，创建后不可改写 */
    coreIntent: string;
    at: number;
  };
  /** 当前子任务 */
  "task/subtask": { taskId: string; subtask: string | null; at: number };
  /** 待执行工具批次（**执行之前**写入；恢复时的 orphan 依据） */
  "task/pending": {
    taskId: string;
    stepId: string;
    pending: Array<{
      toolUseId: string;
      toolName: string;
      input: unknown;
      sideEffect: string;
      operationKey?: string;
      stepId: string;
      startedAt: number;
    }>;
    at: number;
  };
  /** 步骤结算（步后写入） */
  "task/step-completed": {
    taskId: string;
    step: {
      stepId: string;
      intent: string;
      outcome: string;
      toolUseIds: string[];
      finishReason?: string;
      startedAt: number;
      finishedAt: number;
    };
    at: number;
  };
  /** 上下文快照 */
  "task/context": {
    taskId: string;
    snapshot: Record<string, unknown>;
    at: number;
  };
  /** 任务生命周期状态 */
  "task/status": { taskId: string; status: string; at: number };
  /** checkpoint 落盘标记（intent / outcome） */
  "task/checkpoint": {
    taskId: string;
    checkpoint: {
      stepId: string;
      phase: string;
      stateVersion: number;
      at: number;
    };
    at: number;
  };
}

/** 具体事件（type 与 payload 联动） */
export type SessionEvent<T extends SessionEventType = SessionEventType> = SessionEventBase & {
  type: T;
  payload: SessionEventPayloads[T];
};

/**
 * 遍历/重放用判别联合：type ↔ payload 相关性保留（switch(e.type) 可收窄 payload）。
 * 区别于 SessionEvent（默认泛型展开后为非相关对象类型，无法收窄）。
 */
export type AnySessionEvent = {
  [T in SessionEventType]: SessionEventBase & {
    type: T;
    payload: SessionEventPayloads[T];
  };
}[SessionEventType];

/** 事件校验器（返回 false 表示校验失败） */
export type SessionEventValidator<T extends SessionEvent = SessionEvent> = (
  event: T,
) => boolean;

/**
 * 事件注册表接口（#1 运行时校验注册表契约）。
 *
 * 实现方负责：
 * - isSessionEvent / append 校验走本注册表；
 * - 核心类型校验器可预置（见 SESSION_EVENT_TYPES），自定义类型经 registerEventType 注册。
 */
export interface SessionEventRegistry {
  /** 注册事件类型（可附校验器；重复注册覆盖） */
  registerEventType(type: string, validator?: SessionEventValidator): void;
  /** 是否已注册该类型 */
  has(type: string): boolean;
  /** 校验一条事件：未注册类型或校验器返回 false 视为校验失败 */
  validate(event: SessionEvent): boolean;
}
