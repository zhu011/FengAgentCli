/**
 * @fengagent/dsh-compat — dsh 服务契约（P2）
 *
 * 这里用**结构化类型**描述 dsh（`@deepseek-ai/dsh-session@0.1.0-rc.6` /
 * `@deepseek-ai/dsh-agent@0.1.0-rc.6`）的 `ctx.sessions` / `ctx.agents` 形状，
 * 而不是把 dsh 的包变成运行时依赖：
 *
 * - dsh 的 rc 之间服务面会变（见 packages/dsh-compat/README.md「版本策略」），
 *   结构类型让本包只承诺「映射到哪个子集」，升级 dsh 时按契约差异逐项复核；
 * - 映射的**保真度分级**与逐成员裁决见 `docs/DSH-CONTRACT-MAP.md`。
 *
 * 分级（capability tier）：
 * - `direct`   等价直通（语义与 FengAgentCli 现有能力一一对应）
 * - `adapt`    适配（可观察结果等价，但落库/身份/事件粒度有已知偏差，见文档）
 * - `unsupported` 明确不支持：调用即抛 {@link DshContractUnsupportedError}，
 *   不做「假装成功」的静默降级。
 */

/** dsh 契约的成员路径（用于错误信息与能力清单） */
export type DshContractPath =
  | "sessions.get"
  | "sessions.list"
  | "sessions.create"
  | "sessions.fork"
  | "sessions.flush"
  | "sessions.prepare"
  | "sessions.enter"
  | "sessions.announce"
  | "session.events"
  | "session.append"
  | "session.requestHeader"
  | "session.surface"
  | "agents.get"
  | "agents.list"
  | "agents.roots"
  | "agents.register"
  | "agents.enter"
  | "agents.announce"
  | "agents.isOwnedBy"
  | "agents.setFactory"
  | "agents.create"
  | "agents.resume"
  | "agents.withInitiator"
  | "agents.withoutInitiator"
  | "agents.currentInitiator"
  | "agents.requireInitiator"
  | "agentDefaultModel.currentSelection"
  | "agentDefaultModel.saveSelection"
  | "llm.stream"
  | "llm.registerAdapter"
  | "llm.listProviders"
  | "llm.providerRetryPolicy"
  | "llm.listModels"
  | "llm.resolveModelInfo"
  | "llm.prepareCall"
  | "llm.registerConfigurableProviders"
  | "llm.registerModelDiscovery"
  | "message.toDsh"
  | "message.fromDsh"
  | "scope.of"
  | "scope.create"
  | "scope.bindParent"
  | "scope.target"
  | "systemPrompt"
  | "fs"
  | "sessionProjections";

/** 能力分级 */
export type DshCapabilityTier = "direct" | "adapt" | "unsupported";

/** 一个契约成员在 FengAgentCli 侧的映射裁决 */
export interface DshCapability {
  /** dsh 契约成员 */
  readonly path: DshContractPath;
  /** 分级 */
  readonly tier: DshCapabilityTier;
  /** FengAgentCli 侧对应实现（文件:符号，便于审查） */
  readonly mappedTo: string;
  /** 已知偏差/限制（`direct` 时为空） */
  readonly notes?: string;
}

/** dsh 契约不支持的统一错误：带上契约路径，调用方按 code 分支而不是猜 message */
export class DshContractUnsupportedError extends Error {
  readonly code = "dsh_contract_unsupported" as const;

  constructor(
    readonly contract: DshContractPath,
    readonly detail: string,
  ) {
    super(`dsh contract "${contract}" is not supported by FengAgentCli: ${detail}`);
    this.name = "DshContractUnsupportedError";
  }
}

/** 参数/生命周期错误（区别于「不支持」：这是调用方用错了） */
export class DshContractError extends Error {
  readonly code = "dsh_contract_invalid" as const;

  constructor(
    readonly contract: DshContractPath,
    readonly detail: string,
  ) {
    super(`dsh contract "${contract}" rejected: ${detail}`);
    this.name = "DshContractError";
  }
}

