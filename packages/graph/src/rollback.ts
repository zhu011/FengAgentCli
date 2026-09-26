/**
 * @fengagent/graph — 回退策略
 *
 * 「节点回答不佳可回退」的策略层：负责判断一个节点是否回答不佳，
 * 以及决定回退到哪个祖先节点。
 * 该策略本身是可插拔的（Cordis strategy 插件域），未来可以接入
 * 自动质量评估（LLM-as-judge）、用户负反馈、工具错误率等信号。
 */

import type {
  ConversationNode,
  NodeQuality,
  RollbackGranularity,
} from "./types.ts";

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

/**
 * 回退/续跑目标的解析请求（粒度感知）。
 *
 * 图包只做「结构决策」，不碰会话消息 —— 因此「哪个节点是真实提问 / 哪个是
 * 工具结果」由调用方（server 侧持有 session.messages）以回调注入。
 */
export interface RollbackTargetRequest {
  /** 被用户点击的节点 */
  node: ConversationNode;
  /** 粒度：turn=轮级（既有语义）；step=步级 */
  granularity: RollbackGranularity;
  /**
   * 期望的续跑语义（可选，覆盖策略默认判断）：
   * - `replay`：必须**重放这一步**（该步的工具要重新执行）——图上改参重放走这条，
   *   否则改写入参永远等不到匹配的那次调用；
   * - `resume`：必须**从这一步之后续跑**（已执行工具不重跑）；
   * - 缺省：由策略按节点形态自行判断。
   */
  mode?: "replay" | "resume";
  /** 节点查询（沿父链上溯 / 沿子链找续跑边界） */
  getNode(id: string): ConversationNode | undefined;
  /** 该节点是否为「真实提问」（含文本的 user 节点，而非工具结果） */
  isQuestion(node: ConversationNode): boolean;
  /** 该节点是否为「工具结果」节点（role=user 且只含 tool-result 块） */
  isToolResult(node: ConversationNode): boolean;
}

/**
 * 回退/续跑目标（解析结果）。
 *
 * `targetId` 是**图上**的回退点（分支点挂其下），`truncateToMessageId` 是
 * **会话消息**的截断点（保留到该消息为止）。步级续跑时两者可能不是同一个
 * 节点语义：图回退点 = 续跑边界，截断点 = 该边界的消息。
 */
export interface RollbackTargetChoice {
  /** 回退到的图节点 id（最后保留的节点） */
  targetId: string;
  /** 会话消息截断点（保留到该消息为止，含） */
  truncateToMessageId: string;
  /**
   * 续跑语义：
   * - `replay`：从该步重放（该步的工具会重新执行）——改参重放走这条；
   * - `resume`：从该步之后续跑（该步已执行的工具不重复执行）。
   */
  mode: "replay" | "resume";
  /** 粒度（回显请求） */
  granularity: RollbackGranularity;
}

/** 回退策略接口 — 可插拔 */
export interface RollbackStrategy {
  /** 判断节点是否回答不佳 */
  shouldRollback(signal: QualitySignal): boolean;
  /** 选择回退目标：默认回退到该节点的父节点（用户提问处） */
  chooseTarget(node: ConversationNode): string | null;
  /**
   * 粒度感知的回退/续跑目标解析（增量扩展点）。
   *
   * 缺省实现（{@link DefaultRollbackStrategy}）只解析轮级语义；步级语义由
   * {@link StepAwareRollbackStrategy} 提供，第三方策略可实现本方法接管两种粒度。
   *
   * @returns 解析结果；返回 null 表示该策略不接管（调用方回落轮级语义）
   */
  chooseRollbackTarget?(request: RollbackTargetRequest): RollbackTargetChoice | null;
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

  /** 轮级语义：沿父链上溯到「该节点所属轮次」的真实提问节点 */
  chooseRollbackTarget(request: RollbackTargetRequest): RollbackTargetChoice | null {
    return resolveTurnTarget(request);
  }
}

/**
 * 步级回退策略（增量）：在默认轮级语义之上，多接管 `granularity: "step"`。
 *
 * 轮级语义逐字沿用 {@link DefaultRollbackStrategy}（不改变既有回退边界），
 * 步级只在用户显式请求时生效 —— 纯加法。
 */
