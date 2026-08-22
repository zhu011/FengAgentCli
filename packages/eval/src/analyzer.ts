/**
 * @fengagent/eval — LLM 轨迹分析器
 *
 * 读取 llm-trace-{date}.jsonl 日志文件，解析为结构化记录，
 * 供 reporter 生成分析报告。
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

/** 单条 LLM trace 记录（与 llm/trace.ts 中的 LlmTraceRecord 对应） */
export interface TraceRecord {
  timestamp: string;
  sessionId: string;
  /** 本次 LLM 调用对应的助手消息 ID（Agent Loop 写入；per-message 查询用） */
  messageId?: string;
  direction: "request" | "response";
  model: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** KV cache 读取的 token 数 */
  cacheReadTokens?: number;
  /** KV cache 创建的 token 数 */
  cacheCreationTokens?: number;
  hasToolCalls: boolean;
  toolCalls?: Array<{ name: string; input: unknown }>;
  finishReason?: string;
  error?: string | null;
  messages?: unknown;
  tools?: string[];
  responseText?: string;
  maxTokens?: number;
  temperature?: number;
}

/** 单个模型的对比统计 */
export interface ModelComparison {
  /** 模型名称 */
  model: string;
  /** 总调用次数（response 记录数） */
  totalCalls: number;
  /** 含工具调用的 response 数 */
  toolCallCount: number;
  /** 工具调用成功次数（hasToolCalls 且无 error） */
  toolSuccessCount: number;
  /** 工具调用失败次数（hasToolCalls 且有 error） */
  toolFailureCount: number;
  /** 错误次数 */
  errorCount: number;
  /** 错误率（百分比） */
  errorRate: number;
  /** 完成原因分布 */
  finishReasons: Map<string, number>;
  /** 平均耗时（毫秒） */
  avgDurationMs: number;
  /** 平均输入 token */
  avgInputTokens: number;
  /** 平均输出 token */
  avgOutputTokens: number;
  /** 工具调用成功率（百分比 = toolSuccessCount / toolCallCount * 100） */
  toolSuccessRate: number;
  /** 任务完成率（百分比 = finishReason 为 "end_turn" 的调用数 / totalCalls * 100） */
  taskCompletionRate: number;
  /** KV cache 读取 token 总数 */
  cacheReadTokens: number;
  /** KV cache 创建 token 总数 */
  cacheCreationTokens: number;
  /** KV cache 命中率（百分比） */
  cacheHitRate: number;
}


/**
 * LLM-judge 对单个会话的判定结果（由评测引擎的 LLM-judge 评测产出）。
 *
 * 数据结构对齐约定（KG 评测引擎 ↔ self-optimize 诊断器）：
 * - 输入字段：sessionId（与 TraceRecord.sessionId 对应）+ 分数 + 结论枚举
 * - 分数区间：0–100（与现有百分比指标一致，越小问题越严重）
 * - 结论枚举：completed / partial / failed / tool_misused / unsafe / inefficient
 *
 * 评测引擎产出后合并进 AnalysisResult.judgeResults（analyzeRecords 不产生此字段）。
 */
export interface JudgeResult {
  /** 判定的会话 ID（对应 TraceRecord.sessionId） */
  sessionId: string;
  /** 任务完成度分数 0–100（对应 DeepEval TaskCompletionMetric） */
  completionScore: number;
  /** 输出正确性分数 0–100（与任务目标的符合度） */
  correctnessScore: number;
  /** 结论枚举：completed 完成 / partial 部分完成 / failed 未完成 /
   *  tool_misused 工具误用（选型或参数错误）/ unsafe 安全风险 / inefficient 效率低 */
  conclusion: "completed" | "partial" | "failed" | "tool_misused" | "unsafe" | "inefficient";
  /** 判定依据（judge 的说明，供证据展示） */
  note?: string;
}

/** 一个会话的完整轨迹（请求+回复配对） */
export interface SessionTrace {
  sessionId: string;
  model: string;
  requests: TraceRecord[];
  responses: TraceRecord[];
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  toolCallCount: number;
  toolNames: string[];
  errors: string[];
  finishReasons: string[];
}

