/**
 * @fengagent/core — 副作用台账（Operation Ledger）
 *
 * 「恢复先查台账再决定跳过/查结果/重放」的落地形态：
 *
 * 1. **写外部系统的工具**在执行**之前**先 `begin()` 落一条 pending 记录
 *    （`operation_id` + `operation_key`）。这个顺序是安全性的全部来源 ——
 *    先执行后记账时，「已执行、未记账」的窗口照样会把副作用做两遍。
 * 2. 执行结束 `complete()` 写结果摘要；失败 `fail()`；进程死在中间则记录停在
 *    pending → 恢复时 `lookup()` 看到 pending，判定为 **unknown**。
 * 3. 恢复决策（{@link decideOperationReplay}）：
 *    - 台账已 succeeded → **跳过**（幂等键命中，直接复用已记录的结果）；
 *    - pending/unknown 且工具**幂等** → 允许重放（同一 operationId）；
 *    - pending/unknown 且工具**非幂等** → **强制人工核对**，绝不静默重放。
 *
 * 本文件零运行时依赖：幂等键里的入参指纹走内置 {@link fnv1aHash}（FNV-1a 32 位），
 * 只保留短前缀作可读性修饰，**不做截断**（截断会让长前缀 + 不同尾部的两次调用
 * 撞同一个键，进而在恢复时被静默误判为「已成功 → 跳过」）。
 */

import { stableJson } from "./task-state.ts";

/**
 * 工具副作用类别。
 *
 * - `none`：本地只读 / 可重复执行且无外部可见效果（读文件、glob…）；
 * - `idempotent`：重复执行与执行一次等价（PUT 语义、按固定 key 覆盖写）；
 * - `non-idempotent`：重复执行会叠加外部效果（发消息、建单、追加写远端）。
 */
export type SideEffectKind = "none" | "idempotent" | "non-idempotent";

/** 台账记录状态 */
export type OperationStatus = "pending" | "succeeded" | "failed" | "unknown";

/**
 * 台账记录。
 *
 * `operationKey` 是**跨进程稳定**的幂等键：同一逻辑操作无论在哪次运行里发起，
 * 都必须算出同一个 key（因此不能掺入本次运行的 toolUseId 或时间戳）。
 */
