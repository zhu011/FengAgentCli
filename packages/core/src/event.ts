/**
 * @fengagent/core — Agent 事件流类型
 *
 * AgentEvent 联合类型，定义 Agent Loop 产生的所有事件。
 * 参考 PRD 第 5.1 节。
 */

import type { Role } from "./types.ts";
import type { FinishReason } from "./types.ts";
import type { ToolResult, ToolInputCorrectionSource } from "./tool.ts";
import type { Session } from "./session.ts";

/** 可序列化的错误（Error 不可 JSON 序列化） */
export interface AgentError {
  message: string;
  code?: string;
  stack?: string;
}

/** Agent 事件联合类型 */
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
      result: ToolResult;
      /** 实际执行的入参 — 与模型原始入参不同时携带（用户改参后执行，human-in-the-loop） */
      input?: unknown;
      /** 本次执行是否经过用户改参（审批改参 / 图上改参重放） */
      userCorrectedInput?: boolean;
      /** 模型给出的原始入参 — 仅在改参时携带（改参前后可溯源） */
      originalInput?: unknown;
      /** 改参来源：hitl=审批弹窗改参；graph=图上改参重放 */
      correctionSource?: ToolInputCorrectionSource;
    }
  | { type: "message-end"; messageId: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number }
  | { type: "turn-end"; reason: FinishReason }
  | { type: "error"; error: AgentError }
  | { type: "compaction-start" }
  | { type: "compaction-end"; summary: string }
  | { type: "session-end" };

/** 将 Error 转换为可序列化的 AgentError */
export function toAgentError(error: Error): AgentError {
  return {
    message: error.message,
    code: (error as { code?: string }).code,
    stack: error.stack,
  };
}
