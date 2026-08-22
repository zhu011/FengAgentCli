/**
 * @fengagent/eval — 自优化诊断器
 *
 * 基于评测结果（AnalysisResult）自动诊断 Agent 配置问题，
 * 输出可执行的调优建议（系统提示词 / 工具描述 / Skill / 上下文策略）。
 *
 * 设计参考：
 * - DeepEval 六项 Agent 指标（任务完成 / 步骤效率 / 工具正确性 / 参数正确性 / 计划质量 / 计划遵循）
 * - 美团 Agent 评测「结果 / 过程 / 效率 / 风险」四层归因
 *
 * 默认规则驱动（确定性、零成本），LLM-judge 深度分析作为可选扩展点（离线批量场景）。
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDataRoot } from "@fengagent/shared";
import type { AnalysisResult, ModelComparison } from "./analyzer.ts";

/** 建议类型：对应调优目标 */
export type SuggestionType =
  | "system-prompt"
  | "tool-description"
  | "skill"
  | "context"
  | "workflow";

/** 严重程度 */
export type Severity = "high" | "medium" | "low";

/** 单条优化建议 */
export interface OptimizationSuggestion {
  /** 建议 ID（opt-01 …） */
  id: string;
  /** 调优类型 */
  type: SuggestionType;
  /** 调优目标（工具名 / 模型 / 全局） */
  target: string;
  severity: Severity;
  /** 一句话标题 */
  title: string;
  /** 触发依据（指标数值 + 阈值） */
  reason: string;
  /** 样本证据（错误消息 / 工具名等） */
  evidence: string[];
  /** 具体修改建议 */
  suggestedChange: string;
}

/** 诊断阈值配置 */
export interface OptimizationThresholds {
  /** 错误率高于此值触发（百分比） */
  errorRateHigh: number;
  /** 工具成功率低于此值触发（百分比） */
  toolSuccessRateLow: number;
  /** 缓存命中率低于此值触发（百分比） */
  cacheHitRateLow: number;
  /** 任务完成率低于此值触发（百分比） */
  taskCompletionRateLow: number;
  /** 平均每次调用耗时高于此值触发（毫秒） */
  avgDurationMsHigh: number;
  /** max_tokens / stop_sequence 截断占比高于此值触发（百分比） */
  truncationRateHigh: number;
  /** 工具调用率低于此值触发（百分比） */
  toolCallRateLow: number;
  /** 统计基数小于该值不触发（避免小样本误报） */
  minSamples: number;
}

/** 默认阈值 */
export const DEFAULT_THRESHOLDS: OptimizationThresholds = {
  errorRateHigh: 20,
  toolSuccessRateLow: 70,
  cacheHitRateLow: 20,
  taskCompletionRateLow: 60,
  avgDurationMsHigh: 30_000,
  truncationRateHigh: 30,
  toolCallRateLow: 10,
  minSamples: 10,
};

/** 自优化诊断结果 */
export interface OptimizationPlan {
  logFile: string;
  analyzedAt: string;
  totalLlmCalls: number;
  sessionCount: number;
  suggestions: OptimizationSuggestion[];
}

/** 工具失败统计（用于归因工具描述问题） */
interface ToolFailureStat {
  name: string;
  failures: number;
  samples: string[];
}

/**
 * 统计失败率最高的工具（含 error 且 hasToolCalls 的 response）。
 */
function toolFailureStats(result: AnalysisResult): ToolFailureStat[] {
  const stats = new Map<string, ToolFailureStat>();

  for (const session of result.sessions) {
    for (const resp of session.responses) {
      if (!resp.error || !resp.hasToolCalls || !resp.toolCalls) continue;
      for (const tc of resp.toolCalls) {
        let stat = stats.get(tc.name);
        if (!stat) {
          stat = { name: tc.name, failures: 0, samples: [] };
          stats.set(tc.name, stat);
        }
        stat.failures++;
        if (stat.samples.length < 3 && resp.error) stat.samples.push(resp.error);
      }
    }
  }

  return Array.from(stats.values()).sort((a, b) => b.failures - a.failures);
}

