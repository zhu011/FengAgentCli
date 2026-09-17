/**
 * @fengagent/shared — 共享工具函数
 *
 * 零依赖纯函数，供所有包使用。
 */

/** 生成唯一 ID（优先使用 crypto.randomUUID） */
export function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: timestamp + random
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 安全 JSON 解析，失败时返回 fallback 值 */
export function safeJsonParse<T>(
  text: string,
  fallback: T,
): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * 深度合并两个对象（后者覆盖前者）。
 * - 数组直接替换（不合并元素）
 * - 普通对象递归合并
 * - 其他类型直接使用后者
 *
 * 类型为宽松的 Record 签名，使调用方可以传入深层 Partial 而不触发
 * TypeScript 结构兼容性报错。运行时行为不变。
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  if (override === null || override === undefined) {
    return base;
  }

  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(override)) {
    const baseVal = (base as Record<string, unknown>)[key];
    const overrideVal = override[key];

    if (
      baseVal !== null &&
      overrideVal !== null &&
      typeof baseVal === "object" &&
      typeof overrideVal === "object" &&
      !Array.isArray(baseVal) &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }

  return result as T;
}

/** 读取环境变量，不存在时返回 fallback */
export function getEnv(
  key: string,
  fallback: string,
): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    return fallback;
  }
  return value;
}

/** 读取环境变量并解析为数字，不存在或无效时返回 fallback */
export function getEnvNumber(
  key: string,
  fallback: number,
): number {
  const value = process.env[key];
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** 读取环境变量并解析为布尔值，不存在时返回 fallback */
export function getEnvBoolean(
  key: string,
  fallback: boolean,
): boolean {
  const value = process.env[key];
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "true" || value === "1" || value === "yes";
}

/** 将波浪号 (~) 展开为用户主目录 */
export function expandTilde(path: string): string {
  if (path === "~") {
    return process.env.HOME || process.env.USERPROFILE || path;
  }
  if (path.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home) {
      return path.replace("~", home);
    }
  }
  return path;
}

/** Token 估算（字符数 / 4 启发式） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 截断字符串到最大长度，超长时追加省略号 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * 把任意文本压成**单物理行**（多行内容折叠为 `⏎`）。
 *
 * 为什么需要：宿主（Multica 守护进程）按行采集子进程的 stderr，并把首行当作
 * 失败详情。多行 pretty JSON（zod 校验错误、序列化后的对象）被按行切开后，
 * 首行只剩一个 `[`，守护进程据此拼出的 `provider error: [` 完全不可定位
 * （AGE-29 现场）。凡是要落到 stderr / 日志 / 宿主错误帧的文本，都先过这里。
 *
 * @param text - 原始文本
 * @returns 不含 CR/LF 的单行文本
 */
export function toSingleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "⏎");
}
