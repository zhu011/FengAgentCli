/**
 * @fengagent/core — 配置系统
 *
 * ConfigSchema (Zod)、ConfigLayer、loadConfig 函数。
 * 配置分层加载：内置默认值 → 全局配置 → 项目配置 → 环境变量 → CLI 参数。
 * 参考 ARCHITECTURE.md 第 5 节。
 */

import { z } from "zod";
import {
  deepMerge,
  expandTilde,
} from "@fengagent/shared";
import {
  BASH_TIMEOUT,
  COMPACT_BUFFER,
  COMPACT_KEEP_TOKENS,
  COMPACT_THRESHOLD,
  CONTEXT_WINDOW,
  DEFAULT_CORS_ORIGIN,
  DEFAULT_DATA_DIR,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  DEFAULT_SMALL_MODEL,
  DEFAULT_TEMPERATURE,
  GLOBAL_CONFIG_PATH,
  MAX_TOKENS,
  MAX_TOOL_CONCURRENCY,
  MAX_TURNS,
  PROJECT_CONFIG_PATH,
  TOOL_OUTPUT_MAX_CHARS,
} from "@fengagent/shared";

// ──────────────────────────────────────────────
// Config Schema
// ──────────────────────────────────────────────

export const ConfigSchema = z.object({
  // 模型配置
  model: z.string().default(DEFAULT_MODEL),
  smallModel: z.string().default(DEFAULT_SMALL_MODEL),
  provider: z.string().default(DEFAULT_PROVIDER),
  fallbackModel: z.string().optional(),
  maxTokens: z.number().int().positive().default(MAX_TOKENS),
  temperature: z.number().min(0).max(2).default(DEFAULT_TEMPERATURE),

  // 上下文配置
  contextWindow: z.number().int().positive().default(CONTEXT_WINDOW),
  compactThreshold: z.number().min(0).max(1).default(COMPACT_THRESHOLD),
  compactKeepTokens: z.number().int().positive().default(COMPACT_KEEP_TOKENS),
  compactBuffer: z.number().int().positive().default(COMPACT_BUFFER),
  disableCompact: z.boolean().default(false),
  toolOutputMaxChars: z.number().int().positive().default(TOOL_OUTPUT_MAX_CHARS),

  // 服务配置
  serverPort: z.number().int().min(1).max(65535).default(DEFAULT_SERVER_PORT),
  serverHost: z.string().default(DEFAULT_SERVER_HOST),
  corsOrigin: z.string().default(DEFAULT_CORS_ORIGIN),

  // 工具配置
  autoApproveTools: z.boolean().default(false),
  allowedTools: z.string().default("*"),
  deniedTools: z.string().optional(),
  bashTimeout: z.number().int().positive().default(BASH_TIMEOUT),
  maxToolConcurrency: z.number().int().positive().default(MAX_TOOL_CONCURRENCY),

  // 运行配置
  maxTurns: z.number().int().positive().default(MAX_TURNS),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default(DEFAULT_LOG_LEVEL),
  dataDir: z.string().default(DEFAULT_DATA_DIR),
});

/** 完整配置类型 */
export type Config = z.infer<typeof ConfigSchema>;

/** 部分配置类型（用于配置层） */
export type PartialConfig = Partial<Config>;

// ──────────────────────────────────────────────
// Config Layer
// ──────────────────────────────────────────────

/** 配置层（表示一个配置来源） */
export interface ConfigLayer {
  /** 层名称 */
  name: string;
  /** 配置数据 */
  config: PartialConfig;
}

/** 配置层优先级（从低到高） */
export enum ConfigLayerPriority {
  Default = 0,
  Global = 1,
  Project = 2,
  Env = 3,
  CLI = 4,
}

// ──────────────────────────────────────────────
// 环境变量映射
// ──────────────────────────────────────────────

/** 从 env 中读取字符串，不存在时返回 fallback */
function envStr(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const v = env[key];
  return v === undefined || v === "" ? fallback : v;
}

