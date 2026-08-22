/**
 * @fengagent/server — 可观测性路由（AgentLoop 观测面板数据源）
 *
 * 为 WebUI 观测面板提供三类数据：
 *   GET /api/observability/traces                     — 列出全部 trace 日志文件（日期/规模/会话数）
 *   GET /api/observability/traces/:date               — 指定日期的分析结果（指标聚合，AnalysisResult）
 *   GET /api/observability/traces/:date/callchain     — 指定日期的完整调用链（会话 → 消息 → LLM 调用 → 工具调用）
 *
 * 数据源：<数据根>/logs/llm-trace-{date}.jsonl（见 docs/EVALUATION.md 一、可观测性接入指南）。
 * 数据根两分支一致：refactor `.fengagent-cordis/`，main `.fengagent/`，由 @fengagent/shared 的
 * resolveLogsDir() 解析（可用 FENG_DATA_DIR 覆盖）。
 *
 * 调用链重建：request/response 记录按会话配对，响应中的 toolCalls 挂为该 LLM 节点的子节点；
 * 工具返回结果优先取自实时会话消息（SessionManager），Trace 日志未含结果字段时为 null，
 * 待 KG 的 Trace/Span 采集落地后可直接扩展（新增字段透传即可）。
 */

import { Hono } from "hono";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@fengagent/shared";
import { analyzeRecords, parseLogFile } from "@fengagent/eval";
import type { AnalysisResult, TraceRecord } from "@fengagent/eval";

const log = createLogger("server");

/**
 * 解析当前分支数据根（与 @fengagent/shared resolveDataRoot 语义一致，
 * 但兼容两分支：main 的 shared 不导出 data-root，故本地实现）。
 *
 * 优先级：`FENG_DATA_DIR` > 工作目录 `.fengagent-cordis`（refactor 分支）> `.fengagent`（main 分支）。
 */
export function resolveBranchDataRoot(): string {
  if (process.env.FENG_DATA_DIR && process.env.FENG_DATA_DIR !== "") {
    return process.env.FENG_DATA_DIR;
  }
  const cwd = process.cwd();
  const cordis = join(cwd, ".fengagent-cordis");
  if (existsSync(cordis)) return cordis;
  return join(cwd, ".fengagent");
}

/** 日志目录 = 数据根/logs */
export function resolveBranchLogsDir(): string {
  return join(resolveBranchDataRoot(), "logs");
}

// ──────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────

/** 单个 trace 日志文件元信息 */
export interface TraceFileMeta {
  /** 日期（YYYY-MM-DD） */
  date: string;
  /** 日志文件绝对路径 */
  path: string;
  /** 文件字节数 */
  size: number;
  /** 记录条数 */
  records: number;
  /** 涉及会话数 */
  sessions: number;
  /** 使用模型 */
  models: string[];
  /** 文件修改时间（ISO） */
  modifiedAt: string;
}

/** 实时会话中的工具调用（用于回填工具返回结果） */
export interface LiveToolUse {
  toolUseId: string;
  name: string;
  input: unknown;
}

/** 实时会话中的工具结果 */
export interface LiveToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** 实时会话可观测数据（由调用方从 SessionManager 消息中提取） */
export interface LiveSessionData {
  toolUses: LiveToolUse[];
  toolResults: LiveToolResult[];
}

/** 调用链：工具节点 */
export interface CallChainToolNode {
  /** 工具名 */
  name: string;
  /** 工具参数 */
  input: unknown;
  /** 工具返回内容（来自实时会话消息；Trace 无结果字段时为 null） */
  result: { content: string; isError?: boolean } | null;
  /** 工具执行耗时估算（本次回复到下一次 LLM 请求的时间差，毫秒） */
  durationMs?: number;
  /** 工具调用时间戳 */
  timestamp: string;
  /** 工具执行是否出错 */
  isError?: boolean;
}

