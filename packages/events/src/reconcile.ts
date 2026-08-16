/**
 * @fengagent/events — 双写对账门槛（Phase 1 末尾：绿了才进 Phase 2）
 *
 * reconcileSession：对同一会话，「事件投影产物」与「旧 SQLite/存储」逐条等价
 * （title/model/status/tokenCount/createdAt/updatedAt + messages 逐条 id/role/content/createdAt）；
 * reconcileAll：批量对账全部会话；
 * verifyEventChain：事件日志完整性（seq 连续 + #5 hash 链），作为对账的配套自检。
 *
 * 对账不通过（diffs 非空）即为红 — 不允许进入 Phase 2。
 */

import type { Session, SessionMeta } from "@fengagent/core";
import { EventStore } from "./event-store.ts";
import { projectSession } from "./projection.ts";
import { canonicalJson, computeEventHash } from "./hash.ts";
import type { SessionStorePort } from "./dual-write.ts";
import type { AnySessionEvent } from "./types.ts";

export interface ReconcileDiff {
  /** 字段路径（如 messages[2].content） */
  field: string;
  /** 投影值 ≠ 旧存储值 */
  detail: string;
}

export interface ReconcileResult {
  ok: boolean;
  sessionId: string;
  /** 逐条不等价清单（ok=true 时为空） */
  diffs: ReconcileDiff[];
  projected: Session | null;
  legacy: Session | null;
}

export interface ReconcileSummary {
  ok: boolean;
  /** 参与对账的会话数 */
  total: number;
  /** 对账失败的会话 id 列表（ok=true 时为空） */
  failed: string[];
}

/**
 * 对账门槛：事件投影产物 === 旧存储（逐条等价）。
 * 两侧都不存在该会话 → 视为一致（ok）。
 */
export function reconcileSession(
  events: EventStore,
  legacy: SessionStorePort,
  sessionId: string,
): ReconcileResult {
  const projected = projectSession(events.replay(sessionId));
  const legacySession = legacy.loadSession(sessionId) ?? null;
  const diffs: ReconcileDiff[] = [];

  if (!projected && !legacySession) {
    return { ok: true, sessionId, diffs, projected: null, legacy: null };
  }
  if (!projected || !legacySession) {
    diffs.push({
      field: "session",
      detail: `投影=${projected ? "存在" : "缺失"}，旧存储=${legacySession ? "存在" : "缺失"}`,
    });
    return { ok: false, sessionId, diffs, projected, legacy: legacySession };
  }

  const compare = (field: string, a: unknown, b: unknown) => {
    if (canonicalJson(a) !== canonicalJson(b)) {
      diffs.push({
        field,
        detail: `投影=${canonicalJson(a)} ≠ 旧存储=${canonicalJson(b)}`,
      });
    }
  };

  compare("title", projected.title, legacySession.title);
  compare("model", projected.model, legacySession.model);
  compare("status", projected.status, legacySession.status);
  compare("tokenCount", projected.tokenCount, legacySession.tokenCount);
  compare("createdAt", projected.createdAt, legacySession.createdAt);
  compare("updatedAt", projected.updatedAt, legacySession.updatedAt);

  if (projected.messages.length !== legacySession.messages.length) {
    diffs.push({
      field: "messages.length",
      detail: `投影=${projected.messages.length} ≠ 旧存储=${legacySession.messages.length}`,
    });
  } else {
    for (let i = 0; i < projected.messages.length; i++) {
      const p = projected.messages[i]!;
      const l = legacySession.messages[i]!;
      compare(`messages[${i}].id`, p.id, l.id);
      compare(`messages[${i}].role`, p.role, l.role);
      compare(`messages[${i}].content`, p.content, l.content);
      compare(`messages[${i}].createdAt`, p.createdAt, l.createdAt);
    }
  }

  return { ok: diffs.length === 0, sessionId, diffs, projected, legacy: legacySession };
}

/** 批量对账：全量（旧存储 listSessions）或指定会话 id 列表 */
export function reconcileAll(
  events: EventStore,
  legacy: SessionStorePort & { listSessions(): SessionMeta[] },
  sessionIds?: string[],
): ReconcileSummary {
  const ids = sessionIds ?? legacy.listSessions().map((s) => s.id);
  const failed: string[] = [];
  for (const id of ids) {
    const r = reconcileSession(events, legacy, id);
    if (!r.ok) failed.push(id);
  }
  return { ok: failed.length === 0, total: ids.length, failed };
}

/**
 * 事件日志完整性自检：seq 从 1 连续 + #5 hash 链一致。
 * @returns 问题清单（空 = 完整）
 */
export function verifyEventChain(events: AnySessionEvent[]): string[] {
  const problems: string[] = [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let prevHash: string | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    const expectedSeq = i + 1;
    if (e.seq !== expectedSeq) {
      problems.push(`seq 不连续：第 ${i + 1} 条应为 ${expectedSeq}，实际 ${e.seq}`);
    }
    if (e.prevHash !== prevHash) {
      problems.push(`seq=${e.seq} prevHash 断裂：期望 ${String(prevHash).slice(0, 12)}…，实际 ${String(e.prevHash).slice(0, 12)}…`);
    }
    const h = computeEventHash(e.prevHash, e.seq, e.type, e.payload);
    if (h !== e.hash) {
      problems.push(`seq=${e.seq} hash 不匹配`);
    }
    prevHash = e.hash;
  }
  return problems;
}
