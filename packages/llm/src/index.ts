/**
 * @fengagent/llm — LLM 抽象层
 *
 * Provider 无关的 LLM 调用抽象，支持流式输出。
 * 参考 PRD 第 4.2.4 节。
 */

export type { LLMClient } from "./client.ts";
export type {
  LLMRequest,
  LLMResponse,
  LLMEvent,
  LLMError,
} from "./types.ts";

export type { Protocol, Auth, AuthApiKey, AuthBearer, AuthOAuth, Route } from "./route.ts";
export { routeKey } from "./route.ts";

export {
  createAnthropicClient,
  createOpenAIClient,
  createOpenAICompatibleClient,
  createBedrockClient,
  createGoogleClient,
  createClient,
} from "./providers/index.ts";

export type {
  AnthropicClientOptions,
  OpenAIClientOptions,
  OpenAICompatibleOptions,
  BedrockClientOptions,
  GoogleClientOptions,
  ClientCreateOptions,
} from "./providers/index.ts";

export {
  createClientFromEnv,
} from "./env.ts";
export type {
  LLMEnvDefaults,
  ClientFromEnvResult,
} from "./env.ts";

// 可热替换的 LLM Client（/provider 运行时切换用）
export { ReloadableLLMClient } from "./reloadable.ts";

// LLM 追踪日志
export { createLlmTracer } from "./trace.ts";
export type { LlmTraceRecord, LlmTracer } from "./trace.ts";

import { createLlmTracer as _createLlmTracer } from "./trace.ts";
import type { LLMClient } from "./client.ts";
import type { LLMEvent } from "./types.ts";

/**
 * 包装 LLMClient，在每次调用前后自动记录 LLM trace 日志。
 *
 * 用法：
 * ```ts
 * const { client } = createClientFromEnv();
 * const tracedClient = wrapWithTracer(client, sessionId);
 * // tracedClient.stream(request) 会自动记录请求和回复到 llm-trace-{date}.jsonl
 * ```
 */
export function wrapWithTracer(client: LLMClient, sessionId: string): LLMClient {
  const tracer = _createLlmTracer();

  return {
    async *stream(request) {
      tracer.logRequest(sessionId, request);
      const startTime = Date.now();
      const events: LLMEvent[] = [];

      try {
        for await (const event of client.stream(request)) {
          events.push(event);
          yield event;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        events.push({ type: "error", error: { message: errorMsg } });
        throw err;
      } finally {
        tracer.logResponse(sessionId, request.model, events, Date.now() - startTime);
      }
    },

    async generate(request) {
      tracer.logRequest(sessionId, request);
      const startTime = Date.now();
      const events: LLMEvent[] = [];

      try {
        const response = await client.generate(request);
        events.push({ type: "usage", inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens });
        events.push({ type: "finish", reason: response.finishReason });
        for (const block of response.content) {
          if (block.type === "text") {
            events.push({ type: "text-delta", text: block.text });
          } else if (block.type === "tool-use") {
            events.push({ type: "tool-call", id: block.id, name: block.name, input: block.input });
          }
        }
        tracer.logResponse(sessionId, request.model, events, Date.now() - startTime);
        return response;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        tracer.logResponse(sessionId, request.model, [{ type: "error", error: { message: errorMsg } }], Date.now() - startTime);
        throw err;
      }
    },
  };
}
