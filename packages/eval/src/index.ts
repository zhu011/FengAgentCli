/**
 * @fengagent/eval — Agent 测评模块入口
 *
 * 读取 LLM trace 日志，分析工具选择准确率、token 用量、耗时等，
 * 输出 Markdown 分析报告。
 *
 * 用法：
 *   bun run eval                                              # 分析今天的日志
 *   bun run eval --date=2026-08-13                            # 分析指定日期
 *   bun run eval --all                                        # 分析所有日志
 *   bun run eval --file=<dataRoot>/logs/llm-trace-2026-08-13.jsonl  # 分析指定文件
 *   bun run eval --optimize                                   # 分析 + 自优化诊断（输出建议报告）
 *   bun run eval --judge                                      # 全链路：测试集→LLM-judge→diagnose→建议报告
 */

export { parseLogFile, findLogFile, findAllLogFiles, analyzeRecords } from "./analyzer.ts";
export type { TraceRecord, SessionTrace, AnalysisResult, ModelComparison, JudgeResult } from "./analyzer.ts";
export { generateMarkdownReport, outputReport } from "./reporter.ts";
export {
  diagnose,
  runSelfOptimize,
  renderSuggestionsMarkdown,
  optimizationsDir,
  DEFAULT_THRESHOLDS,
} from "./self-optimize.ts";
export type {
  OptimizationSuggestion,
  OptimizationPlan,
  OptimizationThresholds,
  SuggestionType,
  Severity,
} from "./self-optimize.ts";
export {
  judgeSession,
  judgeAllSessions,
  judgeMessage,
  judgeCaseTrace,
  buildCaseSummary,
  mergeJudgeResults,
  buildSessionSummary,
  parseJudgeResponse,
  LLM_FAILURE_NOTE_PREFIX,
} from "./judge.ts";
export type { JudgeOptions, CaseJudgeOptions, MessageTraceInfo } from "./judge.ts";
export { parseTestSet, listTestSets } from "./testset.ts";
export type { TestCase, TestSet } from "./testset.ts";

// judge 结论 → 自省卡草稿（RSI P0 的「卡从哪来」；纯映射，不落盘）
export {
  cardsFromJudgeResults,
  triggerForConclusion,
  lessonForConclusion,
} from "./reflect-cards.ts";
export type { ReflectionCardDraft, CardsFromJudgeOptions } from "./reflect-cards.ts";

// 产卡跳：测试集真跑 → 判分 → 产卡 → 入库（RSI 运行态接线）
export { runTestSetCards, reflectTraceDir } from "./reflect-pipeline.ts";
export type { RunTestSetCardsOptions, TestSetCardRun } from "./reflect-pipeline.ts";

// 测试集执行器（RSI P1 地基：用例 → 隔离会话真跑 → 采 trace → 判分）
export {
  runTestSet,
  aggregateRun,
  summarizeEvents,
  createAgentSessionRunner,
  caseIdOf,
  makeTestSet,
} from "./runner.ts";
export type {
  AgentSessionRunner,
  CaseOutcome,
  CaseTrace,
  RunnerVerdict,
  RunTestSetOptions,
  TestSetRun,
} from "./runner.ts";

// 最小变更器（写回边界：只写数据根 prompt-overlay.md）
export {
  applyPromptOverlayChange,
  assertWriteBoundary,
  promptOverlayPath,
  proposePromptOverlayChange,
  readPromptOverlay,
  restorePromptOverlay,
  PROMPT_OVERLAY_BASENAME,
} from "./mutator.ts";
export type { OverlayChange, OverlaySnapshot } from "./mutator.ts";

// 验证闸（Self-Harness 式：held-in/held-out 双集 + 护栏 + 成本上限 + 回滚/留痕）
export {
  compareGate,
  toGateMetrics,
  runVerificationGate,
  overlappingCaseIds,
  persistExperiment,
  listExperiments,
  experimentsDir,
  experimentsLedgerPath,
  overlayIsEmpty,
  DEFAULT_GATE_LIMITS,
} from "./gate.ts";
export type {
  DualSetMetrics,
  GateExperiment,
  GateLimits,
  GateMetrics,
  RunVerificationGateOptions,
} from "./gate.ts";
export {
  NON_PRODUCTION_SOURCES,
  traceSourceOf,
  isTestTraceRecord,
  splitTraceRecords,
} from "./trace-source.ts";
export type { TraceFilterResult } from "./trace-source.ts";

