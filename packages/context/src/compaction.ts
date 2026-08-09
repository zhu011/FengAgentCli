/**
 * @fengagent/context — 压缩引擎
 *
 * 对话历史压缩：摘要 head 段 + 保留 recent 段。
 * 参考 ARCHITECTURE.md 第 6.6 节和第 3.3 节（上下文压缩数据流）。
 */

import type { Message, ContentBlock } from "@fengagent/core";
import { countTokensInMessage } from "./token-counter.ts";

/** 压缩选项 */
export interface CompactionOptions {
  /** 保留的近期 Token 数 */
  keepTokens: number;
  /** 小模型 ID（用于生成摘要） */
  smallModel?: string;
  /** 摘要最大 Token 数 */
  maxTokens?: number;
}

/** 压缩结果 */
export interface CompactionResult {
  /** head 段的摘要文本（空字符串表示无需压缩） */
  summary: string;
  /** 保留的近期消息 */
  recent: Message[];
}

/**
 * 摘要生成器接口 — 结构上兼容 LLMClient。
 *
 * 任何具有 `generate(request) => Promise<{ content: ContentBlock[] }>` 的对象
 * （包括 @fengagent/llm 的 LLMClient）都满足此接口。
 * 这让 context 包无需依赖 llm 包。
 */
export interface SummaryGenerator {
  generate(request: {
    model: string;
    system: string;
    messages: Message[];
    maxTokens?: number;
  }): Promise<{ content: ContentBlock[] }>;
}

/** 摘要提示模板 */
const SUMMARY_TEMPLATE = `请总结以下对话历史，保留关键信息：

## 目标
{用户的主要目标和意图}

## 已完成的工作
{列出已完成的操作和结果}

## 当前状态
{当前进展和阻塞项}

## 下一步
{接下来需要做什么}

## 相关文件
{涉及的关键文件路径}

---

以下是需要总结的对话历史：
{conversation_history}
`;

/**
 * 从消息数组末尾向前累计 Token，找到保留 recent 段的分割点。
 *
 * @param messages - 完整消息数组
 * @param keepTokens - 需要保留的近期 Token 数
 * @returns 分割点索引（0 ~ messages.length），recent = messages[cutPoint..end]
 */
export function findCutPoint(
  messages: Message[],
  keepTokens: number,
): number {
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    tokens += countTokensInMessage(messages[i]!);
    if (tokens >= keepTokens) {
      return i + 1;
    }
  }
  return 0;
}

/** 将消息数组转换为可读文本（用于摘要提示） */
function messagesToText(messages: Message[]): string {
  return messages
    .map((m) => {
      const contentText = m.content
        .map((c) => {
          if (c.type === "text") return c.text;
          if (c.type === "tool-use")
            return `[tool: ${c.name}(${JSON.stringify(c.input)})]`;
          if (c.type === "tool-result") return `[result: ${c.content}]`;
          if (c.type === "thinking") return `[thinking: ${c.text}]`;
          return "";
        })
        .join(" ");
      return `${m.role}: ${contentText}`;
    })
    .join("\n");
}

/**
 * 压缩对话历史。
 *
 * 流程：
 * 1. 找到分割点（head + recent）
 * 2. 将 head 段转为文本
 * 3. 调用 LLM 生成结构化摘要
 * 4. 返回摘要 + recent 段
 *
 * @param messages - 完整消息历史
 * @param options - 压缩选项
 * @param summaryGenerator - 摘要生成器（LLMClient 即可）
 * @returns 摘要文本 + 保留的近期消息
 */
export async function compact(
  messages: Message[],
  options: CompactionOptions,
  summaryGenerator: SummaryGenerator,
): Promise<CompactionResult> {
  // 1. 找到分割点
  const cutPoint = findCutPoint(messages, options.keepTokens);

  // 没有需要压缩的内容
  if (cutPoint === 0) {
    return { summary: "", recent: messages };
  }

  // 2. 分割
  const head = messages.slice(0, cutPoint);
  const recent = messages.slice(cutPoint);

  // 3. 生成摘要
  const historyText = messagesToText(head);
  const summaryPrompt = SUMMARY_TEMPLATE.replace(
    "{conversation_history}",
    historyText,
  );

  const response = await summaryGenerator.generate({
    model: options.smallModel ?? "claude-haiku-3",
    system: "你是一个对话摘要助手。请简洁准确地总结对话历史。",
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: [{ type: "text" as const, text: summaryPrompt }],
        createdAt: Date.now(),
      },
    ],
    maxTokens: options.maxTokens ?? 2000,
  });

  const summary = response.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");

  // 5. 返回摘要 + 近期消息
  return { summary, recent };
}
