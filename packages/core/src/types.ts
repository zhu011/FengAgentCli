/**
 * @fengagent/core — 基础类型定义
 *
 * Message、Role、ContentBlock 等核心消息类型。
 * 所有类型 JSON 可序列化。
 */

/** 消息角色 */
export type Role = "user" | "assistant" | "system";

/** 文本内容块 */
export interface TextBlock {
  type: "text";
  text: string;
}

/** 工具调用内容块（LLM 请求调用工具） */
export interface ToolUseBlock {
  type: "tool-use";
  id: string;
  name: string;
  input: unknown;
}

/** 工具结果内容块（工具执行返回的结果） */
export interface ToolResultBlock {
  type: "tool-result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** 思考过程内容块（扩展思考 / chain-of-thought） */
export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

/** 图片内容块 */
export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    mediaType: string;
    data: string;
  };
}

/** 内容块联合类型 */
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ImageBlock;

/** 消息 */
export interface Message {
  id: string;
  role: Role;
  content: ContentBlock[];
  createdAt: number;
}

/** LLM 调用结束原因 */
export type FinishReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop"
  | "error";

/** 创建用户文本消息的快捷工厂 */
export function createUserMessage(text: string): Message {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    createdAt: Date.now(),
  };
}

/** 创建助手文本消息的快捷工厂 */
export function createAssistantMessage(text: string): Message {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: [{ type: "text", text }],
    createdAt: Date.now(),
  };
}

/** 创建系统消息的快捷工厂 */
export function createSystemMessage(text: string): Message {
  return {
    id: crypto.randomUUID(),
    role: "system",
    content: [{ type: "text", text }],
    createdAt: Date.now(),
  };
}
