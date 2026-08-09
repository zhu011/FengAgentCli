/**
 * @fengagent/server — SSE 流式推送
 *
 * 将 AgentEvent 流转换为 SSE 事件格式。
 * 每个 AgentEvent → SSE event 帧（event 类型 + data JSON）。
 *
 * 参考 ARCHITECTURE.md 第 6.2 节（WebUI 模式流式输出方案）。
 */

import type { AgentEvent } from "@fengagent/core";

/** SSE 单帧数据 */
export interface SSEFrame {
  event: string;
  data: string;
}

/**
 * 将 AgentEvent 转换为 SSE 帧。
 *
 * SSE 帧格式：
 * ```
 * event: text-delta
 * data: {"type":"text-delta","messageId":"...","text":"..."}
 *
 * ```
 *
 * @param event - Agent 事件
 * @returns SSE 帧（event 类型 + JSON 序列化的 data）
 */
export function agentEventToSSE(event: AgentEvent): SSEFrame {
  return {
    event: event.type,
    data: JSON.stringify(event),
  };
}

/**
 * 将 SSE 帧编码为 SSE 文本格式字符串。
 *
 * 格式：
 * ```
 * event: <event>\n
 * data: <data>\n
 * \n
 * ```
 */
export function encodeSSEFrame(frame: SSEFrame): string {
  return `event: ${frame.event}\ndata: ${frame.data}\n\n`;
}

/** SSE 心跳帧（注释行，用于保持连接活跃） */
export const SSE_HEARTBEAT = `: heartbeat\n\n`;

/**
 * 将 AgentEvent 流编码为 SSE 文本流。
 *
 * 用于直接写入 HTTP 响应体（非 Hono streamSSE 模式）。
 *
 * @param events - AgentEvent 异步生成器
 * @returns 字符串异步生成器
 */
export async function* encodeAgentEventStream(
  events: AsyncGenerator<AgentEvent>,
): AsyncGenerator<string> {
  for await (const event of events) {
    const frame = agentEventToSSE(event);
    yield encodeSSEFrame(frame);
  }
}
