/**
 * @fengagent/core — 自省卡（ReflectionCard）与 `reflect/*` 事件词汇
 *
 * RSI 首期「P0 自省卡」的领域层：把评测/judge/防护闸/人工负反馈的结论
 * 提升为一等公民的**带证据卡片**，供下一轮上下文注入（Reflexion 式闭环）。
 *
 * 三条铁律（见 docs/EVALUATION.md「RSI：自省与验证闸」）：
 *
 * 1. **反思必须挂外部信号** —— 只接受 {@link REFLECTION_TRIGGERS} 里的四类证据来源；
 *    模型「自己觉得还能更好」不构成卡片（{@link hasReflectionEvidence} 会丢弃）。
 * 2. **每条卡片必须带证据指针** —— `evidence[]` 为空或指向空串的卡片一律不入库。
 * 3. **卡片是持久系统状态** —— 跨会话保留（越过 Last AI 的 B0→L1 persistence 边界），
 *    因此必须有状态机、TTL 与版本（`revision` 乐观锁）。
 *
 * 本文件零运行时依赖（与 `task-state.ts` 同口径：事件词汇在这里定义，落盘由
 * `@fengagent/agent` 的 `ReflectionStore` 负责）。
 */

/** 自省卡状态机：proposed → injected → adopted | rejected | expired */
export type ReflectionStatus =
  | "proposed"
  | "injected"
  | "adopted"
  | "rejected"
  | "expired";

/**
 * 触发来源 —— 只允许带外部证据的信号。
 *
 * - `judge_failed`：LLM-judge 判 failed / partial / tool_misused；
 * - `judge_unsafe`：judge 判 unsafe；
 * - `guard_tripped`：Agent Loop 防护闸触发（连续失败 / 重复调用 / 无进展等）；
 * - `test_failed`：测试集执行器判 fail；
 * - `human_negative`：人工负反馈。
 *
 * 刻意**没有** `self_reflection` / `self_critique`：无证据的「觉得」不进入本库。
 */
export type ReflectionTrigger =
  | "judge_failed"
  | "judge_unsafe"
  | "guard_tripped"
  | "test_failed"
  | "human_negative";

/** 全部合法触发来源（测试与校验共用同一事实来源） */
export const REFLECTION_TRIGGERS: readonly ReflectionTrigger[] = [
  "judge_failed",
  "judge_unsafe",
  "guard_tripped",
  "test_failed",
  "human_negative",
] as const;

/** 作用域：会话级（只对同一会话生效）或项目级（同一数据根共享） */
export type ReflectionScope = "session" | "project";

/** 卡片指向的可改进落点（对齐 SuggestionType，不新造一套归因） */
export type ReflectionTargetKind =
  | "system-prompt"
  | "tool-description"
  | "skill"
  | "context"
  | "workflow";

/** 证据指针：卡片能被外部核对的唯一凭据 */
export interface ReflectionEvidence {
  /** 证据类别：trace 记录 / 测试用例 / 防护闸 / 人工反馈 */
  kind: "trace" | "test" | "guard" | "feedback";
  /** 证据引用（trace id / 用例 id / 闸名 / 反馈 id）—— 空串视为无证据 */
  ref: string;
  /** 证据摘要（可选，人可读） */
  detail?: string;
}

/** 信号快照：产生卡片时的评测结论 */
export interface ReflectionSignal {
  /** judge 结论枚举（completed / partial / failed / tool_misused / unsafe / inefficient） */
  conclusion: string;
  /** 完成度（0–100） */
  completionScore?: number;
  /** 正确性（0–100） */
  correctnessScore?: number;
  /** 来源会话 id */
  sessionId?: string;
}

/** 注入效果（注入通道写回） */
export interface ReflectionEffect {
  /** 累计注入次数 */
  injectedCount: number;
  /** 最近一次注入时间（毫秒时间戳） */
  lastInjectedAt?: number;
}

/** 自省卡 */
export interface ReflectionCard {
  /** 卡片 id */
  id: string;
  /** 单调递增版本（乐观锁：写入必须带上读到的 revision） */
  revision: number;
  /** 作用域 */
  scope: ReflectionScope;
  /** 作用域键（sessionId 或数据根标识），用于隔离，不串库 */
  scopeKey: string;
  /** 状态 */
  status: ReflectionStatus;
  /** 触发来源 */
  trigger: ReflectionTrigger;
  /** 信号快照 */
  signal: ReflectionSignal;
  /** 一句话教训（人可读、模型可读） */
  lesson: string;
  /** 证据指针（非空才允许入库/注入） */
  evidence: ReflectionEvidence[];
  /** 改进落点 */
  appliesTo: { kind: ReflectionTargetKind; target: string };
  /** 注入效果（未注入过为 null） */
  effect: ReflectionEffect | null;
  /** 创建时间（毫秒时间戳） */
  createdAt: number;
  /** 更新时间（毫秒时间戳） */
  updatedAt: number;
  /** 过期时间（毫秒时间戳；缺省表示不过期） */
  expiresAt?: number;
}

// ──────────────────────────────────────────────
// reflect/* 事件词汇
// ──────────────────────────────────────────────