/** 从 env 中读取数字，不存在或无效时返回 fallback */
function envNum(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

/** 从 env 中读取布尔值，不存在时返回 fallback */
function envBool(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
}

/** FENG_* 环境变量到 Config 字段的映射 */
function applyEnvVars(
  config: Config,
  env: Record<string, string | undefined>,
): Config {
  return {
    ...config,
    model: envStr(env, "FENG_MODEL", config.model),
    smallModel: envStr(env, "FENG_SMALL_MODEL", config.smallModel),
    provider: envStr(env, "FENG_PROVIDER", config.provider),
    fallbackModel: env.FENG_FALLBACK_MODEL ?? config.fallbackModel,
    maxTokens: envNum(env, "FENG_MAX_TOKENS", config.maxTokens),
    temperature: envNum(env, "FENG_TEMPERATURE", config.temperature),

    contextWindow: envNum(env, "FENG_CONTEXT_WINDOW", config.contextWindow),
    compactThreshold: envNum(env, "FENG_COMPACT_THRESHOLD", config.compactThreshold),
    compactKeepTokens: envNum(env, "FENG_COMPACT_KEEP_TOKENS", config.compactKeepTokens),
    compactBuffer: envNum(env, "FENG_COMPACT_BUFFER", config.compactBuffer),
    disableCompact: envBool(env, "FENG_DISABLE_COMPACT", config.disableCompact),
    toolOutputMaxChars: envNum(env, "FENG_TOOL_OUTPUT_MAX_CHARS", config.toolOutputMaxChars),

    serverPort: envNum(env, "FENG_SERVER_PORT", config.serverPort),
    serverHost: envStr(env, "FENG_SERVER_HOST", config.serverHost),
    corsOrigin: envStr(env, "FENG_CORS_ORIGIN", config.corsOrigin),

    autoApproveTools: envBool(env, "FENG_AUTO_APPROVE_TOOLS", config.autoApproveTools),
    allowedTools: envStr(env, "FENG_ALLOWED_TOOLS", config.allowedTools),
    deniedTools: env.FENG_DENIED_TOOLS ?? config.deniedTools,
    bashTimeout: envNum(env, "FENG_BASH_TIMEOUT", config.bashTimeout),
    maxToolConcurrency: envNum(env, "FENG_MAX_TOOL_CONCURRENCY", config.maxToolConcurrency),

    maxTurns: envNum(env, "FENG_MAX_TURNS", config.maxTurns),
    logLevel: (env.FENG_LOG_LEVEL as Config["logLevel"]) ?? config.logLevel,
    dataDir: envStr(env, "FENG_DATA_DIR", config.dataDir),
  };
}

// ──────────────────────────────────────────────
// 文件读取辅助
// ──────────────────────────────────────────────

/** 尝试读取 JSON 配置文件，不存在或解析失败时返回空对象 */
async function readConfigFile(filePath: string): Promise<PartialConfig> {
  try {
    const expanded = expandTilde(filePath);
    const file = Bun.file(expanded);
    const exists = await file.exists();
    if (!exists) {
      return {};
    }
    const text = await file.text();
    const parsed = JSON.parse(text) as PartialConfig;
    return parsed ?? {};
  } catch {
    return {};
  }
}

// ──────────────────────────────────────────────
// loadConfig
// ──────────────────────────────────────────────

/**
 * 分层加载配置。
 *
 * 优先级从低到高：
 * 1. 内置默认值（ConfigSchema.parse({})）
 * 2. 全局配置（~/.fengagent/config.json）
 * 3. 项目配置（./.fengagent/config.json）
 * 4. 环境变量（FENG_* 系列）
 * 5. 命令行参数（cliArgs）
 *
 * 最终通过 ConfigSchema 校验，确保类型安全。
 *
 * @param cliArgs - 命令行参数覆盖（最高优先级）
 * @param options - 可选：自定义配置文件路径
 */
export async function loadConfig(
  cliArgs?: PartialConfig,
  options?: {
    globalConfigPath?: string;
    projectConfigPath?: string;
    env?: Record<string, string | undefined>;
  },
): Promise<Config> {
  const globalPath = options?.globalConfigPath ?? GLOBAL_CONFIG_PATH;
  const projectPath = options?.projectConfigPath ?? PROJECT_CONFIG_PATH;
  const env = options?.env ?? process.env;

  // 1. 内置默认值
  const defaults = ConfigSchema.parse({});

  // 2. 全局配置
  const globalConfig = await readConfigFile(globalPath);

  // 3. 项目配置
  const projectConfig = await readConfigFile(projectPath);

  // 逐层合并（低优先级 → 高优先级）
  let merged = deepMerge(defaults, globalConfig);
  merged = deepMerge(merged, projectConfig);

  // 4. 环境变量
  const withEnv = applyEnvVars(merged, env);

  // 5. 命令行参数
  if (cliArgs) {
    merged = deepMerge(withEnv, cliArgs);
  } else {
    merged = withEnv;
  }

  // 最终校验
  return ConfigSchema.parse(merged);
}

/**
 * 仅从环境变量 + CLI 参数加载配置（不读文件，用于测试或无文件系统场景）。
 */
export function loadConfigFromEnv(
  cliArgs?: PartialConfig,
  env?: Record<string, string | undefined>,
): Config {
  const defaults = ConfigSchema.parse({});
  const envVars = env ?? process.env;
  const withEnv = applyEnvVars(defaults, envVars);
  const merged = cliArgs ? deepMerge(withEnv, cliArgs) : withEnv;
  return ConfigSchema.parse(merged);
}
