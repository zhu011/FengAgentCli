/**
 * @fengagent/events — 事件哈希链（#5）
 *
 * hash = sha-256(prevHash + "|" + seq + "|" + type + "|" + canonical(payload))；
 * 首事件 prevHash = null，按空串参与哈希。
 * canonical(payload) 使用键排序的稳定 JSON 序列化，保证同负载同哈希
 * （Phase 3 导出/导入校验直接可用，不留空项）。
 */

import { createHash } from "node:crypto";

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
