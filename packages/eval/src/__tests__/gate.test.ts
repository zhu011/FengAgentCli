/**
 * @fengagent/eval — 验证闸测试（RSI P1）
 *
 * 覆盖验收契约 B3（双集都跑 + 不劣于基线才 adopted）/ B4（护栏 + 成本上限）/
 * B5（拒绝即回滚）/ B6（拒绝留痕可查询）/ B7（基线可比、报告原始指标）。
 *
 * 骨架：`runBaseline` / `runCandidate` 都是注入项，用确定性假执行结果构造
 * 「更好 / 更差 / 无差异 / 被拒 / 成本超限」五种情形。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReflectionCard } from "@fengagent/core";
import {
  compareGate,
  listExperiments,
  runVerificationGate,
  toGateMetrics,
  experimentsLedgerPath,
  overlayIsEmpty,
  DEFAULT_GATE_LIMITS,
} from "../gate.ts";
import { promptOverlayPath } from "../mutator.ts";
import { aggregateRun, type CaseOutcome, type TestSetRun } from "../runner.ts";

/** 造一次测试集结果（metrics 决定质量） */
function fakeRun(opts: {
  setName: string;
  passRate: number;
  completion: number;
  steps?: number;
  tokens?: number;
  durationMs?: number;
  caseCount?: number;
}): TestSetRun {
  const caseCount = opts.caseCount ?? 4;
  const passCount = Math.round(opts.passRate * caseCount);
  const cases: CaseOutcome[] = Array.from({ length: caseCount }, (_, i) => ({
    caseId: `c${i}`,
    input: `in${i}`,
    steps: opts.steps ?? 2,
    toolCalls: 1,
    tokens: { input: (opts.tokens ?? 100) / 2, output: (opts.tokens ?? 100) / 2 },
    durationMs: opts.durationMs ?? 1_000,
    finalText: "ok",
    errors: [],
    traceRef: `memory:c${i}`,
    passed: i < passCount,
    score: opts.completion,
    verdict: {
      completionScore: opts.completion,
      correctnessScore: opts.completion,
      conclusion: i < passCount ? "completed" : "failed",
    },
  }));
  return aggregateRun(opts.setName, cases);
}

const CARD: ReflectionCard = {
  id: "card-gate-1",
  revision: 1,
  scope: "project",
  scopeKey: "project:default",
  status: "proposed",
  trigger: "judge_failed",
  signal: { conclusion: "failed" },
  lesson: "改文件前先读目标文件",
  evidence: [{ kind: "trace", ref: "trace-001" }],
  appliesTo: { kind: "system-prompt", target: "prompt-overlay.md" },
  effect: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  expiresAt: 1_000 + 86_400_000,
};

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "feng-gate-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("compareGate — 判定口径", () => {
  const baseline = {
    heldIn: toGateMetrics(fakeRun({ setName: "in", passRate: 0.75, completion: 80 })),
    heldOut: toGateMetrics(fakeRun({ setName: "out", passRate: 0.75, completion: 78 })),
  };

  test("双集都不劣 → adopted", () => {
    const candidate = {
      heldIn: toGateMetrics(fakeRun({ setName: "in", passRate: 0.75, completion: 80 })),
      heldOut: toGateMetrics(fakeRun({ setName: "out", passRate: 0.75, completion: 78 })),
    };
    expect(compareGate(baseline, candidate)).toEqual({ adopted: true, reasons: [] });
  });

  test("held-in 更好但 held-out 回归 → 拒绝（双集都要过）", () => {
    const candidate = {
      heldIn: toGateMetrics(fakeRun({ setName: "in", passRate: 1, completion: 95 })),
      heldOut: toGateMetrics(fakeRun({ setName: "out", passRate: 0.5, completion: 60 })),
    };
    const result = compareGate(baseline, candidate);
    expect(result.adopted).toBe(false);
    expect(result.reasons.join("\n")).toContain("held-out");
  });

  test("held-out 没跑（caseCount=0）→ 拒绝", () => {
    const candidate = {
      heldIn: toGateMetrics(fakeRun({ setName: "in", passRate: 0.75, completion: 80 })),
      heldOut: {
        passRate: 0,
        meanCompletionScore: 0,
        meanCorrectnessScore: 0,
        meanSteps: 0,
        meanTokens: 0,
        meanDurationMs: 0,
        caseCount: 0,
      },
    };
    const result = compareGate(baseline, candidate);
    expect(result.adopted).toBe(false);
    expect(result.reasons.join("\n")).toContain("未执行任何用例");
  });

  test("主指标持平但步数护栏超限 → 拒绝", () => {
    const candidate = {
      heldIn: toGateMetrics(
        fakeRun({ setName: "in", passRate: 0.75, completion: 80, steps: 10 }),
      ),
      heldOut: toGateMetrics(
        fakeRun({ setName: "out", passRate: 0.75, completion: 78, steps: 10 }),
      ),
    };
    const result = compareGate(baseline, candidate);
    expect(result.adopted).toBe(false);
    expect(result.reasons.join("\n")).toContain("步数护栏超限");
  });

  test("token 护栏与耗时护栏同样生效", () => {
    const candidate = {
      heldIn: toGateMetrics(
        fakeRun({ setName: "in", passRate: 0.75, completion: 80, tokens: 10_000, durationMs: 9_000 }),
      ),
      heldOut: toGateMetrics(
        fakeRun({ setName: "out", passRate: 0.75, completion: 78, tokens: 10_000, durationMs: 9_000 }),
      ),
    };
    const reasons = compareGate(baseline, candidate).reasons.join("\n");
    expect(reasons).toContain("token 护栏超限");
    expect(reasons).toContain("耗时护栏超限");
  });

  test("倍率上限可放宽（默认 1.5，放宽到 10 后步数不再拦）", () => {
    const candidate = {
      heldIn: toGateMetrics(fakeRun({ setName: "in", passRate: 0.75, completion: 80, steps: 10 })),
      heldOut: toGateMetrics(fakeRun({ setName: "out", passRate: 0.75, completion: 78, steps: 10 })),
    };
    expect(compareGate(baseline, candidate, { maxStepsRatio: 10 }).adopted).toBe(true);
  });
});

