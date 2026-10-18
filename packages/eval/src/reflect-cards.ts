/**
 * @fengagent/eval — judge 结论 → 自省卡（RSI P0 的「卡从哪来」）
 *
 * 本模块只做**纯映射**（不落盘、不依赖存储实现），因此 eval 包不需要依赖 agent：
 *
 * - `judge_failed`  ← judge 结论 failed / partial / tool_misused / inefficient；
 * - `judge_unsafe`  ← judge 结论 unsafe；
 * - judge 调用本身失败的结论（note 以 `LLM_FAILURE_NOTE_PREFIX` 开头）**不入卡** ——
 *   那是评测器坏了，不是被评对象的问题（沿用铁律 1：只收有证据的外部信号）。
 *
 * 证据指针固定指向 trace（`{kind:"trace", ref:"<sessionId>#<messageId|session>"}`），
 * 于是「这条教训从哪来」永远可回查。
 */

import type { ReflectionEvidence, ReflectionTargetKind, ReflectionTrigger } from "@fengagent/core";
import type { JudgeResult } from "./analyzer.ts";
import { LLM_FAILURE_NOTE_PREFIX } from "./judge.ts";

/** 卡片草稿（调用方把它交给 ReflectionStore.create / ingest 落盘） */
export interface ReflectionCardDraft {
  /** 触发来源 */
  trigger: ReflectionTrigger;
  /** 一句话教训（人可读、模型可读） */
  lesson: string;
  /** 证据指针（至少一条） */
  evidence: ReflectionEvidence[];
  /** 信号快照 */
  signal: {
    conclusion: string;
    completionScore?: number;
    correctnessScore?: number;
    sessionId?: string;
  };
  /** 改进落点（首期只允许 system-prompt 写回） */
  appliesTo: { kind: ReflectionTargetKind; target: string };
}

/** 生成草稿的选项 */
export interface CardsFromJudgeOptions {
  /** 写回落点目标（默认 `prompt-overlay.md`） */
  target?: string;
  /** 只处理这些会话（默认全部） */
  sessionIds?: string[];
}

/** 结论 → 触发源（null = 不产生卡片） */
export function triggerForConclusion(conclusion: string): ReflectionTrigger | null {
  switch (conclusion) {
    case "failed":
    case "partial":
    case "tool_misused":
    case "inefficient":
      return "judge_failed";
    case "unsafe":
      return "judge_unsafe";
    default:
      return null; // completed：没有可反思的外部信号
  }
}

/** 结论 → 可执行教训（首期模板化；后续可由 diagnose 规则替换） */
export function lessonForConclusion(result: JudgeResult): string {
  const detail = (result.note ?? "").trim();
  const suffix = detail === "" ? "" : `（judge: ${detail.slice(0, 120)}）`;
  switch (result.conclusion) {
    case "failed":
      return `上一轮任务未完成（完成度 ${result.completionScore}）：先确认目标再动手，必要时拆步${suffix}`;
    case "partial":
      return `上一轮只完成了一部分（完成度 ${result.completionScore}）：收尾前逐项核对用户要求${suffix}`;
    case "tool_misused":
      return `上一轮工具选型/入参有误：调用前核对工具签名与必填参数${suffix}`;
    case "inefficient":
      return `上一轮步骤冗余：先规划再执行，避免重复读取同一目标${suffix}`;
    case "unsafe":
      return `上一轮触发了安全风险：涉及删除/覆盖/越界路径的操作先停下来确认${suffix}`;
    default:
      return `上一轮存在问题（${result.conclusion}）${suffix}`;
  }
}

/**
 * 把 judge 结果映射成自省卡草稿。
 *
 * @param results - judge 结论列表
 * @param options - 写回目标等
 * @returns 草稿列表（judge 调用失败、completed 结论都不产生草稿）
 */
export function cardsFromJudgeResults(
  results: readonly JudgeResult[],
  options: CardsFromJudgeOptions = {},
): ReflectionCardDraft[] {
  const target = options.target ?? "prompt-overlay.md";
  const allow = options.sessionIds ? new Set(options.sessionIds) : null;
  const drafts: ReflectionCardDraft[] = [];

  for (const result of results) {
    if (allow && !allow.has(result.sessionId)) continue;
    // judge 自身失败 → 不入卡（与 judge 缓存不落盘同一口径）
    if ((result.note ?? "").startsWith(LLM_FAILURE_NOTE_PREFIX)) continue;

    const trigger = triggerForConclusion(result.conclusion);
    if (trigger === null) continue;

    drafts.push({
      trigger,
      lesson: lessonForConclusion(result),
      evidence: [{ kind: "trace", ref: `${result.sessionId}#judge`, detail: result.note }],
      signal: {
        conclusion: result.conclusion,
        completionScore: result.completionScore,
        correctnessScore: result.correctnessScore,
        sessionId: result.sessionId,
      },
      appliesTo: { kind: "system-prompt", target },
    });
  }

  return drafts;
}
