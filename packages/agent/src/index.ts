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
export { AgentLoop, resolveLoopGuards, sanitizeFailureLabel } from "./loop.ts";
export type {
  AgentLoopOptions,
  LoopGuardOptions,
  TaskRuntime,
  TaskStateStoreLike,
} from "./loop.ts";

// Agent 类
export { Agent } from "./agent.ts";
export type { AgentOptions, RequestPermission } from "./agent.ts";

// 会话持久化
export { SessionStore } from "./session.ts";

// 任务状态仓 + 副作用台账（任务可安全恢复）
export { TaskStore, SqliteOperationLedger } from "./task-store.ts";
export type { TaskStoreOptions } from "./task-store.ts";

// 自省卡仓（RSI P0：SQLite + 乐观锁 + reflect/* 事件流）
export { ReflectionStore } from "./reflection-store.ts";
export type {
  CreateReflectionInput,
  TransitionReflectionInput,
  ListReflectionFilter,
  ReflectionStoreOptions,
} from "./reflection-store.ts";

// 外派任务仓（7 态 + seq 单调事件流，P1/P2）
export {
  AgentTaskStore,
  replayAgentTaskStatus,
  isTerminalTaskStatus,
  TERMINAL_TASK_STATUSES,
} from "./agent-task-store.ts";
export type {
  AgentTaskStatus,
  AgentTaskEventType,
  AgentTaskRecord,
  AgentTaskEventRow,
  CreateAgentTaskInput,
  ListAgentTasksFilter,
} from "./agent-task-store.ts";

// 群聊聚合根（G1：`agent_groups` + `group_messages`）
export { AgentGroupStore } from "./agent-group-store.ts";
export type {
  AgentGroupRecord,
  AgentGroupStatus,
  GroupMember,
  GroupMessageFromKind,
  GroupMessageKind,
  GroupMessageRecord,
  GroupSpeechMode,
  CreateAgentGroupInput,
  UpdateAgentGroupInput,
  AppendGroupMessageInput,
  ListAgentGroupsFilter,
  ListGroupMessagesOptions,
} from "./agent-group-store.ts";

// ACP 客户端（把任务派给本机其他 agent 二进制）
export {
  AcpClient,
  textOfUpdate,
  AcpTimeoutError,
  AcpUnavailableError,
  AcpProtocolError,
  ACP_CLIENT_PROTOCOL_VERSION,
} from "./acp-client.ts";
export type {
  AcpClientOptions,
  AcpHandshake,
  AcpPromptResult,
  AcpSessionUpdate,
  AcpPermissionRequest,
  AcpPermissionDecision,
} from "./acp-client.ts";

// 协议无关的运行时驱动（ACP + claude stream-json 两种协议并存）
export { ClientRuntimeDriver, createRuntimeDriver } from "./runtime-driver.ts";
export type {
  RuntimeProtocol,
  RuntimeDriver,
  RuntimeHandshakeInfo,
  RuntimeSessionHandle,
  RuntimePromptOptions,
  RuntimePromptResult,
  CreateRuntimeDriverOptions,
  AcpClientLike,
} from "./runtime-driver.ts";
export { ClaudeStreamJsonClient } from "./claude-client.ts";
export type { ClaudeStreamJsonClientOptions, ClaudeClientLog } from "./claude-client.ts";

// 恢复核对（未决调用 orphan 检测）
export {
  buildTaskRecoveryReport,
  detectOrphanToolCalls,
} from "./task-recovery.ts";
export type {
  OrphanToolCall,
  TaskRecoveryReport,
  RecoveryStoreLike,
  SideEffectLookup,
} from "./task-recovery.ts";

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

// 智能体仓（P0：目录即真相 + 模板一键创建）
export { AgentRegistry, AgentRegistryError, AGENT_TEMPLATES, serializeAgentMarkdown } from "./agent-registry.ts";
export type {
  AgentRecord,
  AgentConfigFile,
  AgentRegistryOptions,
  AgentRegistryErrorCode,
  AgentTemplate,
  AgentVisibility,
  AgentPermissionMode,
  AgentKind,
  CreateAgentInput,
  UpdateAgentInput,
} from "./agent-registry.ts";

// Skill 挂载层 + 版本快照（P1：agent_skill / skill_revision）
export { SkillMountStore } from "./skill-mount-store.ts";
export type {
  AgentSkillMount,
  SkillMountSource,
  SkillMountStoreOptions,
  SkillRevision,
  UpsertSkillMountInput,
} from "./skill-mount-store.ts";

// 智能体执行上下文装配（P1：instructions + 挂载技能 → prompt）
export { buildAgentContext, renderDispatchPrompt } from "./agent-context.ts";
export type { AgentContext, BuildAgentContextInput, ResolvedSkill } from "./agent-context.ts";

// 小队与队长（P2：实体仓 / briefing / 负责人确认）
export { SquadStore, SquadStoreError } from "./squad-store.ts";
export type {
  CreateSquadInput,
  SquadDetail,
  SquadErrorCode,
  SquadMember,
  SquadMemberType,
  SquadMode,
  SquadRecord,
  SquadRunRecord,
  SquadStoreOptions,
  SquadTaskRecord,
  SquadTaskStatus,
  UpdateSquadInput,
} from "./squad-store.ts";
export {
  assignableMembers,
  buildSquadBriefing,
  composeSquadLeaderPrompt,
  composeSquadWakePrompt,
  DEFAULT_SQUAD_PROTOCOL,
} from "./briefing.ts";
export type {
  BuildSquadBriefingInput,
  SquadBriefing,
  SquadRosterEntry,
} from "./briefing.ts";
export { ApprovalStore, ApprovalStoreError } from "./approval-store.ts";
export type {
  ApprovalActor,
  ApprovalAuditAction,
  ApprovalAuditEntry,
  ApprovalGrant,
  ApprovalRequest,
  ApprovalScope,
  ApprovalStatus,
  ApprovalStoreOptions,
  CreateApprovalInput,
  ResolveApprovalInput,
} from "./approval-store.ts";

// 统一运行索引（P0：会话/派单/群聊三路只读聚合）
export { RunIndex } from "./run-index.ts";
export type {
  RunIndexOptions,
  RunKind,
  RunStatus,
  RunSummary,
  RunMessage,
  ListRunsOptions,
} from "./run-index.ts";

// 子 Agent 派遣
export { createSubagentRunner } from "./subagent-runner.ts";
export type { SubagentRunnerOptions } from "./subagent-runner.ts";

// 插件系统
export { createPluginLoader } from "./plugin-loader.ts";
export type { PluginLoader, PluginLoaderOptions } from "./plugin-loader.ts";

export { createPluginRegistry } from "./plugin-registry.ts";
export type { PluginRegistry, PluginRegistryOptions } from "./plugin-registry.ts";