describe("runVerificationGate — 端到端", () => {
  test("更好 → adopted，overlay 保留，记录留痕", async () => {
    const adopted: string[] = [];
    const experiment = await runVerificationGate({
      dataRoot,
      card: CARD,
      id: "exp-better",
      runBaseline: async (which) => fakeRun({ setName: which, passRate: 0.5, completion: 60 }),
      runCandidate: async (which) => fakeRun({ setName: which, passRate: 1, completion: 90 }),
      onAdopted: (e) => adopted.push(e.id),
    });

    expect(experiment.verdict).toBe("adopted");
    expect(experiment.reasons).toEqual([]);
    expect(experiment.rolledBack).toBe(false);
    expect(adopted).toEqual(["exp-better"]);
    // overlay 被保留（改动生效）
    expect(overlayIsEmpty(dataRoot)).toBe(false);
    expect(readFileSync(promptOverlayPath(dataRoot), "utf-8")).toContain("改文件前先读目标文件");
    // 报告原始指标（不只结论）
    expect(experiment.baseline.heldIn.meanCompletionScore).toBe(60);
    expect(experiment.candidate.heldIn.meanCompletionScore).toBe(90);
  });

  test("更差 → rejected，回滚 overlay（内容级），拒绝留痕可查询", async () => {
    const rejected: string[] = [];
    const experiment = await runVerificationGate({
      dataRoot,
      card: CARD,
      id: "exp-worse",
      runBaseline: async (which) => fakeRun({ setName: which, passRate: 1, completion: 90 }),
      runCandidate: async (which) => fakeRun({ setName: which, passRate: 0.25, completion: 30 }),
      onRejected: (e) => rejected.push(e.id),
    });

    expect(experiment.verdict).toBe("rejected");
    expect(experiment.reasons.length).toBeGreaterThan(0);
    expect(experiment.rolledBack).toBe(true);
    expect(rejected).toEqual(["exp-worse"]);
    // overlay 恢复原状（原先不存在 → 回滚后不存在）
    expect(existsSync(promptOverlayPath(dataRoot))).toBe(false);
    expect(overlayIsEmpty(dataRoot)).toBe(true);

    // 拒绝留痕：台账与文件都能查到
    const ledger = listExperiments(dataRoot, { verdict: "rejected" });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.cardId).toBe(CARD.id);
    expect(ledger[0]!.reasons.join("\n")).toContain("回归");
    expect(existsSync(experimentsLedgerPath(dataRoot))).toBe(true);
  });

  test("无差异 → adopted（不劣于基线即采纳）", async () => {
    const experiment = await runVerificationGate({
      dataRoot,
      card: CARD,
      id: "exp-same",
      runBaseline: async (which) => fakeRun({ setName: which, passRate: 0.75, completion: 80 }),
      runCandidate: async (which) => fakeRun({ setName: which, passRate: 0.75, completion: 80 }),
    });
    expect(experiment.verdict).toBe("adopted");
    expect(experiment.rolledBack).toBe(false);
  });

  test("成本上限：超限即中止 → rejected + 回滚 + 中止原因留痕", async () => {
    const experiment = await runVerificationGate({
      dataRoot,
      card: CARD,
      id: "exp-cost",
      limits: { maxExperimentTokens: 100 },
      runBaseline: async (which) =>
        fakeRun({ setName: which, passRate: 1, completion: 90, tokens: 200 }),
      runCandidate: async (which) =>
        fakeRun({ setName: which, passRate: 1, completion: 95, tokens: 200 }),
    });

    expect(experiment.verdict).toBe("rejected");
    expect(experiment.aborted).toBe(true);
    expect(experiment.reasons.join("\n")).toContain("成本超限");
    expect(experiment.rolledBack).toBe(true);
    expect(existsSync(promptOverlayPath(dataRoot))).toBe(false);
    expect(listExperiments(dataRoot, { verdict: "rejected" })).toHaveLength(1);
  });

  test("实验异常（候选跑挂）→ rejected + 回滚，不把半应用 overlay 留在数据根", async () => {
    const experiment = await runVerificationGate({
      dataRoot,
      card: CARD,
      id: "exp-throw",
      runBaseline: async (which) => fakeRun({ setName: which, passRate: 1, completion: 90 }),
      runCandidate: async () => {
        throw new Error("候选执行器崩了");
      },
    });

    expect(experiment.verdict).toBe("rejected");
    expect(experiment.reasons.join("\n")).toContain("实验异常");
    expect(experiment.rolledBack).toBe(true);
    expect(existsSync(promptOverlayPath(dataRoot))).toBe(false);
  });

  test("基线 overlay 有内容时，拒绝后逐字符恢复原内容", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dataRoot, "reflect"), { recursive: true });
    const original = "## 本项目学到的规则\n\n- 历史规则\n";
    writeFileSync(promptOverlayPath(dataRoot), original, "utf-8");

    const experiment = await runVerificationGate({
      dataRoot,
      card: CARD,
      id: "exp-restore",
      runBaseline: async (which) => fakeRun({ setName: which, passRate: 1, completion: 90 }),
      runCandidate: async (which) => fakeRun({ setName: which, passRate: 0, completion: 10 }),
    });

    expect(experiment.verdict).toBe("rejected");
    expect(readFileSync(promptOverlayPath(dataRoot), "utf-8")).toBe(original);
  });

  test("每次实验都写入 experiments/<id>.json（采纳也留痕）", async () => {
    await runVerificationGate({
      dataRoot,
      card: CARD,
      id: "exp-file",
      runBaseline: async (which) => fakeRun({ setName: which, passRate: 0.5, completion: 50 }),
      runCandidate: async (which) => fakeRun({ setName: which, passRate: 1, completion: 95 }),
    });
    const file = join(dataRoot, "reflect", "experiments", "exp-file.json");
    expect(existsSync(file)).toBe(true);
    const record = JSON.parse(readFileSync(file, "utf-8"));
    expect(record.id).toBe("exp-file");
    expect(record.verdict).toBe("adopted");
  });

  test("台账按卡片过滤（同一卡多次实验可回溯）", async () => {
    for (const id of ["exp-a", "exp-b"]) {
      await runVerificationGate({
        dataRoot,
        card: CARD,
        id,
        runBaseline: async (which) => fakeRun({ setName: which, passRate: 0.5, completion: 50 }),
        runCandidate: async (which) => fakeRun({ setName: which, passRate: 0.5, completion: 50 }),
      });
    }
    expect(listExperiments(dataRoot, { cardId: CARD.id })).toHaveLength(2);
  });
});

describe("默认上限", () => {
  test("默认倍率与容差是有明确取值的常量（可被验收核对）", () => {
    expect(DEFAULT_GATE_LIMITS.maxStepsRatio).toBe(1.5);
    expect(DEFAULT_GATE_LIMITS.maxTokensRatio).toBe(1.5);
    expect(DEFAULT_GATE_LIMITS.maxDurationRatio).toBe(2);
    expect(DEFAULT_GATE_LIMITS.epsilon).toBeLessThan(1);
  });
});
