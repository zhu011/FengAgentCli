/**
 * @fengagent/core — WebUI 设置面（S3：模型 / Provider）
 *
 * `settings.json` 是 **WebUI Settings 的唯一写入口**：只保存「UI 显式选择过的
 * 运行配置」（模型、生成参数、Provider 凭据与 BaseURL），跨工作目录共享。
 *
 * 优先级（与本文件同名的常量一起构成对外契约）：
 *
 *    环境变量 > settings.json > 配置文件（全局/项目/分支）> 内置默认值
 *
 * 也就是说：环境变量永远赢（部署方锁定配置时 UI 不会偷偷改掉运行时行为），
 * settings.json 覆盖磁盘上的旧配置文件，缺省值兜底。写盘成功但被环境变量覆盖的
 * 键会在 PATCH 响应里以 `overridden` 回告（仍然持久化，供下次无该环境变量时生效）。
 *
 * 安全约定：本模块只负责读写与校验；任何对外输出都必须先过 `maskSettings()`，
 * 明文 API Key 不出进程。
 */

import { z } from "zod";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expandTilde, GLOBAL_SETTINGS_PATH, maskApiKey, SETTINGS_FILE_ENV } from "@fengagent/shared";
import type { Config, PartialConfig } from "./config.ts";

// ──────────────────────────────────────────────
// 可设置键
// ──────────────────────────────────────────────

/** `settings.json` 允许持久化的键（模型面 + Provider 配置面）。 */
export const SETTINGS_KEYS = [
  "provider",
  "model",
  "smallModel",
  "fallbackModel",
  "maxTokens",
  "temperature",
  "contextWindow",
  "compactThreshold",
  "anthropicApiKey",
  "anthropicBaseUrl",
  "openaiApiKey",
  "openaiBaseUrl",
  "openaiCompatibleApiKey",
  "openaiCompatibleBaseUrl",
  "openaiCompatibleModel",
  "googleApiKey",
  "googleBaseUrl",
] as const;

/** 可设置键的联合类型。 */
export type SettingsKey = (typeof SETTINGS_KEYS)[number];

/** 设置补丁（所有键可选）。 */
export type SettingsPatch = Partial<Pick<Config, SettingsKey>>;

/** 每个可设置键对应的环境变量名（环境变量优先级最高）。 */
export const SETTINGS_ENV_KEYS: Record<SettingsKey, string> = {
  provider: "FENG_PROVIDER",
  model: "FENG_MODEL",
  smallModel: "FENG_SMALL_MODEL",
  fallbackModel: "FENG_FALLBACK_MODEL",
  maxTokens: "FENG_MAX_TOKENS",
  temperature: "FENG_TEMPERATURE",
  contextWindow: "FENG_CONTEXT_WINDOW",
  compactThreshold: "FENG_COMPACT_THRESHOLD",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  anthropicBaseUrl: "ANTHROPIC_BASE_URL",
  openaiApiKey: "OPENAI_API_KEY",
  openaiBaseUrl: "OPENAI_BASE_URL",
  openaiCompatibleApiKey: "OPENAI_COMPATIBLE_API_KEY",
  openaiCompatibleBaseUrl: "OPENAI_COMPATIBLE_BASE_URL",
  openaiCompatibleModel: "OPENAI_COMPATIBLE_MODEL",
  googleApiKey: "GOOGLE_API_KEY",
  googleBaseUrl: "GOOGLE_BASE_URL",
};

/** 敏感键：对外一律打码。 */
export const SECRET_SETTINGS_KEYS = [
  "anthropicApiKey",
  "openaiApiKey",
  "openaiCompatibleApiKey",
  "googleApiKey",
] as const satisfies readonly SettingsKey[];

/**
 * PATCH 校验 schema。
 *
 * `.strict()` 是刻意的：拼错键名（如 `modal`）必须报 400，而不是静默忽略后
 * 让用户以为改成功了。范围与 `ConfigSchema` 同口径（温度 0–2、token 数正整数等）。
 */
