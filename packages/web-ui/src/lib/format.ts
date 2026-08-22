/**
 * @fengagent/web-ui — 共享格式化工具
 *
 * 将任意值格式化为可展示字符串（JSON / 原始字符串）。
 */

/**
 * 将未知类型的值格式化为字符串。
 *
 * - null / undefined → 空字符串
 * - string → 原样返回
 * - 其他 → JSON.stringify（美化），失败则回退到 String()
 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 耗时格式化（毫秒 → 可读文本）。
 *
 * - < 1000ms → "850ms"
 * - ≥ 1s → "1.2s"（保留 1 位小数）
 * - ≥ 60s → "1m 05s"
 */
export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/**
 * Token 数量格式化（千分位）。
 */
export function formatTokens(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "0";
  return n.toLocaleString();
}
