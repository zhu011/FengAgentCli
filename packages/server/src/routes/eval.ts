/**
 * @fengagent/server — 评测模块路由（评测 WebUI 数据源）
 *
 * 为 WebUI 评测页面提供：
 *   GET /api/eval/overview              — 评测报告 / 自优化建议 / 测试集 三合一清单
 *   GET /api/eval/reports/:date         — 指定日期的评测报告（Markdown）
 *   GET /api/eval/optimizations/:date   — 指定日期的自优化建议报告（Markdown）
 *   GET /api/eval/messages/:date?sessionId=X&messageId=Y — 单条消息评测
 *     （trace 指标摘要 + LLM-judge 结果；聊天页「查看评测」deep-link 消费。
 *       judge 字段由路由层接入 judgeMessage() 填充：从 filtered.steps
 *       提取 model + 工具名/参数构建 MessageTraceInfo → judgeMessage() →
 *       合并 { ...judgeResult, messageId }，结构对齐 JudgeResult：
 *       completionScore / correctnessScore / conclusion / note，维度为 messageId。
 *       未配置 llmClient 时 judge 为 null 且 judgeStatus="unavailable"。）
 *   POST /api/eval/reports                            — 触发生成评测报告（复用 CLI 评测管线）
 *
 * LLM-judge 的耗时与缓存（AGE-29 P0 修复）：
 *   judge 是真实模型调用（实测 10–33s+），原先同步跑在请求内 → 超过 Bun.serve 默认
 *   10s idleTimeout 被掐断，前端永远停在「加载中」，且每次点击重复评审同一条消息（白烧 token）。
 *   现在：
 *   - **默认异步**：立即返回 trace 指标 + `judgeStatus:"pending"`，后台评审写
 *     `<数据根>/judge-cache/<date>/…` 落盘缓存，前端轮询到缓存命中即展示；
 *   - **同步可选**：`?sync=1` 在请求内等评审完成（Bun.serve idleTimeout 已同步调大到 120s）；
 *   - **缓存**：命中缓存直接返回 `judgeStatus:"cached"`，不调用模型；`?refresh=1` 强制重评；
 *   - **并发去重**：同一 (date, sessionId, messageId) 在进程内只跑一次评审。
 *
 * 数据源约定（见 docs/EVALUATION.md 二、三）：
 *   - 评测报告：<数据根>/logs/eval-report-{date}.md（bun run eval 落盘）
 *   - 自优化建议：<数据根>/optimizations/optimization-{date}.md（bun run eval --optimize 落盘）
 *   - judge 缓存：<数据根>/judge-cache/<date>/<sessionId>__<messageId>.json
 *   - 测试集：<数据根>/testsets/*.json（AgentBench / DeepEval 风格，由评测引擎接入；
 *     本路由仅做宽容解析与清单展示，供「测试集管理」界面消费）
 */

import { Hono } from "hono";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@fengagent/shared";
import { parseLogFile, judgeMessage, runEval, LLM_FAILURE_NOTE_PREFIX } from "@fengagent/eval";
import type { JudgeResult, MessageTraceInfo } from "@fengagent/eval";
import type { LLMClient } from "@fengagent/llm";
import {
  buildCallChains,
  filterCallChainByMessage,
  resolveBranchDataRoot,
  traceFileForDate,
  type CallChainFocus,
  type CallChainStep,
  type SessionMessageLike,
} from "./observability.ts";
import {
  JudgeInflight,
  defaultJudgeCacheRoot,
  judgeCacheFile,
  readJudgeCache,
  writeJudgeCache,
} from "./judge-cache.ts";

const log = createLogger("server");

/** 评测报告元信息 */
export interface EvalReportMeta {
  date: string;
  path: string;
  size: number;
  modifiedAt: string;
}

/** 自优化建议报告元信息 */
export interface OptimizationMeta {
  date: string;
  path: string;
  size: number;
  modifiedAt: string;
}

/** 测试集元信息 */
export interface TestSetMeta {
  name: string;
  path: string;
  size: number;
  /** 测试用例数（宽容解析：数组 items / {cases|tests|examples} 字段） */
  records: number;
  /** 是否为有效 JSON */
  valid: boolean;
  /** 顶层结构概览（供 UI 展示 schema 风格） */
  shape: string;
}

