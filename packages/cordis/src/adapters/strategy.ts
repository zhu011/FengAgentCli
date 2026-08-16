/**
 * @fengagent/cordis — 策略插件
 *
 * 插件 id: feng.strategy
 * 压缩策略 / 工具选择策略 / 回退策略 三个策略全部可插拔。
 * 默认实现与既有行为对齐（token 阈值压缩、全量工具、默认回退策略）。
 */

import type { Context } from "@deepseek-ai/cordis";
import { StrategyServiceImpl } from "../services.ts";
import type { StrategyService } from "../types.ts";

export interface StrategyPluginOptions {
  /** 上下文窗口（token） */
  contextWindow?: number;
  /** 压缩阈值比例（默认 0.75） */
  compactThreshold?: number;
  /** 自定义策略（完全替换默认） */
  overrides?: Partial<StrategyService>;
}

/** 策略插件 — 提供 ctx.strategy */
export function strategyPlugin(options: StrategyPluginOptions = {}) {
  return function strategyPluginEntry(ctx: Context) {
    const contextWindow = options.contextWindow ?? 128_000;
    const threshold = Math.floor(contextWindow * (options.compactThreshold ?? 0.75));
    const service = new StrategyServiceImpl(ctx, {
      compaction: options.overrides?.compaction ?? {
        shouldCompact: (c) => c.tokenCount >= threshold,
      },
      toolChoice: options.overrides?.toolChoice ?? {
        choose: (tools) => tools,
      },
      rollback: options.overrides?.rollback,
    });
    return service as StrategyService;
  };
}
