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
  direction: "request" | "response";
  model: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
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
  };
}
