/**
 * @fengagent/eval — 评测报告生成器
 *
 * 将分析结果输出为 console 表格 + Markdown 文件报告。
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AnalysisResult } from "./analyzer.ts";

/**
 * 生成 Markdown 格式的分析报告。
 *
 * @param result - 分析结果
 * @returns Markdown 字符串
 */
export function generateMarkdownReport(result: AnalysisResult): string {
  const lines: string[] = [];

  lines.push("# FengAgentCli Agent 测评报告");
  lines.push("");
  lines.push(`> 生成时间：${new Date().toISOString()}`);
  lines.push(`> 日志文件：\`${result.logFile}\``);
  lines.push("");

  // 概览
  lines.push("## 概览");
  lines.push("");
  lines.push("| 指标 | 值 |");
  lines.push("|------|-----|");
  lines.push(`| 会话数 | ${result.sessionCount} |`);
  lines.push(`| LLM 调用次数 | ${result.totalLlmCalls} |`);
  lines.push(`| 总耗时 | ${(result.totalDurationMs / 1000).toFixed(2)}s |`);
  lines.push(`| 平均每次调用耗时 | ${result.avgDurationMs}ms |`);
  lines.push(`| 总输入 Token | ${result.totalInputTokens} |`);
  lines.push(`| 总输出 Token | ${result.totalOutputTokens} |`);
  lines.push(`| 平均输入 Token | ${result.avgInputTokens} |`);
  lines.push(`| 平均输出 Token | ${result.avgOutputTokens} |`);
  lines.push("");

  // 模型准确率对比
  if (result.modelComparisons.length > 0) {
    lines.push("## 模型准确率对比");
    lines.push("");
    const hasCache = result.totalCacheReadTokens > 0 || result.totalCacheCreationTokens > 0;
    if (hasCache) {
      lines.push(
        "| 模型 | 总调用 | 工具调用 | 工具成功率 | 错误率 | 任务完成率 | 平均耗时 | 平均输入 | 平均输出 | Cache 读取 | Cache 命中率 |",
      );
      lines.push(
        "|------|--------|---------|-----------|--------|-----------|---------|---------|---------|-----------|-------------|",
      );
    } else {
      lines.push(
        "| 模型 | 总调用 | 工具调用 | 工具成功率 | 错误率 | 任务完成率 | 平均耗时 | 平均输入 | 平均输出 |",
      );
      lines.push(
        "|------|--------|---------|-----------|--------|-----------|---------|---------|---------|",
      );
    }
    for (const m of result.modelComparisons) {
      const row = [
        m.model,
        String(m.totalCalls),
        String(m.toolCallCount),
        `${m.toolSuccessRate}%`,
        `${m.errorRate}%`,
        `${m.taskCompletionRate}%`,
        `${m.avgDurationMs}ms`,
        String(m.avgInputTokens),
        String(m.avgOutputTokens),
      ];
      if (hasCache) {
        row.push(String(m.cacheReadTokens));
        row.push(`${m.cacheHitRate}%`);
      }
      lines.push(`| ${row.join(" | ")} |`);
    }
    lines.push("");
  }

  // KV Cache 命中率
  if (result.totalCacheReadTokens > 0 || result.totalCacheCreationTokens > 0) {
    lines.push("## KV Cache 命中率");
    lines.push("");
    lines.push("| 指标 | 值 |");
    lines.push("|------|-----|");
    lines.push(`| Cache 读取 Token 总数 | ${result.totalCacheReadTokens} |`);
    lines.push(`| Cache 创建 Token 总数 | ${result.totalCacheCreationTokens} |`);
    lines.push(`| 总输入 Token | ${result.totalInputTokens} |`);
    lines.push(`| Cache 命中率 | ${result.cacheHitRate}% |`);
    lines.push("");
    lines.push("> Cache 命中率 = Cache 读取 Token / 总输入 Token × 100");
    lines.push("");
  }

  // 工具调用分析
  lines.push("## 工具调用分析");
  lines.push("");
  lines.push("| 指标 | 值 |");
  lines.push("|------|-----|");
  lines.push(`| 工具调用轮次 | ${result.toolCallCount} |`);
  lines.push(`| 工具调用率 | ${result.toolCallRate}% |`);
  lines.push("");

  if (result.toolUsage.size > 0) {
    lines.push("### 工具使用分布");
    lines.push("");
    lines.push("| 工具名 | 调用次数 |");
    lines.push("|--------|---------|");
    const sorted = Array.from(result.toolUsage.entries()).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      lines.push(`| ${name} | ${count} |`);
    }
    lines.push("");
  }

  // 完成原因分布
  lines.push("## 完成原因分布");
  lines.push("");
  if (result.finishReasons.size > 0) {
    lines.push("| 原因 | 次数 | 占比 |");
    lines.push("|------|------|------|");
    const total = Array.from(result.finishReasons.values()).reduce((a, b) => a + b, 0);
    for (const [reason, count] of result.finishReasons) {
      const pct = Math.round((count / total) * 100);
      lines.push(`| ${reason} | ${count} | ${pct}% |`);
    }
  } else {
    lines.push("无数据");
  }
  lines.push("");

  // 错误分析
  lines.push("## 错误分析");
  lines.push("");
  lines.push(`- 错误次数：${result.errorCount}`);
  lines.push(`- 错误率：${result.errorRate}%`);
  if (result.errors.length > 0) {
    lines.push("");
    lines.push("### 错误详情");
    lines.push("");
    for (const err of result.errors.slice(0, 10)) {
      lines.push(`- \`${err.slice(0, 100)}\``);
    }
  }
  lines.push("");

  // 会话轨迹
  lines.push("## 会话轨迹");
  lines.push("");
  for (const session of result.sessions) {
    lines.push(`### 会话 ${session.sessionId.slice(0, 8)}...`);
    lines.push("");
    lines.push(`- 模型：${session.model}`);
    lines.push(`- LLM 调用次数：${session.requests.length}`);
    lines.push(`- 总耗时：${(session.totalDurationMs / 1000).toFixed(2)}s`);
    lines.push(`- 输入 Token：${session.totalInputTokens}`);
    lines.push(`- 输出 Token：${session.totalOutputTokens}`);
    lines.push(`- 工具调用轮次：${session.toolCallCount}`);
    lines.push(`- 使用工具：${session.toolNames.join(", ") || "(无)"}`);
    lines.push(`- 完成原因：${session.finishReasons.join(", ")}`);
    if (session.errors.length > 0) {
      lines.push(`- 错误：${session.errors.length} 次`);
    }
    lines.push("");
  }

  // 优化建议
  lines.push("## 优化建议");
  lines.push("");
  const suggestions: string[] = [];

  if (result.errorRate > 10) {
    suggestions.push(`- ⚠️ 错误率 ${result.errorRate}% 偏高，建议检查 LLM 配置和网络连接`);
  }
  if (result.avgDurationMs > 5000) {
    suggestions.push(`- ⏱️ 平均调用耗时 ${result.avgDurationMs}ms 偏长，考虑使用更快模型或减小 maxTokens`);
  }
  if (result.toolCallRate < 20 && result.totalLlmCalls > 5) {
    suggestions.push(`- 🔧 工具调用率 ${result.toolCallRate}% 偏低，模型可能未充分利用工具。建议优化工具描述，使其更清晰明确`);
  }
  if (result.toolCallRate > 80) {
    suggestions.push(`- 🔧 工具调用率 ${result.toolCallRate}% 偏高，模型可能过度依赖工具。检查提示词是否过度引导工具使用`);
  }
  if (result.avgOutputTokens > 4000) {
    suggestions.push(`- 📝 平均输出 ${result.avgOutputTokens} tokens 偏长，考虑在系统提示中要求简洁回复`);
  }

  // 工具使用集中度
  if (result.toolUsage.size > 0) {
    const sorted = Array.from(result.toolUsage.entries()).sort((a, b) => b[1] - a[1]);
    const topTool = sorted[0];
    if (topTool && topTool[1] > result.toolCallCount * 0.5) {
      suggestions.push(`- 🎯 工具 "${topTool[0]}" 占 ${Math.round((topTool[1] / result.toolCallCount) * 100)}% 的调用，考虑是否其他工具描述需要优化以平衡使用`);
    }
  }

  if (suggestions.length === 0) {
    suggestions.push("- ✅ 各项指标正常，未发现明显优化点");
  }

  for (const s of suggestions) {
    lines.push(s);
  }
  lines.push("");

  // 测评方法论说明
  lines.push("## 测评方法论");
  lines.push("");
  lines.push("本报告基于 LLM trace 日志的轨迹评估（Trajectory Evaluation）方法：");
  lines.push("");
  lines.push("1. **工具选择准确率**：通过分析 LLM 选择工具的名称和参数是否符合预期，评估工具描述质量");
  lines.push("2. **工具调用率**：衡量模型在需要时是否主动使用工具，过低可能说明工具描述不清晰");
  lines.push("3. **Token 效率**：输入/输出 token 分布反映提示词和回复的效率");
  lines.push("4. **耗时分析**：定位慢请求，优化模型选择或请求参数");
  lines.push("5. **错误模式**：识别常见错误类型，针对性修复");
  lines.push("");
  lines.push("后续扩展方向：");
  lines.push("- 对比 benchmark 数据集，计算工具选择命中率");
  lines.push("- 多模型 A/B 测试对比");
  lines.push("- 自动生成工具描述优化建议");
  lines.push("");

  return lines.join("\n");
}