/** 调用链：LLM 调用节点 */
export interface CallChainLlmNode {
  /** 会话内调用序号（从 0 起） */
  index: number;
  model: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  finishReason?: string;
  error?: string | null;
  responseText?: string;
  hasToolCalls: boolean;
}

/** 调用链：用户消息节点 */
export interface CallChainUserNode {
  text: string;
}

/** 调用链步骤（用户消息或 LLM 调用，工具作为 LLM 子节点） */
export interface CallChainStep {
  id: string;
  kind: "user" | "llm";
  timestamp: string;
  user?: CallChainUserNode;
  llm?: CallChainLlmNode;
  /** LLM 响应中的工具调用（展开后可见参数/结果/耗时） */
  tools: CallChainToolNode[];
}

/** 单个会话的完整调用链 */
export interface CallChainSession {
  sessionId: string;
  model: string;
  steps: CallChainStep[];
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  toolCallCount: number;
  errorCount: number;
}

/** 序列化后的分析结果（Map → 普通对象，供 JSON 传输） */
export interface SerializedAnalysis extends Omit<AnalysisResult, "finishReasons" | "toolUsage" | "sessions" | "modelComparisons"> {
  finishReasons: Record<string, number>;
  toolUsage: Record<string, number>;
  sessions: Array<Omit<import("@fengagent/eval").SessionTrace, "requests" | "responses"> & {
    requests: number;
    responses: number;
  }>;
  modelComparisons: Array<
    Omit<import("@fengagent/eval").ModelComparison, "finishReasons"> & {
      finishReasons: Record<string, number>;
    }
  >;
}

/** 观测路由构造选项 */
export interface ObservabilityOptions {
  /** 日志目录（默认 resolveLogsDir()，即 <数据根>/logs） */
  logDir?: string;
  /** 实时会话数据提取器（可选；用于回填工具返回结果） */
  getLiveSession?: (sessionId: string) => LiveSessionData | undefined;
}

// ──────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────

/** 列出 trace 日志文件（llm-trace-*.jsonl），按日期升序 */
export function listTraceFiles(logDir: string): string[] {
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((f) => f.startsWith("llm-trace-") && f.endsWith(".jsonl"))
    .sort()
    .map((f) => join(logDir, f));
}

/** 从日期解析 trace 文件路径（YYYY-MM-DD → llm-trace-{date}.jsonl） */
export function traceFileForDate(logDir: string, date: string): string | null {
  // 仅接受 YYYY-MM-DD 形态，避免路径穿越
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const file = join(logDir, `llm-trace-${date}.jsonl`);
  return existsSync(file) ? file : null;
}

/** 统计文件基础规模（记录数 / 会话数 / 模型） */
function summarizeFile(file: string): Pick<TraceFileMeta, "records" | "sessions" | "models" | "size" | "modifiedAt"> {
  const stat = statSync(file);
  const records = parseLogFile(file);
  const sessions = new Set(records.map((r) => r.sessionId));
  const models = Array.from(new Set(records.map((r) => r.model)));
  return {
    records: records.length,
    sessions: sessions.size,
    models,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

/** 将 AnalysisResult 中不可 JSON 序列化的 Map 转换为普通对象 */
export function serializeAnalysis(result: AnalysisResult): SerializedAnalysis {
  const finishReasons: Record<string, number> = {};
  for (const [k, v] of result.finishReasons) finishReasons[k] = v;

  const toolUsage: Record<string, number> = {};
  for (const [k, v] of result.toolUsage) toolUsage[k] = v;

  return {
    ...result,
    finishReasons,
    toolUsage,
    sessions: result.sessions.map((s) => ({
      sessionId: s.sessionId,
      model: s.model,
      requests: s.requests.length,
      responses: s.responses.length,
      totalDurationMs: s.totalDurationMs,
      totalInputTokens: s.totalInputTokens,
      totalOutputTokens: s.totalOutputTokens,
      toolCallCount: s.toolCallCount,
      toolNames: s.toolNames,
      errors: s.errors,
      finishReasons: s.finishReasons,
    })),
    modelComparisons: result.modelComparisons.map((m) => {
      const mf: Record<string, number> = {};
      for (const [k, v] of m.finishReasons) mf[k] = v;
      return { ...m, finishReasons: mf };
    }),
  };
}

/** 从 trace 请求记录中提取最后一条用户文本消息 */
function extractLastUserText(record: TraceRecord): string | null {
  const messages = Array.isArray(record.messages) ? record.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | null;
    if (!m || m.role !== "user") continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const text = blocks
      .filter((b) => (b as { type?: string } | null)?.type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("")
      .trim();
    if (text) return text;
  }
  return null;
}

/** 从实时会话消息中提取工具调用/结果（按出现顺序） */
export function extractLiveSession(messages: Array<{
  role: string;
  content: Array<{ type: string; id?: string; name?: string; input?: unknown; toolUseId?: string; content?: string; isError?: boolean }>;
}>): LiveSessionData {
  const toolUses: LiveToolUse[] = [];
  const toolResults: LiveToolResult[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool-use" && block.name) {
        toolUses.push({ toolUseId: block.id ?? "", name: block.name, input: block.input });
      } else if (block.type === "tool-result") {
        toolResults.push({
          toolUseId: block.toolUseId ?? "",
          content: block.content ?? "",
          isError: block.isError,
        });
      }
    }
  }
  return { toolUses, toolResults };
}

