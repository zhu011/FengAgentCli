/**
 * @fengagent/server — 评测模块路由（评测 WebUI 数据源）
 *
 * 为 WebUI 评测页面提供：
 *   GET /api/eval/overview              — 评测报告 / 自优化建议 / 测试集 三合一清单
 *   GET /api/eval/reports/:date         — 指定日期的评测报告（Markdown）
 *   GET /api/eval/optimizations/:date   — 指定日期的自优化建议报告（Markdown）
 *   GET /api/eval/messages/:date?sessionId=X&messageId=Y — 单条消息评测
 *     （trace 摘要 + LLM-judge 结果；聊天页「查看评测」deep-link 消费。
 *       judge 字段由路由层接入 KG 的 judgeMessage() 填充：从 filtered.steps
 *       提取 model + 工具名/参数构建 MessageTraceInfo → judgeMessage() →
 *       合并 { ...judgeResult, messageId }，结构对齐 JudgeResult：
 *       completionScore / correctnessScore / conclusion / note，维度为 messageId。
 *       未配置 llmClient 时 judge 为 null。）
 *
 * 数据源约定（见 docs/EVALUATION.md 二、三）：
 *   - 评测报告：<数据根>/logs/eval-report-{date}.md（bun run eval 落盘）
 *   - 自优化建议：<数据根>/optimizations/optimization-{date}.md（bun run eval --optimize 落盘）
 *   - 测试集：<数据根>/testsets/*.json（AgentBench / DeepEval 风格，由评测引擎接入；
 *     本路由仅做宽容解析与清单展示，供「测试集管理」界面消费）
 */

import { Hono } from "hono";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@fengagent/shared";
import { parseLogFile, judgeMessage } from "@fengagent/eval";
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
  /** 日志目录（默认 <数据根>/logs） */
  logDir?: string;
  /** 优化建议目录（默认 <数据根>/optimizations） */
  optimizationsDir?: string;
  /** 测试集目录（默认 <数据根>/testsets） */
  testsetsDir?: string;
  /** 会话消息提取器（可选；用于 per-message 评测：用户消息 → 助手轮次解析） */
  getSessionMessages?: (sessionId: string) => SessionMessageLike[] | undefined;
  /** LLM 客户端（可选；per-message 评测 judgeMessage 使用，缺失时 judge 返回 null） */
  llmClient?: LLMClient;
}

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
   * 未配置 llmClient 或该消息无 trace 步骤时为 null。
   */
  judge: (JudgeResult & { messageId: string }) | null;
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
  const dataRoot = resolveBranchDataRoot();
  const logDir = options.logDir ?? join(dataRoot, "logs");
  const optimizationsDir = options.optimizationsDir ?? join(dataRoot, "optimizations");
  const testsetsDir = options.testsetsDir ?? join(dataRoot, "testsets");
  // GET /overview — 三合一清单
  app.get("/overview", (c) => {
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
    return c.json({ reports, optimizations, testsets });
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

    // LLM-judge 单条消息评测（R2：接入 judgeMessage）
    // 从 filtered.steps 提取 model + 工具名/参数构建 MessageTraceInfo，
    // 调用 judgeMessage() 后合并 { ...judgeResult, messageId } 回填 judge 字段。
    let judge: MessageEvalResponse["judge"] = null;
    if (options.llmClient && filtered && llmSteps.length > 0) {
      try {
        const info = buildMessageTraceInfo(sessionId, messageId, filtered.steps);
        const judgeResult = await judgeMessage(info, { llmClient: options.llmClient });
        judge = { ...judgeResult, messageId };
      } catch (err) {
        log.warn(
          "eval",
          `judgeMessage failed sessionId=${sessionId} messageId=${messageId} err=${err instanceof Error ? err.message : String(err)}`,
        );
        judge = null;
      }
    }

    log.info("eval", `messageEval date=${date} sessionId=${sessionId} messageId=${messageId} llmSteps=${llmSteps.length} judged=${judge !== null}`);
    return c.json({
      date,
      sessionId,
      messageId,
      focus,
      message,
      trace,
      judge,
    } satisfies MessageEvalResponse);
  });

  return app;
}