/**
 * 将分析结果输出到控制台 + Markdown 文件。
 *
 * @param result - 分析结果
 * @param outputDir - 报告输出目录（默认 .fengagent/logs/）
 * @returns Markdown 文件路径
 */
export function outputReport(result: AnalysisResult, outputDir?: string): string {
  // 控制台摘要
  console.log("\n" + "=".repeat(60));
  console.log("FengAgentCli Agent 测评报告");
  console.log("=".repeat(60));
  console.log(`日志文件: ${result.logFile}`);
  console.log(`会话数: ${result.sessionCount}`);
  console.log(`LLM 调用: ${result.totalLlmCalls}`);
  console.log(`总耗时: ${(result.totalDurationMs / 1000).toFixed(2)}s`);
  console.log(`平均耗时: ${result.avgDurationMs}ms`);
  console.log(`输入 Token: ${result.totalInputTokens} (avg ${result.avgInputTokens})`);
  console.log(`输出 Token: ${result.totalOutputTokens} (avg ${result.avgOutputTokens})`);
  console.log(`工具调用: ${result.toolCallCount} (${result.toolCallRate}%)`);
  console.log(`错误: ${result.errorCount} (${result.errorRate}%)`);

  if (result.modelComparisons.length > 1) {
    console.log("\n模型对比:");
    for (const m of result.modelComparisons) {
      console.log(
        `  ${m.model}: 调用 ${m.totalCalls}, 工具成功率 ${m.toolSuccessRate}%, 任务完成率 ${m.taskCompletionRate}%, 错误率 ${m.errorRate}%`,
      );
    }
  }

  if (result.totalCacheReadTokens > 0 || result.totalCacheCreationTokens > 0) {
    console.log("\nKV Cache:");
    console.log(`  读取 Token: ${result.totalCacheReadTokens}`);
    console.log(`  创建 Token: ${result.totalCacheCreationTokens}`);
    console.log(`  命中率: ${result.cacheHitRate}%`);
  }

  if (result.toolUsage.size > 0) {
    console.log("\n工具使用分布:");
    for (const [name, count] of result.toolUsage) {
      console.log(`  ${name}: ${count}`);
    }
  }

  if (result.finishReasons.size > 0) {
    console.log("\n完成原因:");
    for (const [reason, count] of result.finishReasons) {
      console.log(`  ${reason}: ${count}`);
    }
  }

  // 写入 Markdown 文件
  const dir = outputDir ?? resolve(process.cwd(), ".fengagent/logs");
  const date = new Date().toISOString().slice(0, 10);
  const filename = `eval-report-${date}.md`;
  const filepath = resolve(dir, filename);

  const markdown = generateMarkdownReport(result);
  writeFileSync(filepath, markdown, "utf-8");

  console.log(`\n报告已保存: ${filepath}`);
  console.log("=".repeat(60) + "\n");

  return filepath;
}
