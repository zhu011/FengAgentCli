/**
 * @fengagent/server — 可观测性路由（AgentLoop 观测面板数据源）
 *
 * 为 WebUI 观测面板提供四类数据：
 *   GET /api/observability/traces                     — 列出全部 trace 日志文件（日期/规模/会话数）
 *   GET /api/observability/traces/:date               — 指定日期的分析结果（指标聚合，AnalysisResult）
 *   GET /api/observability/traces/:date/callchain     — 指定日期的完整调用链（会话 → 消息 → LLM 调用 → 工具调用）
 *   GET /api/observability/traces/:date/messages      — 指定日期、指定会话的按消息粒度摘要（deep-link 消息选择器）
 *
 * per-message 查询（聊天页「查看调用链」deep-link）：
 *   GET /api/observability/traces/:date/callchain?sessionId=X&messageId=Y
 *     返回 X 会话中 messageId=Y 所在轮次的调用链（steps 已过滤），并携带 focus 解析结果。
 *     messageId 为助手消息时直接命中 trace；为用户消息时通过会话消息解析到其后第一个
 *     助手轮次（工具循环产生的多个助手消息全部纳入）。会话消息不可用时退化为空步骤。
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
  /** 该 LLM 调用对应的助手消息 ID（用户步骤无此字段；per-message 查询用） */
  messageId?: string;
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

/** per-message 查询的焦点信息（deep-link 解析结果） */
export interface CallChainFocus {
  /** 点击的消息 ID（原样回传，便于前端展示） */
  messageId: string;
  /** 点击消息的角色（用户消息会解析到其后的助手轮次） */
  role: "user" | "assistant";
  /** 命中的助手消息 ID 集合（工具循环可能对应多个助手消息） */
  resolvedMessageIds: string[];
  /** 旧格式日志（无 messageId）按文本匹配定位时为 true */
  legacyMatch?: boolean;
}

/** 按消息粒度的调用链摘要（/traces/:date/messages 与评测 per-message 视图消费） */
export interface MessageTraceSummary {
  /** 消息 ID（trace 助手消息必有；用户消息来自会话消息，无则 null） */
  messageId: string | null;
  role: "user" | "assistant";
  text: string;
  /** ISO 时间（用户消息取自会话 createdAt，助手消息取自 trace） */
  timestamp: string;
  /** 该消息对应的 LLM 调用次数 */
  llmCallCount: number;
  /** 该消息对应的工具调用次数 */
  toolCallCount: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  error?: string | null;
}

