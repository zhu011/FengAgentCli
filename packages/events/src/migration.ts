/**
 * @fengagent/events — 事件导出/导入（Phase 3 跨数据根 / 跨机迁移）
 *
 * 可移植文件格式（JSONL，首行 header + 逐条事件，事件行与事件日志逐字一致）：
 *
 * ```jsonl
 * {"type":"fengagent-export","format":"fengagent-event-export","version":1,
 *  "exportedAt":"2026-08-16T...Z","sessionId":"<uuid>","eventCount":N,
 *  "firstSeq":1,"lastSeq":N,"lastHash":"<sha256>"}
 * {…事件 seq=1…}
 * {…事件 seq=N…}
 * ```
 *
 * 文件是**机器无关**的：事件携带的时间戳为 ISO-8601、sessionId 为 UUID、hash 链
 * 由内容推导（canonical JSON），不含任何本机路径/进程态 → 同一文件可在另一数据根
 * 或另一台机器原样导入。
 *
 * 导入路径：
 * 1. header 校验（format/version/sessionId/eventCount）；
 * 2. 事件行解析 + 同一会话约束；
 * 3. `verifyEventChain`（#5：seq 连续 + hash/prevHash 链完整）— 失败拒绝；
 * 4. 运行时注册表校验（#1，EventStore.importEvents 内逐条校验）— 未注册类型拒绝；
 * 5. 幂等去重（EventStore.importEvents：noop / appended 前缀续写；冲突抛错）。
 *
 * 配合 rebuild.ts 的「以事件为准重建」即可完成端到端迁移：
 * 导出（源根）→ 导入（新根事件日志）→ 重建（新根读模型）→ 对账绿。
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EventStore, ImportOutcome } from "./event-store.ts";
import { ImportConflictError } from "./event-store.ts";
import { verifyEventChain } from "./hash.ts";
import type { AnySessionEvent } from "./types.ts";

/** 可移植文件格式标识（header.type 与 format 双保险） */
export const EVENT_EXPORT_FORMAT = "fengagent-event-export";
export const EVENT_EXPORT_VERSION = 1;
/** 导出文件扩展名 */
export const EVENT_EXPORT_EXT = ".fengevents.jsonl";

/** 可移植文件 header 行（type/format/version 三重识别，避免与事件行混淆） */
export interface EventExportHeader {
  type: "fengagent-export";
  format: typeof EVENT_EXPORT_FORMAT;
  version: typeof EVENT_EXPORT_VERSION;
  /** 导出时刻（ISO-8601） */
  exportedAt: string;
  sessionId: string;
  eventCount: number;
  firstSeq: number;
  lastSeq: number;
  /** 链尾哈希（导入方核验 header 与事件链一致） */
  lastHash: string;
}

/** 批量导入汇总 */
export interface ImportSummary {
  /** 成功导入的会话数 */
  imported: number;
  /** 幂等去重（noop/appended）的会话数 */
  skipped: number;
  /** 校验/冲突失败被拒的会话数 */
  failed: number;
  /** 失败明细（文件 → 错误信息） */
  failures: Array<{ file: string; error: string }>;
}

function isHeaderLine(value: unknown): value is EventExportHeader {
  if (value === null || typeof value !== "object") return false;
  const h = value as Partial<EventExportHeader>;
  return (
    h.type === "fengagent-export" &&
    h.format === EVENT_EXPORT_FORMAT &&
    h.version === EVENT_EXPORT_VERSION &&
    typeof h.sessionId === "string" &&
    h.sessionId !== "" &&
    typeof h.eventCount === "number" &&
    Number.isSafeInteger(h.eventCount) &&
    h.eventCount >= 0 &&
    typeof h.lastSeq === "number" &&
    typeof h.lastHash === "string"
  );
}

/** 会话 id → 文件名安全化（与 EventStore 一致） */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * 导出会话事件 → 可移植文件（`<dir>/<sanitizedSessionId>.fengevents.jsonl` 或显式 filePath）。
 * 事件行与事件日志逐字一致（保留 seq/hash/timestamp 信封），header 含链尾哈希供导入核验。
 * @returns 写入的 header
 */
export function exportSessionEvents(
  store: EventStore,
  sessionId: string,
  filePath: string,
): EventExportHeader {
  const events = store.replay(sessionId);
  if (events.length === 0) {
    throw new Error(`exportSessionEvents: 会话 ${sessionId} 无事件（事件日志为空）`);
  }
  const problems = verifyEventChain(events);
  if (problems.length > 0) {
    throw new ImportConflictError(
      `exportSessionEvents: 源事件链不完整，拒绝导出（会话 ${sessionId}）`,
      problems,
    );
  }
  const last = events[events.length - 1]!;
  const header: EventExportHeader = {
    type: "fengagent-export",
    format: EVENT_EXPORT_FORMAT,
    version: EVENT_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    sessionId,
    eventCount: events.length,
    firstSeq: events[0]!.seq,
    lastSeq: last.seq,
    lastHash: last.hash,
  };
  const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return header;
}

