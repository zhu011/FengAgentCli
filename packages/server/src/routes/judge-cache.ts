/**
 * @fengagent/server — per-message LLM-judge 结果缓存
 *
 * 背景（AGE-29 P0 实测缺陷）：`GET /api/eval/messages/:date` 原先在请求内同步跑
 * LLM-judge（真实模型调用 10–33s+），超过 Bun.serve 默认 10s idleTimeout，连接被掐断
 * （curl HTTP 000 / exit 52），而服务端仍继续跑完评审 —— 前端永远停在「加载中」，
 * 且每次点击都重新评审同一 messageId（白烧 token）。
 *
 * 本模块提供两件事：
 *   1. **落盘缓存**：评审结果按 (date, sessionId, messageId) 存一份
 *      `<judge 缓存根>/<date>/<sessionId>__<messageId>.json`；
 *      同一消息第二次查询直接命中，不再调用模型（除非显式 `refresh`）。
 *   2. **并发去重**：同一 key 的评审在进程内只跑一次（`JudgeInflight`），
 *      连点 / 多标签页并发不会重复烧 token。
 *
 * 缓存根默认 `<数据根>/judge-cache`（与 trace / 报告同数据根，见 @fengagent/shared
 * resolveDataRoot），保证「观测/评测页读哪个根、缓存就落哪个根」；可注入覆盖（测试隔离）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JudgeResult } from "@fengagent/eval";

/** 落盘的 judge 缓存条目（JudgeResult + 归属与时间戳） */
export interface JudgeCacheEntry extends JudgeResult {
  /** 被评审的助手消息 ID（缓存键的一部分，落盘后便于人工核对） */
  messageId: string;
  /** 所属日期（缓存键的一部分） */
  date: string;
  /** 评审落盘时间（ISO） */
  judgedAt: string;
  /** 评审所用模型（judge 请求的 model 字段；未知时缺省） */
  model?: string;
}

/** 默认 judge 缓存根目录：<数据根>/judge-cache */
export function defaultJudgeCacheRoot(dataRoot: string): string {
  return join(dataRoot, "judge-cache");
}

/** 指定日期的 judge 缓存目录：<judge 缓存根>/<date> */
export function judgeCacheDir(cacheRoot: string, date: string): string {
  return join(cacheRoot, date);
}

/**
 * 把 sessionId / messageId 收敛为安全文件名片段。
 *
 * messageId 由 AgentLoop 生成（形如 `01a0...`），但为防注入路径分隔符，
 * 统一把 `[^A-Za-z0-9._-]` 替换为 `_` 并限长。
 */
function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return safe.length > 0 ? safe : "_";
}

/** 单条消息 judge 缓存文件路径 */
export function judgeCacheFile(
  cacheRoot: string,
  date: string,
  sessionId: string,
  messageId: string,
): string {
  return join(judgeCacheDir(cacheRoot, date), `${safeSegment(sessionId)}__${safeSegment(messageId)}.json`);
}

/** 判断解析出的对象是否为结构可用的缓存条目（宽容解析，坏文件当未命中） */
function isJudgeCacheEntry(value: unknown, date: string, messageId: string): value is JudgeCacheEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<JudgeCacheEntry>;
  return (
    typeof v.completionScore === "number" &&
    typeof v.correctnessScore === "number" &&
    typeof v.conclusion === "string" &&
    v.messageId === messageId &&
    v.date === date &&
    typeof v.judgedAt === "string"
  );
}

/**
 * 读取缓存的 judge 结果。
 *
 * @returns 命中且结构合法时返回条目；文件缺失 / JSON 损坏 / 结构不符时返回 null（视为未命中）
 */
export function readJudgeCache(
  cacheRoot: string,
  date: string,
  sessionId: string,
  messageId: string,
): JudgeCacheEntry | null {
  const file = judgeCacheFile(cacheRoot, date, sessionId, messageId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    return isJudgeCacheEntry(parsed, date, messageId) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 写入 judge 缓存（目录不存在时创建）。
 *
 * 写盘失败不影响请求结果（缓存是优化，不是正确性前提），故仅返回路径。
 *
 * @returns 缓存文件路径（写盘失败时也返回，便于日志记录）
 */
export function writeJudgeCache(
  cacheRoot: string,
  date: string,
  entry: JudgeCacheEntry,
): string {
  const dir = judgeCacheDir(cacheRoot, date);
  const file = judgeCacheFile(cacheRoot, date, entry.sessionId, entry.messageId);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, "utf-8");
  } catch {
    // 忽略：缓存写失败只是下次重评，不影响本次响应
  }
  return file;
}

/**
 * 并发去重集合：同一 judge key 在进程内只跑一次。
 *
 * 用途：前端连点「查看评测」/ 多标签页同时打开同一条消息时，避免重复的
 * LLM-judge 调用（每次 10–33s + 真实 token 花费）。
 */
export class JudgeInflight {
  private readonly running = new Map<string, Promise<void>>();

  /**
   * 若该 key 已有评审在跑则直接返回，否则启动 task 并登记。
   *
   * task 的 rejection 由调用方在 task 内部消化（本方法只负责登记与清理）。
   *
   * @returns 是否本次真正启动了任务（false = 已有同 key 评审在跑，已跳过）
   */
  start(key: string, task: () => Promise<void>): boolean {
    if (this.running.has(key)) return false;
    const p = task().finally(() => {
      this.running.delete(key);
    });
    this.running.set(key, p);
    return true;
  }

  /** 当前在跑的任务数（测试 / 观测用） */
  get size(): number {
    return this.running.size;
  }

  /** 等待全部在跑任务结束（测试用） */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  /** 是否已有该 key 在跑 */
  has(key: string): boolean {
    return this.running.has(key);
  }
}
