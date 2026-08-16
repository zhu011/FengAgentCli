/**
 * @fengagent/cordis — 插件域类型
 *
 * 以 Cordis 为一等公民：模型、工具、策略、存储、上下文管理、agent loop、
 * 图（Graph）全部是 Cordis 插件/服务。开发者可以拔下不满意的插件换一个，
 * 或按规则写一个新插件直接插上。
 *
 * 服务命名约定（挂在 ctx 上）：
 * - ctx.model    — 模型服务（LLM 调用，支持 provider/model 切换）
 * - ctx.tools    — 工具服务（工具注册表）
 * - ctx.strategy — 策略服务（压缩策略 / 工具选择 / 回退策略）
 * - ctx.storage  — 存储服务（会话持久化）
 * - ctx.context  — 上下文管理服务（压缩、记忆、系统上下文）
 * - ctx.loop     — Agent Loop 服务（agent loop 本身也是插件）
 * - ctx.graph    — 图服务（对话可溯源 / 对话即节点 / 可回退）
 */

import type { Context } from "@deepseek-ai/cordis";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMEvent,
} from "@fengagent/llm";
import type {
  Message,
  Session,
  SessionMeta,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@fengagent/core";
import type {
  AssembledContext,
  CompactionResult,
  ContextManager,
} from "@fengagent/context";
import type {
  ConversationNode,
  GraphStore,
  RollbackStrategy,
} from "@fengagent/graph";
import type {
  AnySessionEvent,
  AppendEventInput,
  EventStore,
  SessionEvent,
  SessionEventRegistry,
  SessionEventValidator,
} from "@fengagent/events";

/* ------------------------------ 模型域 ------------------------------ */

/** 模型服务 — 包裹 LLMClient，支持按 (provider, model) 解析 */
export interface ModelService {
  /** 当前生效的 client */
  readonly client: LLMClient;
  /** 当前 provider */
  provider: string;
  /** 当前 model */
  model: string;
  /** 流式调用 */
  stream(request: LLMRequest): AsyncGenerator<LLMEvent>;
  /** 一次性调用 */
  generate(request: LLMRequest): Promise<LLMResponse>;
  /** 热切换 provider/model（/model、/provider 命令的插件化底座） */
  switchProvider(provider: string, options?: { model?: string }): Promise<void>;
}

/** 模型插件配置 */
export interface ModelPluginConfig {
  /** provider 名（如 openai-compatible / anthropic / deepseek） */
  provider: string;
  /** 模型名 */
  model: string;
  /** 解析 client 的工厂（默认使用 @fengagent/llm createClient） */
  createClient?: (config: ModelPluginConfig) => LLMClient;
}

/* ------------------------------ 工具域 ------------------------------ */

/** 工具服务 */
export interface ToolService {
  /** 注册工具 */
  register(tool: ToolDefinition): void;
  /** 查询工具 */
  get(name: string): ToolDefinition | undefined;
  /** 物化工具列表（给 LLM 用） */
  materialize(): ToolDefinition[];
  /** 执行工具 */
  execute(calls: Array<{ tool: ToolDefinition; input: unknown }>, context: ToolContext): Promise<ToolResult[]>;
  /** 列出全部工具名 */
  listNames(): string[];
}

/** 工具插件配置 */
export interface ToolPluginConfig {
  /** 初始工具列表 */
  tools?: ToolDefinition[];
  /** 可选：复用既有 ToolRegistry 实例 */
  registry?: unknown;
}

/* ------------------------------ 策略域 ------------------------------ */

/** 压缩策略 */
export interface CompactionStrategy {
  /** 是否应触发压缩 */
  shouldCompact(context: { tokenCount: number; threshold: number }): boolean;
}

/** 工具选择策略（预留：未来按需选择工具，降低 token 成本） */
export interface ToolChoiceStrategy {
  /** 从可用工具中选择本轮暴露给 LLM 的工具 */
  choose(tools: ToolDefinition[], context: { messages: Message[]; turn: number }): ToolDefinition[];
}

/** 策略服务 — 压缩 / 工具选择 / 回退 全部可插拔 */
export interface StrategyService {
  compaction: CompactionStrategy;
  toolChoice: ToolChoiceStrategy;
  rollback: RollbackStrategy;
  /** 运行时替换策略（拔下换一个） */
  setCompaction(strategy: CompactionStrategy): void;
  setToolChoice(strategy: ToolChoiceStrategy): void;
  setRollback(strategy: RollbackStrategy): void;
}

/* ------------------------------ 存储域 ------------------------------ */

/** 会话存储的最小结构（兼容 SessionStore 类） */
export interface SessionStoreLike {
  saveSession(session: Session): void;
  loadSession(id: string): Session | null | undefined;
  listSessions(): SessionMeta[];
  deleteSession(id: string): void;
  /** 保存单条消息（可选：仅完整 SessionStore 提供） */
  saveMessage?(sessionId: string, message: Message): void;
  /** 保存多条消息（可选：仅完整 SessionStore 提供） */
  saveMessages?(sessionId: string, messages: Message[]): void;
}

/** 存储服务 — 会话 + 图 的持久化 */
export interface StorageService {
  /** 保存/更新会话 */
  saveSession(session: Session): void;
  /** 加载会话 */
  loadSession(id: string): Session | null | undefined;
  /** 列出会话（元信息） */
  listSessions(): SessionMeta[];
  /** 删除会话 */
  deleteSession(id: string): void;
  /** 保存单条消息（完整 SessionStore 提供；内存存储可忽略） */
  saveMessage?(sessionId: string, message: Message): void;
  /** 保存多条消息 */
  saveMessages?(sessionId: string, messages: Message[]): void;
  /** 图存储（对话即节点） */
  graph: GraphStore;
  /** 刷新持久化 */
  flush(): Promise<void>;
}

/* ------------------------------ 上下文域 ------------------------------ */

/** 上下文服务 — 组装 / 压缩 / 记忆 / 系统上下文（对齐既有 ContextManager） */
export interface ContextService {
  /** 组装上下文 */
  assemble(session: Session): Promise<AssembledContext>;
  /** 是否应压缩 */
  shouldCompact(context: AssembledContext): boolean;
  /** 执行压缩 */
  compact(messages: Message[], options?: Parameters<ContextManager["compact"]>[1]): Promise<CompactionResult>;
  /** token 估算 */
  estimateTokens(content: string | Message[]): number;
  /** 底层管理器（兼容既有实现） */
  readonly manager: ContextManager;
}

/* ------------------------------ Loop 域 ------------------------------ */

/** Loop 事件（对齐既有 AgentEvent，供 CLI/WebUI 复用） */
export type LoopEvent =
  | { type: "message-start"; messageId: string; role: string }
  | { type: "message-end"; messageId: string }
  | { type: "text-delta"; messageId: string; text: string }
  | { type: "tool-call"; messageId: string; name: string; input: unknown }
  | { type: "tool-call-result"; messageId: string; toolUseId: string; result: ToolResult }
  | { type: "turn-end"; reason: string }
  | { type: "compaction-start" }
  | { type: "compaction-end"; summary?: string }
  | { type: "error"; error: { message: string; code?: string } }
  | { type: "graph-node"; nodeId: string; parentId: string | null; kind: string };

/** Loop 服务 — agent loop 本身也是可插拔插件 */
export interface LoopService {
  /** 运行一轮完整 agent loop */
  run(
    session: Session,
    options?: { requestPermission?: ToolContext["requestPermission"] },
  ): AsyncGenerator<LoopEvent>;
}

/* ------------------------------ 图域 ------------------------------ */

/** 图服务 — 对话可溯源 / 对话即节点 / 可回退 */
export interface GraphService {
  readonly store: GraphStore;
  /**
   * 追加用户节点（幂等：同一会话同一 messageId 只追加一次，重复 run() 不会重复追加）。
   * @returns 实际落库的节点（若已存在则返回既有节点）
   */
  appendUserNode(
    conversationId: string,
    messageId: string,
    meta?: Record<string, unknown>,
  ): ConversationNode;
  /** 追加助手节点，返回实际落库的节点（供事件使用真实 nodeId / parentId） */
  appendAssistantNode(
    conversationId: string,
    messageId: string,
    meta?: Record<string, unknown>,
  ): ConversationNode;
  /** 标记回答不佳并回退 */
  rollbackPoorAnswer(nodeId: string, reason?: string): boolean;
  /**
   * 从某节点分叉出新分支（Phase 2：fork 事件落盘，旧分支作废保留）。
   * @returns 分支点节点（新 head）；节点不存在/不在活跃路径时 undefined
   */
  forkBranch(parentNodeId: string, branch?: string): ConversationNode | undefined;

  /* ---- 溯源 / 分支读取（CLI /rollback、/graph 与 WebUI 可视化共用） ---- */

  /** 获取节点 */
  getNode(nodeId: string): ConversationNode | undefined;
  /** 列出会话全部节点 */
  listNodes(conversationId: string): ConversationNode[];
  /** 溯源链：从根到某节点 */
  getChain(nodeId: string): ConversationNode[];
  /** 当前活跃路径 */
  getActivePath(conversationId: string): ConversationNode[];
  /** 当前活跃 head */
  getActiveHead(conversationId: string): ConversationNode | undefined;
}

/* ------------------------------ 事件域（Phase 1） ------------------------------ */

/**
 * 事件服务 — 事件日志写路径/重放/自愈 + 运行时注册表（#1）。
 *
 * 事件日志为会话事实的唯一来源（append-only `events/{sessionId}.jsonl`）；
 * isSessionEvent / append 校验走运行时注册表（ctx.events.register() 注册扩展类型）。
 */
export interface EventService {
  /** 事件日志存储（每会话单文件 append-only，重放，尾部半行自愈） */
  readonly store: EventStore;
  /** 运行时注册表（校验走这里） */
  readonly registry: SessionEventRegistry;
  /** 注册事件类型（cordis 复用点：ctx.events.register()） */
  register(type: string, validator?: SessionEventValidator): void;
  /** 是否已注册该类型 */
  has(type: string): boolean;
  /** 校验一条事件 */
  validate(event: SessionEvent): boolean;
  /** 校验未知值是否为注册表认可的会话事件（isSessionEvent） */
  isSessionEvent(value: unknown): value is SessionEvent;
  /** 追加事件（append-only 写路径，经注册表校验） */
  append(input: AppendEventInput): SessionEvent;
  /** 重放：按 seq 返回会话全部事件 */
  replay(sessionId: string): AnySessionEvent[];
  /** 崩溃自愈：截断尾部半行（返回被截断字节数） */
  healTail(sessionId: string): number;
  /** 会话事件日志文件路径 */
  pathFor(sessionId: string): string;
}

/* ------------------------------ 运行时 ------------------------------ */

/** 插件注册项 — config 驱动加载（可插拔积木） */
export interface RuntimePluginEntry {
  /** 插件 id（内置注册表或用户插件路径） */
  id: string;
  /** 插件配置 */
  config?: Record<string, unknown>;
}

/** 运行时配置 */
export interface FengRuntimeConfig {
  /** 会话/工作目录 */
  workdir: string;
  /** 插件列表（顺序加载，后注册的可以覆盖前一个服务实现） */
  plugins: RuntimePluginEntry[];
}

/** 运行时句柄 */
export interface FengRuntime {
  /** Cordis 根上下文 */
  ctx: Context;
  /** 启动（加载全部插件） */
  start(): Promise<void>;
  /** 停止（卸载全部插件） */
  stop(): Promise<void>;
  /** 运行时是否已启动 */
  started: boolean;
}

/** 内置插件 id 常量 */
export const BUILTIN_PLUGINS = {
  MODEL: "feng.model",
  TOOLS: "feng.tools",
  STRATEGY: "feng.strategy",
  STORAGE: "feng.storage",
  CONTEXT: "feng.context",
  LOOP: "feng.loop",
  GRAPH: "feng.graph",
  EVENTS: "feng.events",
} as const;

/* ------------------------------ Context 服务增强 ------------------------------ */

declare module "@deepseek-ai/cordis" {
  interface Context {
    model: ModelService;
    tools: ToolService;
    strategy: StrategyService;
    storage: StorageService;
    context: ContextService;
    loop: LoopService;
    graph: GraphService;
    /**
     * 事件溯源服务（事件日志写路径/重放/自愈 + 运行时注册表）。
     *
     * 命名说明：cordis 框架自带的事件总线占用 `ctx.events`（EventsService），
     * 本服务（事件溯源日志）以 `ctx.eventLog` 暴露，避免同名冲突；
     * 「ctx.events.register()」的语义由 `ctx.eventLog.register()` 承担。
     */
    eventLog: EventService;
  }
}
