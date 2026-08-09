/**
 * @fengagent/core — 核心领域层
 *
 * 定义所有核心数据类型和接口契约。
 * 零运行时依赖（仅 Zod 用于类型校验）。
 * 所有类型 JSON 可序列化。
 */

// 基础类型
export type {
  Role,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  ImageBlock,
  Message,
  FinishReason,
} from "./types.ts";
export {
  createUserMessage,
  createAssistantMessage,
  createSystemMessage,
} from "./types.ts";

// 工具类型
export type {
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolCall,
} from "./tool.ts";

// Agent 类型
export type { AgentConfig, AgentInfo, SubagentParams, SubagentResult, SubagentRunner } from "./agent.ts";

// 会话类型
export type {
  Session,
  SessionState,
  SessionMeta,
} from "./session.ts";
export {
  createSession,
  toSessionMeta,
} from "./session.ts";

// 事件类型
export type { AgentEvent, AgentError } from "./event.ts";
export { toAgentError } from "./event.ts";

// 配置
export {
  ConfigSchema,
  ConfigLayerPriority,
  loadConfig,
  loadConfigFromEnv,
} from "./config.ts";
export type { Config, PartialConfig, ConfigLayer } from "./config.ts";

export type {
  SquadMemberStatus,
  SquadTaskStatus,
  SquadTaskPriority,
  SquadMember,
  SquadTask,
  SquadTaskAttempt,
  SquadConfig,
  SquadEvent,
  SquadStatus,
} from "./squad.ts";
export {
  DEFAULT_SQUAD_CONFIG,
  PRIORITY_WEIGHT,
  createSquadMember,
  createSquadTask,
} from "./squad.ts";

// 权限类型
export type {
  Permission,
  PermissionResult,
  PermissionDecision,
  PermissionFilter,
} from "./permission.ts";
export { ALLOW, deny, ask } from "./permission.ts";

// 插件接口
export type {
  FengPlugin,
  PluginContext,
  PluginRegistrations,
  PluginLoadResult,
} from "./plugin.ts";
