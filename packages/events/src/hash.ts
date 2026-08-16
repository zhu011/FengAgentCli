/**
 * @fengagent/events — 事件哈希链（#5）
 *
 * hash = sha-256(prevHash + "|" + seq + "|" + type + "|" + canonical(payload))；
 * 首事件 prevHash = null，按空串参与哈希。
 * canonical(payload) 使用键排序的稳定 JSON 序列化，保证同负载同哈希
 * （Phase 3 导出/导入校验直接可用，不留空项）。
 */

import { createHash } from "node:crypto";
import type { AnySessionEvent } from "./types.ts";

/**
 * 稳定 JSON 序列化：对象键按字典序排序，数组保序。
 * 与 JSON.stringify 的差异仅在键序 — 序列化结果仍是合法 JSON。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** sha-256 十六进制摘要 */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 计算单条事件哈希（#5 信封哈希） */
export function computeEventHash(
  prevHash: string | null,
  seq: number,
  type: string,
  payload: unknown,
): string {
  return sha256(`${prevHash ?? ""}|${seq}|${type}|${canonicalJson(payload)}`);
}

/**
 * 事件日志完整性自检：seq 从 1 连续 + #5 hash 链一致。
 * 导出/导入校验与对账配套自检共用（Phase 3 import 走本函数）。
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
