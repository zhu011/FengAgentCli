/**
 * @fengagent/dsh-compat — 消息 / 内容块互转（P3）
 *
 * dsh 与 FengAgentCli 的消息模型**都是不可变值 + 内容块数组**，但块词汇不同：
 *
 * | dsh（`@deepseek-ai/dsh-llm`） | FengAgentCli（`@fengagent/core`） |
 * |---|---|
 * | `text` | `text` |
 * | `reasoning` | `thinking` |
 * | `tool-call`（`arguments` 是原始 JSON 字符串） | `tool-use`（`input` 是已解析对象） |
 * | `tool-result`（`content: ContentBlock[]`） | `tool-result`（`content: string`） |
 * | `image`（attachment 引用） | `image`（base64 inline） |
 *
 * 两条硬约束：
 * 1. **消息身份必须保留**。dsh 的 `MessageId` 是跨层稳定身份，FengAgentCli 的
 *    `messages.id` 是全局主键——重新铸 id 会让同一轮对话在两张表里变成两条。
 * 2. **不做「假装兼容」的静默丢弃**：图片块在 compat 面没有等价物，转换函数返回
 *    `undefined` 由调用方裁决（并记入偏差表），而不是塞一段假文本。
 *
 * `createUserMessage` 的口径：dsh 插件常直接用 `@deepseek-ai/dsh-llm` 的构造函数
 * 铸用户消息，再把消息交给 `ctx.llm.stream()` / `session.append()`。本模块给出
 * 反方向的桥（`toDshUserMessage`），并保证 `fromDshMessage(toDshMessage(m))`
 * 在文本/推理/工具块上往返等价（id 不变）。
 */

import type { ContentBlock, Message, ToolDefinition } from "@fengagent/core";
import type {
  DshContentBlock,
  DshMessage,
  DshToolCallBlock,
  DshToolResultBlock,
  DshToolSchema,
} from "./contracts.ts";
import { DshContractError } from "./contracts.ts";

/** 转换过程中被丢弃的块（供调用方记录/断言，不静默） */
export interface DshMessageLoss {
  readonly messageId: string;
  readonly blocks: readonly string[];
}

/** 消息 → FengAgentCli 的转换结果（附带丢块清单） */
export interface FromDshMessageResult {
  readonly message: Message | undefined;
  readonly loss: DshMessageLoss | undefined;
}

/** 解析 dsh tool-call 的原始 JSON 参数；解析失败时保留原字符串（不抛） */
export function parseToolCallArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** 把工具结果里的块数组压成 FengAgentCli 需要的纯文本 */
function blocksToText(blocks: readonly DshContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "reasoning" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "tool-result" && Array.isArray(block.content)) {
      parts.push(blocksToText(block.content as readonly DshContentBlock[]));
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}

/**
 * dsh 内容块 → FengAgentCli 内容块。
 *
 * @param block - dsh 块
 * @returns 等价块；图片块（attachment 引用）无等价物时返回 `undefined`
 */
export function fromDshContent(block: DshContentBlock): ContentBlock | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: String(block.text ?? "") };
    case "reasoning":
      return { type: "thinking", text: String(block.text ?? "") };
    case "tool-call": {
      const call = block as DshToolCallBlock;
      return {
        type: "tool-use",
        id: call.id,
        name: call.name,
        input: parseToolCallArguments(call.arguments),
      };
    }
    case "tool-result": {
      const result = block as DshToolResultBlock;
      return {
        type: "tool-result",
        toolUseId: result.toolCallId,
        content: blocksToText(result.content),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      };
    }
    default:
      // 图片（attachment 引用）、插件扩展块：compat 面没有等价物
      return undefined;
  }
}

/**
 * FengAgentCli 内容块 → dsh 内容块。
 *
 * @param block - feng 块
 * @returns 等价块；base64 图片没有 dsh attachment 身份时返回 `undefined`
 */
export function toDshContent(block: ContentBlock): DshContentBlock | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "reasoning", text: block.text };
    case "tool-use":
      return {
        type: "tool-call",
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: block.toolUseId,
        content: [{ type: "text", text: block.content }],
        ...(block.isError === undefined ? {} : { isError: block.isError }),
      };
    default:
      // image（base64 inline）在 dsh 需要 attachment 服务铸引用——P4 再接
      return undefined;
  }
}

/**
 * dsh 消息 → FengAgentCli 消息（**保留 id**；dsh 消息没有时间戳，`createdAt` 取转换时刻）。
 *
 * @param message - dsh 消息
 * @returns 转换结果 + 被丢弃的块类型（图片/扩展块）
 */
