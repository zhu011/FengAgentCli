/**
 * @fengagent/llm — LLM 调用追踪日志器
 *
 * 将每次 LLM 请求/回复以 JSONL 格式写入独立日志文件，
 * 供 eval 模块分析工具选择准确率、token 用量、耗时等。
 *
 * 日志路径：{workdir}/.fengagent/logs/llm-trace-{date}.jsonl
 *
 * 每条记录格式（一行 JSON）：
 * {
 *   "timestamp": "2026-08-13T15:00:00.000Z",
 *   "sessionId": "xxx",
 *   "messageId": "xxx",  // 本次 LLM 调用对应的助手消息 ID（deep-link 到单条消息）
 *   "direction": "request" | "response",
 *   "model": "deepseek-v4-pro",
 *   "durationMs": 1234,
 *   "inputTokens": 5330,
 *   "outputTokens": 372,
 *   "hasToolCalls": true,
 *   "toolCalls": [{"name": "bash", "input": {...}}],
 *   "finishReason": "tool_use",
 *   "error": null,
 *   "messages": [...],  // 请求时记录
 *   "tools": ["file-read", "bash", ...],  // 请求时记录工具名列表
 *   "responseText": "..."  // 回复时记录（截断到 500 字符）
 * }
 */

import { resolve, join } from "node:path";
import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import type { LLMRequest, LLMEvent } from "./types.ts";

/** 追踪记录类型 */
export interface LlmTraceRecord {
  timestamp: string;
  sessionId: string;
  /** 本次 LLM 调用对应的助手消息 ID（Agent Loop 每个循环步生成；用于按消息粒度查询调用链） */
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

/** 获取日志目录 */
function getLogDir(): string {
  const workdir = process.cwd();
  const logDir = resolve(workdir, ".fengagent/logs");
  if (!existsSync(logDir)) {
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      // ignore
    }
  }
  return logDir;
}

/** 获取当天日志文件路径 */
function getLogFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(getLogDir(), `llm-trace-${date}.jsonl`);
}

/** 检测是否在测试环境中运行（避免 mock 数据污染 trace 日志） */
function isTestEnvironment(): boolean {
  // Bun 测试运行器设置 import.meta.env.TEST 或 process.env.NODE_ENV=test
  // 也可通过 FENG_TRACE_DISABLED 手动禁用
  if (process.env.FENG_TRACE_DISABLED === "true") return true;
  if (process.env.NODE_ENV === "test") return true;
  // Bun test 设置的标志
  try {
    // @ts-ignore — import.meta.env 在 Bun 中可用
    if (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.TEST) return true;
  } catch {
    // ignore
  }
  // 检测 bun test 运行器（通过 process.argv 中的 test 路径）
  if (process.argv.some((arg) => arg.includes("__tests__") || arg.endsWith(".test.ts") || arg.endsWith(".test.tsx"))) {
    return true;
  }
  return false;
}

/** 写入一条 JSONL 记录（测试环境下跳过） */
function writeRecord(record: LlmTraceRecord): void {
  if (isTestEnvironment()) return;
  try {
    const line = JSON.stringify(record) + "\n";
    appendFileSync(getLogFile(), line, "utf-8");
  } catch {
    // ignore write errors
  }
}

/**
 * 创建 LLM 追踪日志器。
 *
 * 用法：
 * ```ts
 * const tracer = createLlmTracer();
 * tracer.logRequest(sessionId, request);
 * // ... 调用 LLM ...
 * tracer.logResponse(sessionId, model, events, durationMs);
 * ```
 */
export function createLlmTracer() {
  return {
    /**
     * 记录 LLM 请求。
     * 在调用 llmClient.stream() / generate() 前调用。
     *
     * @param sessionId - 会话 ID
     * @param request - LLM 请求
     * @param messageId - 本次调用对应的助手消息 ID（可选，用于 per-message 查询）
     */
    logRequest(sessionId: string, request: LLMRequest, messageId?: string): void {
      const record: LlmTraceRecord = {
        timestamp: new Date().toISOString(),
        sessionId,
        ...(messageId ? { messageId } : {}),
        direction: "request",
        model: request.model,
        hasToolCalls: false,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content.map((b) => {
            if (b.type === "text") return { type: "text", text: b.text.slice(0, 200) };
            if (b.type === "tool-use") return { type: "tool-use", id: b.id, name: b.name };
            if (b.type === "tool-result") return { type: "tool-result", toolUseId: b.toolUseId };
            return { type: b.type };
          }),
        })),
        tools: request.tools?.map((t) => t.name) ?? [],
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      };
      writeRecord(record);
    },

    /**
     * 记录 LLM 回复。
     * 在 LLM 流结束后调用，传入收集到的事件。
     *
     * @param sessionId - 会话 ID
     * @param model - 模型名
     * @param events - LLM 事件列表
     * @param durationMs - 调用耗时
     * @param messageId - 本次调用对应的助手消息 ID（可选，与 logRequest 一致）
     */
    logResponse(
      sessionId: string,
      model: string,
      events: LLMEvent[],
      durationMs: number,
      messageId?: string,
    ): void {
      const toolCalls: Array<{ name: string; input: unknown }> = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens: number | undefined;
      let cacheCreationTokens: number | undefined;
      let finishReason: string | undefined;
      let responseText = "";
      let error: string | null = null;

      for (const event of events) {
        switch (event.type) {
          case "text-delta":
            responseText += event.text;
            break;
          case "tool-call":
            toolCalls.push({ name: event.name, input: event.input });
            break;
          case "usage":
            inputTokens = event.inputTokens;
            outputTokens = event.outputTokens;
            if (event.cacheReadTokens) cacheReadTokens = event.cacheReadTokens;
            if (event.cacheCreationTokens) cacheCreationTokens = event.cacheCreationTokens;
            break;
          case "finish":
            finishReason = event.reason;
            break;
          case "error":
            error = event.error.message;
            break;
        }
      }

      const record: LlmTraceRecord = {
        timestamp: new Date().toISOString(),
        sessionId,
        ...(messageId ? { messageId } : {}),
        direction: "response",
        model,
        durationMs,
        inputTokens,
        outputTokens,
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
        hasToolCalls: toolCalls.length > 0,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
        error,
        responseText: responseText.slice(0, 500) || undefined,
      };
      writeRecord(record);
    },
  };
}

/** 追踪器类型 */
export type LlmTracer = ReturnType<typeof createLlmTracer>;