/** 评测路由构造选项 */
export interface EvalRoutesOptions {
  /** 数据根（默认 resolveBranchDataRoot()；测试可注入） */
  dataRoot?: string;
  /** 日志目录（默认 <数据根>/logs） */
  logDir?: string;
  /** 优化建议目录（默认 <数据根>/optimizations） */
  optimizationsDir?: string;
  /** 测试集目录（默认 <数据根>/testsets） */
  testsetsDir?: string;
  /** judge 缓存根目录（默认 <数据根>/judge-cache） */
  judgeCacheRoot?: string;
  /** 会话消息提取器（可选；用于 per-message 评测：用户消息 → 助手轮次解析） */
  getSessionMessages?: (sessionId: string) => SessionMessageLike[] | undefined;
  /** LLM 客户端（可选；per-message 评测 judgeMessage 使用，缺失时 judge 返回 null） */
  llmClient?: LLMClient;
}

/** judge 字段的状态（前端据此决定「展示结果 / 轮询等待 / 显示未接入」） */
export type JudgeStatus =
  /** 命中落盘缓存（未调用模型） */
  | "cached"
  /** 本次请求内新评审完成 */
  | "fresh"
  /** 后台评审进行中（前端可稍后重查，命中缓存后返回 cached） */
  | "pending"
  /** 无法评审：未配置 llmClient，或该消息没有对应 trace 步骤 */
  | "unavailable";

/** 单条消息评测：trace 指标摘要 */
export interface MessageEvalTrace {
  llmCallCount: number;
  toolCallCount: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  finishReasons: string[];
  errors: string[];
}

/** 单条消息评测响应（聊天页「查看评测」deep-link 消费） */
export interface MessageEvalResponse {
  date: string;
  sessionId: string;
  messageId: string;
  /** deep-link 解析结果（用户消息 → 助手轮次） */
  focus: CallChainFocus | null;
  /** 消息内容（角色 + 文本） */
  message: { role: "user" | "assistant"; text: string } | null;
  /** 该消息轮次的 trace 指标摘要 */
  trace: MessageEvalTrace | null;
  /**
   * 单条消息 LLM-judge 结果（路由层接入 judgeMessage() 填充）。
   * 结构对齐 JudgeResult 并合并 messageId：
   * { messageId, sessionId, completionScore, correctnessScore, conclusion, note? }。
   * judge 为 null 时看 judgeStatus：pending = 后台评审中（稍后重查），
   * unavailable = 未配置 llmClient 或该消息无 trace 步骤。
   */
  judge: (JudgeResult & { messageId: string }) | null;
  /** judge 字段状态（cached / fresh / pending / unavailable） */
  judgeStatus: JudgeStatus;
}

/** 列出 `prefix-date.ext` 形态的文件并解析日期 */
function listDatedFiles(dir: string, prefix: string, ext: string): Array<{ date: string; path: string; size: number; modifiedAt: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
    .sort()
    .map((f) => {
      const path = join(dir, f);
      const stat = statSync(path);
      const date = f.slice(prefix.length, -ext.length);
      return { date, path, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    });
}

/** 宽容解析测试集文件，统计用例数并给出结构概览 */
function summarizeTestSet(path: string): Pick<TestSetMeta, "records" | "valid" | "shape"> {
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    let records = 0;
    if (Array.isArray(data)) records = data.length;
    else if (data && Array.isArray(data.items)) records = data.items.length;
    else if (data && Array.isArray(data.cases)) records = data.cases.length;
    else if (data && Array.isArray(data.tests)) records = data.tests.length;
    else if (data && Array.isArray(data.examples)) records = data.examples.length;
    else if (data && typeof data === "object") records = Object.keys(data).length;
    const shape = Array.isArray(data)
      ? `array[${data.length}]`
      : data && typeof data === "object"
        ? `object{${Object.keys(data).slice(0, 8).join(",")}}`
        : typeof data;
    return { records, valid: true, shape };
  } catch {
    return { records: 0, valid: false, shape: "invalid-json" };
  }
}

/** 工具参数序列化为字符串（MessageTraceInfo.toolCalls.input 约定为 string） */
function stringifyToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input === undefined || input === null) return "";
  const str = JSON.stringify(input);
  return typeof str === "string" ? str : "";
}

