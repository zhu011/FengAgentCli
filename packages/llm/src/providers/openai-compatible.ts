/**
 * @fengagent/llm — OpenAI-Compatible Provider
 *
 * 通用 OpenAI 兼容 API（用于本地模型、第三方代理等）。
 */

import type { LLMClient, LLMRequest, LLMEvent, LLMResponse } from "../client.ts";
import type { ContentBlock, FinishReason } from "@fengagent/core";

export interface OpenAICompatibleOptions {
  apiKey: string;
  baseURL: string;
  /** 默认模型 ID（当请求中未指定有效模型时使用，对应 OPENAI_COMPATIBLE_MODEL 环境变量） */
  defaultModel?: string;
}

export function createOpenAICompatibleClient(
  options: OpenAICompatibleOptions,
): LLMClient {
  const { apiKey, baseURL, defaultModel } = options;
  const endpoint = baseURL.replace(/\/+$/, "");

  /** 优先使用请求中的 model，defaultModel 仅作为兜底 */
  function resolveModel(request: LLMRequest): string {
    return request.model || defaultModel || "";
  }

  return {
    async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
      const body = buildRequestBody(request, resolveModel(request));

      try {
        const response = await fetch(`${endpoint}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ ...body, stream: true }),
        });

        if (!response.ok) {
          yield {
            type: "error",
            error: {
              message: `HTTP ${response.status}: ${response.statusText}`,
              status: response.status,
            },
          };
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = "";
        let currentToolCallId = "";
        let currentToolName = "";
        let currentToolArgs = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const data = trimmed.startsWith("data: ")
                ? trimmed.slice(6)
                : trimmed.slice(5);
              if (data === "[DONE]") continue;

              try {
                const parsed = JSON.parse(data);
                const choice = parsed.choices?.[0];
                const delta = choice?.delta;

                if (delta?.content) {
                  yield { type: "text-delta", text: delta.content };
                }

                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (tc.id) {
                      if (currentToolCallId) {
                        let input: unknown = {};
                        try { input = JSON.parse(currentToolArgs); } catch { input = currentToolArgs; }
                        input = snakeToCamelKeys(input);
                        yield { type: "tool-call", id: currentToolCallId, name: currentToolName, input };
                      }
                      currentToolCallId = tc.id;
                      currentToolName = tc.function?.name ?? "";
                      currentToolArgs = "";
                    }
                    if (tc.function?.arguments) {
                      currentToolArgs += tc.function.arguments;
                    }
                  }
                }

                if (parsed.usage) {
                  // 解析 KV cache 字段
                  // DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
                  // OpenAI: prompt_tokens_details.cached_tokens
                  const cacheReadTokens =
                    parsed.usage.prompt_cache_hit_tokens ??
                    parsed.usage.prompt_tokens_details?.cached_tokens ??
                    0;
                  const cacheCreationTokens =
                    parsed.usage.prompt_cache_miss_tokens ?? 0;

                  yield {
                    type: "usage",
                    inputTokens: parsed.usage.prompt_tokens ?? 0,
                    outputTokens: parsed.usage.completion_tokens ?? 0,
                    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
                    ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
                  };
                }

                if (choice?.finish_reason) {
                  if (currentToolCallId && choice.finish_reason === "tool_calls") {
                    let input: unknown = {};
                    try { input = JSON.parse(currentToolArgs); } catch { input = currentToolArgs; }
                    input = snakeToCamelKeys(input);
                    yield { type: "tool-call", id: currentToolCallId, name: currentToolName, input };
                    currentToolCallId = "";
                    currentToolName = "";
                    currentToolArgs = "";
                  }
                  yield {
                    type: "finish",
                    reason: mapFinishReasonCompat(choice.finish_reason),
                  };
                }
              } catch {
                // skip unparseable lines
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield {
          type: "error",
          error: { message },
        };
      }
    },

    async generate(request: LLMRequest): Promise<LLMResponse> {
      const body = buildRequestBody(request, resolveModel(request));

      const response = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const json = await response.json() as Record<string, unknown>;
      const choices = json.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      const msg = choice?.message as Record<string, unknown> | undefined;
      const usage = json.usage as Record<string, number> | undefined;

      const blocks: ContentBlock[] = [];
      if (msg?.content && typeof msg.content === "string") {
        blocks.push({ type: "text", text: msg.content });
      }
      const toolCalls = msg?.tool_calls as Array<Record<string, unknown>> | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          let input: unknown = {};
          const func = tc.function as Record<string, unknown> | undefined;
          const args = func?.arguments;
          if (typeof args === "string") {
            try { input = JSON.parse(args); } catch { input = args; }
          }
          input = snakeToCamelKeys(input);
          blocks.push({
            type: "tool-use",
            id: tc.id as string,
            name: func?.name as string,
            input,
          });
        }
      }

      // 解析 KV cache 字段
      const usageExt = usage as Record<string, unknown> | undefined;
      const details = usageExt?.prompt_tokens_details as
        | Record<string, number>
        | undefined;
      const cacheReadTokens =
        (usageExt?.prompt_cache_hit_tokens as number | undefined) ??
        details?.cached_tokens ??
        0;
      const cacheCreationTokens =
        (usageExt?.prompt_cache_miss_tokens as number | undefined) ?? 0;

      return {
        id: (json.id as string) ?? crypto.randomUUID(),
        model: (json.model as string) ?? request.model,
        content: blocks,
        usage: {
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
          ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
        },
        finishReason: mapFinishReasonCompat((choice?.finish_reason as string) ?? "stop"),
      };
    },
  };
}

function mapFinishReasonCompat(reason: string): FinishReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

/**
 * 将对象的 key 从 snake_case 转换为 camelCase。
 *
 * 某些 OpenAI 兼容模型（如 DeepSeek）生成 snake_case 参数名（如 `file_path`），
 * 而工具的 Zod schema 期待 camelCase（如 `filePath`）。
 * 此函数递归转换对象的所有 key，使工具参数名匹配 schema。
 *
 * 仅转换顶层和嵌套对象的 key，不转换数组元素的 key。
 */
function snakeToCamelKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    result[camelKey] =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? snakeToCamelKeys(value)
        : value;
  }
  return result;
}

interface CompatRequestBody {
  model: string;
  messages: Array<{
    role: string;
    content: string | null | Array<Record<string, unknown>>;
    tool_calls?: Array<Record<string, unknown>>;
    tool_call_id?: string;
  }>;
  tools?: Array<{
    type: string;
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  max_tokens?: number;
  temperature?: number;
}

function buildRequestBody(
  request: LLMRequest,
  modelOverride?: string,
): CompatRequestBody {
  const messages: CompatRequestBody["messages"] = [];

  if (typeof request.system === "string" && request.system.trim()) {
    messages.push({ role: "system", content: request.system });
  } else if (Array.isArray(request.system)) {
    const text = request.system
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text.trim()) {
      messages.push({ role: "system", content: text });
    }
  }

  for (const msg of request.messages) {
    const hasImages = msg.content.some((b) => b.type === "image");
    const hasToolCalls = msg.content.some((b) => b.type === "tool-use");
    const hasToolResults = msg.content.some((b) => b.type === "tool-result");

    if (hasImages) {
      messages.push({
        role: msg.role,
        content: msg.content.map((b) => {
          if (b.type === "text") return { type: "text", text: b.text };
          if (b.type === "image") {
            return {
              type: "image_url",
              image_url: { url: `data:${b.source.mediaType};base64,${b.source.data}` },
            };
          }
          return { type: "text", text: JSON.stringify(b) };
        }),
      });
    } else if (hasToolResults) {
      for (const block of msg.content) {
        if (block.type === "tool-result") {
          messages.push({
            role: "tool",
            content: block.content,
            tool_call_id: block.toolUseId,
          });
        } else if (block.type === "text") {
          messages.push({ role: msg.role, content: block.text });
        }
      }
    } else if (hasToolCalls) {
      messages.push({
        role: "assistant",
        content: msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n") || null,
        tool_calls: msg.content
          .filter((b) => b.type === "tool-use")
          .map((b) => ({
            id: b.id,
            type: "function",
            function: {
              name: b.name,
              arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input),
            },
          })),
      });
    } else {
      messages.push({
        role: msg.role,
        content: msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n"),
      });
    }
  }

  return {
    model: modelOverride ?? request.model,
    messages,
    tools: request.tools?.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchemaCompat(t.inputSchema),
      },
    })),
    max_tokens: request.maxTokens,
    temperature: request.temperature,
  };
}

function zodToJsonSchemaCompat(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && "_def" in (schema as Record<string, unknown>)) {
    try {
      const zodToJsonSchema = (
        schema as { toJSONSchema?: () => Record<string, unknown> }
      ).toJSONSchema?.();
      if (zodToJsonSchema) return zodToJsonSchema;
    } catch {
      // fall through
    }
  }
  return { type: "object", properties: {} };
}