import { findLogFile, findAllLogFiles, parseLogFile, analyzeRecords } from "./analyzer.ts";
import { outputReport } from "./reporter.ts";
import { runSelfOptimize, renderSuggestionsMarkdown } from "./self-optimize.ts";
import { judgeAllSessions, judgeCaseTrace, mergeJudgeResults } from "./judge.ts";
import { listTestSets } from "./testset.ts";
import { runTestSetCards, reflectTraceDir } from "./reflect-pipeline.ts";
import type { AgentSessionRunner, CaseTrace, RunnerVerdict } from "./runner.ts";
import type { ReflectionCardDraft } from "./reflect-cards.ts";
import { resolveDataRoot, resolveReflectStoreOptions } from "@fengagent/shared";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "@fengagent/core";
import type { LLMClient } from "@fengagent/llm";
import type { AnalysisResult, JudgeResult } from "./analyzer.ts";

/** 评测选项 */
export interface RunEvalOptions {
  date?: string;
  all?: boolean;
  file?: string;
  logDir?: string;
  excludeModels?: string[];
  /** 评测后运行自优化诊断（写入 <dataRoot>/optimizations/ 建议报告） */
  optimize?: boolean;
  /** 运行 LLM-judge 全链路（测试集→analyze→judge→diagnose→建议报告） */
  judge?: boolean;
  /** LLM 客户端（judge 模式必需） */
  llmClient?: LLMClient;
  /** 测试集目录（默认 <dataRoot>/testsets） */
  testsetsDir?: string;
  /**
   * 找不到日志文件时抛错而不是 `process.exit(1)`。
   *
   * CLI 入口需要 exit（脚本语义），但被服务端嵌入调用（WebUI「生成评测报告」）
   * 时 exit 会直接杀掉 HTTP 服务进程，故嵌入方传 true 走异常路径。
   */
  throwOnMissingLog?: boolean;

  /* ── RSI 产卡跳（运行态接线）：测试集真跑 → 判分 → 自省卡 → 入库 ── */

  /**
   * 隔离会话执行器（生产 = 真 Agent，每条用例一个新会话）。
   *
   * 给了它 + {@link RunEvalOptions.ingestCard}，`--judge` 才会真的执行测试集用例
   * 并产卡；不给则保持旧行为（只列测试集名字）。
   */
  caseRunner?: AgentSessionRunner;
  /** 用例判分（默认 `judgeCaseTrace` + `llmClient`） */
  caseJudge?: (trace: CaseTrace) => RunnerVerdict | Promise<RunnerVerdict>;
  /** 用例判分用的模型（默认拿不到时判分器会退回客户端默认模型） */
  caseJudgeModel?: string;
  /** 产卡入库口（`(draft) => reflectionStore.ingest(draft)`） */
  ingestCard?: (draft: ReflectionCardDraft) => unknown;
  /** 每个测试集最多跑多少条用例（成本闸，默认 5） */
  maxCasesPerTestSet?: number;
  /** 数据根（产卡与 trace 落点；默认 resolveDataRoot()） */
  dataRoot?: string;
}

/**
 * 运行评测分析。
 *
 * @param options - 评测选项
 */
