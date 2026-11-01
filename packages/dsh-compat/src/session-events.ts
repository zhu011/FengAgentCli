/**
 * @fengagent/dsh-compat — 会话领域事件日志（P3 收尾）
 *
 * dsh 的会话是 **append-only 事件日志**：`session.append(type, data)` 写入一条
 * 领域事件（`todo/write`、`turn/start`、`goal/…`），投影（`sessionProjections`）、
 * 持久化、查询都从这条日志推导。FengAgentCli 的事实源是 SQLite 的
 * `messages` 表，没有事件日志——此前 `session.append` 因此**明确不支持**
 * （抛 `dsh_contract_unsupported`），`dsh-tool-todo-plus` 这类插件也就装得上、
 * 跑不动。
 *
 * 本模块补的是**进程内领域事件日志**：
 *
 * - `append(sessionId, type, data)` → 带 `seq` / `time` 的事件，进程内单调递增；
 * - `list(sessionId)` → 该会话已追加的领域事件（按追加顺序）；
 * - `clear(sessionId)` → 会话被删除时清空，避免 Map 长存。
 *
 * 已知偏差（写进 `docs/DSH-CONTRACT-MAP.md` §10）：
 * 1. **不落盘**：进程重启后领域事件丢失；消息仍然是 SQLite 里的唯一持久事实源。
 *    需要跨重启的投影（`session-persistence-jsonl` 那类）仍属 P4 的持久事件桥。
 * 2. **`seq` 在读取时会被重排**：`CompatSession.events` 是「消息投影 + 领域事件」
 *    的拼接视图，消息增长会把领域事件整体后移。投影驱动用的是追加那一刻的事件，
 *    不受影响；但**不要把 `seq` 当稳定游标**（dsh 里它是稳定的，这里不是）。
 */

import type { DshSessionEvent } from "./contracts.ts";

/** 一个会话的进程内领域事件日志 */
export class SessionEventLog {
  private readonly logs = new Map<string, DshSessionEvent[]>();

  /**
   * 追加一条领域事件。
   *
   * @param sessionId - 会话 id
   * @param type - 事件类型（dsh 的 `type` 词汇，如 `todo/write`）
   * @param data - 事件负载（整体状态，不是增量——与 dsh 的 whole-value 规则一致）
   * @returns 已追加的事件（含 `seq` / `time`）
   */
  append(sessionId: string, type: string, data: unknown): DshSessionEvent {
    if (typeof type !== "string" || type.length === 0) {
      throw new Error("dsh-compat/session-events: event type must be a non-empty string");
    }
    const log = this.logs.get(sessionId) ?? [];
    const event: DshSessionEvent = {
      seq: log.length,
      type,
      time: Date.now(),
      data: (data ?? {}) as Record<string, unknown>,
    };
    log.push(event);
    this.logs.set(sessionId, log);
    return event;
  }

  /**
   * 该会话已追加的领域事件（按追加顺序，返回内部数组的只读视图）。
   *
   * @param sessionId - 会话 id
   */
  list(sessionId: string): readonly DshSessionEvent[] {
    return this.logs.get(sessionId) ?? EMPTY;
  }

  /**
   * 会话内已追加的事件条数。
   *
   * @param sessionId - 会话 id
   */
  size(sessionId: string): number {
    return this.logs.get(sessionId)?.length ?? 0;
  }

  /**
   * 丢弃一个会话的日志（会话删除 / fork 完成时用）。
   *
   * @param sessionId - 会话 id
   * @returns 是否真的删除了日志
   */
  clear(sessionId: string): boolean {
    return this.logs.delete(sessionId);
  }

  /** 当前有日志的会话数（诊断用） */
  get trackedSessions(): number {
    return this.logs.size;
  }
}

const EMPTY: readonly DshSessionEvent[] = Object.freeze([]);
