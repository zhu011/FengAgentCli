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
