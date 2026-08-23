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
  mergeJudgeResults,
  buildSessionSummary,
  parseJudgeResponse,
} from "./judge.ts";
export type { JudgeOptions, MessageTraceInfo } from "./judge.ts";
export { parseTestSet, listTestSets } from "./testset.ts";
export type { TestCase, TestSet } from "./testset.ts";

import { findLogFile, findAllLogFiles, parseLogFile, analyzeRecords } from "./analyzer.ts";
import { outputReport } from "./reporter.ts";
import { runSelfOptimize, renderSuggestionsMarkdown } from "./self-optimize.ts";
import { judgeAllSessions, mergeJudgeResults } from "./judge.ts";
import { listTestSets } from "./testset.ts";
import { resolveDataRoot } from "@fengagent/shared";
import { join } from "node:path";
import type { LLMClient } from "@fengagent/llm";
import type { AnalysisResult, JudgeResult } from "./analyzer.ts";

/**
 * 运行评测分析。
 *
 * @param options - 评测选项
 */
export async function runEval(options?: {
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
}): Promise<void> {
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
    const date = options?.date ?? new Date().toISOString().slice(0, 10);
    console.error(`未找到日志文件。请先运行对话生成 llm-trace-${date}.jsonl`);
    console.error(`日志目录: ${options?.logDir ?? join(resolveDataRoot(), "logs")}`);
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
      }
    } else if (options?.optimize) {
      console.log("\n==== 自优化诊断 ====");
      const plan = runSelfOptimize(result, { writeReport: true });
      console.log(renderSuggestionsMarkdown(plan));
    }
  }
}

// CLI 入口
if (import.meta.main) {
  const args = process.argv.slice(2);
  const options: {
    date?: string;
    all?: boolean;
    file?: string;
    excludeModels?: string[];
    optimize?: boolean;
    judge?: boolean;
  } = {};

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
    }
  }

  // judge 模式需要 LLM 客户端
  if (options.judge) {
    const { loadConfig } = await import("@fengagent/core");
    const { createClientFromEnv } = await import("@fengagent/llm");
    try {
      const config = await loadConfig();
      const { buildEnvForLLM } = await import("@fengagent/server");
      const envForLLM = buildEnvForLLM(config);
      const { client } = createClientFromEnv(envForLLM);
      (options as { llmClient?: LLMClient }).llmClient = client;
    } catch {
      // 配置不可用时仍运行（judge 会显示警告）
    }
  }

  runEval(options).catch((err) => {
    console.error("评测失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