/** 截断完成原因占比（max_tokens / stop_sequence） */
function truncationRate(comp: ModelComparison): number {
  let truncated = 0;
  for (const [reason, count] of comp.finishReasons) {
    if (reason === "max_tokens" || reason === "stop_sequence") truncated += count;
  }
  return comp.totalCalls > 0 ? Math.round((truncated / comp.totalCalls) * 100) : 0;
}

/**
 * 规则驱动诊断：基于评测指标与阈值生成优化建议。
 *
 * @param result - 评测分析结果
 * @param thresholds - 阈值配置（默认见 DEFAULT_THRESHOLDS）
 * @returns 优化建议列表（按严重程度排序）
 */
export function diagnose(
  result: AnalysisResult,
  thresholds: OptimizationThresholds = DEFAULT_THRESHOLDS,
): OptimizationSuggestion[] {
  const suggestions: OptimizationSuggestion[] = [];
  let id = 1;
  const add = (s: Omit<OptimizationSuggestion, "id">) => {
    suggestions.push({ ...s, id: `opt-${String(id++).padStart(2, "0")}` });
  };

  const total = result.totalLlmCalls;
  const toolFailures = toolFailureStats(result);
  const model = result.modelComparisons[0];
  const comp = model ?? {
    totalCalls: total,
    toolCallCount: result.toolCallCount,
    errorRate: result.errorRate,
    toolSuccessRate: 0,
    taskCompletionRate: 0,
    cacheHitRate: result.cacheHitRate,
    avgDurationMs: result.avgDurationMs,
    avgInputTokens: result.avgInputTokens,
    avgOutputTokens: result.avgOutputTokens,
  } as ModelComparison;

  // 1. 任务完成率低 → 系统提示词（结果层）
  if (comp.totalCalls >= thresholds.minSamples && comp.taskCompletionRate < thresholds.taskCompletionRateLow) {
    add({
      type: "system-prompt",
      target: "全局",
      severity: "high",
      title: `任务完成率 ${comp.taskCompletionRate}% 低于阈值 ${thresholds.taskCompletionRateLow}%`,
      reason: `end_turn 占比 ${comp.taskCompletionRate}% < ${thresholds.taskCompletionRateLow}%（${comp.totalCalls} 次调用）`,
      evidence: result.finishReasons.size > 0
        ? [`完成原因分布: ${Array.from(result.finishReasons.entries()).map(([k, v]) => `${k}=${v}`).join(", ")}`]
        : [],
      suggestedChange:
        "在系统提示词中强化「任务完成标准」：明确一轮任务结束的判定条件、输出格式要求，" +
        "避免模型在达到目标后继续产生中间态输出。",
    });
  }

  // 2. 错误率偏高 → 按错误样本归因分流（结果/过程层）
  if (comp.totalCalls >= thresholds.minSamples && comp.errorRate > thresholds.errorRateHigh) {
    const toolErrors = toolFailures.reduce((sum, t) => sum + t.failures, 0);
    const totalErrors = result.errorCount;
    const toolShare = totalErrors > 0 ? Math.round((toolErrors / totalErrors) * 100) : 0;

    if (toolErrors > 0 && toolShare >= 50) {
      // 大部分错误与工具调用相关 → 工具描述/参数（toolErrors > 0 保证非空）
      const worst = toolFailures[0]!;
      add({
        type: "tool-description",
        target: worst.name,
        severity: "high",
        title: `工具 ${worst.name} 相关错误占比 ${toolShare}%（错误率 ${comp.errorRate}%）`,
        reason: `错误率 ${comp.errorRate}% > ${thresholds.errorRateHigh}%，其中工具相关错误占 ${toolShare}%`,
        evidence: worst.samples,
        suggestedChange:
          `检查工具 ${worst.name} 的描述与参数 schema：确认参数说明无歧义、必填字段有示例值、` +
          "错误消息中反馈的失败模式已覆盖。可在描述中补充典型用法示例。",
      });
    } else {
      add({
        type: "system-prompt",
        target: "全局",
        severity: "high",
        title: `错误率 ${comp.errorRate}% 高于阈值 ${thresholds.errorRateHigh}%`,
        reason: `${comp.totalCalls} 次调用中 ${comp.errorCount} 次错误`,
        evidence: result.errors.slice(0, 3),
        suggestedChange:
          "检查系统提示词中的任务说明是否超出模型能力范围（如要求多步骤复杂推理），" +
          "拆分为更小的子任务；同时核对上下文是否含冲突指令。",
      });
    }
  }

  // 3. 工具调用成功率低 → 工具描述（action 层）
  if (
    comp.totalCalls >= thresholds.minSamples &&
    comp.toolCallCount >= thresholds.minSamples &&
    comp.toolSuccessRate < thresholds.toolSuccessRateLow
  ) {
    const worst = toolFailures[0];
    add({
      type: "tool-description",
      target: worst?.name ?? "全部工具",
      severity: "high",
      title: `工具成功率 ${comp.toolSuccessRate}% 低于阈值 ${thresholds.toolSuccessRateLow}%`,
      reason: `${comp.toolCallCount} 次工具调用，${comp.toolCallCount - comp.toolSuccessCount} 次失败`,
      evidence: worst?.samples ?? result.errors.slice(0, 3),
      suggestedChange:
        "优化工具描述与参数 schema（DeepEval ToolCorrectness / ArgumentCorrectness 指标对应项）：" +
        "参数名与说明对齐实际语义、补充枚举值说明、为易错参数提供默认值示例，并检查工具实现是否对非法输入返回友好错误。",
    });
  }

  // 4. 缓存命中率低 → 系统提示词前缀稳定性（效率层·成本）
  if (
    comp.totalCalls >= thresholds.minSamples &&
    result.totalInputTokens > 10_000 &&
    comp.cacheHitRate < thresholds.cacheHitRateLow
  ) {
    add({
      type: "context",
      target: "全局",
      severity: "medium",
      title: `KV cache 命中率 ${comp.cacheHitRate}% 低于阈值 ${thresholds.cacheHitRateLow}%`,
      reason: `总输入 ${result.totalInputTokens} token，cache 读取 ${result.totalCacheReadTokens} token`,
      evidence: [`cache 命中率 ${comp.cacheHitRate}%（读取 ${comp.cacheReadTokens} / 输入 ${comp.avgInputTokens}×${comp.totalCalls}）`],
      suggestedChange:
        "KV cache 命中依赖系统提示词前缀稳定：避免在系统提示词中拼入易变内容（如时间戳、动态工具列表），" +
        "将易变部分移入用户消息；检查是否在每次请求前重新组装系统提示词。",
    });
  }

  // 5. 平均耗时高 → 步骤效率（效率层）
  if (comp.totalCalls >= thresholds.minSamples && comp.avgDurationMs > thresholds.avgDurationMsHigh) {
    add({
      type: "workflow",
      target: "全局",
      severity: "medium",
      title: `平均耗时 ${(comp.avgDurationMs / 1000).toFixed(1)}s 高于阈值 ${thresholds.avgDurationMsHigh / 1000}s`,
      reason: `${comp.totalCalls} 次调用平均耗时 ${comp.avgDurationMs}ms`,
      evidence: [
        `平均输入 ${comp.avgInputTokens} token / 平均输出 ${comp.avgOutputTokens} token`,
        `工具调用率 ${result.toolCallRate}%（${result.toolCallCount}/${result.totalLlmCalls}）`,
      ],
      suggestedChange:
        "检查是否存在工具调用循环（工具结果未推动进展）：在系统提示词中约束「同一工具连续失败 2 次应换策略」；" +
        "若输入 token 持续增长，启用更激进的上下文压缩。",
    });
  }

  // 6. 截断占比高 → 上下文/maxTokens（过程层）
  if (comp.totalCalls >= thresholds.minSamples && truncationRate(comp) > thresholds.truncationRateHigh) {
    add({
      type: "context",
      target: "全局",
      severity: "medium",
      title: `截断完成占比 ${truncationRate(comp)}% 高于阈值 ${thresholds.truncationRateHigh}%`,
      reason: `max_tokens / stop_sequence 完成占比 ${truncationRate(comp)}%`,
      evidence: Array.from(comp.finishReasons.entries()).map(([k, v]) => `${k}=${v}`),
      suggestedChange:
        "多数响应被 max_tokens 截断：提高 maxTokens 配置，或压缩上下文（清理历史消息、裁剪工具结果），" +
        "让模型有足够输出空间完成回答。",
    });
  }

  // 7. 工具使用过少 → 工具可见性（action 层）
  if (
    result.sessionCount >= 3 &&
    result.totalLlmCalls >= thresholds.minSamples &&
    result.toolCallRate < thresholds.toolCallRateLow
  ) {
    add({
      type: "workflow",
      target: "全局",
      severity: "low",
      title: `工具调用率 ${result.toolCallRate}% 低于阈值 ${thresholds.toolCallRateLow}%`,
      reason: `${result.toolCallCount}/${result.totalLlmCalls} 次调用含工具调用（${result.sessionCount} 个会话）`,
      evidence: [`可用工具: ${Array.from(result.toolUsage.keys()).join(", ") || "（无工具调用记录）"}`],
      suggestedChange:
        "工具调用率过低说明模型未意识到可用工具：检查系统提示词中工具能力描述是否醒目，" +
        "或在任务描述中显式提示「可使用工具完成任务」。",
    });
  }

  const severityRank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return suggestions.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}