export const SettingsPatchSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    smallModel: z.string().min(1),
    fallbackModel: z.string().min(1),
    maxTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2),
    contextWindow: z.number().int().positive(),
    compactThreshold: z.number().min(0).max(1),
    anthropicApiKey: z.string(),
    anthropicBaseUrl: z.string(),
    openaiApiKey: z.string(),
    openaiBaseUrl: z.string(),
    openaiCompatibleApiKey: z.string(),
    openaiCompatibleBaseUrl: z.string(),
    openaiCompatibleModel: z.string(),
    googleApiKey: z.string(),
    googleBaseUrl: z.string(),
  })
  .partial()
  .strict();

/** 设置文件读写错误（路径 + 人类可读原因）。 */
export class SettingsError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

// ──────────────────────────────────────────────
// 路径
// ──────────────────────────────────────────────

/**
 * 解析设置文件路径：`FENG_SETTINGS_FILE` > `~/.fengagent/settings.json`。
 *
 * @param env - 环境变量对象（默认 process.env）
 * @returns 未展开 `~` 的路径（与既有配置路径常量同风格）
 */
export function resolveSettingsPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env[SETTINGS_FILE_ENV];
  if (override !== undefined && override.trim() !== "") return override.trim();
  return GLOBAL_SETTINGS_PATH;
}

// ──────────────────────────────────────────────
// 读
// ──────────────────────────────────────────────

/** 读取结果：设置值 + 被丢弃的未知键（坏文件不抛错，降级为空设置）。 */
export interface ReadSettingsResult {
  /** 展开后的绝对路径 */
  path: string;
  /** 文件中的有效设置（只含 `SETTINGS_KEYS` 且类型合法的键） */
  settings: SettingsPatch;
  /** 被丢弃的键（未知键或类型非法） */
  dropped: string[];
  /** 文件存在但解析失败时的原因 */
  error?: string;
}

/**
 * 读取 `settings.json`。
 *
 * 容错策略与配置读取一致：文件不存在 → 空设置；JSON 坏 → `error` + 空设置。
 * 单个键类型非法只丢该键（`dropped`），不连坐整份文件。
 *
 * @param path - 设置文件路径（默认按 {@link resolveSettingsPath} 解析）
 * @param env - 仅在 `path` 缺省时使用
 */
export function readSettings(
  path?: string,
  env: Record<string, string | undefined> = process.env,
): ReadSettingsResult {
  const resolved = path ?? resolveSettingsPath(env);
  const expanded = expandTilde(resolved);
  let text: string;
  try {
    text = readFileSync(expanded, "utf-8");
  } catch {
    return { path: expanded, settings: {}, dropped: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      path: expanded,
      settings: {},
      dropped: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { path: expanded, settings: {}, dropped: [], error: "settings file is not an object" };
  }
  // 落盘格式是 `{ version, settings: {...} }`；同时兼容历史/手写的扁平格式。
  const wrapper = raw as Record<string, unknown>;
  const inner = wrapper.settings;
  const values =
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : wrapper;
  const { settings, dropped } = sanitizeSettings(values);
  return { path: expanded, settings, dropped };
}

/**
 * 只保留已知键且类型合法的项。
 *
 * @param raw - 文件解析出的原始对象
 * @returns 有效设置 + 被丢弃的键名
 */
export function sanitizeSettings(raw: Record<string, unknown>): {
  settings: SettingsPatch;
  dropped: string[];
} {
  const settings: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(key)) {
      dropped.push(key);
      continue;
    }
    const field = SettingsPatchSchema.shape[key as SettingsKey];
    const parsed = field.safeParse(value);
    if (!parsed.success) {
      dropped.push(key);
      continue;
    }
    settings[key] = parsed.data;
  }
  return { settings: settings as SettingsPatch, dropped };
}

// ──────────────────────────────────────────────
// 写
// ──────────────────────────────────────────────

/** 写入结果。 */
export interface WriteSettingsResult {
  /** 展开后的绝对路径 */
  path: string;
  /** 落盘后的完整设置 */
  settings: SettingsPatch;
  /** 本次实际写入的键 */
  written: SettingsKey[];
}

