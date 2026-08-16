/**
 * @fengagent/graph — 回退策略
 *
 * 「节点回答不佳可回退」的策略层：负责判断一个节点是否回答不佳，
 * 以及决定回退到哪个祖先节点。
 * 该策略本身是可插拔的（Cordis strategy 插件域），未来可以接入
 * 自动质量评估（LLM-as-judge）、用户负反馈、工具错误率等信号。
 */

import type { ConversationNode, NodeQuality } from "./types.ts";

/** 回退判定信号 */
export interface QualitySignal {
  /** 节点自身（assistant 节点） */
  node: ConversationNode;
  /** 用户显式负反馈（如 ✗ / 评分低） */
  userRejected?: boolean;
  /** 工具调用失败次数（该节点内） */
  toolErrorCount?: number;
  /** 自定义评分（0-1，越低越差） */
  score?: number;
}

/** 回退策略接口 — 可插拔 */
export interface RollbackStrategy {
  /** 判断节点是否回答不佳 */
  shouldRollback(signal: QualitySignal): boolean;
  /** 选择回退目标：默认回退到该节点的父节点（用户提问处） */
  chooseTarget(node: ConversationNode): string | null;
}

/** 默认回退策略：用户拒绝 或 工具错误过多 或 评分过低 → 回退到父节点 */
export class DefaultRollbackStrategy implements RollbackStrategy {
  constructor(private options: { toolErrorThreshold?: number; minScore?: number } = {}) {
    this.options = {
      toolErrorThreshold: 2,
      minScore: 0.4,
      ...options,
    };
  }

  shouldRollback(signal: QualitySignal): boolean {
    if (signal.userRejected) return true;
    const toolErrors = signal.toolErrorCount ?? 0;
    if (toolErrors >= (this.options.toolErrorThreshold ?? 2)) return true;
    if (signal.score !== undefined && signal.score < (this.options.minScore ?? 0.4)) {
      return true;
    }
    return false;
  }

  chooseTarget(node: ConversationNode): string | null {
    // 默认回退到该节点的父节点（通常是用户提问节点）
    return node.parentId;
  }
}

/** 将 NodeQuality 归一化为判定信号 */
export function qualityToSignal(node: ConversationNode): QualitySignal {
  const quality: NodeQuality = node.meta.quality ?? "unrated";
  return {
    node,
    userRejected: quality === "poor",
    score: quality === "good" ? 1 : quality === "poor" ? 0 : undefined,
  };
}
