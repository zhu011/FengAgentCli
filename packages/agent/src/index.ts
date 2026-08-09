/**
 * @fengagent/agent — Agent 运行时
 *
 * 实现 Agent Loop 核心循环、会话状态管理、流式处理、多 Agent 小队协调。
 *
 * 模块：
 * - AgentLoop：Agent 核心循环（组装上下文 → LLM → 工具 → 循环）
 * - Agent：Agent 类（状态管理、事件发射、会话生命周期）
 * - SessionStore：会话持久化（SQLite）
 * - streaming：LLMEvent → AgentEvent 转换
 * - SquadCoordinator：多 Agent 小队协调器
 * - AgentDefinitionLoader：Agent 定义加载（从 .md 文件）
 * - SubagentRunner：子 Agent 派遣实现
 */

// Agent Loop
export { AgentLoop } from "./loop.ts";
export type { AgentLoopOptions } from "./loop.ts";

// Agent 类
export { Agent } from "./agent.ts";
export type { AgentOptions, RequestPermission } from "./agent.ts";

// 会话持久化
export { SessionStore } from "./session.ts";

// 流式处理
export { llmEventToAgentEvents, errorToAgentEvent } from "./streaming.ts";

// 小队协调器
export { SquadCoordinator } from "./squad.ts";
export type {
  ReassignmentResult,
  SquadCoordinatorOptions,
} from "./squad.ts";

// Agent 定义系统
export {
  createAgentDefinitionLoader,
  parseAgentMarkdown,
  BUILTIN_AGENTS,
} from "./agent-definition.ts";
export type {
  AgentDefinitionLoader,
  AgentDefinitionLoaderOptions,
} from "./agent-definition.ts";

// 子 Agent 派遣
export { createSubagentRunner } from "./subagent-runner.ts";
export type { SubagentRunnerOptions } from "./subagent-runner.ts";

// 插件系统
export { createPluginLoader } from "./plugin-loader.ts";
export type { PluginLoader, PluginLoaderOptions } from "./plugin-loader.ts";

export { createPluginRegistry } from "./plugin-registry.ts";
export type { PluginRegistry, PluginRegistryOptions } from "./plugin-registry.ts";