/** 分析结果 */
export interface AnalysisResult {
  /** 日志文件路径 */
  logFile: string;
  /** 总记录数 */
  totalRecords: number;
  /** 会话数 */
  sessionCount: number;
  /** 总 LLM 调用次数 */
  totalLlmCalls: number;
  /** 总耗时 */
  totalDurationMs: number;
  /** 平均每次调用耗时 */
  avgDurationMs: number;
  /** 总 token 用量 */
  totalInputTokens: number;
  totalOutputTokens: number;
  /** 平均 token */
  avgInputTokens: number;
  avgOutputTokens: number;
  /** 工具调用统计 */
  toolCallCount: number;
  toolCallRate: number;
  toolUsage: Map<string, number>;
  /** 错误统计 */
  errorCount: number;
  errorRate: number;
  errors: string[];
  /** 完成原因分布 */
  finishReasons: Map<string, number>;
  /** 每个会话的轨迹 */
  sessions: SessionTrace[];
  /** 使用模型 */
  models: string[];
  /** 模型对比统计 */
  modelComparisons: ModelComparison[];
  /** KV cache 读取 token 总数 */
  totalCacheReadTokens: number;
  /** KV cache 创建 token 总数 */
  totalCacheCreationTokens: number;
  /** KV cache 命中率（百分比 = totalCacheReadTokens / totalInputTokens * 100） */
  cacheHitRate: number;
  /** LLM-judge 判定结果（可选：由评测引擎的 LLM-judge 评测产出并合并，analyzeRecords 不产生） */
  judgeResults?: JudgeResult[];
}

/**
 * 读取并解析 JSONL 日志文件。
 *
 * @param logFile - 日志文件路径
 * @returns 解析后的记录数组
 */
export function parseLogFile(logFile: string): TraceRecord[] {
  if (!existsSync(logFile)) {
    return [];
  }

  const content = readFileSync(logFile, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const records: TraceRecord[] = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as TraceRecord;
      records.push(record);
    } catch {
      // 跳过无法解析的行
    }
  }

  return records;
}

/**
 * 查找指定日期的日志文件。
 *
 * @param logsDir - 日志目录（默认 .fengagent/logs）
 * @param date - 日期（YYYY-MM-DD），默认今天
 * @returns 日志文件路径，不存在返回 null
 */
export function findLogFile(logsDir?: string, date?: string): string | null {
  const dir = logsDir ?? resolve(process.cwd(), ".fengagent/logs");
  const targetDate = date ?? new Date().toISOString().slice(0, 10);
  const file = join(dir, `llm-trace-${targetDate}.jsonl`);
  return existsSync(file) ? file : null;
}

/**
 * 查找所有日志文件。
 *
 * @param logsDir - 日志目录
 * @returns 日志文件路径数组（按日期排序）
 */