export async function runEval(options?: RunEvalOptions): Promise<void> {
  let files: string[];

  if (options?.file) {
    files = [options.file];
  } else if (options?.all) {
    files = findAllLogFiles(options?.logDir);
  } else {
    const file = findLogFile(options?.logDir, options?.date);
    files = file ? [file] : [];
  }

  if (files.length === 0) {
    // RSI 产卡跳不依赖历史 trace 日志：有测试集照样真跑产卡（默认路径要能通）
    if (hasCardPipeline(options)) {
      console.log("\n==== 未找到 trace 日志，跳过历史会话分析 ====");
      await runTestsetsIntoCards(options!);
      return;
    }
    const date = options?.date ?? new Date().toISOString().slice(0, 10);
    const logsDir = options?.logDir ?? join(resolveDataRoot(), "logs");
    if (options?.throwOnMissingLog) {
      throw new Error(`未找到日志文件 llm-trace-${date}.jsonl（日志目录: ${logsDir}）`);
    }
    console.error(`未找到日志文件。请先运行对话生成 llm-trace-${date}.jsonl`);
    console.error(`日志目录: ${logsDir}`);
    console.error(`也可使用 --file=<路径> 指定日志文件`);
    process.exit(1);
  }

  for (const file of files) {
    console.log(`\n分析日志: ${file}`);
    let records = parseLogFile(file);

    // 过滤掉指定的模型（如测试 mock 模型）
    if (options?.excludeModels && options.excludeModels.length > 0) {
      const before = records.length;
      records = records.filter((r) => !options.excludeModels!.includes(r.model));
      const filtered = before - records.length;
      if (filtered > 0) {
        console.log(`  已过滤 ${filtered} 条记录（模型: ${options.excludeModels.join(", ")}）`);
      }
    }

    if (records.length === 0) {
      console.log("  日志为空，跳过");
      continue;
    }

    const result = analyzeRecords(records, file);
    outputReport(result);

    if (options?.judge) {
      console.log("\n==== LLM-judge 评测 ====");
      if (!options.llmClient) {
        console.error("  ⚠️ 未提供 LLM 客户端，跳过 judge。请通过 --judge 配合 LLM 配置使用。");
      } else {
        // 显示测试集概览（如有）
        const testsetsDir = options.testsetsDir ?? join(resolveDataRoot(), "testsets");
        const testsets = listTestSets(testsetsDir);
        if (testsets.length > 0) {
          console.log(`  测试集: ${testsets.map((t) => `${t.name}(${t.cases.length})`).join(", ")}`);
        }

        // judge 全部会话
        const judgeResults: JudgeResult[] = await judgeAllSessions(result.sessions, {
          llmClient: options.llmClient,
        });

        // 合并到 AnalysisResult
        const merged: AnalysisResult = mergeJudgeResults(result, judgeResults);
        console.log(`  judge 完成: ${judgeResults.length} 条结果`);

        // diagnose（含 judge 规则）
        console.log("\n==== 自优化诊断（含 judge 规则）====");
        const plan = runSelfOptimize(merged, { writeReport: true });
        console.log(renderSuggestionsMarkdown(plan));

        // RSI 产卡跳：测试集真跑 → 判分 → 自省卡 → 入库（默认路径的闭环入口）
        if (hasCardPipeline(options)) {
          await runTestsetsIntoCards(options);
        } else {
          console.log(
            "\n提示：未接线用例执行器/入库口 —— 测试集只列名不真跑（产卡跳在 CLI 入口自动接线）。",
          );
        }
      }
    } else if (options?.optimize) {
      console.log("\n==== 自优化诊断 ====");
      const plan = runSelfOptimize(result, { writeReport: true });
      console.log(renderSuggestionsMarkdown(plan));
    }
  }
}

/* ------------------------------ RSI 产卡跳 ------------------------------ */

/** 产卡链路是否接线（执行器 + 入库口齐备） */
function hasCardPipeline(options?: RunEvalOptions): boolean {
  return options?.caseRunner !== undefined && options.ingestCard !== undefined;
}

/**
 * 测试集真跑 → 判分 → 产卡 → 入库（`runEval --judge` 的闭环那一跳）。
 *
 * 没有测试集时如实说明并返回（不静默成功）。
 */
