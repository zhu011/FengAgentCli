/**
 * @fengagent/events — 「以事件为准重建」（Phase 3 ②）
 *
 * SQLite（或任意旧读模型）完全降级为读模型：本模块从事件日志全量投影，
 * 把读模型整写为事件投影产物（含 #3 的 title/status/model/tokenCount/
 * createdAt/updatedAt + messages）。语义：
 *
 * - **脱双写依赖**：重建只读事件日志（events.replay）+ 写读模型
 *   （saveSession/saveMessages/deleteMessages），绝不追加事件 —
 *   事件文件在重建前后字节级不变；
 * - **#3 不丢**：projectSession 从 session/created|title|status 投影
 *   会话元数据，重建即恢复完整会话（不依赖旧存储里的标题/状态）；
 * - **截断收敛**：deleteMessages(keepIds) 让读模型消息集合收敛到
 *   当前投影（rollback/fork 截断同步），幂等可重复执行；
 * - **重建即对账**：重建后 reconcileSession 必须绿（投影 === 读模型）；
 * - **prune**（可选）：删除事件日志中不存在的遗留会话 —
 *   读模型彻底「以事件为准」，孤儿旧数据清除。
 */

import type { Session } from "@fengagent/core";
import type { EventStore } from "./event-store.ts";
import { projectSession } from "./projection.ts";
import type { SessionStorePort } from "./dual-write.ts";

/** 单会话重建结果 */
export interface RebuildResult {
  sessionId: string;
  ok: boolean;
  /** ok=false 的原因（事件日志无该会话 / 无 session/created） */
  reason?: "no-events";
  /** 重建写入读模型的投影会话（无事件时为 null） */
  session: Session | null;
}

/** 批量重建选项 */
export interface RebuildAllOptions {
  /** 删除事件日志中不存在的遗留会话（读模型完全以事件为准；默认 false） */
  prune?: boolean;
}

/** 批量重建汇总 */
export interface RebuildSummary {
  /** 成功重建的会话 id */
  rebuilt: string[];
  /** 因无事件而无法重建的会话 id */
  failed: string[];
  /** prune=true 时被删除的遗留会话 id */
  pruned: string[];
}

/**
 * 重建单个会话读模型：事件日志 → 全量投影 → 整写读模型。
 * 只读事件、绝不写事件（脱双写依赖）。
 * @returns ok=false 且 reason="no-events"（事件日志无该会话或无 session/created）
 */
export function rebuildSession(
  events: EventStore,
  legacy: SessionStorePort,
  sessionId: string,
): RebuildResult {
  const projected = projectSession(events.replay(sessionId));
  if (!projected) {
    return { sessionId, ok: false, reason: "no-events", session: null };
  }
  legacy.saveSession(projected);
  legacy.saveMessages?.(sessionId, projected.messages);
  // 截断收敛：读模型消息集合 = 当前投影（rollback/fork 旧分支消息移除）
  legacy.deleteMessages?.(
    sessionId,
    projected.messages.map((m) => m.id),
  );
  return { sessionId, ok: true, session: projected };
}

/**
 * 重建全部会话（以事件日志为准）：
 * - 对每个有事件的会话执行 rebuildSession；
 * - prune=true 时删除事件日志中不存在的遗留会话（读模型完全降级）。
 */
export function rebuildAll(
  events: EventStore,
  legacy: SessionStorePort,
  options: RebuildAllOptions = {},
): RebuildSummary {
  const ids = events.listSessionIds();
  const rebuilt: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    const r = rebuildSession(events, legacy, id);
    if (r.ok) rebuilt.push(id);
    else failed.push(id);
  }

  const pruned: string[] = [];
  if (options.prune && legacy.listSessions) {
    const eventIds = new Set(ids);
    for (const meta of legacy.listSessions()) {
      if (!eventIds.has(meta.id)) {
        legacy.deleteSession(meta.id);
        pruned.push(meta.id);
      }
    }
  }
  return { rebuilt, failed, pruned };
}