/**
 * 重建调用链。
 *
 * 算法：按文件顺序遍历记录，request 开启一个「用户消息 + LLM 节点」，
 * response 按 FIFO 配对填充分配，其 toolCalls 挂为子节点；
 * 工具耗时估算为「本次回复 → 下一次同会话记录」的时间差。
 */
export function buildCallChains(
  records: TraceRecord[],
  getLiveSession?: (sessionId: string) => LiveSessionData | undefined,
): CallChainSession[] {
  const bySession = new Map<string, TraceRecord[]>();
  for (const r of records) {
    const list = bySession.get(r.sessionId);
    if (list) list.push(r);
    else bySession.set(r.sessionId, [r]);
  }

  const result: CallChainSession[] = [];
  for (const [sessionId, sessionRecords] of bySession) {
    const steps: CallChainStep[] = [];
    const pendingLlm: Array<{ step: CallChainStep; userStep: CallChainStep | null }> = [];
    let llmIndex = 0;

    // 预取实时会话数据（工具返回结果回填）
    const live = getLiveSession?.(sessionId);

    // 工具结果队列：按名称顺序消费（trace 无 toolUseId，只能按序匹配）
    const liveToolResults: CallChainToolNode["result"][] = [];
    if (live) {
      for (const tu of live.toolUses) {
        const result = live.toolResults.find((tr) => tr.toolUseId === tu.toolUseId) ?? null;
        liveToolResults.push(result);
      }
    }
    let liveToolIdx = 0;

    for (const [i, record] of sessionRecords.entries()) {
      // 工具耗时估算：到下一次记录的时间差
      const next = sessionRecords[i + 1];
      const gapMs =
        next && record.timestamp
          ? Math.max(0, new Date(next.timestamp).getTime() - new Date(record.timestamp).getTime())
          : undefined;

      if (record.direction === "request") {
        const userText = extractLastUserText(record);
        let userStep: CallChainStep | null = null;
        if (userText) {
          userStep = {
            id: `u-${sessionId}-${steps.length}-${i}`,
            kind: "user",
            timestamp: record.timestamp,
            user: { text: userText },
            tools: [],
          };
          steps.push(userStep);
        }
        const llmStep: CallChainStep = {
          id: `l-${sessionId}-${llmIndex}-${i}`,
          kind: "llm",
          timestamp: record.timestamp,
          llm: {
            index: llmIndex,
            model: record.model,
            hasToolCalls: false,
          },
          tools: [],
        };
        steps.push(llmStep);
        pendingLlm.push({ step: llmStep, userStep });
      } else {
        const pending = pendingLlm.shift();
        const target = pending?.step ?? null;
        if (!target) continue; // 无配对请求（孤立 response），跳过
        if (target.llm) {
          target.llm.model = record.model;
          target.llm.durationMs = record.durationMs;
          target.llm.inputTokens = record.inputTokens;
          target.llm.outputTokens = record.outputTokens;
          target.llm.cacheReadTokens = record.cacheReadTokens;
          target.llm.cacheCreationTokens = record.cacheCreationTokens;
          target.llm.finishReason = record.finishReason;
          target.llm.error = record.error;
          target.llm.responseText = record.responseText;
          target.llm.hasToolCalls = record.hasToolCalls;
        }
        // 工具子节点
        if (record.toolCalls) {
          for (const tc of record.toolCalls) {
            const toolNode: CallChainToolNode = {
              name: tc.name,
              input: tc.input,
              result: liveToolResults[liveToolIdx] ?? null,
              durationMs: gapMs,
              timestamp: record.timestamp,
              isError: Boolean(record.error),
            };
            liveToolIdx++;
            target.tools.push(toolNode);
          }
        }
        llmIndex++;
      }
    }

    // 未配对 request 标记为进行中（保留节点，指标缺失）
    for (const p of pendingLlm) {
      if (p.step.llm) {
        p.step.llm.finishReason = p.step.llm.finishReason ?? "in_progress";
      }
    }

    const responses = sessionRecords.filter((r) => r.direction === "response");
    const toolCalls = responses.filter((r) => r.hasToolCalls);
    result.push({
      sessionId,
      model: sessionRecords[0]?.model ?? "",
      steps,
      totalDurationMs: responses.reduce((s, r) => s + (r.durationMs ?? 0), 0),
      totalInputTokens: responses.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
      totalOutputTokens: responses.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
      toolCallCount: toolCalls.reduce((s, r) => s + (r.toolCalls?.length ?? 0), 0),
      errorCount: responses.filter((r) => r.error).length,
    });
  }

  return result;
}

