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
  /** 该 LLM 调用对应的助手消息 ID（用户步骤无此字段；per-message 查询用） */
  messageId?: string;
}

/** 单个会话的完整调用链 */
export interface CallChainSession {
  sessionId: string;
  model: string;
  steps: CallChainStep[];
  /** 已完成（有 response 配对）的 LLM 调用次数 */
  llmCallCount: number;
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
  /** per-message 深链解析结果（?sessionId=X&messageId=Y 时返回） */
  focus?: {
    messageId: string;
    role: "user" | "assistant";
    resolvedMessageIds: string[];
    /** 旧格式日志（无 messageId）按文本匹配定位时为 true */
    legacyMatch?: boolean;
  } | null;
}

/** 按消息粒度的调用链摘要（/traces/:date/messages 与评测 per-message 视图消费） */
export interface MessageTraceSummary {
  messageId: string | null;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  llmCallCount: number;
  toolCallCount: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  error?: string | null;
}

/** 消息摘要响应（/traces/:date/messages?sessionId=X） */
export interface MessageTracesResponse {
  date: string;
  file: string;
  sessionId: string;
  messages: MessageTraceSummary[];
}

/** 单条消息评测响应（/eval/messages/:date?sessionId=X&messageId=Y） */
export interface MessageEvalResponse {
  date: string;
  sessionId: string;
  messageId: string;
  focus: {
    messageId: string;
    role: "user" | "assistant";
    resolvedMessageIds: string[];
    legacyMatch?: boolean;
  } | null;
  message: { role: "user" | "assistant"; text: string } | null;
  trace: {
    llmCallCount: number;
    toolCallCount: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    finishReasons: string[];
    errors: string[];
  } | null;
  /** 单条消息 LLM-judge 结果（KG judgeMessage 扩展点；当前为 null，接入后自动渲染） */
  judge: {
    messageId: string;
    sessionId: string;
    completionScore: number;
    correctnessScore: number;
    conclusion: string;
    note?: string;
  } | null;
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
