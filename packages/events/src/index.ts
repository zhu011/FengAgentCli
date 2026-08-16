/**
 * @fengagent/events — 事件溯源类型与注册表契约（Phase 0 定稿）
 *
 * 本包只提供三样东西，**零运行时行为变化**（事件日志写入/投影/重放自 Phase 1 起实现）：
 * 1. 事件名常量数组（SESSION_EVENT_TYPES）— 核心事件集合
 * 2. 事件类型（SessionEvent 判别联合）— 含 #5 的 hash/prevHash 信封
 * 3. 运行时注册表接口（SessionEventRegistry）+ 最小内存实现 —
 *    #1 的「校验走运行时注册表」契约，cordis 复用 service 注入：ctx.events.register()
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
  "turn/end",
  // #6 图导入事实（quality 为事实；active/rolledBack/branch 为派生态）
  "node/quality",
  // #4 head 确定式推导
  "rollback",
  "fork",
] as const;

/** 核心会话事件类型（编译期已知集合） */
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * 事件信封基类（#5：hash/prevHash 链，Phase 3 导出/导入校验直接可用，不留空项）。
 *
 * hash = sha-256(prevHash + "|" + seq + "|" + type + "|" + canonical(payload))；
 * 首事件 prevHash = null，hash = sha-256("")。
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
  "turn/end": { messageId: string; tokenCount?: number; assembled?: unknown };
  /** #6：事实事件（quality/note）；active/rolledBack/branch 由投影重算，不字面写入 */
  "node/quality": {
    nodeId: string;
    quality: "good" | "poor" | "unrated";
    note?: string;
  };
  "rollback": { targetNodeId: string; reason?: string; supersededNodeIds: string[] };
  "fork": { parentNodeId: string; branch: string };
}

/** 具体事件（type 与 payload 联动） */
export type SessionEvent<T extends SessionEventType = SessionEventType> = SessionEventBase & {
  type: T;
  payload: SessionEventPayloads[T];
};

/** 事件校验器（返回 false 表示校验失败） */
export type SessionEventValidator<T extends SessionEvent = SessionEvent> = (
  event: T,
) => boolean;

/**
 * 事件注册表接口（#1 运行时校验注册表契约）。
 *
 * 实现方（Phase 1 起）负责：
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

/** 默认（未注册）校验器 — 结构最小校验：信封字段齐全 */
const DEFAULT_VALIDATOR: SessionEventValidator = (event) =>
  event !== null &&
  typeof event === "object" &&
  typeof (event as SessionEventBase).sessionId === "string" &&
  typeof (event as SessionEventBase).seq === "number" &&
  typeof (event as SessionEventBase).timestamp === "string" &&
  typeof (event as SessionEventBase).hash === "string";

/**
 * 创建最小内存版事件注册表（Phase 1 起由事件存储实现方替换/包装）。
 */
export function createEventRegistry(): SessionEventRegistry {
  const validators = new Map<string, SessionEventValidator>();

  function registerEventType(type: string, validator?: SessionEventValidator): void {
    validators.set(type, validator ?? DEFAULT_VALIDATOR);
  }

  function has(type: string): boolean {
    return validators.has(type);
  }

  function validate(event: SessionEvent): boolean {
    const validator = validators.get(event.type);
    if (!validator) return false;
    try {
      return validator(event) !== false;
    } catch {
      return false;
    }
  }

  // 预置核心类型（默认校验器）
  for (const type of SESSION_EVENT_TYPES) {
    registerEventType(type);
  }

  return { registerEventType, has, validate };
}
