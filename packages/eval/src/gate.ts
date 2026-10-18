/**
 * @fengagent/eval — 验证闸（RSI P1）
 *
 * 对齐 Self-Harness 的小闭环：**提案 → held-in / held-out 双集验证 → 回归即拒绝 →
 * 被拒提案也留痕**。没有这道闸，自省卡写回的「改进」只是赌。
 *
 * 判定规则（全部可证伪）：
 *
 * 1. 双集都要跑；任一只跑一个集合 → 不构成 adopted（`held_out_missing`）。
 * 2. 主指标不得劣于基线：通过率、平均完成度都 `>= baseline - epsilon`。
 * 3. 护栏指标不得失控：步数 / token / 耗时不超基线 × 倍率上限。
 * 4. 单次实验成本上限：基线 + 候选总 token 超限 → 立即中止、拒绝并回滚。
 * 5. 拒绝一律回滚（文件内容级）+ 写入 `<数据根>/reflect/experiments/` 与
 *    `experiments.jsonl`（拒绝留痕可查询）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReflectionCard } from "@fengagent/core";
import type { TestSetRun } from "./runner.ts";
import {
  applyPromptOverlayChange,
  proposePromptOverlayChange,
  promptOverlayPath,
  readPromptOverlay,
  restorePromptOverlay,
  type OverlayChange,
  type OverlaySnapshot,
} from "./mutator.ts";

/** 单集合指标（验证闸比较口径） */
export interface GateMetrics {
  /** 通过率 0–1 */
  passRate: number;
  /** 平均完成度 */
  meanCompletionScore: number;
  /** 平均正确性 */
  meanCorrectnessScore: number;
  /** 平均步数 */
  meanSteps: number;
  /** 平均 token */
  meanTokens: number;
  /** 平均耗时 */
  meanDurationMs: number;
  /** 用例数 */
  caseCount: number;
}

/** 护栏与成本上限 */
export interface GateLimits {
  /** 主指标允许的劣化容差（默认 1e-9，即严格不劣） */
  epsilon?: number;
  /** 步数倍率上限（默认 1.5） */
  maxStepsRatio?: number;
  /** token 倍率上限（默认 1.5） */
  maxTokensRatio?: number;
  /** 耗时倍率上限（默认 2） */
  maxDurationRatio?: number;
  /** 单次实验成本上限（基线 + 候选总 token；默认 Infinity） */
  maxExperimentTokens?: number;
}

/** 双集测量 */
export interface DualSetMetrics {
  heldIn: GateMetrics;
  heldOut: GateMetrics;
}

/** 一次实验的持久记录（采纳与拒绝都留痕） */
export interface GateExperiment {
  /** 实验 id */
  id: string;
  /** 来源卡片 */
  cardId: string;
  /** 变更 id */
  changeId: string;
  /** 判定 */
  verdict: "adopted" | "rejected";
  /** 拒绝/异常原因（adopted 时为空） */
  reasons: string[];
  /** 是否回滚了 overlay */
  rolledBack: boolean;
  /** 基线指标 */
  baseline: DualSetMetrics;
  /** 候选指标 */
  candidate: DualSetMetrics;
  /** 成本核算（基线 + 候选总 token） */
  costTokens: number;
  /** 是否因成本上限中止 */
  aborted: boolean;
  /** 时间戳 */
  createdAt: number;
}

/** 运行验证闸的入参 */
export interface RunVerificationGateOptions {
  /** 数据根（overlay 与实验台账都落这里） */
  dataRoot: string;
  /** 来源自省卡 */
  card: ReflectionCard;
  /** 基线：跑某个集合（不应用变更） */
  runBaseline: (which: "held-in" | "held-out") => Promise<TestSetRun>;
  /** 候选：应用变更后跑某个集合 */
  runCandidate: (which: "held-in" | "held-out") => Promise<TestSetRun>;
  /** 上限 */
  limits?: GateLimits;
  /** 采纳回调（例如把卡片置 adopted） */
  onAdopted?: (experiment: GateExperiment) => void;
  /** 拒绝回调（例如把卡片置 rejected，留痕） */
  onRejected?: (experiment: GateExperiment) => void;
  /** 时钟 */
  now?: () => number;
  /** 实验 id（测试可注入） */
  id?: string;
}

/** 默认上限 */
export const DEFAULT_GATE_LIMITS: Required<GateLimits> = {
  epsilon: 1e-9,
  maxStepsRatio: 1.5,
  maxTokensRatio: 1.5,
  maxDurationRatio: 2,
  maxExperimentTokens: Number.POSITIVE_INFINITY,
};

