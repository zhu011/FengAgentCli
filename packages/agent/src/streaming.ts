/**
 * @fengagent/agent — 流式处理
 *
 * 将 LLMEvent 转换为 AgentEvent。
 * LLM 的底层流式事件被映射为 Agent 层面的高层事件。
 * 参考 ARCHITECTURE.md 第 3.2 节（流式事件序列）。
 */

import type { LLMEvent } from "@fengagent/llm";
import type { AgentEvent, AgentError } from "@fengagent/core";
import { toAgentError } from "@fengagent/core";

/**
 * 将单个 LLMEvent 转换为 0 或多个 AgentEvent。
 *
 * - text-delta → text-delta（附带 messageId）
 * - thinking-delta → 当前版本不转发（AgentEvent 未定义 thinking-delta）
 * - tool-call → tool-call-start
 * - usage → usage
 * - finish → 不转发（由 loop 发出 turn-end）
 * - error → error
 * - tool-result → 不转发（LLM 不应发送 tool-result）
 *
 * @param event - LLM 流式事件
 * @param messageId - 当前助手消息 ID
 * @returns AgentEvent 数组（可能为空）
 */
export function llmEventToAgentEvents(
  event: LLMEvent,
  messageId: string,
): AgentEvent[] {
  switch (event.type) {
    case "text-delta":
      return [{ type: "text-delta", messageId, text: event.text }];

    case "thinking-delta":
      // AgentEvent 当前未定义 thinking-delta 事件
      return [];

    case "tool-call":
      return [
        {
          type: "tool-call-start",
          toolUseId: event.id,
          name: event.name,
          input: event.input,
        },
      ];

    case "usage":
      return [
        {
          type: "usage",
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        },
      ];

    case "finish":
      // finish 由 loop 转为 turn-end，不在此转发
      return [];

    case "error":
      return [
        {
          type: "error",
          error: {
            message: event.error.message,
            code: event.error.code,
          } satisfies AgentError,
        },
      ];

    case "tool-result":
      // LLM 不应发送 tool-result 事件
      return [];

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return [];
    }
  }
}

/** 将 Error 转换为 error AgentEvent */
export function errorToAgentEvent(error: Error): AgentEvent {
  return { type: "error", error: toAgentError(error) };
}
