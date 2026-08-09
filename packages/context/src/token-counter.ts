/**
 * @fengagent/context — Token 估算
 *
 * 启发式估算：字符数 / 4。
 * 参考 ARCHITECTURE.md 第 5.2 节 TOKEN_ESTIMATE_RATIO。
 */

import type { Message, ContentBlock } from "@fengagent/core";
import { estimateTokens } from "@fengagent/shared/utils";

/** 估算字符串的 Token 数（chars / 4） */
export function countTokensInText(text: string): number {
  return estimateTokens(text);
}

/** 估算单个 ContentBlock 的 Token 数 */
export function countTokensInBlock(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTokens(block.text);
    case "thinking":
      return estimateTokens(block.text);
    case "tool-use":
      // 工具名 + JSON 序列化的输入 + 固定开销
      return estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input)) + 20;
    case "tool-result":
      return estimateTokens(block.content) + 10;
    case "image":
      // 图片 Token 粗估（取决于尺寸，这里用固定值）
      return 100;
    default: {
      // 确保穷尽检查
      const _exhaustive: never = block;
      void _exhaustive;
      return 0;
    }
  }
}

/** 估算单条消息的 Token 数（内容块 Token + 消息开销） */
export function countTokensInMessage(message: Message): number {
  const contentTokens = message.content.reduce(
    (sum, block) => sum + countTokensInBlock(block),
    0,
  );
  return contentTokens + 10; // 每条消息的元数据开销
}

/** 估算消息数组的总 Token 数 */
export function countTokensInMessages(messages: Message[]): number {
  return messages.reduce(
    (sum, message) => sum + countTokensInMessage(message),
    0,
  );
}