/** 集合 → 指标 */
export function toGateMetrics(run: TestSetRun): GateMetrics {
  return {
    passRate: run.passRate,
    meanCompletionScore: run.meanCompletionScore,
    meanCorrectnessScore: run.meanCorrectnessScore,
    meanSteps: run.meanSteps,
    meanTokens: run.meanTokens,
    meanDurationMs: run.meanDurationMs,
    caseCount: run.cases.length,
  };
}

/** 无测量（集合没跑） */
const EMPTY_METRICS: GateMetrics = {
  passRate: 0,
  meanCompletionScore: 0,
  meanCorrectnessScore: 0,
  meanSteps: 0,
  meanTokens: 0,
  meanDurationMs: 0,
  caseCount: 0,
};

/**
 * 双集比较（纯函数）。
 *
 * @param baseline - 基线双集指标
 * @param candidate - 候选双集指标
 * @param limits - 上限
 * @returns `{ adopted, reasons }`
 */
export function compareGate(
  baseline: DualSetMetrics,
  candidate: DualSetMetrics,
  limits: GateLimits = {},
): { adopted: boolean; reasons: string[] } {
  const cfg = { ...DEFAULT_GATE_LIMITS, ...limits };
  const reasons: string[] = [];

  for (const which of ["heldIn", "heldOut"] as const) {
    const base = baseline[which];
    const cand = candidate[which];
    const label = which === "heldIn" ? "held-in" : "held-out";

    if (cand.caseCount === 0) {
      reasons.push(`${label}: 未执行任何用例（双集必须都跑）`);
      continue;
    }
    if (cand.passRate + cfg.epsilon < base.passRate) {
      reasons.push(
        `${label}: 通过率回归 ${base.passRate.toFixed(3)} → ${cand.passRate.toFixed(3)}`,
      );
    }
    if (cand.meanCompletionScore + cfg.epsilon < base.meanCompletionScore) {
      reasons.push(
        `${label}: 平均完成度回归 ${base.meanCompletionScore.toFixed(1)} → ${cand.meanCompletionScore.toFixed(1)}`,
      );
    }
    // 护栏（基线为 0 时跳过倍率判定，避免除零放大）
    if (base.meanSteps > 0 && cand.meanSteps > base.meanSteps * cfg.maxStepsRatio) {
      reasons.push(
        `${label}: 步数护栏超限 ${base.meanSteps.toFixed(1)} → ${cand.meanSteps.toFixed(1)}（上限 ×${cfg.maxStepsRatio}）`,
      );
    }
    if (base.meanTokens > 0 && cand.meanTokens > base.meanTokens * cfg.maxTokensRatio) {
      reasons.push(
        `${label}: token 护栏超限 ${base.meanTokens.toFixed(0)} → ${cand.meanTokens.toFixed(0)}（上限 ×${cfg.maxTokensRatio}）`,
      );
    }
    if (
      base.meanDurationMs > 0 &&
      cand.meanDurationMs > base.meanDurationMs * cfg.maxDurationRatio
    ) {
      reasons.push(
        `${label}: 耗时护栏超限 ${base.meanDurationMs.toFixed(0)}ms → ${cand.meanDurationMs.toFixed(0)}ms（上限 ×${cfg.maxDurationRatio}）`,
      );
    }
  }

  return { adopted: reasons.length === 0, reasons };
}

/** 实验目录 = `<dataRoot>/reflect/experiments` */
export function experimentsDir(dataRoot: string): string {
  return join(resolve(dataRoot), "reflect", "experiments");
}

/** 实验索引文件 = `<dataRoot>/reflect/experiments.jsonl` */
export function experimentsLedgerPath(dataRoot: string): string {
  return join(resolve(dataRoot), "reflect", "experiments.jsonl");
}

/**
 * 落盘实验记录（采纳/拒绝都写：拒绝留痕是一等公民）。
 *
 * @param dataRoot - 数据根
 * @param experiment - 实验记录
 */