export class StepAwareRollbackStrategy extends DefaultRollbackStrategy {
  override chooseRollbackTarget(
    request: RollbackTargetRequest,
  ): RollbackTargetChoice | null {
    if (request.granularity !== "step") {
      return super.chooseRollbackTarget(request);
    }
    const step = resolveStepTarget(request);
    // 步级无法解析（点到提问/分支点等）→ 回落轮级语义，不改变既有行为
    return step ?? super.chooseRollbackTarget({ ...request, granularity: "turn" });
  }
}

/**
 * 轮级解析：沿父链上溯到最近的真实提问节点。
 *
 * 事件溯源图里工具结果以 role=user 的 tool-result 消息落 user/message 事件，
 * 会派生「工具结果 user 节点」—— 它不是真实提问，必须跳过继续上溯，否则会
 * 截断到工具结果消息（重答不再重跑工具、粒度错乱）。
 */
function resolveTurnTarget(request: RollbackTargetRequest): RollbackTargetChoice | null {
  const { node, getNode, isQuestion } = request;
  let cursor: ConversationNode | undefined = node;
  let questionFallback: ConversationNode | undefined;
  let question: ConversationNode | undefined;
  while (cursor) {
    if (cursor.type === "user") {
      questionFallback ??= cursor;
      if (isQuestion(cursor)) {
        question = cursor;
        break;
      }
    }
    cursor = cursor.parentId ? getNode(cursor.parentId) : undefined;
  }
  const chosen = question ?? questionFallback ?? node;
  if (!chosen) return null;
  return {
    targetId: chosen.id,
    truncateToMessageId: chosen.messageId,
    mode: "replay",
    granularity: "turn",
  };
}

/**
 * 步级解析：把回退点精确到一轮之内的一步。
 *
 * - 调用方显式要求 `mode: "replay"`（图上改参重放）→ 退回该步的**前一条消息**，
 *   让模型重新生成这一步、工具以改写入参重新执行；
 * - 点工具结果节点 → 从它之后**续跑**（该步工具已执行完，不重复执行）；
 * - 点助手步骤节点且该步产出了工具结果 → 续跑到该工具结果（工具不重复执行）；
 * - 点无工具结果的助手步骤（纯回答步）→ **重放**到其前一条消息（重答该步）；
 * - 点提问 / 分支点 → 返回 null，由调用方回落轮级语义。
 */
function resolveStepTarget(request: RollbackTargetRequest): RollbackTargetChoice | null {
  const { node, getNode, isToolResult, mode } = request;

  // 显式重放：截断到该步之前，这一步（含其工具调用）重新执行。
  if (mode === "replay") {
    if (node.type !== "assistant") return null; // 提问/工具结果节点没有「重放」语义 → 轮级
    const parent = node.parentId ? getNode(node.parentId) : undefined;
    if (!parent || parent.type === "branch-point") return null;
    return {
      targetId: parent.id,
      truncateToMessageId: parent.messageId,
      mode: "replay",
      granularity: "step",
    };
  }

  if (node.type === "user" && isToolResult(node)) {
    return {
      targetId: node.id,
      truncateToMessageId: node.messageId,
      mode: "resume",
      granularity: "step",
    };
  }

  if (node.type !== "assistant") return null;

  // 该步产出的工具结果 = 续跑边界（结果已在上下文里，工具不会被重跑）
  const boundary = node.childrenIds
    .map((id) => getNode(id))
    .find(
      (child): child is ConversationNode =>
        child !== undefined && child.type === "user" && isToolResult(child),
    );
  if (boundary) {
    return {
      targetId: boundary.id,
      truncateToMessageId: boundary.messageId,
      mode: "resume",
      granularity: "step",
    };
  }

  // 纯回答步：重放该步（截断到前一条消息，让模型重新生成这一步）
  const parent = node.parentId ? getNode(node.parentId) : undefined;
  if (!parent || parent.type === "branch-point") return null;
  return {
    targetId: parent.id,
    truncateToMessageId: parent.messageId,
    mode: "replay",
    granularity: "step",
  };
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
