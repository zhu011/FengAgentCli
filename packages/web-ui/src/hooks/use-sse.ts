/**
 * @fengagent/web-ui — use-sse hook
 *
 * SSE 事件流消费工具。
 * 提供 consumeSSEStream 函数，将 ApiClient.sendMessage 的 AsyncGenerator
 * 转换为回调驱动的事件处理。
 *
 * 同时提供 useSseReducer，用于将 AgentEvent 流 reducer 化管理消息状态。
 */

import { useCallback, useRef } from "react";
import type { ApiClient } from "../api/client.ts";
import type { AgentEvent } from "../api/types.ts";

/** SSE 事件回调 */
export interface SseHandlers {
  onEvent: (event: AgentEvent) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

/**
 * SSE 流消费函数。
 *
 * 调用 client.sendMessage() 并迭代事件流，
 * 将每个 AgentEvent 传递给 onEvent 回调。
 *
 * 支持 AbortSignal 中断。
 */
export async function consumeSSEStream(
  client: ApiClient,
  sessionId: string,
  content: string,
  signal: AbortSignal,
  handlers: SseHandlers,
  model?: string,
): Promise<void> {
  try {
    for await (const event of client.sendMessage({ sessionId, content, signal, model })) {
      handlers.onEvent(event);
    }
    handlers.onComplete?.();
  } catch (err) {
    // AbortError 不视为错误
    if (err instanceof DOMException && err.name === "AbortError") {
      handlers.onComplete?.();
      return;
    }
    if (err instanceof Error && err.name === "AbortError") {
      handlers.onComplete?.();
      return;
    }
    handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * use-sse hook — 返回一个 consume 函数和 AbortController 引用。
 *
 * 用法：
 * ```ts
 * const { consume, abort } = useSse(client);
 * await consume(sessionId, text, { onEvent: ... });
 * ```
 */
export function useSse(client: ApiClient) {
  const abortRef = useRef<AbortController | null>(null);

  const consume = useCallback(
    async (
      sessionId: string,
      content: string,
      handlers: SseHandlers,
      model?: string,
    ): Promise<void> => {
      // 中断之前的流
      abortRef.current?.abort();

      const controller = new AbortController();
      abortRef.current = controller;

      await consumeSSEStream(
        client,
        sessionId,
        content,
        controller.signal,
        handlers,
        model,
      );

      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    },
    [client],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { consume, abort, abortRef };
}
