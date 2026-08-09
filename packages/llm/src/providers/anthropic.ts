/**
 * @fengagent/llm — Anthropic Provider
 *
 * 实现 Anthropic Messages API（通过 @anthropic-ai/sdk）。
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, LLMRequest, LLMEvent, LLMResponse } from "../client.ts";
import type {
  TextBlock,
  ContentBlock,
  Message,
  FinishReason,
} from "@fengagent/core";
import type { ToolDefinition } from "@fengagent/core";

function toAnthropicContent(
  blocks: ContentBlock[],
): Anthropic.Messages.ContentBlockParam[] {
  return blocks.map((block): Anthropic.Messages.ContentBlockParam => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "image":
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: block.source.mediaType as
              | "image/jpeg"
              | "image/png"
              | "image/gif"
              | "image/webp",
            data: block.source.data,
          },
        };
      case "tool-use":
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      case "tool-result":
        return {
          type: "tool_result",
          tool_use_id: block.toolUseId,
          content: block.content,
          is_error: block.isError,
        };
      case "thinking":
        return { type: "text", text: block.text };
    }
  });
}

function toAnthropicMessages(
  messages: Message[],
): Anthropic.Messages.MessageParam[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: toAnthropicContent(m.content),
    }));
}

function toAnthropicSystem(
  system: string | ContentBlock[],
): Anthropic.Messages.TextBlockParam[] {
  if (typeof system === "string") {
    return [{ type: "text", text: system }];
  }
  return system
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => ({ type: "text", text: b.text }));
}

function toAnthropicTools(
  tools: ToolDefinition[],
): Anthropic.Messages.Tool[] {
  return tools.map((tool) => {
    const schema = convertZodToJsonSchema(tool.inputSchema);
    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object" as const,
        properties: schema.properties ?? {},
        ...(schema.description ? { description: schema.description as string } : {}),
      },
    };
  });
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
  stopReason: string | null,
): FinishReason {
  switch (stopReason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop";
    default:
      return "end_turn";
  }
}

function mapContentToBlocks(
  content: Anthropic.Messages.ContentBlock[],
): ContentBlock[] {
  return content.map((block): ContentBlock => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "tool_use":
        return {
          type: "tool-use",
          id: block.id,
          name: block.name,
          input: block.input,
        };
      case "thinking":
        return { type: "thinking", text: block.thinking };
      case "redacted_thinking":
        return {
          type: "thinking",
          text: "[redacted]",
        };
      default:
        return { type: "text", text: JSON.stringify(block) };
    }
  });
}

export interface AnthropicClientOptions {
  apiKey: string;
  baseURL?: string;
}

export function createAnthropicClient(
  options: AnthropicClientOptions,
): LLMClient {
  const anthropic = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });

  return {
    async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
      const system = toAnthropicSystem(request.system);
      const messages = toAnthropicMessages(request.messages);
      const tools = request.tools
        ? toAnthropicTools(request.tools)
        : undefined;

      try {
        const stream = anthropic.messages.stream({
          model: request.model,
          system: system.length > 0 ? system : undefined,
          messages,
          tools,
          max_tokens: request.maxTokens ?? 8192,
          temperature: request.temperature,
        });

        let currentToolId = "";
        let currentToolName = "";

        for await (const event of stream) {
          switch (event.type) {
            case "content_block_start": {
              const block = event.content_block;
              if (block.type === "tool_use") {
                currentToolId = block.id;
                currentToolName = block.name;
                yield {
                  type: "tool-call",
                  id: block.id,
                  name: block.name,
                  input: block.input,
                };
              }
              break;
            }
            case "content_block_delta": {
              const delta = event.delta;
              if (delta.type === "text_delta") {
                yield { type: "text-delta", text: delta.text };
              } else if (delta.type === "input_json_delta") {
                if (currentToolId && delta.partial_json) {
                  let input: unknown = {};
                  try {
                    input = JSON.parse(delta.partial_json);
                  } catch {
                    input = delta.partial_json;
                  }
                  yield {
                    type: "tool-call",
                    id: currentToolId,
                    name: currentToolName,
                    input,
                  };
                }
              } else if (delta.type === "thinking_delta") {
                yield { type: "thinking-delta", text: delta.thinking };
              }
              break;
            }
            case "content_block_stop": {
              currentToolId = "";
              currentToolName = "";
              break;
            }
            case "message_start": {
              const msg = event.message;
              if (msg.usage) {
                yield {
                  type: "usage",
                  inputTokens: msg.usage.input_tokens,
                  outputTokens: msg.usage.output_tokens,
                };
              }
              break;
            }
            case "message_delta": {
              if (event.usage) {
                yield {
                  type: "usage",
                  inputTokens: 0,
                  outputTokens: event.usage.output_tokens,
                };
              }
              break;
            }
            case "message_stop": {
              break;
            }
          }
        }

        const finalMsg = await stream.finalMessage();
        if (finalMsg) {
          const reason = mapFinishReason(finalMsg.stop_reason);
          yield { type: "finish", reason };
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
      const system = toAnthropicSystem(request.system);
      const messages = toAnthropicMessages(request.messages);
      const tools = request.tools
        ? toAnthropicTools(request.tools)
        : undefined;

      const response = await anthropic.messages.create({
        model: request.model,
        system: system.length > 0 ? system : undefined,
        messages,
        tools,
        max_tokens: request.maxTokens ?? 8192,
        temperature: request.temperature,
      });

      return {
        id: response.id,
        model: response.model,
        content: mapContentToBlocks(response.content),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        finishReason: mapFinishReason(response.stop_reason),
      };
    },
  };
}