export interface OperationRecord {
  /** 本次操作唯一 id（进程内唯一即可；重放沿用同一条记录的 id） */
  operationId: string;
  /** 跨进程稳定的幂等键 */
  operationKey: string;
  toolName: string;
  sessionId: string;
  taskId?: string;
  /** 发起该操作的步 id */
  stepId?: string;
  /** 实际执行的入参 */
  input: unknown;
  status: OperationStatus;
  /** 结果摘要（成功时） */
  resultDigest?: string;
  /** 结果 JSON（成功且可安全复用时有值） */
  resultJson?: unknown;
  /** 失败原因 */
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/** `begin()` 入参（operationId 缺省由调用方生成） */
export interface BeginOperationInput {
  operationId: string;
  operationKey: string;
  toolName: string;
  sessionId: string;
  taskId?: string;
  stepId?: string;
  input: unknown;
  startedAt: number;
}

/**
 * 副作用台账接口。
 *
 * 实现方必须保证 `begin()` 在**副作用执行之前**落盘（同步或 await 完成后再执行）。
 */
export interface OperationLedger {
  /** 记录「即将执行」——必须在副作用之前调用 */
  begin(entry: BeginOperationInput): OperationRecord;
  /** 记录成功结果（幂等命中时可直接复用 resultJson） */
  complete(
    operationId: string,
    result: { digest: string; json?: unknown; finishedAt: number },
  ): void;
  /** 记录失败 */
  fail(operationId: string, error: string, finishedAt: number): void;
  /** 把记录标记为 unknown（进程重启后仍停在 pending 的条目） */
  markUnknown(operationId: string): void;
  /** 按幂等键查找（取最新一条） */
  lookup(operationKey: string): OperationRecord | null;
  /** 按 operationId 查找 */
  get(operationId: string): OperationRecord | null;
  /** 列出停在 pending 的条目（恢复时的 orphan 台账） */
  listPending(): OperationRecord[];
}

/** 恢复决策 */
export type OperationReplayDecision =
  /** 无台账记录 —— 正常执行 */
  | { action: "execute" }
  /** 已成功 —— 跳过执行，复用记录的结果 */
  | { action: "skip"; record: OperationRecord }
  /** 幂等工具遇到的未决记录 —— 允许重放（沿用同一 operationId） */
  | { action: "replay"; record: OperationRecord; operationId: string }
  /** 非幂等工具遇到的未决记录 —— 必须人工核对，禁止自动执行 */
  | { action: "manual-review"; record: OperationRecord; reason: string };

/**
 * 恢复决策 —— 台账命中后的唯一分派点。
 *
 * @param record - 台账命中记录（null = 未命中）
 * @param kind - 工具副作用类别
 * @returns 恢复决策
 */
export function decideOperationReplay(
  record: OperationRecord | null,
  kind: SideEffectKind,
): OperationReplayDecision {
  if (!record) return { action: "execute" };
  if (record.status === "succeeded") return { action: "skip", record };
  if (record.status === "failed") return { action: "execute" };

  // pending / unknown —— 副作用的最终状态不可知
  if (kind === "idempotent") {
    return {
      action: "replay",
      record,
      operationId: record.operationId,
    };
  }
  return {
    action: "manual-review",
    record,
    reason:
      `前置执行未落结果（status=${record.status}），且工具 "${record.toolName}" 的副作用` +
      `不是幂等的 —— 可能已经生效，禁止自动重放，需人工核对后放行。`,
  };
}

/** FNV-1a 32 位偏移基数 */
const FNV1A_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a 32 位素数 */
const FNV1A_PRIME = 0x01000193;

/**
 * FNV-1a 32 位哈希（对 UTF-16 码元逐位进位，无符号输出）。
 *
 * 选它是因为纯位运算、无依赖、跨进程/跨平台逐位可复现 —— 幂等键必须做到
 * 「同一入参在任何一次运行里都算出同一结果」。
 *
 * @param text - 待哈希文本
 * @returns 8 位小写十六进制摘要
 */
export function fnv1aHash(text: string): string {
  let hash = FNV1A_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV1A_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 指纹里分隔「可读前缀」与「哈希」的标记（避免与序列化正文歧义） */
const HASH_MARKER = "…#";

/** 规范化入参序列化（对象键排序；循环引用时降级为 String） */
function canonicalizeInput(input: unknown): string {
  try {
    return stableJson(input);
  } catch {
    return String(input);
  }
}

/**
 * 规范化的入参指纹：`<可读前缀>…#<全量哈希>`。
 *
 * **哈希覆盖完整入参**，前缀只截 `maxLength` 个字符用于人眼扫键（日志、
 * 人工核对清单）。这里绝不能只保留前缀：`write_file` / `bash` 这类工具的入参
 * 很容易超过前缀长度，两次「长前缀相同、尾部不同」的调用一旦撞键，恢复时
 * 就会命中别人的 `succeeded` 记录而被静默跳过 —— 副作用漏做且无人察觉。
 *
 * @param input - 实际执行入参
 * @param maxLength - 可读前缀保留的字符数（不影响哈希覆盖面）
 * @returns 入参指纹
 */
export function inputFingerprint(input: unknown, maxLength = 64): string {
  const text = canonicalizeInput(input);
  const digest = fnv1aHash(text);
  if (maxLength <= 0) return `${HASH_MARKER}${digest}`;
  const prefix = text.length > maxLength ? text.slice(0, maxLength) : text;
  return `${prefix}${HASH_MARKER}${digest}`;
}

/**
 * 从「工具名 + 入参」派生默认幂等键。
 *
 * 注意：**不能**掺入 toolUseId / 时间戳 —— 崩溃恢复后模型会重新发起同一调用，
 * 只有内容派生的键才能跨进程命中同一条台账记录。
 *
 * @param toolName - 工具名
 * @param input - 实际执行入参
 * @returns 幂等键
 */
export function deriveOperationKey(toolName: string, input: unknown): string {
  return `${toolName}::${inputFingerprint(input)}`;
}

/** 工具结果摘要（台账去重对拍的比较口径） */
export function digestResult(
  content: unknown,
  isError: boolean | undefined,
): string {
  const body =
    typeof content === "string" ? content : (() => {
      try {
        return JSON.stringify(content);
      } catch {
        return String(content);
      }
    })();
  return `${isError ? "ERR" : "OK"}:${body.length}:${body.slice(0, 200)}`;
}
