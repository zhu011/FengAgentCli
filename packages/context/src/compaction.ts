/**
 * @fengagent/context — 压缩引擎
 *
 * 对话历史压缩：工具结果裁剪 + 摘要 head 段 + 保留 recent 段。
 *
 * 优化要点（参考 pi/hermes-agent/Hummingbird）：
 * 1. 工具结果裁剪：超过阈值的旧工具结果替换为占位符（不需要 LLM 调用）
 * 2. 分割点优化：不在 tool-result 消息边界切割（防止孤儿 tool-call）
 * 3. 结构化摘要模板：目标 / 约束 / 进展 / 关键决策 / 下一步 / 关键上下文 / 相关文件
 * 4. 迭代摘要更新：有前一次摘要时传入更新，而非从头生成
 * 5. 文件操作追踪：从消息中提取已读/已改文件，附加到摘要
 *
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
  /** 工具结果裁剪阈值（字符数，超过则替换为占位符，默认 2000） */
  toolResultPruneThreshold?: number;
  /** 前一次摘要（用于迭代更新，可选） */
  previousSummary?: string;
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
 */
export interface SummaryGenerator {
  generate(request: {
    model: string;
    system: string;
    messages: Message[];
    maxTokens?: number;
  }): Promise<{ content: ContentBlock[] }>;
}

/** 摘要提示模板（首次压缩） */
const SUMMARY_TEMPLATE = `请总结以下对话历史，保留关键信息用于后续对话的上下文恢复。

## 目标
{用户的主要目标和意图}

## 约束
{技术约束、需求限制}

## 进展
### 已完成
{列出已完成的操作和结果}
### 进行中
{当前正在做的工作}
### 阻塞项
{遇到的问题和阻塞}

## 关键决策
{做出的重要技术决策和原因}

## 下一步
{接下来需要做什么}

## 关键上下文
{不能丢失的关键信息：错误信息、重要参数、文件路径等}

## 相关文件
{涉及的关键文件路径列表}

---
以下是需要总结的对话历史：
{conversation_history}
`;

/** 迭代更新摘要模板（有前一次摘要时使用） */
const UPDATE_TEMPLATE = `你之前生成过一份对话摘要。现在有新的对话内容，请更新摘要，整合新信息。

## 前一次摘要
{previous_summary}

## 新增对话内容
{new_conversation}

---

请基于前一次摘要和新增内容，输出更新后的完整摘要。保持相同结构：目标 / 约束 / 进展 / 关键决策 / 下一步 / 关键上下文 / 相关文件。`;

/**
 * 从消息数组末尾向前累计 Token，找到保留 recent 段的分割点。
 *
 * 优化：不在 tool-result 消息边界切割（防止产生孤儿 tool-call）。
 * 如果分割点落在 tool-result 消息上，向前移动到 tool-use 或 user 消息边界。
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
  let found = false;
  let cutPoint = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    tokens += countTokensInMessage(messages[i]!);
    if (tokens >= keepTokens) {
      cutPoint = i + 1;
      found = true;
      break;
    }
  }

  // 未找到分割点（keepTokens > 总 tokens）— 无需压缩
  if (!found) {
    return 0;
  }

  // 优化：确保不在 tool-result 消息边界切割
  if (cutPoint > 0 && cutPoint < messages.length) {
    while (cutPoint < messages.length) {
      const msg = messages[cutPoint];
      if (!msg) break;
      const hasToolResult = msg.content.some((b) => b.type === "tool-result");
      if (hasToolResult && cutPoint > 0) {
        cutPoint--;
      } else {
        break;
      }
    }
  }

  return cutPoint;
}

/**
 * 裁剪旧消息中的大工具结果。
 *
 * 将超过阈值的 tool-result content 替换为占位符，
 * 减少 head 段的 token 数（不需要 LLM 调用）。
 *
 * 参考 Hummingbird 的 Tool Result Budget 和 hermes-agent 的 Phase 1。
 */
