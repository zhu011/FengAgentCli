/**
 * @fengagent/events — 事件日志存储（Phase 1 写路径 / 重放 / 崩溃自愈）
 *
 * EventStore 是会话事件日志的唯一落盘实现：
 * - 每会话单文件 append-only：`<dir>/{sessionId}.jsonl`，一行一条事件；
 * - 追加校验走运行时注册表（#1）：append/isSessionEvent 经 registry.validate，
 *   `ctx.eventLog.register(type, validator)` 注册的自定义类型同样生效；
 * - seq 单调递增 + #5 hash/prevHash 链自动计算；
 * - 重放按 seq 返回；崩溃残留的尾部半行 JSON 在读取时自愈截断（self-heal），
 *   后续追加从正确 seq 继续，不丢已落盘事件。
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { resolveDataRoot } from "@fengagent/shared";
import { createEventRegistry } from "./registry.ts";
import { computeEventHash } from "./hash.ts";
import type { AnySessionEvent, SessionEvent, SessionEventRegistry, SessionEventType } from "./types.ts";

/** 追加事件的输入（seq/hash/prevHash 由存储计算） */
export interface AppendEventInput {
  sessionId: string;
  type: string;
  payload: unknown;
  /** ISO-8601 时间戳（默认当前时刻） */
  timestamp?: string;
}

export interface EventStoreOptions {
  /** 事件日志根目录（默认 <数据根>/events，见 resolveDataRoot） */
  dir?: string;
  /** 校验注册表（默认 createEventRegistry()；#1 运行时注册表） */
  registry?: SessionEventRegistry;
  /** 崩溃自愈：读取时截断尾部半行（默认 true） */
  selfHeal?: boolean;
}