export function fromDshMessage(message: DshMessage): FromDshMessageResult {
  if (typeof message?.id !== "string" || message.id.length === 0) {
    throw new DshContractError("message.fromDsh", "message.id must be a non-empty string");
  }
  const content: ContentBlock[] = [];
  const lost: string[] = [];
  for (const block of message.content ?? []) {
    const converted = fromDshContent(block);
    if (converted === undefined) lost.push(block.type);
    else content.push(converted);
  }
  const converted: Message = {
    id: message.id,
    role: message.role,
    content,
    createdAt: Date.now(),
  };
  return {
    message: converted,
    loss: lost.length === 0 ? undefined : { messageId: message.id, blocks: lost },
  };
}

/** dsh 消息 → FengAgentCli 消息；有丢块时抛错（严格模式，默认） */
export function requireFengMessage(message: DshMessage): Message {
  const { message: converted, loss } = fromDshMessage(message);
  if (loss) {
    throw new DshContractError(
      "message.fromDsh",
      `message "${loss.messageId}" contains blocks with no FengAgentCli equivalent: ${loss.blocks.join(", ")}`,
    );
  }
  if (!converted) {
    throw new DshContractError("message.fromDsh", `message "${message.id}" produced no content`);
  }
  return converted;
}

/**
 * FengAgentCli 消息 → dsh 消息。
 *
 * @param message - feng 消息
 * @param options - assistant 消息的 provider/model 溯源（dsh 助手消息的 `source` 必填身份）
 * @returns dsh 消息（丢块时抛错，避免下游把空消息当成功）
 */
export function toDshMessage(
  message: Message,
  options: { provider?: string; model?: string } = {},
): DshMessage {
  const content: DshContentBlock[] = [];
  const lost: string[] = [];
  for (const block of message.content) {
    const converted = toDshContent(block);
    if (converted === undefined) lost.push(block.type);
    else content.push(converted);
  }
  if (lost.length > 0) {
    throw new DshContractError(
      "message.toDsh",
      `message "${message.id}" contains blocks with no dsh equivalent: ${lost.join(", ")}`,
    );
  }
  const source =
    message.role === "assistant"
      ? { kind: "model", provider: options.provider ?? "fengagent", model: options.model ?? "unknown" }
      : message.role === "system"
        ? { kind: "plugin", plugin: "@fengagent/dsh-compat" }
        : { kind: "user" };
  return { id: message.id, role: message.role, content, source };
}

/**
 * 造一条 dsh 用户消息（对齐 `createUserMessage({ content, source })` 的语义）。
 *
 * @param content - 文本，或已构造好的 dsh 内容块数组
 * @param options - 可指定 id（缺省铸新 id）与 source
 * @returns 冻结前的 dsh 用户消息
 */
export function toDshUserMessage(
  content: string | readonly DshContentBlock[],
  options: { id?: string; source?: Record<string, unknown> } = {},
): DshMessage {
  const blocks: DshContentBlock[] =
    typeof content === "string" ? [{ type: "text", text: content }] : [...content];
  if (blocks.length === 0) {
    throw new DshContractError("message.toDsh", "a user message needs at least one content block");
  }
  return {
    id: options.id ?? crypto.randomUUID(),
    role: "user",
    content: blocks,
    source: options.source ?? { kind: "user" },
  };
}

/** 取消息里的可见文本（忽略推理/工具块），用于标题、日志与断言 */
export function dshMessageText(message: DshMessage): string {
  return message.content
    .filter((block): block is DshContentBlock & { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * dsh 工具 schema → FengAgentCli 工具定义。
 *
 * dsh 的工具 schema 是 JSON Schema，FengAgentCli 的 `ToolDefinition` 要求 zod schema；
 * 两者不是无损可转的。调用方（宿主）必须提供转换器——没提供就抛错，避免把
 * 「模型看不到工具」伪装成成功。
 *
 * @param schema - dsh 工具 schema
 * @param convert - JSON Schema → zod/ToolDefinition 的转换器（宿主注入）
 * @returns FengAgentCli 工具定义
 */
export function toFengToolDefinition(
  schema: DshToolSchema,
  convert: (schema: DshToolSchema) => ToolDefinition,
): ToolDefinition {
  if (typeof convert !== "function") {
    throw new DshContractError(
      "message.toDsh",
      "tools need a JSON-Schema → ToolDefinition converter; pass LlmCompatOptions.toolSchemaConverter",
    );
  }
  return convert(schema);
}
