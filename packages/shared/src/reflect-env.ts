/**
 * @fengagent/shared — RSI 自省通道的环境开关与硬预算
 *
 * 三个变量（全部 `FENG_` 前缀，符合项目约定）：
 *
 * | 变量 | 默认 | 含义 |
 * |---|---|---|
 * | `FENG_REFLECT_INJECT` | `on` | `off` = 一键关注入（主流程行为不变） |
 * | `FENG_REFLECT_MAX_CARDS` | `5` | 单次注入卡片数上限 |
 * | `FENG_REFLECT_MAX_TOKENS` | `600` | 单次注入 token 上限 |
 * | `FENG_REFLECT_TTL_MS` | `14 天` | 卡片存活期（到期不注入、可清理） |
 *
 * 开关默认关闭的是「自改进写回」，不是「注入」：注入默认开，因为它只读卡片、
 * 有硬预算、失败即降级（见注入通道的 try/catch）。
 */

import { join, resolve } from "node:path";
import { resolveDataRoot, type DataRootOptions } from "./data-root.ts";

/** 注入通道默认预算（与验收契约一致：≤5 条 / ≤600 token） */
export const REFLECT_INJECT_DEFAULTS = {
  maxCards: 5,
  maxTokens: 600,
  ttlMs: 14 * 24 * 60 * 60 * 1000,
} as const;

/** 注入预算 */
export interface ReflectInjectionBudget {
  /** 卡片条数上限 */
  maxCards: number;
  /** token 上限 */
  maxTokens: number;
  /** 卡片存活期（毫秒） */
  ttlMs: number;
}

/**
 * 注入通道是否开启。
 *
 * `FENG_REFLECT_INJECT=off`（大小写/空格不敏感，也接受 `0` / `false`）时返回 false。
 *
 * @param env - 环境变量（默认 process.env；测试可注入）
 */
export function isReflectInjectionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.FENG_REFLECT_INJECT ?? "").trim().toLowerCase();
  if (raw === "") return true;
  return !(raw === "off" || raw === "0" || raw === "false" || raw === "no");
}

/**
 * 读取注入预算（含环境变量覆盖，非法值回退默认）。
 *
 * @param env - 环境变量（默认 process.env）
 */
export function resolveReflectBudget(
  env: Record<string, string | undefined> = process.env,
): ReflectInjectionBudget {
  const maxCards = readPositiveInt(env, "FENG_REFLECT_MAX_CARDS", REFLECT_INJECT_DEFAULTS.maxCards);
  const maxTokens = readPositiveInt(env, "FENG_REFLECT_MAX_TOKENS", REFLECT_INJECT_DEFAULTS.maxTokens);
  const ttlMs = readPositiveInt(env, "FENG_REFLECT_TTL_MS", REFLECT_INJECT_DEFAULTS.ttlMs);
  return { maxCards, maxTokens, ttlMs };
}

/** 读取正整数环境变量（缺省/非法/非正数一律回退） */
function readPositiveInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * 自省数据目录 = `<数据根>/reflect`（卡片库、overlay、实验台账都在这里）。
 *
 * @param opts - 与 `resolveDataRoot` 相同的选项
 */
export function resolveReflectDir(opts: DataRootOptions = {}): string {
  return join(resolveDataRoot(opts), "reflect");
}

/**
 * 自省库文件 = `<数据根>/reflect/reflections.db`。
 *
 * @param opts - 与 `resolveDataRoot` 相同的选项
 */
export function resolveReflectDbPath(opts: DataRootOptions = {}): string {
  return join(resolveReflectDir(opts), "reflections.db");
}

/** 自改进写回落点的文件名（首期唯一允许的写回目标） */
export const PROMPT_OVERLAY_FILE = "prompt-overlay.md";

/**
 * 写回 overlay 的绝对路径 = `<数据根>/reflect/prompt-overlay.md`。
 *
 * 装配侧（`context`）读它、变更器（`eval/mutator`）写它 —— 两侧共用一个事实来源，
 * 避免路径口径漂移。
 *
 * @param dataRoot - 数据根
 */
export function resolvePromptOverlayPath(dataRoot: string): string {
  return join(resolve(dataRoot), "reflect", PROMPT_OVERLAY_FILE);
}