export function persistExperiment(dataRoot: string, experiment: GateExperiment): void {
  const dir = experimentsDir(dataRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${experiment.id}.json`),
    JSON.stringify(experiment, null, 2),
    "utf-8",
  );
  appendFileSync(experimentsLedgerPath(dataRoot), `${JSON.stringify(experiment)}\n`, "utf-8");
}

/**
 * 查询实验台账（含被拒提案 —— 「拒绝也留痕」的查询面）。
 *
 * @param dataRoot - 数据根
 * @param filter - 可选过滤（verdict / cardId）
 */
export function listExperiments(
  dataRoot: string,
  filter?: { verdict?: "adopted" | "rejected"; cardId?: string },
): GateExperiment[] {
  const dir = experimentsDir(dataRoot);
  if (!existsSync(dir)) return [];
  const ledger = experimentsLedgerPath(dataRoot);
  const records: GateExperiment[] = [];
  if (existsSync(ledger)) {
    for (const line of readFileSync(ledger, "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        records.push(JSON.parse(line) as GateExperiment);
      } catch {
        // 坏行跳过（台账可追加，不因一行坏掉全盘）
      }
    }
  }
  return records.filter(
    (r) =>
      (filter?.verdict === undefined || r.verdict === filter.verdict) &&
      (filter?.cardId === undefined || r.cardId === filter.cardId),
  );
}

/**
 * 跑一次完整实验：基线双集 → 应用 overlay → 候选双集 → 采纳/拒绝 → 回滚/留痕。
 *
 * 任何异常都会走「拒绝 + 回滚 + 留痕」路径，不会把半应用的 overlay 留在数据根里。
 */
export async function runVerificationGate(
  options: RunVerificationGateOptions,
): Promise<GateExperiment> {
  const now = options.now ?? Date.now;
  const cfg = { ...DEFAULT_GATE_LIMITS, ...(options.limits ?? {}) };
  const at = now();

  // 1. 基线双集
  const baselineHeldIn = await options.runBaseline("held-in");
  const baselineHeldOut = await options.runBaseline("held-out");
  const baseline: DualSetMetrics = {
    heldIn: toGateMetrics(baselineHeldIn),
    heldOut: toGateMetrics(baselineHeldOut),
  };

  // 2. 生成并应用最小变更（只写 prompt-overlay.md）
  let change: OverlayChange | null = null;
  let snapshot: OverlaySnapshot = readPromptOverlay(options.dataRoot);
  const reasons: string[] = [];
  let aborted = false;
  let candidate: DualSetMetrics = { heldIn: EMPTY_METRICS, heldOut: EMPTY_METRICS };
  let costTokens =
    baselineHeldIn.totalTokens +
    baselineHeldOut.totalTokens;

  try {
    change = proposePromptOverlayChange({
      dataRoot: options.dataRoot,
      card: options.card,
      at,
    });
    applyPromptOverlayChange(options.dataRoot, change);

    // 3. 候选双集（成本上限随时可中止）
    const runOne = async (which: "held-in" | "held-out") => {
      if (costTokens > cfg.maxExperimentTokens) {
        aborted = true;
        reasons.push(
          `单次实验成本超限：已用 ${costTokens} token > ${cfg.maxExperimentTokens}（中止，未跑完 ${which}）`,
        );
        return null;
      }
      const run = await options.runCandidate(which);
      costTokens += run.totalTokens;
      return run;
    };

    const candHeldIn = await runOne("held-in");
    const candHeldOut = await runOne("held-out");

    candidate = {
      heldIn: candHeldIn ? toGateMetrics(candHeldIn) : EMPTY_METRICS,
      heldOut: candHeldOut ? toGateMetrics(candHeldOut) : EMPTY_METRICS,
    };

    if (!aborted) {
      const comparison = compareGate(baseline, candidate, options.limits);
      reasons.push(...comparison.reasons);
      if (costTokens > cfg.maxExperimentTokens) {
        aborted = true;
        reasons.push(
          `单次实验成本超限：${costTokens} token > ${cfg.maxExperimentTokens}`,
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reasons.push(`实验异常：${message}`);
  }

  const adopted = !aborted && reasons.length === 0;

  // 4. 拒绝即回滚（内容级恢复）
  let rolledBack = false;
  if (!adopted) {
    restorePromptOverlay(snapshot);
    const after = readPromptOverlay(options.dataRoot);
    rolledBack = after.existed === snapshot.existed && after.content === snapshot.content;
  }

  const experiment: GateExperiment = {
    id: options.id ?? `exp-${at.toString(36)}-${options.card.id.slice(0, 8)}`,
    cardId: options.card.id,
    changeId: change?.id ?? "none",
    verdict: adopted ? "adopted" : "rejected",
    reasons: adopted ? [] : reasons,
    rolledBack,
    baseline,
    candidate,
    costTokens,
    aborted,
    createdAt: at,
  };

  // 5. 留痕 + 回调
  persistExperiment(options.dataRoot, experiment);
  if (adopted) {
    options.onAdopted?.(experiment);
  } else {
    options.onRejected?.(experiment);
  }

  return experiment;
}

/** overlay 当前是否为空（无规则） */
export function overlayIsEmpty(dataRoot: string): boolean {
  const snap = readPromptOverlay(dataRoot);
  return !snap.existed || (snap.content ?? "").trim() === "";
}

/** overlay 路径（对外暴露，便于核对写回边界） */
export { promptOverlayPath };