/**
 * 从过滤后的调用链步骤提取 judgeMessage 输入（MessageTraceInfo）。
 *
 * 数据源是 filtered.steps（buildCallChains + filterCallChainByMessage 产出）：
 * - userText       — 轮次内的用户步骤文本
 * - assistantText  — 点击消息对应的 LLM 步骤回复文本（工具循环多步时取首步）
 * - toolCalls      — 该轮次全部 LLM 步骤的工具调用（名 + 序列化参数）
 * - finishReasons / errors — 全部 LLM 步骤聚合
 * - model          — 点击消息对应 LLM 步骤的模型（缺失时取首个 LLM 步骤）
 */
function buildMessageTraceInfo(
  sessionId: string,
  messageId: string,
  filteredSteps: CallChainStep[],
): MessageTraceInfo {
  const llmSteps = filteredSteps.filter((s) => s.kind === "llm");
  const primary =
    llmSteps.find((s) => s.messageId === messageId) ?? llmSteps[0];
  const userStep = filteredSteps.find((s) => s.kind === "user");

  const toolCalls = llmSteps.flatMap((s) =>
    s.tools.map((t) => ({ name: t.name, input: stringifyToolInput(t.input) })),
  );

  return {
    sessionId,
    messageId,
    userText: userStep?.user?.text ?? "",
    assistantText: primary?.llm?.responseText ?? "",
    toolCalls,
    finishReasons: llmSteps
      .map((s) => s.llm?.finishReason)
      .filter((r): r is string => Boolean(r)),
    errors: llmSteps
      .map((s) => s.llm?.error)
      .filter((e): e is string => Boolean(e)),
    model: primary?.llm?.model ?? "",
  };
}

