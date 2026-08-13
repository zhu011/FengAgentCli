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
 *   bun run eval --file=.fengagent/logs/llm-trace-2026-08-13.jsonl  # 分析指定文件
 */

export { parseLogFile, findLogFile, findAllLogFiles, analyzeRecords } from "./analyzer.ts";
export type { TraceRecord, SessionTrace, AnalysisResult } from "./analyzer.ts";
export { generateMarkdownReport, outputReport } from "./reporter.ts";

import { findLogFile, findAllLogFiles, parseLogFile, analyzeRecords } from "./analyzer.ts";
import { outputReport } from "./reporter.ts";

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
}): Promise<void> {
  let files: string[];

  if (options?.file) {
    // --file：直接指定日志文件路径
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
    console.error(`日志目录: ${options?.logDir ?? ".fengagent/logs/"}`);
    console.error(`也可使用 --file=<路径> 指定日志文件`);
    process.exit(1);
  }

  for (const file of files) {
    console.log(`\n分析日志: ${file}`);
    const records = parseLogFile(file);

    if (records.length === 0) {
      console.log("  日志为空，跳过");
      continue;
    }

    const result = analyzeRecords(records, file);
    outputReport(result);
  }
}

// CLI 入口
if (import.meta.main) {
  const args = process.argv.slice(2);
  const options: { date?: string; all?: boolean; file?: string } = {};

  for (const arg of args) {
    if (arg.startsWith("--date=")) {
      options.date = arg.slice("--date=".length);
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg.startsWith("--file=")) {
      options.file = arg.slice("--file=".length);
    }
  }

  runEval(options).catch((err) => {
    console.error("评测失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