/**
 * 将诊断结果渲染为 Markdown 建议报告。
 *
 * @param plan - 诊断结果
 * @returns Markdown 字符串
 */
export function renderSuggestionsMarkdown(plan: OptimizationPlan): string {
  const lines: string[] = [];

  lines.push("# FengAgentCli 自优化建议报告");
  lines.push("");
  lines.push(`> 生成时间：${plan.analyzedAt}`);
  lines.push(`> 日志文件：\`${plan.logFile}\``);
  lines.push("");
  lines.push(`会话 ${plan.sessionCount} 个 · LLM 调用 ${plan.totalLlmCalls} 次 · 建议 ${plan.suggestions.length} 条`);
  lines.push("");

  if (plan.suggestions.length === 0) {
    lines.push("**未发现需要调优的指标，Agent 配置健康。**");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("| 严重度 | 类型 | 目标 | 建议 |");
  lines.push("|--------|------|------|------|");
  for (const s of plan.suggestions) {
    const sev = s.severity === "high" ? "🔴 高" : s.severity === "medium" ? "🟡 中" : "🟢 低";
    lines.push(`| ${sev} | ${s.type} | ${s.target} | ${s.title} |`);
  }
  lines.push("");

  for (const s of plan.suggestions) {
    lines.push(`## ${s.id} [${s.severity}] ${s.type} → ${s.target}`);
    lines.push("");
    lines.push(`**${s.title}**`);
    lines.push("");
    lines.push(`触发依据：${s.reason}`);
    lines.push("");
    if (s.evidence.length > 0) {
      lines.push("样本证据：");
      lines.push("");
      for (const e of s.evidence) {
        lines.push(`- \`${e.length > 200 ? e.slice(0, 200) + "…" : e}\``);
      }
      lines.push("");
    }
    lines.push(`修改建议：${s.suggestedChange}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 运行自优化诊断（评测 → 诊断 → 建议）。
 *
 * @param result - 评测分析结果
 * @param options - 选项（writeReport 是否写入报告文件）
 * @returns 诊断结果
 */
export function runSelfOptimize(
  result: AnalysisResult,
  options?: {
    writeReport?: boolean;
    thresholds?: OptimizationThresholds;
    /** 报告输出目录（默认 <数据根>/optimizations） */
    outputDir?: string;
  },
): OptimizationPlan {
  const plan: OptimizationPlan = {
    logFile: result.logFile,
    analyzedAt: new Date().toISOString(),
    totalLlmCalls: result.totalLlmCalls,
    sessionCount: result.sessionCount,
    suggestions: diagnose(result, options?.thresholds),
  };

  if (options?.writeReport) {
    const dir = options?.outputDir ?? join(resolveDataRoot(), "optimizations");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 按日志日期命名，多文件分析（--all）时报告互不覆盖
    const match = result.logFile.match(/llm-trace-(\d{4}-\d{2}-\d{2})/);
    const date = match ? match[1] : new Date().toISOString().slice(0, 10);
    const file = join(dir, `optimization-${date}.md`);
    writeFileSync(file, renderSuggestionsMarkdown(plan), "utf-8");
    console.log(`自优化报告已写入: ${file}`);
  }

  return plan;
}

/** 报告输出目录（供 CLI 提示） */
export function optimizationsDir(): string {
  return join(resolveDataRoot(), "optimizations");
}