/**
 * 本包需要的最小 Cordis Context 面。
 *
 * 刻意不 import `@deepseek-ai/cordis`：dsh-compat 的依赖里只有 `dsh-tools`，
 * 而 cordis 由 `@fengagent/cordis` 持有；用结构化类型注册服务（`ctx.reflect.provide`）
 * 既避免新增依赖，也保持本包可在任意 Cordis 4 宿主里装配。
 */
export interface DshContextLike {
  readonly reflect: {
    provide(name: string, value?: unknown): () => void;
    /**
     * 读服务而不声明 `inject`（Cordis 4 的代理在未声明 inject 时会对 `ctx.model`
     * 直接抛错；可选依赖必须走 reflect.get）。
     */
    get?(name: string): unknown;
  };
  /** 可选的模型服务（dsh agentDefaultModel 映射用） */
  readonly model?: {
    readonly provider: string;
    readonly model: string;
    switchProvider(provider: string, options?: { model?: string }): Promise<void>;
  };
}

/* ------------------------------ sessions ------------------------------ */

/** dsh 会话事件（结构化投影，仅保留映射需要的字段） */
export interface DshSessionEvent {
  readonly seq: number;
  readonly type: string;
  readonly time: number;
  readonly data: Record<string, unknown>;
}

/** dsh 会话头（不可变创建元数据；FengAgentCli 侧只有一部分可持久化） */
export interface DshSessionHeader {
  readonly version: number;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly seedLength?: number;
  readonly origin?: "subagent";
  readonly delegationDepth?: number;
}

/** dsh `Session` 的**只读投影**面 */
export interface DshSessionLike {
  readonly id: string;
  readonly header: DshSessionHeader;
  readonly events: readonly DshSessionEvent[];
  /**
   * 事件溯源写入口。
   *
   * 装了 `dsh-services` 时写入进程内领域事件日志并返回该事件；单独构造的
   * {@link CompatSession}（无事件桥）仍抛 `dsh_contract_unsupported`。
   * 声明成返回 `never` 会让「已支持」的实现无法结构化匹配，故按真实返回面声明。
   */
  append(type: string, data?: unknown): DshSessionEvent;
  /** dsh 的请求头折叠：FengAgentCli 没有 request/header 事件 → undefined */
  requestHeader(): undefined;
  /** dsh 的顺序 surface：不支持（没有 surfaceOp） */
  readonly surface: never;
}

/** dsh `SessionStore`（`ctx.sessions`）的映射面 */
export interface DshSessionsLike {
  get(id: string): DshSessionLike | undefined;
  list(): DshSessionLike[];
  create(id?: string, options?: DshCreateSessionOptions): DshSessionLike;
  fork(source: DshSessionLike | string, boundary?: number, childId?: string): DshSessionLike;
  flush(session: DshSessionLike): Promise<boolean>;
  prepare(id?: string, options?: DshCreateSessionOptions): never;
  enter(session: DshSessionLike): never;
  announce(session: DshSessionLike): never;
}

/** dsh `CreateSessionOptions` 的映射子集 */
export interface DshCreateSessionOptions {
  /** seed 事件（回放/分叉）：P2 不支持非空 seed */
  readonly seed?: readonly DshSessionEvent[];
  /** 创建元数据；只有 cwd 会被校验并保留在内存 header 中 */
  readonly meta?: {
    readonly cwd?: string;
    readonly parentSession?: string;
    readonly seedLength?: number;
    readonly origin?: "subagent";
    readonly delegationDepth?: number;
  };
  /** dsh persistence 恢复路径标记：P2 不支持 */
  readonly seedSource?: "persistence";
}

/* ------------------------------ agents ------------------------------ */

/** dsh `Agent` 的映射面（只承诺 registry 消费者真正读取的字段） */
export interface DshAgentLike {
  readonly id: string;
  readonly session: DshSessionLike;
}

