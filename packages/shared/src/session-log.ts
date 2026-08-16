/**
 * @fengagent/shared — 会话 JSONL 日志器
 *
 * 将每次对话消息以 JSONL 格式写入独立日志文件，
 * 与 SQLite 并行，作为人工可见的追加副本。
 *
 * 日志路径：{dataRoot}/logs/sessions-{date}.jsonl（dataRoot 见 resolveDataRoot）
 *
 * 每条记录格式（一行 JSON）：
 * {
 *   "timestamp": "2026-08-13T15:00:00.000Z",
 *   "sessionId": "xxx",
 *   "messageId": "yyy",
 *   "role": "user" | "assistant" | "system",
 *   "content": [{"type":"text","text":"..."}],
 *   "model": "deepseek-v4-pro",
 *   "hasToolCalls": false,
 *   "toolCalls": [{"name":"bash","input":{...}}],
 *   "tokenCount": 167
 * }
 */

import { join } from "node:path";
import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { resolveLogsDir } from "./data-root.ts";

/** 会话日志记录 */
export interface SessionLogRecord {
  timestamp: string;
  sessionId: string;
  messageId: string;
  role: "user" | "assistant" | "system";
  content: unknown;
  model?: string;
  hasToolCalls: boolean;
  toolCalls?: Array<{ name: string; input: unknown }>;
  tokenCount?: number;
}

function getLogDir(): string {
  const logDir = resolveLogsDir();
  if (!existsSync(logDir)) {
    try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
  }
  return logDir;
}

function getLogFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(getLogDir(), `sessions-${date}.jsonl`);
}

/**
 * 写入一条会话消息到 JSONL 日志。
 *
 * @param record - 会话日志记录
 */
export function writeSessionLog(record: SessionLogRecord): void {
  try {
    const line = JSON.stringify(record) + "\n";
    appendFileSync(getLogFile(), line, "utf-8");
  } catch {
    // 文件写入失败 — 忽略
  }
}
