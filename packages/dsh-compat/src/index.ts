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