/** 创建评测模块路由 */
export function createEvalRoutes(options: EvalRoutesOptions = {}): Hono {
  const app = new Hono();
  const dataRoot = options.dataRoot ?? resolveBranchDataRoot();
  const logDir = options.logDir ?? join(dataRoot, "logs");
  const optimizationsDir = options.optimizationsDir ?? join(dataRoot, "optimizations");
  const testsetsDir = options.testsetsDir ?? join(dataRoot, "testsets");
  const judgeCache = options.judgeCacheRoot ?? defaultJudgeCacheRoot(dataRoot);
  /** per-message judge 并发去重（同 key 只跑一次评审） */
  const inflight = new JudgeInflight();
  /** POST /reports 报告生成去重（同一时刻只允许一个生成任务） */
  let reportBuilding: Promise<{ date: string; ok: boolean; error?: string }> | null = null;

  /** 列出三合一清单（GET /overview 与 POST /reports 复用） */
  const listOverview = () => {
    const reports = listDatedFiles(logDir, "eval-report-", ".md").map((f) => f as EvalReportMeta);
    const optimizations = listDatedFiles(optimizationsDir, "optimization-", ".md").map((f) => f as OptimizationMeta);
    const testsets: TestSetMeta[] = existsSync(testsetsDir)
      ? readdirSync(testsetsDir)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => {
            const path = join(testsetsDir, f);
            const stat = statSync(path);
            const summary = summarizeTestSet(path);
            return {
              name: f.slice(0, -".json".length),
              path,
              size: stat.size,
              modifiedAt: stat.mtime.toISOString(),
              ...summary,
            };
          })
      : [];
    log.info("eval", `overview reports=${reports.length} optimizations=${optimizations.length} testsets=${testsets.length}`);
    return { reports, optimizations, testsets };
  };

  // GET /overview — 三合一清单
  app.get("/overview", (c) => {
    return c.json(listOverview());
  });

  // POST /reports — 触发生成评测报告（复用 CLI 评测管线 bun run eval）
  // body: { date?: "YYYY-MM-DD"; optimize?: boolean }
  // 说明：WebUI 原先只能展示既有报告（最新报告可能停在一个月前），
  // 这里补上「生成」入口 —— 复用 runEval()，落点与 CLI 完全一致
  // （<数据根>/logs/eval-report-{生成日}.md，optimize=true 时另落 optimizations/）。
  app.post("/reports", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { date?: unknown; optimize?: unknown };
    const date =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : undefined;
    if (typeof body.date === "string" && date === undefined) {
      return c.json({ error: { message: "date must be YYYY-MM-DD" } }, 400);
    }
    const targetDate = date ?? new Date().toISOString().slice(0, 10);
    const traceFile = traceFileForDate(logDir, targetDate);
    if (!traceFile) {
      return c.json({ error: { message: `Trace log for ${targetDate} not found` } }, 404);
    }
    if (reportBuilding) {
      return c.json({ error: { message: "Report generation already running" } }, 409);
    }
    const task = (async (): Promise<{ date: string; ok: boolean; error?: string }> => {
      try {
        // throwOnMissingLog：嵌入服务进程时禁止 process.exit（否则会杀掉 HTTP 服务）
        await runEval({
          date: targetDate,
          optimize: body.optimize === true,
          llmClient: options.llmClient,
          logDir,
          testsetsDir,
          throwOnMissingLog: true,
        });
        return { date: targetDate, ok: true };
      } catch (err) {
        return {
          date: targetDate,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })();
    reportBuilding = task;
    const outcome = await task;
    if (reportBuilding === task) reportBuilding = null;
    if (!outcome.ok) {
      log.warn("eval", `report generation failed date=${targetDate} err=${outcome.error}`);
      return c.json({ error: { message: `Report generation failed: ${outcome.error}` } }, 500);
    }
    log.info("eval", `report generated date=${targetDate} optimize=${body.optimize === true}`);
    return c.json({ date: targetDate, ...listOverview() });
  });

  // GET /reports/:date — 评测报告内容（Markdown）
  app.get("/reports/:date", (c) => {
    const date = c.req.param("date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: { message: "date must be YYYY-MM-DD" } }, 400);
    }
    const path = join(logDir, `eval-report-${date}.md`);
    if (!existsSync(path)) {
      return c.json({ error: { message: `Eval report for ${date} not found` } }, 404);
    }
    const content = readFileSync(path, "utf-8");
    return c.json({ date, path, content });
  });

  // GET /optimizations/:date — 自优化建议报告内容（Markdown）
  app.get("/optimizations/:date", (c) => {
    const date = c.req.param("date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: { message: "date must be YYYY-MM-DD" } }, 400);
    }
    const path = join(optimizationsDir, `optimization-${date}.md`);
    if (!existsSync(path)) {
      return c.json({ error: { message: `Optimization report for ${date} not found` } }, 404);
    }
    const content = readFileSync(path, "utf-8");
    return c.json({ date, path, content });
  });

  // GET /testsets/:name — 单个测试集原始 JSON（供「测试集管理」界面查看/导出）
  app.get("/testsets/:name", (c) => {
    const name = c.req.param("name");
    // 仅允许文件名，拒绝路径穿越
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      return c.json({ error: { message: "invalid test set name" } }, 400);
    }
    const path = join(testsetsDir, `${name}.json`);
    if (!existsSync(path)) {
      return c.json({ error: { message: `Test set "${name}" not found` } }, 404);
    }
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      return c.json(data);
    } catch {
      return c.json({ error: { message: `Test set "${name}" is not valid JSON` } }, 422);
    }
  });

  // GET /messages/:date?sessionId=X&messageId=Y — 单条消息评测（聊天页「查看评测」deep-link）
  app.get("/messages/:date", async (c) => {
    const date = c.req.param("date");
    const sessionId = c.req.query("sessionId") ?? "";
    const messageId = c.req.query("messageId") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: { message: "date must be YYYY-MM-DD" } }, 400);
    }
    if (!sessionId || !messageId) {
      return c.json({ error: { message: "sessionId and messageId are required" } }, 400);
    }
    const file = traceFileForDate(logDir, date);
    if (!file) {
      return c.json({ error: { message: `Trace log for ${date} not found` } }, 404);
    }
    const records = parseLogFile(file).filter((r) => r.sessionId === sessionId);
    const sessionMessages = options.getSessionMessages?.(sessionId);

    // 通过调用链重建解析该消息所属轮次
    const chains = buildCallChains(records, undefined);
    const chain = chains.find((s) => s.sessionId === sessionId);
    const filtered = chain
      ? filterCallChainByMessage(chain, messageId, sessionMessages)
      : null;
    const focus = filtered?.focus ?? null;
    const llmSteps = filtered?.steps.filter((s) => s.kind === "llm") ?? [];

    const trace: MessageEvalTrace | null = llmSteps.length > 0
      ? {
          llmCallCount: llmSteps.length,
          toolCallCount: llmSteps.reduce((sum, s) => sum + s.tools.length, 0),
          durationMs: llmSteps.reduce((sum, s) => sum + (s.llm?.durationMs ?? 0), 0),
          inputTokens: llmSteps.reduce((sum, s) => sum + (s.llm?.inputTokens ?? 0), 0),
          outputTokens: llmSteps.reduce((sum, s) => sum + (s.llm?.outputTokens ?? 0), 0),
          finishReasons: llmSteps
            .map((s) => s.llm?.finishReason)
            .filter((r): r is string => Boolean(r)),
          errors: llmSteps
            .map((s) => s.llm?.error)
            .filter((e): e is string => Boolean(e)),
        }
      : null;

    // 消息内容：助手消息取 responseText；用户消息取过滤链中的用户步骤文本
    let message: MessageEvalResponse["message"] = null;
    if (focus?.role === "assistant") {
      const step = llmSteps.find((s) => s.messageId === messageId);
      const text = step?.llm?.responseText ?? "";
      if (text) message = { role: "assistant", text };
    } else if (focus?.role === "user") {
      const userStep = filtered?.steps.find((s) => s.kind === "user");
      const text = userStep?.user?.text ?? "";
      if (text) message = { role: "user", text };
    }

    // LLM-judge 单条消息评测：
    // 从 filtered.steps 提取 model + 工具名/参数构建 MessageTraceInfo → judgeMessage()。
    // judge 是真实模型调用（10–33s+），因此：
    //   命中落盘缓存 → 直接返回（judgeStatus=cached，不烧 token）
    //   ?sync=1     → 请求内等待（judgeStatus=fresh）
    //   默认        → 立即返回 trace 指标 + judgeStatus=pending，后台评审写缓存
    //   ?refresh=1  → 忽略缓存强制重评
    const canJudge = Boolean(options.llmClient) && Boolean(filtered) && llmSteps.length > 0;
    const forceRefresh = c.req.query("refresh") === "1";
    const syncJudge = c.req.query("sync") === "1";
    let judge: MessageEvalResponse["judge"] = null;
    let judgeStatus: JudgeStatus = "unavailable";

    /**
     * 跑一次评审。
     *
     * `cacheable=false` 表示这是 LLM 调用本身失败的容错结论（note 以
     * LLM_FAILURE_NOTE_PREFIX 开头）——不落盘，避免一次瞬时超时把失败结论固化，
     * 之后再也不重评。
     */
    const evaluate = async (): Promise<{
      judge: MessageEvalResponse["judge"];
      cacheable: boolean;
    }> => {
      if (!options.llmClient || !filtered) return { judge: null, cacheable: false };
      const info = buildMessageTraceInfo(sessionId, messageId, filtered.steps);
      const judgeResult = await judgeMessage(info, { llmClient: options.llmClient });
      const cacheable = !(judgeResult.note ?? "").startsWith(LLM_FAILURE_NOTE_PREFIX);
      if (cacheable) {
        writeJudgeCache(judgeCache, date, {
          ...judgeResult,
          sessionId,
          messageId,
          date,
          judgedAt: new Date().toISOString(),
          model: info.model || undefined,
        });
      }
      return { judge: { ...judgeResult, messageId }, cacheable };
    };

    /** 后台评审（落盘缓存；异常只记日志，不影响已返回的响应） */
    const runJudgeInBackground = async (): Promise<void> => {
      try {
        await evaluate();
      } catch (err) {
        log.warn(
          "eval",
          `judgeMessage failed sessionId=${sessionId} messageId=${messageId} err=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    if (canJudge) {
      const cached = forceRefresh ? null : readJudgeCache(judgeCache, date, sessionId, messageId);
      if (cached) {
        judge = { ...cached, messageId };
        judgeStatus = "cached";
      } else if (syncJudge) {
        const outcome = await evaluate();
        if (outcome.judge) {
          judge = outcome.judge;
          judgeStatus = "fresh";
        }
      } else {
        // 后台评审：不阻塞响应（前端据 judgeStatus=pending 轮询，命中缓存后返回 cached）
        const key = judgeCacheFile(judgeCache, date, sessionId, messageId);
        const started = inflight.start(key, runJudgeInBackground);
        judgeStatus = "pending";
        log.info(
          "eval",
          `messageEval judge queued date=${date} sessionId=${sessionId} messageId=${messageId} started=${started}`,
        );
      }
    }

    log.info("eval", `messageEval date=${date} sessionId=${sessionId} messageId=${messageId} llmSteps=${llmSteps.length} judge=${judgeStatus}`);
    return c.json({
      date,
      sessionId,
      messageId,
      focus,
      message,
      trace,
      judge,
      judgeStatus,
    } satisfies MessageEvalResponse);
  });

  return app;
}