/** agent 创建选项（结构化子集：身份 + 元数据 + setup 钩子） */
export interface DshCreateAgentOptions {
  readonly sessionId: string;
  readonly meta?: DshCreateSessionOptions["meta"];
  readonly seed?: readonly DshSessionEvent[];
  readonly agentOptions?: Record<string, unknown>;
  readonly setup?: (agentCtx: unknown) => unknown;
  readonly signal?: AbortSignal;
}

/** resume 选项 */
export interface DshResumeAgentOptions {
  readonly resumeSessionId: string;
  readonly agentOptions?: Record<string, unknown>;
  readonly setup?: (agentCtx: unknown) => unknown;
  readonly signal?: AbortSignal;
}

/** dsh `AgentHandle` */
export interface DshAgentHandle {
  readonly agent: DshAgentLike;
  dispose(): Promise<void>;
}

/** dsh `AgentFactory`（由 loop 实现并提供给 registry） */
export interface DshAgentFactory {
  createAgent(ownerCtx: unknown, options: DshCreateAgentOptions): Promise<DshAgentHandle>;
  resume(ownerCtx: unknown, options: DshResumeAgentOptions): Promise<DshAgentHandle>;
}

/** dsh `AgentRegistry`（`ctx.agents`）的映射面 */
export interface DshAgentsLike {
  get(id: string): DshAgentLike | undefined;
  list(): DshAgentLike[];
  roots(): DshAgentLike[];
  register(agent: DshAgentLike): () => void;
  enter(agent: DshAgentLike, owner: DshAgentLike | undefined): () => void;
  announce(agent: DshAgentLike): void;
  isOwnedBy(id: string, owner: DshAgentLike): boolean;
  setFactory(factory: DshAgentFactory): () => void;
  create(options: DshCreateAgentOptions): Promise<DshAgentHandle>;
  resume(options: DshResumeAgentOptions): Promise<DshAgentHandle>;
  withInitiator<T>(agent: DshAgentLike, operation: () => T): T;
  withoutInitiator<T>(operation: () => T): T;
  currentInitiator(): DshAgentLike | undefined;
  requireInitiator(): DshAgentLike;
}

/* ------------------------------ agentDefaultModel ------------------------------ */

/** dsh `ModelSelection` 的结构子集 */
export interface DshModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** dsh `agentDefaultModel` 服务面 */
export interface DshAgentDefaultModelLike {
  currentSelection(): DshModelSelection;
  saveSelection(next: DshModelSelection): Promise<void>;
}

/* ------------------------------ llm（P3） ------------------------------ */

/** dsh 文本块 */
export interface DshTextBlock {
  readonly type: "text";
  readonly text: string;
}

/** dsh 推理/思考块（与可见文本分离） */
export interface DshReasoningBlock {
  readonly type: "reasoning";
  readonly text: string;
}