export function findAllLogFiles(logsDir?: string): string[] {
  const dir = logsDir ?? resolve(process.cwd(), ".fengagent/logs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("llm-trace-") && f.endsWith(".jsonl"))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * 将记录按会话分组，配对请求和回复。
 */
function groupBySession(records: TraceRecord[]): Map<string, SessionTrace> {
  const sessions = new Map<string, SessionTrace>();

  for (const record of records) {
    let session = sessions.get(record.sessionId);
    if (!session) {
      session = {
        sessionId: record.sessionId,
        model: record.model,
        requests: [],
        responses: [],
        totalDurationMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        toolCallCount: 0,
        toolNames: [],
        errors: [],
        finishReasons: [],
      };
      sessions.set(record.sessionId, session);
    }

    if (record.direction === "request") {
      session.requests.push(record);
    } else {
      session.responses.push(record);
      if (record.durationMs) session.totalDurationMs += record.durationMs;
      if (record.inputTokens) session.totalInputTokens += record.inputTokens;
      if (record.outputTokens) session.totalOutputTokens += record.outputTokens;
      if (record.hasToolCalls) {
        session.toolCallCount++;
        if (record.toolCalls) {
          for (const tc of record.toolCalls) {
            if (!session.toolNames.includes(tc.name)) {
              session.toolNames.push(tc.name);
            }
          }
        }
      }
      if (record.error) session.errors.push(record.error);
      if (record.finishReason) session.finishReasons.push(record.finishReason);
    }
  }

  return sessions;
}

/**
 * 分析日志记录，生成统计结果。
 *
 * @param records - 解析后的记录数组
 * @param logFile - 日志文件路径
 * @returns 分析结果
 */
export function analyzeRecords(records: TraceRecord[], logFile: string): AnalysisResult {
  const sessions = groupBySession(records);
  const sessionList = Array.from(sessions.values());

  const responses = records.filter((r) => r.direction === "response");
  const totalDuration = responses.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const totalInputTokens = responses.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
  const totalOutputTokens = responses.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);
  const toolCalls = responses.filter((r) => r.hasToolCalls);
  const errors = responses.filter((r) => r.error);

  const toolUsage = new Map<string, number>();
  for (const r of toolCalls) {
    if (r.toolCalls) {
      for (const tc of r.toolCalls) {
        toolUsage.set(tc.name, (toolUsage.get(tc.name) ?? 0) + 1);
      }
    }
  }

  const finishReasons = new Map<string, number>();
  for (const r of responses) {
    if (r.finishReason) {
      finishReasons.set(r.finishReason, (finishReasons.get(r.finishReason) ?? 0) + 1);
    }
  }

  const models = Array.from(new Set(records.map((r) => r.model)));

  // 按模型分组计算对比指标
  const responsesByModel = new Map<string, TraceRecord[]>();
  for (const r of responses) {
    const list = responsesByModel.get(r.model);
    if (list) {
      list.push(r);
    } else {
      responsesByModel.set(r.model, [r]);
    }
  }

  const modelComparisons: ModelComparison[] = [];
  for (const [model, modelResponses] of responsesByModel) {
    const total = modelResponses.length;
    const toolCallRsps = modelResponses.filter((r) => r.hasToolCalls);
    const toolCallCount = toolCallRsps.length;
    const toolSuccessCount = toolCallRsps.filter((r) => !r.error).length;
    const toolFailureCount = toolCallRsps.filter((r) => r.error).length;
    const errorCount = modelResponses.filter((r) => r.error).length;
    const endTurnCount = modelResponses.filter(
      (r) => r.finishReason === "end_turn",
    ).length;

    const modelDuration = modelResponses.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
    const modelInputTokens = modelResponses.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
    const modelOutputTokens = modelResponses.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);
    const modelCacheRead = modelResponses.reduce((sum, r) => sum + (r.cacheReadTokens ?? 0), 0);
    const modelCacheCreation = modelResponses.reduce(
      (sum, r) => sum + (r.cacheCreationTokens ?? 0),
      0,
    );

    const modelFinishReasons = new Map<string, number>();
    for (const r of modelResponses) {
      if (r.finishReason) {
        modelFinishReasons.set(
          r.finishReason,
          (modelFinishReasons.get(r.finishReason) ?? 0) + 1,
        );
      }
    }

    // cacheHitRate = cacheRead / (cacheRead + 非缓存输入) * 100
    // 非缓存输入 = inputTokens - cacheReadTokens，故分母 = inputTokens
    const cacheDenom = modelInputTokens;
    const cacheHitRate =
      cacheDenom > 0 ? Math.round((modelCacheRead / cacheDenom) * 100) : 0;

    modelComparisons.push({
      model,
      totalCalls: total,
      toolCallCount,
      toolSuccessCount,
      toolFailureCount,
      errorCount,
      errorRate: total > 0 ? Math.round((errorCount / total) * 100) : 0,
      finishReasons: modelFinishReasons,
      avgDurationMs: total > 0 ? Math.round(modelDuration / total) : 0,
      avgInputTokens: total > 0 ? Math.round(modelInputTokens / total) : 0,
      avgOutputTokens: total > 0 ? Math.round(modelOutputTokens / total) : 0,
      toolSuccessRate: toolCallCount > 0 ? Math.round((toolSuccessCount / toolCallCount) * 100) : 0,
      taskCompletionRate: total > 0 ? Math.round((endTurnCount / total) * 100) : 0,
      cacheReadTokens: modelCacheRead,
      cacheCreationTokens: modelCacheCreation,
      cacheHitRate,
    });
  }

  // 全局 KV cache 统计
  const totalCacheReadTokens = responses.reduce((sum, r) => sum + (r.cacheReadTokens ?? 0), 0);
  const totalCacheCreationTokens = responses.reduce(
    (sum, r) => sum + (r.cacheCreationTokens ?? 0),
    0,
  );
  const cacheHitRate =
    totalInputTokens > 0 ? Math.round((totalCacheReadTokens / totalInputTokens) * 100) : 0;

  return {
    logFile,
    totalRecords: records.length,
    sessionCount: sessions.size,
    totalLlmCalls: responses.length,
    totalDurationMs: totalDuration,
    avgDurationMs: responses.length > 0 ? Math.round(totalDuration / responses.length) : 0,
    totalInputTokens,
    totalOutputTokens,
    avgInputTokens: responses.length > 0 ? Math.round(totalInputTokens / responses.length) : 0,
    avgOutputTokens: responses.length > 0 ? Math.round(totalOutputTokens / responses.length) : 0,
    toolCallCount: toolCalls.length,
    toolCallRate: responses.length > 0 ? Math.round((toolCalls.length / responses.length) * 100) : 0,
    toolUsage,
    errorCount: errors.length,
    errorRate: responses.length > 0 ? Math.round((errors.length / responses.length) * 100) : 0,
    errors: errors.map((r) => r.error ?? "unknown"),
    finishReasons,
    sessions: sessionList,
    models,
    modelComparisons,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    cacheHitRate,
  };
}