/** 会话消息的宽松结构（供 per-message 解析；兼容 Session.messages） */
export interface SessionMessageLike {
  id?: string;
  role: string;
  createdAt?: number;
  content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
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
  /** 会话消息提取器（可选；用于 per-message 解析：用户消息 → 助手轮次） */
  getSessionMessages?: (sessionId: string) => SessionMessageLike[] | undefined;
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
          messageId: record.messageId,
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
        // 请求侧未带 messageId 时以响应侧为准
        if (!target.messageId && record.messageId) {
          target.messageId = record.messageId;
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
// per-message 解析（deep-link：聊天消息 → 调用链/评测）
// ──────────────────────────────────────────────

/** 判断消息是否为「真实用户文本消息」（tool-result 内部消息无 text 块，不计入） */
export function isTextUserMessage(m: SessionMessageLike): boolean {
  if (m.role !== "user") return false;
  const blocks = Array.isArray(m.content) ? m.content : [];
  return blocks.some(
    (b) => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0,
  );
}

/** 提取消息文本（text 块拼接） */
export function messageText(m: SessionMessageLike): string {
  const blocks = Array.isArray(m.content) ? m.content : [];
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
}

/**
 * 从会话消息解析点击消息所属轮次的助手消息 ID 集合。
 *
 * - 助手消息 → 自身 ID
 * - 真实用户文本消息 → 其后到下一个真实用户消息之前的全部助手消息 ID
 *   （工具循环会产生多个助手消息，全部属于同一轮对话）
 * - tool-result 内部用户消息 → null（无独立轮次）
 *
 * @returns 解析结果；会话消息缺失或消息不在列表中时返回 null
 */
export function resolveTurnMessageIds(
  messageId: string,
  sessionMessages?: SessionMessageLike[],
): { role: "user" | "assistant"; ids: string[] } | null {
  if (!sessionMessages) return null;
  const idx = sessionMessages.findIndex((m) => m.id === messageId);
  if (idx === -1) return null;
  const target = sessionMessages[idx]!;
  if (target.role === "assistant") {
    return { role: "assistant", ids: [messageId] };
  }
  if (!isTextUserMessage(target)) return null;
  const ids: string[] = [];
  for (let i = idx + 1; i < sessionMessages.length; i++) {
    const m = sessionMessages[i]!;
    if (isTextUserMessage(m)) break;
    if (m.role === "assistant" && m.id) ids.push(m.id);
  }
  return { role: "user", ids };
}

/** 为命中的 LLM 步骤补充其前置用户步骤（保持 用户→LLM 顺序） */
function withUserSteps(all: CallChainStep[], llmSteps: CallChainStep[]): CallChainStep[] {
  const userSteps = all.filter((s) => s.kind === "user");
  const out: CallChainStep[] = [];
  for (const step of llmSteps) {
    const prior = [...userSteps].reverse().find((u) => u.timestamp <= step.timestamp);
    if (prior && !out.includes(prior)) out.push(prior);
    if (!out.includes(step)) out.push(step);
  }
  return out;
}

/**
 * 将单个会话的调用链过滤到指定消息所属的轮次。
 *
 * 解析优先级：
 * 1. 直接命中 trace 中的助手 messageId（新格式日志）
 * 2. 用户消息经 resolveTurnMessageIds 解析到其后的助手轮次（新格式日志）
 * 3. 旧格式日志（无 messageId）回退：按文本匹配用户消息 / 助手回复
 *
 * @returns 过滤后的步骤 + focus 解析信息；无匹配时 steps 为空数组
 */
export function filterCallChainByMessage(
  chain: CallChainSession,
  messageId: string,
  sessionMessages?: SessionMessageLike[],
): { steps: CallChainStep[]; focus: CallChainFocus } {
  // 1) 直接命中：messageId 是某条 trace 的助手消息 ID
  const direct = chain.steps.filter((s) => s.messageId === messageId);
  if (direct.length > 0) {
    return {
      steps: withUserSteps(chain.steps, direct),
      focus: { messageId, role: "assistant", resolvedMessageIds: [messageId] },
    };
  }
  // 2) 用户消息 → 通过会话消息解析到其后的助手轮次
  const turn = resolveTurnMessageIds(messageId, sessionMessages);
  if (turn && turn.ids.length > 0) {
    const matched = chain.steps.filter((s) => s.messageId && turn.ids.includes(s.messageId));
    if (matched.length > 0) {
      return {
        steps: withUserSteps(chain.steps, matched),
        focus: { messageId, role: turn.role, resolvedMessageIds: turn.ids },
      };
    }
  }
  // 3) 旧格式日志回退：按文本匹配（trace 无 messageId 时）
  if (sessionMessages) {
    const target = sessionMessages.find((m) => m.id === messageId);
    if (target) {
      if (isTextUserMessage(target)) {
        const text = messageText(target);
        const userIdx = chain.steps.findIndex((s) => s.kind === "user" && s.user?.text === text);
        if (userIdx !== -1 && text) {
          const steps: CallChainStep[] = [chain.steps[userIdx]!];
          for (let i = userIdx + 1; i < chain.steps.length; i++) {
            const s = chain.steps[i]!;
            if (s.kind === "user" && s.user?.text !== text) break;
            steps.push(s);
          }
          return {
            steps,
            focus: { messageId, role: "user", resolvedMessageIds: [], legacyMatch: true },
          };
        }
      } else if (target.role === "assistant") {
        const text = messageText(target);
        if (text) {
          const llmIdx = chain.steps.findIndex(
            (s) =>
              s.kind === "llm" &&
              Boolean(s.llm?.responseText) &&
              (s.llm!.responseText!.startsWith(text) || text.startsWith(s.llm!.responseText!)),
          );
          if (llmIdx !== -1) {
            const llmStep = chain.steps[llmIdx]!;
            const prior = [...chain.steps]
              .slice(0, llmIdx)
              .reverse()
              .find((s) => s.kind === "user");
            const steps = prior ? [prior, llmStep] : [llmStep];
            return {
              steps,
              focus: { messageId, role: "assistant", resolvedMessageIds: [], legacyMatch: true },
            };
          }
        }
      }
    }
  }
  // 4) 无匹配 — 返回空步骤（前端展示「该日期无此消息的调用链」）
  return { steps: [], focus: { messageId, role: "user", resolvedMessageIds: [] } };
}

/**
 * 构建按消息粒度的 trace 摘要（/traces/:date/messages 与评测 per-message 视图）。
 *
 * 助手消息来自 trace（按 messageId 聚合 request/response）；
 * 真实用户文本消息来自会话消息（无 trace 记录时也有条目，便于选择器展示）。
 * 返回顺序与会话消息一致（无会话消息时按 trace 出现顺序）。
 */
export function buildMessageSummaries(
  records: TraceRecord[],
  sessionMessages?: SessionMessageLike[],
): MessageTraceSummary[] {
  const byMessage = new Map<string, TraceRecord[]>();
  for (const r of records) {
    if (!r.messageId) continue;
    const list = byMessage.get(r.messageId);
    if (list) list.push(r);
    else byMessage.set(r.messageId, [r]);
  }

  const assistantById = new Map<string, MessageTraceSummary>();
  for (const [messageId, recs] of byMessage) {
    const resp = recs.find((r) => r.direction === "response");
    const timestamp = recs[0]?.timestamp ?? "";
    assistantById.set(messageId, {
      messageId,
      role: "assistant",
      text: resp?.responseText ?? "",
      timestamp,
      llmCallCount: 1,
      toolCallCount: resp?.toolCalls?.length ?? 0,
      durationMs: resp?.durationMs,
      inputTokens: resp?.inputTokens,
      outputTokens: resp?.outputTokens,
      finishReason: resp?.finishReason,
      error: resp?.error ?? null,
    });
  }

  const summaries: MessageTraceSummary[] = [];
  if (sessionMessages) {
    for (const m of sessionMessages) {
      if (isTextUserMessage(m)) {
        summaries.push({
          messageId: m.id ?? null,
          role: "user",
          text: messageText(m),
          timestamp: m.createdAt ? new Date(m.createdAt).toISOString() : "",
          llmCallCount: 0,
          toolCallCount: 0,
        });
      } else if (m.role === "assistant" && m.id) {
        const s = assistantById.get(m.id);
        if (s) summaries.push(s);
      }
    }
  } else {
    summaries.push(...assistantById.values());
  }
  return summaries;
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
  // 支持 per-message 深链：?sessionId=X&messageId=Y（返回该消息轮次的过滤链 + focus）
  app.get("/traces/:date/callchain", (c) => {
    const date = c.req.param("date");
    const file = traceFileForDate(logDir, date);
    if (!file) {
      return c.json({ error: { message: `Trace log for ${date} not found` } }, 404);
    }
    const records = parseLogFile(file);
    const sessionId = c.req.query("sessionId") || undefined;
    const messageId = c.req.query("messageId") || undefined;

    let sessions = buildCallChains(records, options.getLiveSession);
    if (sessionId) {
      sessions = sessions.filter((s) => s.sessionId === sessionId);
    }

    // per-message 深链：解析消息所属轮次并过滤步骤
    let focus: CallChainFocus | null = null;
    if (messageId) {
      let target: CallChainSession | undefined;
      if (sessionId) {
        target = sessions.find((s) => s.sessionId === sessionId);
      } else {
        // 未指定会话：先在 trace 内直接找该助手消息
        target = sessions.find((s) => s.steps.some((st) => st.messageId === messageId));
        if (!target) {
          // 再按会话消息解析用户消息轮次
          for (const s of sessions) {
            const msgs = options.getSessionMessages?.(s.sessionId);
            const turn = resolveTurnMessageIds(messageId, msgs);
            if (turn && turn.ids.some((id) => s.steps.some((st) => st.messageId === id))) {
              target = s;
              break;
            }
          }
        }
      }
      if (target) {
        const sessionMessages = options.getSessionMessages?.(target.sessionId);
        const filtered = filterCallChainByMessage(target, messageId, sessionMessages);
        sessions = [{ ...target, steps: filtered.steps }];
        focus = filtered.focus;
      } else {
        sessions = [];
        focus = null;
      }
    }

    log.info("observability", `callchain date=${date} sessions=${sessions.length} focus=${messageId ?? "none"}`);
    return c.json({ date, file, sessions, focus });
  });

  // GET /traces/:date/messages?sessionId=X — 指定会话的按消息粒度摘要（deep-link 消息选择器）
  app.get("/traces/:date/messages", (c) => {
    const date = c.req.param("date");
    const sessionId = c.req.query("sessionId");
    if (!sessionId) {
      return c.json({ error: { message: "sessionId is required" } }, 400);
    }
    const file = traceFileForDate(logDir, date);
    if (!file) {
      return c.json({ error: { message: `Trace log for ${date} not found` } }, 404);
    }
    const records = parseLogFile(file).filter((r) => r.sessionId === sessionId);
    const sessionMessages = options.getSessionMessages?.(sessionId);
    const messages = buildMessageSummaries(records, sessionMessages);
    log.info("observability", `messages date=${date} sessionId=${sessionId} count=${messages.length}`);
    return c.json({ date, file, sessionId, messages });
  });

  return app;
}
