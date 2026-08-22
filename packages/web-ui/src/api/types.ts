/**
 * @fengagent/web-ui — API 类型定义
 *
 * 镜像 @fengagent/core 的类型，供前端使用。
 * 这些类型与服务端 API 返回的 JSON 结构一致。
 */

// ──────────────────────────────────────────────
// 消息类型（镜像 core/types.ts）
// ──────────────────────────────────────────────

export type Role = "user" | "assistant" | "system";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface ToolUseBlock {
  type: "tool-use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool-result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  id: string;
  role: Role;
  content: ContentBlock[];
  createdAt: number;
}

// ──────────────────────────────────────────────
// 会话类型（镜像 core/session.ts）
// ──────────────────────────────────────────────

export type SessionState = "idle" | "running" | "error";

export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  status: SessionState;
  tokenCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Session extends SessionMeta {
  messages: Message[];
}

// ──────────────────────────────────────────────
// AgentEvent（镜像 core/event.ts）
// ──────────────────────────────────────────────

export interface AgentError {
  message: string;
  code?: string;
  stack?: string;
}

export type FinishReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop"
  | "error";

export type AgentEvent =
  | { type: "session-start"; session: Session }
  | { type: "message-start"; messageId: string; role: Role }
  | { type: "text-delta"; messageId: string; text: string }
  | { type: "thinking-delta"; messageId: string; text: string }
  | {
      type: "tool-call-start";
      toolUseId: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool-call-result";
      toolUseId: string;
      result: { content: string; isError?: boolean; metadata?: unknown };
    }
  | { type: "message-end"; messageId: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number }
  | { type: "turn-end"; reason: FinishReason }
  | { type: "error"; error: AgentError }
  | { type: "compaction-start" }
  | { type: "compaction-end"; summary: string }
  | { type: "session-end" };

// ──────────────────────────────────────────────
// 模型
// ──────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface ModelsResponse {
  models: ModelInfo[];
}

// ──────────────────────────────────────────────
// 权限请求
// ──────────────────────────────────────────────

export interface PermissionRequest {
  reqId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  reason?: string;
}

export type PermissionResult =
  | { decision: "allow" }
  | { decision: "deny"; reason?: string };

// ──────────────────────────────────────────────
// 对话图（镜像 @fengagent/graph，Phase 3/4 分支可视化）
// ──────────────────────────────────────────────

export type ConversationNodeType =
  | "user"
  | "assistant"
  | "tool"
  | "branch-point";

export type NodeQuality = "good" | "poor" | "unrated";

export interface ConversationNodeMeta {
  model?: string;
  toolCalls?: Array<{ id: string; name: string }>;
  tokenCount?: number;
  llmTraceId?: string;
  quality?: NodeQuality;
  qualityNote?: string;
  branch?: string;
  active?: boolean;
  rolledBack?: boolean;
}

export interface ConversationNode {
  id: string;
  conversationId: string;
  type: ConversationNodeType;
  messageId: string;
  parentId: string | null;
  childrenIds: string[];
  createdAt: number;
  meta: ConversationNodeMeta;
}

export interface GraphData {
  nodes: ConversationNode[];
  activePath: ConversationNode[];
  activeHead: ConversationNode | undefined;
  chain: ConversationNode[];
}

export interface RollbackResponse {
  ok: boolean;
  message: string;
  target?: ConversationNode;
  rollbackToNode?: ConversationNode;
  truncatedToMessageId?: string;
  graph?: GraphData;
}

// ──────────────────────────────────────────────
// 可观测性（AgentLoop 观测面板）— 镜像 server/routes/observability.ts
// ──────────────────────────────────────────────

/** 单个 trace 日志文件元信息 */
export interface TraceFileMeta {
  date: string;
  path: string;
  size: number;
  records: number;
  sessions: number;
  models: string[];
  modifiedAt: string;
}

/** 调用链：工具节点 */
export interface CallChainToolNode {
  name: string;
  input: unknown;
  result: { content: string; isError?: boolean } | null;
  durationMs?: number;
  timestamp: string;
  isError?: boolean;
}

/** 调用链：LLM 调用节点 */
export interface CallChainLlmNode {
  index: number;
  model: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  finishReason?: string;
  error?: string | null;
  responseText?: string;
  hasToolCalls: boolean;
}

/** 调用链：用户消息节点 */
export interface CallChainUserNode {
  text: string;
}

/** 调用链步骤（用户消息或 LLM 调用；工具为 LLM 子节点） */
export interface CallChainStep {
  id: string;
  kind: "user" | "llm";
  timestamp: string;
  user?: CallChainUserNode;
  llm?: CallChainLlmNode;
  tools: CallChainToolNode[];
}

/** 单个会话的完整调用链 */
export interface CallChainSession {
  sessionId: string;
  model: string;
  steps: CallChainStep[];
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  toolCallCount: number;
  errorCount: number;
}

/** 序列化分析结果（server 端 Map → 普通对象） */
export interface SerializedAnalysis {
  logFile: string;
  totalRecords: number;
  sessionCount: number;
  totalLlmCalls: number;
  totalDurationMs: number;
  avgDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  toolCallCount: number;
  toolCallRate: number;
  toolUsage: Record<string, number>;
  errorCount: number;
  errorRate: number;
  errors: string[];
  finishReasons: Record<string, number>;
  sessions: Array<{
    sessionId: string;
    model: string;
    requests: number;
    responses: number;
    totalDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    toolCallCount: number;
    toolNames: string[];
    errors: string[];
    finishReasons: string[];
  }>;
  models: string[];
  modelComparisons: Array<{
    model: string;
    totalCalls: number;
    toolCallCount: number;
    toolSuccessCount: number;
    toolFailureCount: number;
    errorCount: number;
    errorRate: number;
    finishReasons: Record<string, number>;
    avgDurationMs: number;
    avgInputTokens: number;
    avgOutputTokens: number;
    toolSuccessRate: number;
    taskCompletionRate: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    cacheHitRate: number;
  }>;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  cacheHitRate: number;
}

/** 观测数据响应 */
export interface TraceAnalysisResponse {
  date: string;
  file: string;
  analysis: SerializedAnalysis;
}

/** 调用链响应 */
export interface CallChainResponse {
  date: string;
  file: string;
  sessions: CallChainSession[];
}

// ──────────────────────────────────────────────
// 评测模块 — 镜像 server/routes/eval.ts
// ──────────────────────────────────────────────

export interface EvalReportMeta {
  date: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export interface OptimizationMeta {
  date: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export interface TestSetMeta {
  name: string;
  path: string;
  size: number;
  records: number;
  valid: boolean;
  shape: string;
}

export interface EvalOverview {
  reports: EvalReportMeta[];
  optimizations: OptimizationMeta[];
  testsets: TestSetMeta[];
}

export interface MarkdownReport {
  date: string;
  path: string;
  content: string;
}
