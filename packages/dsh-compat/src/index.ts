/**
 * @fengagent/dsh-compat — P2 契约映射 + dsh 插件兼容层
 *
 * 装配面，按需组合：
 * - P1 `dshCompatPlugin`：`ctx.tools` 的 dsh 接口面（tools-only dsh 插件直装），
 *   P2 起带上 dsh 的 `exec` 上下文与 `tools/*` 事件桥；
 * - P2 `dshServicesPlugin`：`ctx.sessions` / `ctx.agents` / `ctx.agentDefaultModel`
 *   服务面（契约映射，分级与偏差见 `docs/DSH-CONTRACT-MAP.md`）；
 * - `loadDshPlugin`：按模块 id 装一个 dsh/Cordis 插件。
 */

export {
  adaptDshTool,
  isDshToolDefinition,
  type AdaptDshToolOptions,
  type DshToolDefinition,
} from "./adapter.ts";
export { name, inject, apply, dshCompatPlugin, type DshCompatConfig } from "./plugin.ts";
export {
  importDshPlugin,
  loadDshPlugin,
  type DshLoadContext,
  type DshPluginModule,
  type LoadDshPluginOptions,
} from "./loader.ts";
export { defineTool } from "@deepseek-ai/dsh-tools";

/* ------------------------------ P2：工具执行上下文 ------------------------------ */

export {
  createDshExecContext,
  resolveAgentFromServices,
  type DshAgentResolver,
  type DshExecContextOptions,
  type DshExecContextParams,
  type DshToolExec,
  type DshToolExecutionToken,
} from "./exec-context.ts";

/* ------------------------------ P2：dsh 事件桥 ------------------------------ */

export {
  DshToolEventBridge,
  DEFAULT_NATIVE_TOOL_ALIASES,
  type DshEventContextLike,
  type DshEventExec,
  type DshEventResult,
  type DshHookContextLike,
  type DshHookRegistryLike,
  type DshHookToolResultLike,
  type DshPostDecision,
  type DshPreDecision,
  type DshToolEventBridgeOptions,
  type DshToolEventSink,
} from "./events.ts";

/* ------------------------------ P2：服务契约映射 ------------------------------ */

export {
  DshContractError,
  DshContractUnsupportedError,
  type DshAgentFactory,
  type DshAgentHandle,
  type DshAgentLike,
  type DshAgentDefaultModelLike,
  type DshAgentsLike,
  type DshCapability,
  type DshCapabilityTier,
  type DshContractPath,
  type DshCreateAgentOptions,
  type DshCreateSessionOptions,
  type DshModelSelection,
  type DshResumeAgentOptions,
  type DshSessionEvent,
  type DshSessionHeader,
  type DshSessionLike,
  type DshSessionsLike,
} from "./contracts.ts";
export { CompatSession, SessionsCompat } from "./sessions.ts";
export { AgentsCompat, CompatAgent, createCompatAgent } from "./agents.ts";
export { AgentDefaultModelCompat } from "./agent-default-model.ts";
export {
  DSH_SERVICE_CAPABILITIES,
  apply as applyDshServices,
  dshServicesPlugin,
  type DshServicesConfig,
} from "./services-plugin.ts";
export {
  messageBoundaryForSeq,
  projectSessionEvents,
  type ProjectedSessionEvent,
} from "./projection.ts";

/* ------------------------------ P3：llm / 消息互转 ------------------------------ */

export {
  DEFAULT_DSH_RETRY_POLICY,
  LlmCompat,
  toLlmRequest,
  type DshModelLike,
  type LlmCompatOptions,
} from "./llm.ts";
export {
  dshMessageText,
  fromDshContent,
  fromDshMessage,
  parseToolCallArguments,
  requireFengMessage,
  toDshContent,
  toDshMessage,
  toDshUserMessage,
  toFengToolDefinition,
  type DshMessageLoss,
  type FromDshMessageResult,
} from "./messages.ts";
export type {
  DshAdapterRegistrationHandle,
  DshContentBlock,
  DshFinishReason,
  DshGenerateOptions,
  DshLlmAdapterLike,
  DshLlmLike,
  DshMessage,
  DshModelInfo,
  DshPreparedCall,
  DshProviderInfo,
  DshReasoningBlock,
  DshResolvedModelInfo,
  DshRetryPolicy,
  DshStreamChunk,
  DshTextBlock,
  DshTokenUsage,
  DshToolCallBlock,
  DshToolResultBlock,
  DshToolSchema,
} from "./contracts.ts";

/* ------------------------------ P3：scope ------------------------------ */

export {
  AnonymousEntries,
  NamedEntries,
  ScopedLayers,
  bindScopeParent,
  carrierKeyOf,
  createAgentScope,
  createScope,
  forgetSessionScopeKey,
  isScopeCarrier,
  isScopedContext,
  scopeChainOf,
  scopeKeyForSession,
  scopeKeyOf,
  scopeOf,
  scopeParentOf,
  scopeTarget,
  type AgentScope,
  type AgentScopeOptions,
  type CreateScopeOptions,
  type DshScopeContextLike,
  type Scope,
  type ScopeKey,
  type ScopeLayer,
  type ScopeParentBinding,
  type Scoped,
} from "./scope.ts";

/* ------------------------------ P3：服务面清单 ------------------------------ */

export {
  DSH_SCOPE_NOTE,
  DSH_SERVICE_INVENTORY,
  summarizeServiceInventory,
  type DshServiceInventoryEntry,
  type DshServiceTier,
} from "./service-inventory.ts";

/* ------------------- P3 收尾：systemPrompt / fs / sessionProjections ------------------- */

export {
  CONTEXT_ORDERS,
  SECTION_ORDERS,
  SystemPromptCompat,
  renderContextSnapshot,
  renderPrompt,
  type AssembleContext,
  type AssembledContext,
  type AssembledSection,
  type PromptAssembly,
  type PromptContext,
  type PromptContextOrderName,
  type PromptSection,
  type PromptSectionOrderName,
  type ToolProviderResult,
} from "./system-prompt.ts";
export {
  FsShimError,
  LocalFileSystemCompat,
  isWritable,
  pathFromFileUrl,
  type FsDirEntry,
  type FsEditOutcome,
  type FsEditRequest,
  type FsErrorCode,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
  type FsWriteIntent,
  type FsWriteOutcome,
} from "./fs.ts";
export { SessionEventLog } from "./session-events.ts";
export {
  SessionProjectionsCompat,
  type ProjectionChangeListener,
  type ProjectionCheckpoint,
  type ProjectionCheckpointRow,
  type ProjectionDefinitionLike,
  type ProjectionSnapshot,
  type SchemaLike,
} from "./session-projections.ts";
export type { SessionEventBridge, SessionsCompatOptions } from "./sessions.ts";
