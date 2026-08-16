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

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

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
