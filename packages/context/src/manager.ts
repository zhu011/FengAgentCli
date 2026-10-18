/**
 * @fengagent/context — 上下文管理器
 *
 * 组装完整上下文（系统提示 + 历史）、检查压缩阈值、执行压缩。
 * 实现 PRD 第 4.2.5 节定义的 ContextManager 接口。
 * 参考 ARCHITECTURE.md 第 3.1 节步骤 3 和第 6.6 节。
 */

import type { Message, Session, Config, ReflectionCard } from "@fengagent/core";
import {
  countTokensInMessages,
  countTokensInText,
} from "./token-counter.ts";
import {
  loadSystemContext,
  type SystemContextOptions,
} from "./system-context.ts";
import type { ReflectionInjection } from "./reflection.ts";
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

/** 注入记账信息（RSI P0 运行态接线：真的注入了哪些卡） */
export interface ReflectionInjectionRecord {
  /** 注入到哪个会话（首次装配该会话时记账） */
  sessionId: string;
  /** 实际注入的卡片 id（已过预算裁量：不含被丢弃/被截断到无） */
  cardIds: string[];
  /** 被截断的卡片 id */
  truncated: string[];
  /** 因预算被丢弃的卡片 id */
  dropped: string[];
  /** 小节 token 估算 */
  tokens: number;
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
  /**
   * 注入记账回调（RSI P0 运行态接线）。
   *
   * 系统提示里真的注入了自省卡时**记账一次**，参数带会话 id 与实际注入的卡 id。
   * 装配点用它调 `ReflectionStore.recordInjection`（卡片进 `injected`、事件流出
   * `reflect/injected`）。回调抛异常不影响装配（记账失败不打断主循环）。
   */
  onReflectionInjected?: (record: ReflectionInjectionRecord) => void;
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
  /**
   * 最近一次注入结果（系统提示装配时算出）。
   *
   * 系统提示按实例缓存，所以注入只在「算系统提示的那一次」发生；`assemble(session)`
   * 是唯一知道会话 id 的地方 —— 由它在记账后清空，保证一次注入只记一次账，
   * 不会因为循环多步反复累加 `injectedCount`。
   */
  let pendingInjection: ReflectionInjection | null = null;

  const baseSystemOptions = options.systemContextOptions;
  const systemContextOptions: SystemContextOptions | undefined =
    options.onReflectionInjected === undefined
      ? baseSystemOptions
      : {
          ...baseSystemOptions,
          onReflectionInjected: (injection) => {
            baseSystemOptions?.onReflectionInjected?.(injection);
            pendingInjection = injection;
          },
        };

  /** 把本实例算出的注入结果记账到该会话（一次性） */
  function flushInjectionRecord(session: Session): void {
    const injection = pendingInjection;
    const record = options.onReflectionInjected;
    if (!injection || !record) return;
    pendingInjection = null;
    const cardIds = injection.cards.map((c: ReflectionCard) => c.id);
    try {
      record({
        sessionId: session.id,
        cardIds,
        truncated: [...injection.truncated],
        dropped: [...injection.dropped],
        tokens: injection.tokens,
      });
    } catch {
      // 记账失败不打断主循环
    }
  }

  /** 获取系统提示（带缓存） */
  async function getSystemPrompt(): Promise<string> {
    if (systemPromptCache === null) {
      systemPromptCache = await loadSystemContext(systemContextOptions);
    }
    return systemPromptCache;
  }

  /** 组装完整上下文 */
  async function assemble(session: Session): Promise<AssembledContext> {
    const system = await getSystemPrompt();
    // 系统提示装配完成后按「实际注入的卡 id」记账（RSI P0 运行态接线）
    flushInjectionRecord(session);
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
