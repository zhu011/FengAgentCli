/**
 * @fengagent/context — 上下文管理器
 *
 * 组装完整上下文（系统提示 + 历史）、检查压缩阈值、执行压缩。
 * 实现 PRD 第 4.2.5 节定义的 ContextManager 接口。
 * 参考 ARCHITECTURE.md 第 3.1 节步骤 3 和第 6.6 节。
 */

import type { Message, Session, Config } from "@fengagent/core";
import {
  countTokensInMessages,
  countTokensInText,
} from "./token-counter.ts";
import {
  loadSystemContext,
  type SystemContextOptions,
} from "./system-context.ts";
import {
  compact,
  type CompactionOptions,
  type CompactionResult,
  type SummaryGenerator,
} from "./compaction.ts";

/** 组装后的上下文 */
export interface AssembledContext {
  /** 系统提示 */
  system: string;
  /** 对话历史消息 */
  messages: Message[];
  /** 估算的总 Token 数（系统提示 + 消息） */
  tokenCount: number;
}

/** ContextManager 构造选项 */
export interface ContextManagerOptions {
  /** 配置（仅需上下文相关字段） */
  config: Pick<
    Config,
    | "contextWindow"
    | "compactThreshold"
    | "compactKeepTokens"
    | "disableCompact"
    | "smallModel"
  >;
  /** 摘要生成器（LLMClient 即满足此接口） */
  summaryGenerator: SummaryGenerator;
  /** 系统上下文加载选项 */
  systemContextOptions?: SystemContextOptions;
}

/**
 * 创建上下文管理器。
 *
 * 职责：
 * - `assemble()` — 组装系统提示 + 对话历史
 * - `shouldCompact()` — 检查是否达到压缩阈值
 * - `compact()` — 执行压缩（摘要 head + 保留 recent）
 * - `estimateTokens()` — Token 估算
 */
export function createContextManager(options: ContextManagerOptions) {
  let systemPromptCache: string | null = null;

  /** 获取系统提示（带缓存） */
  async function getSystemPrompt(): Promise<string> {
    if (systemPromptCache === null) {
      systemPromptCache = await loadSystemContext(
        options.systemContextOptions,
      );
    }
    return systemPromptCache;
  }

  /** 组装完整上下文 */
  async function assemble(session: Session): Promise<AssembledContext> {
    const system = await getSystemPrompt();
    const tokenCount =
      countTokensInText(system) + countTokensInMessages(session.messages);
    return {
      system,
      messages: session.messages,
      tokenCount,
    };
  }

  /** 检查是否需要压缩 */
  function shouldCompact(context: AssembledContext): boolean {
    if (options.config.disableCompact) return false;
    const threshold =
      options.config.contextWindow * options.config.compactThreshold;
    return context.tokenCount >= threshold;
  }

  /** 执行压缩 */
  async function compactMessages(
    messages: Message[],
    compactOptions?: Partial<CompactionOptions>,
  ): Promise<CompactionResult> {
    const opts: CompactionOptions = {
      keepTokens: compactOptions?.keepTokens ?? options.config.compactKeepTokens,
      smallModel: compactOptions?.smallModel ?? options.config.smallModel,
      maxTokens: compactOptions?.maxTokens,
    };
    return compact(messages, opts, options.summaryGenerator);
  }

  /** Token 估算 */
  function estimateTokens(content: string | Message[]): number {
    if (typeof content === "string") {
      return countTokensInText(content);
    }
    return countTokensInMessages(content);
  }

  /** 使系统提示缓存失效（下次 assemble 重新加载） */
  function invalidateSystemPrompt(): void {
    systemPromptCache = null;
  }

  return {
    assemble,
    shouldCompact,
    compact: compactMessages,
    estimateTokens,
    invalidateSystemPrompt,
  };
}

/** ContextManager 实例类型 */
export type ContextManager = ReturnType<typeof createContextManager>;
