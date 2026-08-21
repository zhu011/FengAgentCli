/**
 * @fengagent/llm — OpenAI Provider
 *
 * 实现 OpenAI Chat Completions API（通过 openai SDK）。
 */

import OpenAI from "openai";
import type { LLMClient, LLMRequest, LLMEvent, LLMResponse } from "../client.ts";
import type {
  ContentBlock,
  Message,
  FinishReason,
} from "@fengagent/core";
import type { ToolDefinition } from "@fengagent/core";

function toOpenAIMessages(
  system: string | ContentBlock[],
  messages: Message[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  if (typeof system === "string" && system.trim()) {
    result.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    const text = system
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text.trim()) {
      result.push({ role: "system", content: text });
    }
  }

  for (const msg of messages) {
    const hasToolUse = msg.content.some((b) => b.type === "tool-use");
    const hasToolResult = msg.content.some((b) => b.type === "tool-result");
    const hasImages = msg.content.some((b) => b.type === "image");

    if (hasToolResult) {
      for (const block of msg.content) {
        if (block.type === "tool-result") {
          result.push({
            role: "tool",
            content: block.content,
            tool_call_id: block.toolUseId,
          });
        } else if (block.type === "text" && msg.role === "assistant") {
          result.push({ role: "assistant", content: block.text });
        }
      }
    } else if (hasToolUse) {
      const toolCalls = msg.content
        .filter((b) => b.type === "tool-use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input),
          },
        }));
      const textContent = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n") || null;
      result.push({
        role: "assistant",
        content: textContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam);
    } else if (hasImages) {
      result.push({
        role: "user",
        content: msg.content.map((b) => {
          if (b.type === "text") return { type: "text", text: b.text };
          if (b.type === "image") {
            return {
              type: "image_url",
              image_url: {
                url: `data:${b.source.mediaType};base64,${b.source.data}`,
              },
            };
          }
          return { type: "text", text: JSON.stringify(b) };
        }) as OpenAI.Chat.Completions.ChatCompletionContentPart[],
      });
    } else {
      const textContent = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      result.push({
        role: msg.role as "user" | "assistant" | "system",
        content: textContent,
      });
    }
  }

  return result;
}

function toOpenAITools(
  tools: ToolDefinition[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: convertZodToJsonSchema(tool.inputSchema) as Record<string, unknown>,
    },
  }));
}

function convertZodToJsonSchema(schema: unknown): Record<string, unknown> {
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

function mapFinishReason(
  finish: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"],
): FinishReason {
  switch (finish) {
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

function mapContentToBlocks(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const msg = choice.message;

  // DeepSeek reasoner 非流式响应的思考内容（不在官方 SDK 类型中）
  const reasoning = (msg as { reasoning_content?: string }).reasoning_content;
  if (reasoning) {
    blocks.push({ type: "thinking", text: reasoning });
  }

  if (msg.content) {
    blocks.push({ type: "text", text: msg.content });
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = tc.function.arguments;
      }
      blocks.push({
        type: "tool-use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  return blocks;
}

export interface OpenAIClientOptions {
  apiKey: string;
  baseURL?: string;
}

export function createOpenAIClient(options: OpenAIClientOptions): LLMClient {
  const openai = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });

  return {
    async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
      const messages = toOpenAIMessages(request.system, request.messages);
      const tools = request.tools
        ? toOpenAITools(request.tools)
        : undefined;

      try {
        const stream = await openai.chat.completions.create({
          model: request.model,
          messages,
          tools,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          stream: true,
          stream_options: { include_usage: true },
        });

        let currentToolCallId = "";
        let currentToolName = "";
        let currentToolArgs = "";

        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;

          // DeepSeek reasoner 等模型的思考内容（reasoning_content，不在官方 SDK 类型中）
          const reasoning = (delta as { reasoning_content?: string } | undefined)
            ?.reasoning_content;
          if (reasoning) {
            yield { type: "thinking-delta", text: reasoning };
          }

          if (delta?.content) {
            yield { type: "text-delta", text: delta.content };
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.id) {
                if (currentToolCallId) {
                  let input: unknown = {};
                  try {
                    input = JSON.parse(currentToolArgs);
                  } catch {
                    input = currentToolArgs;
                  }
                  yield {
                    type: "tool-call",
                    id: currentToolCallId,
                    name: currentToolName,
                    input,
                  };
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

          if (choice?.finish_reason) {
            if (currentToolCallId && choice.finish_reason === "tool_calls") {
              let input: unknown = {};
              try {
                input = JSON.parse(currentToolArgs);
              } catch {
                input = currentToolArgs;
              }
              yield {
                type: "tool-call",
                id: currentToolCallId,
                name: currentToolName,
                input,
              };
              currentToolCallId = "";
              currentToolName = "";
              currentToolArgs = "";
            }
            yield {
              type: "finish",
              reason: mapFinishReason(choice.finish_reason),
            };
          }

          if (chunk.usage) {
            yield {
              type: "usage",
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            };
          }
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
      const messages = toOpenAIMessages(request.system, request.messages);
      const tools = request.tools
        ? toOpenAITools(request.tools)
        : undefined;

      const response = await openai.chat.completions.create({
        model: request.model,
        messages,
        tools,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
      });

      const choice = response.choices[0];
      if (!choice) {
        throw new Error("No response from OpenAI");
      }

      return {
        id: response.id,
        model: response.model,
        content: mapContentToBlocks(choice),
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
        finishReason: mapFinishReason(choice.finish_reason),
      };
    },
  };
}
