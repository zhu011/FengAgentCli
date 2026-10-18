/**
 * @fengagent/eval — 测试集 → 真跑 → 产卡 → 入库（RSI 运行态接线的「产卡跳」）
 *
 * 这就是验收里缺的那一跳：`runEval --judge` 以前只把测试集**列个名字**，judge 评的是
 * 历史 trace，`cardsFromJudgeResults` / `ReflectionStore.ingest` 在生产代码零调用 ——
 * 于是默认运行下 `reflections.db` 永远是空的。本模块把它们串起来：
 *
 * 1. 读测试集（`TestSet` 已解析）→ 2. `runTestSet` 真跑每条用例（隔离会话 + 真 trace）
 * → 3. 用例判分（生产 = LLM-judge；测试 = 确定性判分）→ 4. `cardsFromJudgeResults`
 * 映射成卡草稿 → 5. `ingestCard` 落库（由持有 `ReflectionStore` 的调用方注入 ——
 * eval 包不依赖 agent）。
 *
 * 三个刻意的边界：
 *
 * - **不产卡的失败不入库**：judge 自己挂了（note 以 `LLM_FAILURE_NOTE_PREFIX` 开头）
 *   `cardsFromJudgeResults` 已过滤，这里是第二次防线（草稿为空即不调 sink）。
 * - **证据指向真实 trace**：`traceRef`（落盘路径）进 `evidence.ref`，可回查。
 * - **无 sink 也照跑**：只给 `agent` + `judge` 时返回草稿（dry-run 用），不落库。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JudgeResult } from "./analyzer.ts";
import { cardsFromJudgeResults, type ReflectionCardDraft } from "./reflect-cards.ts";
import {
  runTestSet,
  type AgentSessionRunner,
  type CaseOutcome,
  type CaseTrace,
  type RunnerVerdict,
  type TestSetRun,
} from "./runner.ts";
import type { TestSet } from "./testset.ts";

/** 单个测试集的「真跑 + 产卡」结果 */
export interface TestSetCardRun {
  /** 测试集名 */
  setName: string;
  /** 真跑结果（逐用例 trace + 聚合指标） */
  run: TestSetRun;
  /** 生成的卡片草稿（未入库，`ingested` 为实际入库数） */
  drafts: ReflectionCardDraft[];
  /** 实际入库张数（无 sink 或 sink 返回 null 时不计数） */
  ingested: number;
}

/** 产卡链路选项 */
export interface RunTestSetCardsOptions {
  /** 待执行测试集（至少一个） */
  testSets: readonly TestSet[];
  /** 隔离会话执行器（生产 = 真 Agent；测试 = mock） */
  agent: AgentSessionRunner;
  /** 用例判分（生产 = LLM-judge） */
  judge: (trace: CaseTrace) => RunnerVerdict | Promise<RunnerVerdict>;
  /**
   * 入库口（调用方持有 `ReflectionStore`，传 `(draft) => store.ingest(draft)`）。
   *
   * 不传 = 只产草稿不落库（dry-run）；返回 `null`/`undefined` 视为「证据门拒收」。
   */
  ingestCard?: (draft: ReflectionCardDraft) => unknown;
  /** 隔离工作目录（默认 `process.cwd()`） */
  workdir?: string;
  /** trace 落盘目录（按测试集名给，默认不落盘） */
  traceDir?: (setName: string) => string | undefined;
  /** 每个测试集最多跑多少条用例（成本闸） */
  maxCases?: number;
  /** 单次执行 token 上限 */
  maxTokens?: number;
  /** 单次执行耗时上限（毫秒） */
  maxDurationMs?: number;
  /** 写回落点（默认 `prompt-overlay.md`） */
  target?: string;
  /** 每个测试集跑完的回调（打印进度用） */
  onRun?: (setName: string, run: TestSetRun) => void;
}

/** judge 六态枚举（用例判分结论归一化，非法值按 failed 处理） */
const CASE_CONCLUSIONS = new Set([
  "completed",
  "partial",
  "failed",
  "tool_misused",
  "unsafe",
  "inefficient",
]);

function concreteConclusion(conclusion: string): JudgeResult["conclusion"] {
  const value = conclusion.trim().toLowerCase();
  return (CASE_CONCLUSIONS.has(value) ? value : "failed") as JudgeResult["conclusion"];
}

/** 用例结果 → judge 结论（`cardsFromJudgeResults` 的输入口径） */
function judgeResultOf(outcome: CaseOutcome, setName: string): JudgeResult {
  return {
    // 会话 id 带上测试集名：不同集的同名用例不会互相覆盖，证据指针也不歧义
    sessionId: `${setName}/${outcome.caseId}`,
    completionScore: outcome.verdict.completionScore,
    correctnessScore: outcome.verdict.correctnessScore ?? 0,
    conclusion: concreteConclusion(outcome.verdict.conclusion),
    ...(outcome.verdict.note === undefined ? {} : { note: outcome.verdict.note }),
  };
}

/**
 * 跑测试集 → 按 judge 结论产卡 → 落库。
 *
 * @param options - 产卡链路选项
 * @returns 每个测试集的真跑结果与产卡/入库数
 */
export async function runTestSetCards(
  options: RunTestSetCardsOptions,
): Promise<TestSetCardRun[]> {
  const results: TestSetCardRun[] = [];

  for (const testSet of options.testSets) {
    if (!testSet.valid || testSet.cases.length === 0) continue;

    const dir = options.traceDir?.(testSet.name);
    if (dir) mkdirSync(dir, { recursive: true });

    const run = await runTestSet({
      testSet,
      agent: options.agent,
      judge: options.judge,
      ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
      ...(dir === undefined ? {} : { traceDir: dir }),
      ...(options.maxCases === undefined ? {} : { maxCases: options.maxCases }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
    });

    options.onRun?.(testSet.name, run);

    // traceRef → 证据指针（真跑出来的 trace 文件路径）
    const traceRefBySession = new Map<string, string>();
    const judgeResults: JudgeResult[] = [];
    for (const outcome of run.cases) {
      const result = judgeResultOf(outcome, testSet.name);
      judgeResults.push(result);
      if (outcome.traceRef !== "" && !outcome.traceRef.startsWith("memory:")) {
        traceRefBySession.set(result.sessionId, outcome.traceRef);
      }
    }

    const drafts = cardsFromJudgeResults(judgeResults, {
      ...(options.target === undefined ? {} : { target: options.target }),
      evidenceRef: (result) => traceRefBySession.get(result.sessionId),
    });

    let ingested = 0;
    if (options.ingestCard) {
      for (const draft of drafts) {
        // 二次防线：无证据的草稿到不了库里（`ReflectionStore.ingest` 也再判一次）
        if (draft.evidence.length === 0) continue;
        const stored = options.ingestCard(draft);
        if (stored !== null && stored !== undefined) ingested++;
      }
    }

    results.push({ setName: testSet.name, run, drafts, ingested });
  }

  return results;
}

/** trace 目录（`<数据根>/reflect/traces/<测试集名>`，文件名安全化） */
export function reflectTraceDir(dataRoot: string, setName: string): string {
  return join(dataRoot, "reflect", "traces", setName.replace(/[^A-Za-z0-9._-]/g, "_"));
}