async function runTestsetsIntoCards(options: RunEvalOptions): Promise<void> {
  const dataRoot = options.dataRoot ?? resolveDataRoot();
  const testsetsDir = options.testsetsDir ?? join(dataRoot, "testsets");
  const testSets = listTestSets(testsetsDir).filter((t) => t.valid && t.cases.length > 0);

  console.log("\n==== 测试集真跑 → 自省卡（RSI 产卡跳）====");
  if (testSets.length === 0) {
    console.log(`  测试集: 无可用用例（目录 ${testsetsDir}），跳过真跑产卡`);
    return;
  }
  const llmClient = options.llmClient;
  const caseJudge =
    options.caseJudge ??
    (llmClient === undefined
      ? undefined
      : (trace: CaseTrace) =>
          judgeCaseTrace(trace, {
            llmClient,
            ...(options.caseJudgeModel === undefined ? {} : { model: options.caseJudgeModel }),
          }));
  if (caseJudge === undefined) {
    console.error("  ⚠️ 无用例判分器（既没给 caseJudge，也没有 LLM 客户端），跳过真跑产卡");
    return;
  }

  const workdir = join(dataRoot, "reflect", "eval-work");
  mkdirSync(workdir, { recursive: true });

  const results = await runTestSetCards({
    testSets,
    agent: options.caseRunner!,
    judge: caseJudge,
    ingestCard: options.ingestCard,
    workdir,
    traceDir: (name) => reflectTraceDir(dataRoot, name),
    maxCases: options.maxCasesPerTestSet ?? 5,
  });

  let drafts = 0;
  let ingested = 0;
  for (const item of results) {
    drafts += item.drafts.length;
    ingested += item.ingested;
    console.log(
      `  测试集 ${item.setName}: 跑 ${item.run.cases.length} 条` +
      `（通过 ${item.run.passed} / 失败 ${item.run.failed}，` +
      `${item.run.meanSteps.toFixed(1)} 步、${item.run.totalTokens} token）` +
      ` → 产卡 ${item.drafts.length} 张、入库 ${item.ingested} 张`,
    );
    for (const outcome of item.run.cases) {
      if (outcome.passed) continue;
      console.log(
        `    ✗ ${outcome.caseId}: ${outcome.verdict.conclusion}` +
        `（${outcome.verdict.completionScore} 分）${outcome.verdict.note ?? ""}`,
      );
    }
  }
  console.log(`  合计: 产卡 ${drafts} 张，入库 ${ingested} 张（库: ${join(dataRoot, "reflect", "reflections.db")}）`);
  if (drafts === 0) {
    console.log("  说明: 所有用例都判为 completed —— 没有外部信号就不产卡（铁律 1）。");
  }
}

