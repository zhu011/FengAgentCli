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

import { findLogFile, findAllLogFiles, parseLogFile, analyzeRecords } from "./analyzer.ts";
import { outputReport } from "./reporter.ts";
import { runSelfOptimize, renderSuggestionsMarkdown } from "./self-optimize.ts";
import { resolveDataRoot } from "@fengagent/shared";
import { join } from "node:path";

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

    if (options?.optimize) {
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
    }
  }

  runEval(options).catch((err) => {
    console.error("评测失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