/**
 * 合并写入 `settings.json`（原子写）。
 *
 * 语义与 `writeConfigFile` 一致：读旧文件 → 深合并浅层键 → 写临时文件 →
 * `rename` 覆盖（同目录 rename 是原子的，崩溃不会留下半截 JSON）。
 * 文件在 POSIX 上收紧为 `0600`（含 API Key），Windows 上忽略权限位错误。
 *
 * @param patch - 已通过 {@link SettingsPatchSchema} 校验的补丁
 * @param options - 可选：自定义路径（测试隔离用）
 * @returns 落盘路径、合并后的完整设置、本次写入的键
 */
export function writeSettings(
  patch: SettingsPatch,
  options?: { path?: string; env?: Record<string, string | undefined> },
): WriteSettingsResult {
  const env = options?.env ?? process.env;
  const target = expandTilde(options?.path ?? resolveSettingsPath(env));
  const existing = readSettings(target, env);
  const merged: SettingsPatch = { ...existing.settings, ...patch };
  const written = (Object.keys(patch) as SettingsKey[]).filter(
    (key) => patch[key] !== undefined,
  );

  const serialized = JSON.stringify(
    {
      version: 1,
      settings: merged,
    },
    null,
    2,
  ) + "\n";

  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, serialized, "utf-8");
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Windows 无 POSIX 权限位 — 忽略
    }
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 临时文件可能没建出来 — 忽略
    }
    throw new SettingsError(
      `写入设置文件失败（${target}）：${err instanceof Error ? err.message : String(err)}`,
      target,
    );
  }

  return { path: target, settings: merged, written };
}

// ──────────────────────────────────────────────
// 合并 / 展示
// ──────────────────────────────────────────────

/**
 * 把设置层合并进已合并的配置（settings.json 层，低于环境变量）。
 *
 * 空串视为「未设置」：UI 清空输入框不该把已有凭据抹成空字符串。
 *
 * @param base - 低优先级层已合并的配置
 * @param settings - 设置文件内容
 * @returns 合并后的配置（未做最终 schema 校验，由 loadConfig 统一做）
 */
export function applySettingsLayer(
  base: Config,
  settings: SettingsPatch,
): Config {
  const patch: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    const value = settings[key];
    if (value === undefined || value === "") continue;
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) return base;
  return { ...base, ...patch } as Config;
}

/**
 * 判断某键是否被环境变量锁定（环境变量非空即锁定）。
 *
 * @param key - 可设置键
 * @param env - 环境变量对象（默认 process.env）
 */
export function isLockedByEnv(
  key: SettingsKey,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[SETTINGS_ENV_KEYS[key]];
  return value !== undefined && value !== "";
}

/**
 * 环境变量锁定的键列表。
 *
 * @param env - 环境变量对象（默认 process.env）
 */
export function envLockedKeys(
  env: Record<string, string | undefined> = process.env,
): SettingsKey[] {
  return SETTINGS_KEYS.filter((key) => isLockedByEnv(key, env));
}

/**
 * 对外展示用设置视图：敏感键打码，其余原样。
 *
 * @param settings - 设置（文件的或合并后的）
 * @returns 可直接进 HTTP 响应的对象
 */
export function maskSettings(
  settings: Partial<Record<SettingsKey, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    const value = settings[key];
    if (value === undefined) continue;
    if ((SECRET_SETTINGS_KEYS as readonly string[]).includes(key)) {
      out[key] = maskApiKey(typeof value === "string" ? value : undefined);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** 从完整配置中提取设置面视图（含默认值，敏感键打码）。 */
export function settingsViewOf(config: PartialConfig): Record<string, unknown> {
  const view: Partial<Record<SettingsKey, unknown>> = {};
  for (const key of SETTINGS_KEYS) {
    const value = (config as Record<string, unknown>)[key];
    if (value !== undefined) view[key] = value;
  }
  return maskSettings(view);
}