// CLI 入口
if (import.meta.main) {
  const args = process.argv.slice(2);
  const options: RunEvalOptions = {};
  /** 每个测试集最多跑多少条用例（默认 5） */
  let maxCasesPerTestSet: number | undefined;

  for (const arg of args) {
    if (arg.startsWith("--date=")) {
      options.date = arg.slice("--date=".length);
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg.startsWith("--file=")) {
      options.file = arg.slice("--file=".length);
    } else if (arg.startsWith("--exclude-model=")) {
      options.excludeModels = arg.slice("--exclude-model=".length).split(",").map((s) => s.trim());
    } else if (arg === "--optimize") {
      options.optimize = true;
    } else if (arg === "--judge") {
      options.judge = true;
    } else if (arg.startsWith("--max-cases=")) {
      const parsed = Number.parseInt(arg.slice("--max-cases=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) maxCasesPerTestSet = parsed;
    }
  }
  if (maxCasesPerTestSet !== undefined) options.maxCasesPerTestSet = maxCasesPerTestSet;

  // judge 模式需要 LLM 客户端；并把 RSI 产卡跳接到真实运行路径上
  // （测试集真跑要用真 Agent、产卡要用真 ReflectionStore —— 都在 CLI 这个装配根接线）
  if (options.judge) {
    const { loadConfig } = await import("@fengagent/core");
    const { createClientFromEnv } = await import("@fengagent/llm");
    try {
      const config = await loadConfig();
      const { buildEnvForLLM } = await import("@fengagent/server");
      const envForLLM = buildEnvForLLM(config);
      const { client } = createClientFromEnv(envForLLM);
      options.llmClient = client;
      // 判分用与被测 Agent 同一个模型（空 model 会被 provider 路由到默认模型，可能返回空判定）
      options.caseJudgeModel = config.model;

      // ── 产卡跳接线：真跑用例（真 Agent）+ 真产卡（真 SQLite 仓） ──
      try {
        const wired = await wireCardPipeline({ config, llmClient: client });
        options.caseRunner = wired.caseRunner;
        options.ingestCard = wired.ingestCard;
        options.dataRoot = wired.dataRoot;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  ⚠️ 产卡通道不可用（${message}）：本轮只评历史 trace，不产卡`);
      }
    } catch {
      // 配置不可用时仍运行（judge 会显示警告）
    }
  }

  runEval(options).catch((err) => {
    console.error("评测失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

/**
 * 把产卡跳接到真实运行路径（CLI 装配根）。
 *
 * 组装：数据根 → `ReflectionStore`（真 SQLite）→ 每条用例一个真 `Agent`
 * （隔离会话、不持久化会话库，避免评测污染会话列表）→ `runTestSetCards`。
 * 被评测的 Agent 自己也吃自省注入并记账 —— 闭环在评测路径上同样成立。
 */
export async function wireCardPipeline(args: {
  config: Config;
  llmClient: LLMClient;
}): Promise<{
  caseRunner: AgentSessionRunner;
  ingestCard: (draft: ReflectionCardDraft) => unknown;
  dataRoot: string;
}> {
  const { Agent, ReflectionStore } = await import("@fengagent/agent");
  const {
    createToolRegistry,
    registerBuiltinTools,
    createToolExecutor,
  } = await import("@fengagent/tools");
  const { createContextManager } = await import("@fengagent/context");
  const { createAgentSessionRunner } = await import("./runner.ts");

  // 数据根按「跑 eval 的当前目录」定位（与产卡/入户口径一致）；
  // 但**用例自己的工作目录必须是隔离目录** —— 由 `ctx.workdir` 传进来
  // （`runTestSet` 会给每条用例分 `<隔离根>/<caseId>`），用例的工具读写因此
  // 不会落到真实工作区，也不会在用例之间互相污染。
  const cwd = process.cwd();
  const dataRoot = resolveDataRoot({ workdir: cwd, configDataDir: args.config.dataDir });
  const store = new ReflectionStore(
    join(dataRoot, "reflect", "reflections.db"),
    // `FENG_REFLECT_TTL_MS` 真正接线：存活期由环境变量决定，改它即生效
    resolveReflectStoreOptions(),
  );

  /** 每条用例一个全新 Agent（隔离会话 + 隔离 workdir + 全新系统提示缓存 → 重新取可注入卡） */
  const makeCaseAgent = (workdir: string = cwd) => {
    const toolRegistry = createToolRegistry();
    registerBuiltinTools(toolRegistry);
    const contextManager = createContextManager({
      config: {
        contextWindow: args.config.contextWindow,
        compactThreshold: args.config.compactThreshold,
        compactKeepTokens: args.config.compactKeepTokens,
        disableCompact: args.config.disableCompact,
        smallModel: args.config.smallModel,
      },
      summaryGenerator: args.llmClient,
      systemContextOptions: {
        workdir,
        loadMemory: false,
        loadAgentsMd: false,
        reflectDataRoot: dataRoot,
        reflections: () => {
          try {
            store.expireDue();
            return store.selectForInjection({ at: Date.now() });
          } catch {
            return [];
          }
        },
      },
      onReflectionInjected: ({ sessionId, cardIds }) => {
        if (cardIds.length === 0) return;
        try {
          store.recordInjection(cardIds, sessionId);
        } catch {
          // 记账失败不影响评测
        }
      },
    });
    return new Agent({
      llmClient: args.llmClient,
      toolRegistry,
      toolExecutor: createToolExecutor(),
      contextManager,
      config: args.config,
      workdir,
    });
  };

  return {
    caseRunner: createAgentSessionRunner((ctx) => makeCaseAgent(ctx.workdir)),
    ingestCard: (draft) => store.ingest(draft),
    dataRoot,
  };
}