/** dsh 工具调用块（`arguments` 是模型产出的原始 JSON 字符串） */
export interface DshToolCallBlock {
  readonly type: "tool-call";
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** dsh 工具结果块（内容本身也是块数组） */
export interface DshToolResultBlock {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly content: readonly DshContentBlock[];
  readonly isError?: boolean;
}

/** dsh 内容块：核心五类 + 任意扩展块（结构透传，未知类型由调用方裁决） */
export type DshContentBlock =
  | DshTextBlock
  | DshReasoningBlock
  | DshToolCallBlock
  | DshToolResultBlock
  | { readonly type: string; readonly [key: string]: unknown };

/** dsh `Message` 的映射面（身份 `id` 必填且跨边界保留） */
export interface DshMessage {
  readonly id: string;
  readonly role: "system" | "user" | "assistant";
  readonly content: readonly DshContentBlock[];
  /** 产生者（dsh `MessageSource`；本包只读有损保留，不参与路由） */
  readonly source?: Readonly<Record<string, unknown>>;
}

/** dsh `TokenUsage`（缓存字段与输入输出是**不相交**计数） */
export interface DshTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

/** dsh `FinishReason`（可合并扩展；本包只产出核心五种） */
export type DshFinishReason =
  | { readonly kind: "stop" }
  | { readonly kind: "tool-calls" }
  | { readonly kind: "max-tokens" }
  | { readonly kind: "aborted"; readonly failure?: unknown }
  | { readonly kind: "error"; readonly failure?: unknown };

/** dsh `StreamChunk`：适配器原始流协议（usage 在 finish 之前，tool 参数保持原始 JSON） */
export type DshStreamChunk =
  | { readonly type: "block-start"; readonly index: number; readonly blockType: string }
  | { readonly type: "text-delta"; readonly index: number; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly index: number; readonly text: string }
  | {
      readonly type: "tool-call-delta";
      readonly index: number;
      readonly id: string;
      readonly name?: string;
      readonly argumentsDelta: string;
    }
  | { readonly type: "block-end"; readonly index: number; readonly block: DshContentBlock }
  | { readonly type: "usage"; readonly usage: DshTokenUsage }
  | { readonly type: "finish"; readonly reason: DshFinishReason; readonly replayState?: unknown };

/** dsh 工具 schema（`GenerateOptions.tools` 的元素） */
export interface DshToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** dsh `GenerateOptions`：一次完整模型请求 */
export interface DshGenerateOptions {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly messages: readonly DshMessage[];
  readonly system?: string;
  readonly tools?: readonly DshToolSchema[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly stop?: readonly string[];
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
  readonly purpose?: string;
}

/** dsh `LlmProviderInfo` */
export interface DshProviderInfo {
  readonly id: string;
  readonly name: string;
}

/** dsh `LlmModelInfo`（目录是建议性的，不是请求白名单） */
export interface DshModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/** dsh `LlmResolvedModelInfo` */
export interface DshResolvedModelInfo extends DshModelInfo {
  readonly context?: { readonly contextWindow: number };
  readonly defaultMaxTokens?: number;
}

/** dsh `ResolvedRetryPolicy`（本包只产出 normal 模式的完整解析值） */
export interface DshRetryPolicy {
  readonly mode: "normal" | "always";
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  readonly maxRetries?: number;
  readonly retryableCodes?: readonly string[];
}

/** dsh `LlmAdapter` 的结构面（插件注册进来的 provider 适配器） */
export interface DshLlmAdapterLike {
  stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk>;
  providerInfo?(provider: string): DshProviderInfo;
  providerRetryPolicy?(provider: string): DshRetryPolicy | undefined;
  listModels?(provider: string): Promise<readonly DshModelInfo[]>;
  resolveModel?(provider: string, model: string, signal?: AbortSignal): Promise<DshResolvedModelInfo>;
}

/** dsh `PreparedLlmCall`：配置与适配器注册一起解析后的单次调用句柄 */
export interface DshPreparedCall {
  readonly config: {
    readonly provider: string;
    readonly model: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
  };
  stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk>;
}

/** `ctx.llm.registerAdapter()` 的返回值（disposer + 原子路由替换） */
export interface DshAdapterRegistrationHandle {
  (): void;
  replace(providers: string[]): void;
}

/** dsh `ctx.llm` 服务面（本包映射的子集） */
export interface DshLlmLike {
  registerAdapter(providers: string[], adapter: DshLlmAdapterLike): DshAdapterRegistrationHandle;
  listProviders(): DshProviderInfo[];
  providerRetryPolicy(provider: string): DshRetryPolicy;
  listModels(provider: string): Promise<readonly DshModelInfo[]>;
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<DshResolvedModelInfo>;
  stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk>;
  prepareCall(options: DshGenerateOptions): DshPreparedCall;
  registerConfigurableProviders(entries: readonly unknown[]): never;
  registerModelDiscovery(settingsNs: string, discover: unknown): never;
}