/** 会话 id → 文件名安全化（避免路径穿越） */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class EventStore {
  readonly registry: SessionEventRegistry;
  readonly dir: string;
  private readonly selfHeal: boolean;

  constructor(options: EventStoreOptions = {}) {
    this.registry = options.registry ?? createEventRegistry();
    this.dir = options.dir ?? join(resolveDataRoot(), "events");
    this.selfHeal = options.selfHeal ?? true;
  }

  /** 会话事件日志文件路径 */
  pathFor(sessionId: string): string {
    return join(this.dir, `${sanitizeSessionId(sessionId)}.jsonl`);
  }

  /**
   * 校验一个未知值是否为注册表认可的会话事件（#1 isSessionEvent）。
   * 信封字段齐全 + 类型已注册且校验器通过，才算合法。
   */
  isSessionEvent(value: unknown): value is SessionEvent {
    if (value === null || typeof value !== "object") return false;
    const e = value as Partial<SessionEvent>;
    if (typeof e.sessionId !== "string") return false;
    if (typeof e.seq !== "number" || !Number.isInteger(e.seq)) return false;
    if (typeof e.type !== "string") return false;
    if (typeof e.timestamp !== "string") return false;
    if (typeof e.hash !== "string") return false;
    if (e.prevHash !== null && typeof e.prevHash !== "string") return false;
    if (!("payload" in e) || e.payload === undefined) return false;
    return this.registry.validate(value as SessionEvent);
  }

  /**
   * 追加一条事件（append-only 写路径）：
   * 1) 读取现有日志（含尾部半行自愈）→ 计算 seq/prevHash；
   * 2) 组装完整信封 → 经注册表校验（#1，失败抛错）；
   * 3) append 一行 JSON 到 `events/{sessionId}.jsonl`。
   */
  append(input: AppendEventInput): SessionEvent {
    if (typeof input.sessionId !== "string" || input.sessionId === "") {
      throw new Error("EventStore.append: sessionId 必须是非空字符串");
    }
    if (typeof input.type !== "string" || input.type === "") {
      throw new Error("EventStore.append: type 必须是非空字符串");
    }

    const sessionId = input.sessionId;
    const { events } = this.readSessionFile(sessionId);
    const last = events[events.length - 1];
    const seq = last ? last.seq + 1 : 1;
    const prevHash = last ? last.hash : null;
    const timestamp = input.timestamp ?? new Date().toISOString();
    const hash = computeEventHash(prevHash, seq, input.type, input.payload);

    const event: SessionEvent = {
      version: 1,
      sessionId,
      seq,
      type: input.type as SessionEventType,
      timestamp,
      hash,
      prevHash,
      payload: input.payload as SessionEvent["payload"],
    };

    // 追加校验走运行时注册表（#1）
    if (!this.registry.validate(event)) {
      throw new Error(
        `EventStore.append: 事件类型 "${input.type}" 未注册或校验失败（seq=${seq}）`,
      );
    }

    const path = this.pathFor(sessionId);
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      // 目录可能已存在或不可创建 — 交给 append 报错
    }
    this.ensureTrailingNewline(path);
    appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
    return event;
  }

  /** 重放：按 seq 返回会话全部事件（尾部半行已自愈跳过；type↔payload 判别联合） */
  replay(sessionId: string): AnySessionEvent[] {
    return this.readSessionFile(sessionId).events;
  }

  /** 会话当前最大 seq（无事件返回 0） */
  lastSeq(sessionId: string): number {
    const events = this.readSessionFile(sessionId).events;
    return events.length > 0 ? events[events.length - 1]!.seq : 0;
  }

  /**
   * 列出已有事件日志的全部会话 id（Phase 2：graph 派生视图整写 / 全量投影用）。
   * 以每个文件首条事件的实际 sessionId 为准（文件名是 sanitize 后的，不可逆）。
   */
  listSessionIds(): string[] {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const first = readFileSync(join(this.dir, f), "utf8").split("\n")[0];
        if (!first || !first.trim()) continue;
        const ev = JSON.parse(first) as { sessionId?: unknown };
        if (typeof ev.sessionId === "string" && ev.sessionId) ids.push(ev.sessionId);
      } catch {
        // 空文件/坏文件跳过
      }
    }
    return ids;
  }

  /**
   * 崩溃自愈：截断文件尾部半行 JSON。
   * @returns 被截断的字节数（无残留返回 0）
   */
  healTail(sessionId: string): number {
    return this.readSessionFile(sessionId).healedBytes;
  }

  /**
   * 读取会话事件文件（内部）。解析失败的最后一行视为崩溃残留：
   * - selfHeal=true → 截断到最后一个完整行（自愈）；
   * - 中间损坏行 → 保守停在损坏行前，不截断。
   */
  private readSessionFile(sessionId: string): {
    events: AnySessionEvent[];
    healedBytes: number;
  } {
    const path = this.pathFor(sessionId);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return { events: [], healedBytes: 0 };
    }
    if (text.length === 0) return { events: [], healedBytes: 0 };

    const lines = text.split("\n");
    const events: AnySessionEvent[] = [];
    let idx = 0;
    let goodEnd = 0;
    let healed = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const isLast = i === lines.length - 1;
      idx += line.length;
      if (line === "" && isLast) break; // 末尾换行产生的空元素
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (isLast && this.selfHeal) healed = true;
        break;
      }
      events.push(parsed as AnySessionEvent);
      goodEnd = isLast ? idx : idx + 1; // 含行尾换行符（若有）
      idx += isLast ? 0 : 1;
    }

    let healedBytes = 0;
    if (healed) {
      const healedText = text.slice(0, goodEnd);
      const normalized = healedText.endsWith("\n") ? healedText : healedText + "\n";
      healedBytes = Buffer.byteLength(text, "utf8") - Buffer.byteLength(normalized, "utf8");
      try {
        truncateSync(path, Buffer.byteLength(normalized, "utf8"));
      } catch {
        // 只读场景（如导入源）— 忽略截断失败
      }
    }

    return { events, healedBytes };
  }

  /** append 前确保文件以换行结尾（避免与上次未换行的完整行粘连） */
  private ensureTrailingNewline(path: string): void {
    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch {
      return; // 文件不存在 — 无需处理
    }
    if (buf.byteLength === 0) return;
    if (buf.subarray(buf.byteLength - 1, buf.byteLength)[0] !== 10 /* \n */) {
      appendFileSync(path, "\n", "utf8");
    }
  }
}