/**
 * 导入可移植事件文件（exportSessionEvents 的逆操作）。
 *
 * 校验顺序（任一步失败即拒绝，目标日志不动）：
 * 1. header 形状/版本；
 * 2. 事件行解析 + 同一会话约束（与 header.sessionId 一致）；
 * 3. header.eventCount === 事件数、header.lastHash === 链尾 hash；
 * 4. verifyEventChain（#5 seq 连续 + hash/prevHash 链完整）；
 * 5. EventStore.importEvents：注册表校验（#1）+ 幂等去重（noop/appended）/ 冲突拒绝。
 *
 * @returns 导入结果（status=imported/appended/noop；幂等重复导入返回 noop）
 */
export function importSessionEvents(
  store: EventStore,
  filePath: string,
): ImportOutcome {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new ImportConflictError(
      `importSessionEvents: 无法读取文件 ${filePath}`,
      [err instanceof Error ? err.message : String(err)],
    );
  }

  const lines = text.split("\n");
  const header = parseHeader(lines);
  const events: AnySessionEvent[] = [];

  // 事件行解析（跳过空行/末尾换行；坏行即拒 — 可移植文件不允许半行）
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ImportConflictError(
        `importSessionEvents: 第 ${i + 1} 行 JSON 解析失败（文件损坏）`,
        [line.slice(0, 80)],
      );
    }
    const ev = parsed as Partial<AnySessionEvent>;
    if (ev.sessionId !== header.sessionId) {
      throw new ImportConflictError(
        "importSessionEvents: 事件 sessionId 与 header 不一致",
        [`行 ${i + 1}: ${String(ev.sessionId)} ≠ header ${header.sessionId}`],
      );
    }
    events.push(parsed as AnySessionEvent);
  }

  // header 计数/链尾核验
  if (events.length !== header.eventCount) {
    throw new ImportConflictError(
      "importSessionEvents: 事件数与 header.eventCount 不一致",
      [`实际 ${events.length} ≠ header ${header.eventCount}`],
    );
  }
  if (events.length > 0 && events[events.length - 1]!.hash !== header.lastHash) {
    throw new ImportConflictError(
      "importSessionEvents: 链尾 hash 与 header.lastHash 不一致（文件被篡改或截断）",
      [`实际 ${events[events.length - 1]!.hash.slice(0, 12)}… ≠ header ${header.lastHash.slice(0, 12)}…`],
    );
  }

  // #5 hash 链 + seq 连续；#1 注册表 + 幂等去重交给 EventStore.importEvents
  const chainProblems = verifyEventChain(events);
  if (chainProblems.length > 0) {
    throw new ImportConflictError(
      "importSessionEvents: 事件链校验失败（#5），拒绝导入",
      chainProblems,
    );
  }
  return store.importEvents(events);
}

/** 解析 header 行（第 1 个非空行；缺失/形状不符 → 拒绝） */
function parseHeader(lines: string[]): EventExportHeader {
  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ImportConflictError(
        "importSessionEvents: 首行不是合法 header（JSON 解析失败）",
        [line.slice(0, 80)],
      );
    }
    if (!isHeaderLine(parsed)) {
      throw new ImportConflictError(
        "importSessionEvents: 首行不是 fengagent-event-export header（可能不是可移植事件文件）",
        [line.slice(0, 80)],
      );
    }
    return parsed;
  }
  throw new ImportConflictError("importSessionEvents: 空文件，缺少 header", []);
}

/**
 * 导出整库：把事件日志中每个会话导出为一个可移植文件到 dir。
 * @returns 写入的文件路径列表
 */
export function exportStoreEvents(store: EventStore, dir: string): string[] {
  const sessionIds = store.listSessionIds();
  const written: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // 目录可能已存在或不可创建 — 交给写入报错
  }
  for (const sessionId of sessionIds) {
    const filePath = join(dir, `${sanitizeSessionId(sessionId)}${EVENT_EXPORT_EXT}`);
    exportSessionEvents(store, sessionId, filePath);
    written.push(filePath);
  }
  return written;
}

/**
 * 导入整库：把 dir 下全部 `*.fengevents.jsonl` 导入事件日志（逐文件幂等去重）。
 * 单个文件失败不影响其余（汇总 failures）。
 */
export function importStoreEvents(store: EventStore, dir: string): ImportSummary {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(EVENT_EXPORT_EXT));
  } catch {
    return { imported: 0, skipped: 0, failed: 0, failures: [] };
  }
  const summary: ImportSummary = { imported: 0, skipped: 0, failed: 0, failures: [] };
  for (const file of files) {
    try {
      const outcome = importSessionEvents(store, join(dir, file));
      if (outcome.status === "noop") summary.skipped++;
      else summary.imported++;
    } catch (err) {
      summary.failed++;
      summary.failures.push({
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return summary;
}
