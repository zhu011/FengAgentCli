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

/** 写入一条 JSONL 记录 */
function writeRecord(record: LlmTraceRecord): void {
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
     */
    logRequest(sessionId: string, request: LLMRequest): void {
      const record: LlmTraceRecord = {
        timestamp: new Date().toISOString(),
        sessionId,
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
     */
    logResponse(
      sessionId: string,
      model: string,
      events: LLMEvent[],
      durationMs: number,
    ): void {
      const toolCalls: Array<{ name: string; input: unknown }> = [];
      let inputTokens = 0;
      let outputTokens = 0;
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
        direction: "response",
        model,
        durationMs,
        inputTokens,
        outputTokens,
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
