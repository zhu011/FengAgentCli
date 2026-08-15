/**
 * @fengagent/llm — LLM 类型定义
 *
 * LLMRequest、LLMResponse、LLMEvent、LLMError。
 * 参考 PRD 第 4.2.4 节。
 */

import type { ContentBlock, Message, FinishReason } from "@fengagent/core";
import type { ToolDefinition, ToolResult } from "@fengagent/core";

export interface LLMRequest {
  model: string;
  system: string | ContentBlock[];
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse {
  id: string;
  model: string;
  content: ContentBlock[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** KV cache 读取的 token 数（prompt 前缀命中缓存） */
    cacheReadTokens?: number;
    /** KV cache 创建的 token 数（新写入缓存的 token） */
    cacheCreationTokens?: number;
  };
  finishReason: FinishReason;
}

export interface LLMError {
  message: string;
  code?: string;
  status?: number;
}

export type LLMEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; result: ToolResult }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number }
  | { type: "finish"; reason: FinishReason }
  | { type: "error"; error: LLMError };