/**
 * `reflect/*` 事件词汇（写入、注入、过期、采纳、拒绝）。
 *
 * 与 `task/*` 同口径：词汇在 core 定义，事件流由存储层 append-only 落盘，
 * 因此「证据 → 卡 → 注入」这条闭环可以从事件流复原。
 */
export const REFLECT_EVENT_TYPES = [
  "reflect/card-created",
  "reflect/card-updated",
  "reflect/injected",
  "reflect/expired",
  "reflect/adopted",
  "reflect/rejected",
] as const;

export type ReflectEventType = (typeof REFLECT_EVENT_TYPES)[number];

/** 自省事件（判别式：type ↔ payload） */
export type ReflectEvent =
  | {
      type: "reflect/card-created";
      cardId: string;
      trigger: ReflectionTrigger;
      evidence: ReflectionEvidence[];
      at: number;
    }
  | {
      type: "reflect/card-updated";
      cardId: string;
      revision: number;
      status: ReflectionStatus;
      at: number;
    }
  | { type: "reflect/injected"; cardId: string; sessionId: string; at: number }
  | { type: "reflect/expired"; cardId: string; at: number }
  | { type: "reflect/adopted"; cardId: string; at: number }
  | { type: "reflect/rejected"; cardId: string; reason: string; at: number };

/** 该类型事件是否属于 `reflect/*` 词汇 */
export function isReflectEventType(type: string): type is ReflectEventType {
  return (REFLECT_EVENT_TYPES as readonly string[]).includes(type);
}

// ──────────────────────────────────────────────
// 校验与排序
// ──────────────────────────────────────────────

/** 自省错误（非法卡片 / 版本冲突 / 越权写入） */
export class ReflectionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "evidence_required"
      | "unknown_trigger"
      | "invalid_lesson"
      | "stale_revision"
      | "card_not_found"
      | "write_boundary_violation",
  ) {
    super(message);
    this.name = "ReflectionError";
  }
}

/**
 * 卡片是否带证据 —— 铁律 2 的唯一判定点。
 *
 * 空数组、空白 `ref`、非字符串 `ref` 都算无证据。
 *
 * @param card - 待判定的卡片（只读）
 * @returns 至少一条可用证据时 true
 */
export function hasReflectionEvidence(
  card: Pick<ReflectionCard, "evidence">,
): boolean {
  if (!Array.isArray(card.evidence) || card.evidence.length === 0) return false;
  return card.evidence.every(
    (e) =>
      e !== null &&
      typeof e === "object" &&
      typeof e.ref === "string" &&
      e.ref.trim().length > 0,
  );
}

/**
 * 校验一张待入库的卡片，非法即抛 {@link ReflectionError}。
 *
 * @param card - 待校验卡片
 * @throws {ReflectionError} 无证据 / 未知触发源 / 教训为空
 */
export function assertValidReflectionCard(
  card: Pick<ReflectionCard, "trigger" | "lesson" | "evidence">,
): void {
  if (!REFLECTION_TRIGGERS.includes(card.trigger)) {
    throw new ReflectionError(
      `unknown reflection trigger: ${String(card.trigger)}`,
      "unknown_trigger",
    );
  }
  if (typeof card.lesson !== "string" || card.lesson.trim().length === 0) {
    throw new ReflectionError("reflection lesson must not be empty", "invalid_lesson");
  }
  if (!hasReflectionEvidence(card)) {
    throw new ReflectionError(
      "reflection card requires at least one evidence pointer (no evidence → discarded)",
      "evidence_required",
    );
  }
}

/**
 * 触发源严重度（排序主键）。
 *
 * unsafe > 人工负反馈 > judge 失败 > 测试失败 > 防护闸。
 */
export const REFLECTION_SEVERITY: Readonly<Record<ReflectionTrigger, number>> = {
  judge_unsafe: 100,
  human_negative: 90,
  judge_failed: 80,
  test_failed: 70,
  guard_tripped: 60,
};

/**
 * 排序分：严重度 × 1000 + 证据条数 × 10 + 新近度（0–9）。
 *
 * 纯函数（`now` 由调用方传入），同一输入必然同一排序。
 *
 * @param card - 自省卡
 * @param now - 当前时间（毫秒）
 * @returns 排序分（越大越优先）
 */
export function reflectionRank(card: ReflectionCard, now: number): number {
  const severity = REFLECTION_SEVERITY[card.trigger] ?? 0;
  const evidenceBonus = Math.min(card.evidence.length, 5) * 10;
  const ageHours = Math.max(0, now - card.updatedAt) / 3_600_000;
  const recency = Math.max(0, 9 - Math.floor(ageHours / 6));
  return severity * 1000 + evidenceBonus + recency;
}

/**
 * 卡片此刻是否可注入。
 *
 * 只有 `proposed` / `injected` / `adopted` 三种状态可注入；`rejected` / `expired`
 * 一律不注入；`expiresAt` 已到的不注入（等清理任务改状态）。
 *
 * @param card - 自省卡
 * @param now - 当前时间（毫秒）
 */
export function isReflectionInjectable(card: ReflectionCard, now: number): boolean {
  if (card.status !== "proposed" && card.status !== "injected" && card.status !== "adopted") {
    return false;
  }
  if (typeof card.expiresAt === "number" && card.expiresAt <= now) return false;
  return hasReflectionEvidence(card);
}
