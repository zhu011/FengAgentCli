/**
 * @fengagent/dsh-compat — dsh 插件兼容层
 *
 * 三个装配面，按需组合：
 * - P1 `dshCompatPlugin`：`ctx.tools` 的 dsh 接口面（tools-only dsh 插件直装）；
 * - P2 `dshServicesPlugin`：`ctx.sessions` / `ctx.agents` / `ctx.agentDefaultModel`
 *   服务面（契约映射，分级与偏差见 `docs/DSH-CONTRACT-MAP.md`）；
 * - `loadDshPlugin`：按模块 id 装一个 dsh/Cordis 插件。
 */

export {
  adaptDshTool,
  isDshToolDefinition,
  type DshToolDefinition,
} from "./adapter.ts";
export { name, inject, apply, dshCompatPlugin } from "./plugin.ts";
export { importDshPlugin, loadDshPlugin, type DshPluginModule } from "./loader.ts";
export { defineTool } from "@deepseek-ai/dsh-tools";

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