function pruneToolResults(
  messages: Message[],
  threshold: number,
): Message[] {
  return messages.map((msg) => {
    const hasLargeToolResult = msg.content.some(
      (b) => b.type === "tool-result" && b.content.length > threshold,
    );
    if (!hasLargeToolResult) return msg;

    return {
      ...msg,
      content: msg.content.map((b) => {
        if (b.type === "tool-result" && b.content.length > threshold) {
          return {
            ...b,
            content: `[已裁剪: 原始结果 ${b.content.length} 字符，保留前 ${Math.min(200, b.content.length)} 字符]\n${b.content.slice(0, 200)}`,
          };
        }
        return b;
      }),
    };
  });
}

/**
 * 从消息历史中提取文件操作（读取/修改的文件路径）。
 *
 * 参考 pi 的 extractFileOperations。
 */
function extractFileOperations(messages: Message[]): { read: string[]; modified: string[] } {
  const read = new Set<string>();
  const modified = new Set<string>();

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== "tool-use") continue;
      const input = block.input as Record<string, unknown>;

      if (block.name === "file-read" && typeof input.path === "string") {
        read.add(input.path);
      } else if (block.name === "file-write" && typeof input.path === "string") {
        modified.add(input.path);
      } else if (block.name === "file-edit" && typeof input.path === "string") {
        modified.add(input.path);
      } else if (block.name === "bash" && typeof input.command === "string") {
        // 从 bash 命令中提取文件路径（简单启发式）
        const cmd = input.command as string;
        const fileMatch = cmd.match(/(?:cat|head|tail|less|more)\s+(\S+)/);
        if (fileMatch?.[1]) read.add(fileMatch[1]);
      }
    }
  }

  return { read: Array.from(read), modified: Array.from(modified) };
}

/** 将消息数组转换为可读文本（用于摘要提示） */
function messagesToText(messages: Message[]): string {
  return messages
    .map((m) => {
      const contentText = m.content
        .map((c) => {
          if (c.type === "text") return c.text;
          if (c.type === "tool-use")
            return `[tool: ${c.name}(${JSON.stringify(c.input).slice(0, 200)})]`;
          if (c.type === "tool-result")
            return `[result: ${c.content.slice(0, 200)}]`;
          if (c.type === "thinking") return `[thinking: ${c.text.slice(0, 200)}]`;
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
 * 优化流程：
 * 1. 裁剪 head 段中的大工具结果（非 LLM 操作）
 * 2. 找到分割点（不在 tool-result 边界切割）
 * 3. 提取文件操作信息
 * 4. 生成结构化摘要（有前次摘要时迭代更新）
 * 5. 附加文件操作信息到摘要
 * 6. 返回摘要 + recent 段
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

  // 3. 裁剪 head 段中的大工具结果
  const pruneThreshold = options.toolResultPruneThreshold ?? 2000;
  const prunedHead = pruneToolResults(head, pruneThreshold);

  // 4. 提取文件操作
  const fileOps = extractFileOperations(prunedHead);

  // 5. 生成摘要
  const historyText = messagesToText(prunedHead);
  const previousSummary = options.previousSummary;

  let summaryPrompt: string;
  let systemPrompt: string;

  if (previousSummary) {
    // 迭代更新模式
    summaryPrompt = UPDATE_TEMPLATE
      .replace("{previous_summary}", previousSummary)
      .replace("{new_conversation}", historyText);
    systemPrompt = "你是一个对话摘要助手。请基于前一次摘要更新内容，保持结构完整。";
  } else {
    // 首次压缩模式
    summaryPrompt = SUMMARY_TEMPLATE.replace(
      "{conversation_history}",
      historyText,
    );
    systemPrompt = "你是一个对话摘要助手。请简洁准确地总结对话历史，保留关键信息。";
  }

  const response = await summaryGenerator.generate({
    model: options.smallModel ?? "claude-haiku-3",
    system: systemPrompt,
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

  let summary = response.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");

  // 6. 附加文件操作信息
  if (fileOps.read.length > 0 || fileOps.modified.length > 0) {
    const fileSection = [];
    if (fileOps.read.length > 0) {
      fileSection.push(`<read-files>${fileOps.read.join(", ")}</read-files>`);
    }
    if (fileOps.modified.length > 0) {
      fileSection.push(`<modified-files>${fileOps.modified.join(", ")}</modified-files>`);
    }
    summary += "\n\n" + fileSection.join("\n");
  }

  // 7. 返回摘要 + 近期消息
  return { summary, recent };
}