// ──────────────────────────────────────────────
// 路由
// ──────────────────────────────────────────────

/** 创建可观测性路由 */
export function createObservabilityRoutes(options: ObservabilityOptions = {}): Hono {
  const app = new Hono();
  const logDir = options.logDir ?? resolveBranchLogsDir();

  // GET /traces — 列出全部 trace 日志
  app.get("/traces", (c) => {
    const files = listTraceFiles(logDir);
    const metas: TraceFileMeta[] = files.map((file) => {
      const date = file.slice(file.lastIndexOf("llm-trace-") + "llm-trace-".length, -".jsonl".length);
      const { records, sessions, models, size, modifiedAt } = summarizeFile(file);
      return { date, path: file, records, sessions, models, size, modifiedAt };
    });
    log.info("observability", `list traces count=${metas.length}`);
    return c.json(metas);
  });

  // GET /traces/:date — 指定日期的分析结果
  app.get("/traces/:date", (c) => {
    const date = c.req.param("date");
    const file = traceFileForDate(logDir, date);
    if (!file) {
      return c.json({ error: { message: `Trace log for ${date} not found` } }, 404);
    }
    const records = parseLogFile(file);
    if (records.length === 0) {
      return c.json({ error: { message: `Trace log for ${date} is empty` } }, 404);
    }
    const result = serializeAnalysis(analyzeRecords(records, file));
    return c.json({ date, file, analysis: result });
  });

  // GET /traces/:date/callchain — 指定日期的完整调用链
  app.get("/traces/:date/callchain", (c) => {
    const date = c.req.param("date");
    const file = traceFileForDate(logDir, date);
    if (!file) {
      return c.json({ error: { message: `Trace log for ${date} not found` } }, 404);
    }
    const records = parseLogFile(file);
    const sessions = buildCallChains(records, options.getLiveSession);
    log.info("observability", `callchain date=${date} sessions=${sessions.length}`);
    return c.json({ date, file, sessions });
  });

  return app;
}
