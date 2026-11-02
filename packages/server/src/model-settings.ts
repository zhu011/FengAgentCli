/**
 * @fengagent/server — 模型设置服务（S3）
 *
 * 把「WebUI Settings 的模型 / Provider 面」收在一个服务里：
 *
 * - 读：当前生效值（合并了 `环境变量 > settings.json > 配置文件 > 默认值`）、
 *   每个键的来源（env / settings / config）、被环境变量锁定或覆盖的键；
 * - 写：校验 → 落盘 `settings.json`（原子写）→ 重载配置 → 热切换运行中的
 *   LLM client（provider / model / 凭据改动即时生效，无需重启宿主）；
 * - Provider 目录：`@fengagent/llm` 的注册表 + 实时配置状态（Key 一律打码）。
 *
 * 明文 API Key 不出进程：所有对外结构都过 `maskSettings()` 打码。
 */

import {
  SETTINGS_KEYS,
  SettingsError,
  SettingsPatchSchema,
  isLockedByEnv,
  maskApiKey,
  maskSettings,
  readSettings,
  settingsViewOf,
  writeSettings,
  type Config,
  type PartialConfig,
  type SettingsKey,
  type SettingsPatch,
} from "@fengagent/core";
import {
  PROVIDER_CATALOG,
  findProvider,
  isProviderConfigured,
  type ProviderDescriptor,
} from "@fengagent/llm";

/** 一次写入会影响的热切换键（其余键属于启动期配置） */
export const MODEL_HOT_KEYS = [
  "provider",
  "model",
  "smallModel",
  "fallbackModel",
  "maxTokens",
  "temperature",
  "contextWindow",
  "compactThreshold",
] as const satisfies readonly SettingsKey[];

/**
 * 需要推给运行中 runtime 的键 = 模型面 + Provider 凭据。
 *
 * 凭据必须一并推下去：`onSwitch` 重建 client 时读的是「当前配置」，
 * 只换 provider 不换 key 会用旧凭据建客户端（UI 里刚填的 Key 要重启才生效）。
 */
export const HOT_APPLY_KEYS = [
  ...MODEL_HOT_KEYS,
  "anthropicApiKey",
  "anthropicBaseUrl",
  "openaiApiKey",
  "openaiBaseUrl",
  "openaiCompatibleApiKey",
  "openaiCompatibleBaseUrl",
  "openaiCompatibleModel",
  "googleApiKey",
  "googleBaseUrl",
] as const satisfies readonly SettingsKey[];

/** 键的来源 */
export type SettingSource = "env" | "settings" | "config";

/** `GET /api/settings/model` 的响应体 */
export interface ModelSettingsSnapshot {
  /** 当前生效值（敏感键打码） */
  settings: Record<string, unknown>;
  /** `settings.json` 里持久化的值（敏感键打码） */
  persisted: Record<string, unknown>;
  /** 每个可设置键的来源 */
  sources: Record<string, SettingSource>;
  /** 被环境变量锁定的键（UI 改动不会影响当前进程） */
  envLocked: SettingsKey[];
  /** 已持久化、但当前被环境变量覆盖的键 */
  overridden: SettingsKey[];
  /** 高亮用的生效摘要 */
  active: {
    provider: string;
    model: string;
    smallModel: string;
    fallbackModel?: string;
    maxTokens: number;
    temperature: number;
    contextWindow: number;
    compactThreshold: number;
  };
  /** 设置文件路径（绝对路径，仅供展示） */
  settingsPath: string;
  /** 设置文件读取告警（坏 JSON / 被丢弃的键） */
  warnings: string[];
}

/** `PATCH /api/settings/model` 的响应体 */
export interface ModelSettingsPatchResult {
  snapshot: ModelSettingsSnapshot;
  /** 本次落盘的键 */
  written: SettingsKey[];
  /** 落盘了但当前被环境变量覆盖的键 */
  overridden: SettingsKey[];
  /** 热切换失败时的原因（设置已持久化，重启后生效） */
  applyError?: string;
}

/** Provider 配置项状态（前端直接渲染） */
export interface ProviderFieldState {
  key: string;
  label: string;
  type: "text" | "secret" | "url";
  env: string;
  required: boolean;
  /** 环境变量是否锁定本项 */
  locked: boolean;
  /** 当前是否已有值（secret 也会给出） */
  configured: boolean;
  /** 展示值：secret 打码，其余原样 */
  value?: string;
}

/** Provider 状态 */
export interface ProviderState {
  id: string;
  label: string;
  description: string;
  active: boolean;
  /** 当前配置是否满足该 Provider 的凭据要求 */
  configured: boolean;
  models: string[];
  requiredEnv?: string[];
  fields: ProviderFieldState[];
}

/** `GET /api/settings/providers` 的响应体 */
export interface ProvidersSnapshot {
  active: string;
  providers: ProviderState[];
}

/** 设置面服务（server 路由只依赖这个接口） */
export interface ModelSettingsService {
  get(): ModelSettingsSnapshot;
  patch(patch: unknown): Promise<ModelSettingsPatchResult>;
  providers(): ProvidersSnapshot;
}

/** 设置面错误（带 HTTP 语义的错误码） */
export class ModelSettingsError extends Error {
  constructor(
    message: string,
    readonly code: "bad_request" | "internal" = "bad_request",
  ) {
    super(message);
    this.name = "ModelSettingsError";
  }
}

/** 服务构造依赖 */
export interface ModelSettingsServiceOptions {
  /** 取当前生效配置（同一个 Config 对象，热切换后就地更新） */
  getConfig: () => Config;
  /** 设置文件路径（缺省按 FENG_SETTINGS_FILE / ~/.fengagent/settings.json 解析） */
  settingsPath?: string;
  /** 环境变量（缺省 process.env；必须是启动时的原始环境，用于判定 env 锁定） */
  env?: Record<string, string | undefined>;
  /** 重新加载配置（读写 settings.json 之后调用，得到与重启一致的生效值） */
  reload: () => Promise<Config>;
  /** 把生效的模型面配置推给运行中的 runtime（热切换 client） */
  apply: (patch: PartialConfig) => void;
}

/** 从配置里挑出需要热切换的键（模型面 + 凭据） */
function pickModelKeys(config: Config): PartialConfig {
  const patch: Record<string, unknown> = {};
  for (const key of HOT_APPLY_KEYS) {
    const value = (config as Record<string, unknown>)[key];
    if (value !== undefined) patch[key] = value;
  }
  return patch as PartialConfig;
}

/**
 * 创建模型设置服务。
 *
 * @param options - 依赖注入（配置读取、重载、热切换）
 * @returns `ModelSettingsService`
 */
export function createModelSettingsService(
  options: ModelSettingsServiceOptions,
): ModelSettingsService {
  const env = options.env ?? process.env;

  function fileState() {
    return readSettings(options.settingsPath, env);
  }

  function snapshot(): ModelSettingsSnapshot {
    const config = options.getConfig();
    const file = fileState();
    const persisted = file.settings as Record<string, unknown>;

    const sources: Record<string, SettingSource> = {};
    const overridden: SettingsKey[] = [];
    for (const key of SETTINGS_KEYS) {
      const inEnv = isLockedByEnv(key, env);
      const inFile = persisted[key] !== undefined && persisted[key] !== "";
      if (inEnv) {
        sources[key] = "env";
        if (inFile) overridden.push(key);
        continue;
      }
      sources[key] = inFile ? "settings" : "config";
    }

    const warnings: string[] = [];
    if (file.error) {
      warnings.push(`设置文件解析失败，已忽略：${file.error}`);
    }
    if (file.dropped.length > 0) {
      warnings.push(`设置文件中以下键无效或未知，已忽略：${file.dropped.join(", ")}`);
    }

    return {
      settings: settingsViewOf(config),
      persisted: maskSettings(persisted),
      sources,
      envLocked: SETTINGS_KEYS.filter((key) => isLockedByEnv(key, env)),
      overridden,
      active: {
        provider: config.provider,
        model: config.model,
        smallModel: config.smallModel,
        ...(config.fallbackModel ? { fallbackModel: config.fallbackModel } : {}),
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        contextWindow: config.contextWindow,
        compactThreshold: config.compactThreshold,
      },
      settingsPath: file.path,
      warnings,
    };
  }

  function providers(): ProvidersSnapshot {
    const config = options.getConfig();
    const values = config as unknown as Record<string, unknown>;
    const active = config.provider;

    const states = PROVIDER_CATALOG.map((descriptor: ProviderDescriptor): ProviderState => {
      const fields = descriptor.fields.map((field): ProviderFieldState => {
        const raw = values[field.key];
        const hasValue = typeof raw === "string" && raw !== "";
        const locked = isLockedByEnv(field.key as SettingsKey, env) ||
          (descriptor.requiredEnv ?? []).includes(field.env);
        return {
          key: field.key,
          label: field.label,
          type: field.type,
          env: field.env,
          required: field.required,
          locked,
          configured: hasValue,
          ...(hasValue
            ? {
                value:
                  field.type === "secret"
                    ? maskApiKey(typeof raw === "string" ? raw : undefined)
                    : String(raw),
              }
            : {}),
        };
      });
      return {
        id: descriptor.id,
        label: descriptor.label,
        description: descriptor.description,
        active: descriptor.id === active,
        configured: isProviderConfigured(descriptor, values, env),
        models: descriptor.defaultModels,
        ...(descriptor.requiredEnv ? { requiredEnv: descriptor.requiredEnv } : {}),
        fields,
      };
    });

    return { active, providers: states };
  }

  async function patch(input: unknown): Promise<ModelSettingsPatchResult> {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new ModelSettingsError("请求体必须是 JSON 对象");
    }
    const body = input as Record<string, unknown>;
    if (Object.keys(body).length === 0) {
      throw new ModelSettingsError("请求体为空：至少要给一个可设置键");
    }
    const parsed = SettingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ModelSettingsError(
        first ? `${first.path.join(".") || "body"}: ${first.message}` : "设置校验失败",
      );
    }
    const settings = parsed.data as SettingsPatch;

    const providerId = settings.provider;
    if (providerId !== undefined && !findProvider(providerId)) {
      throw new ModelSettingsError(
        `未知 Provider: ${providerId}（可用：${PROVIDER_CATALOG.map((p) => p.id).join(" / ")}）`,
      );
    }

    let written: SettingsKey[];
    try {
      written = writeSettings(settings, { path: options.settingsPath, env }).written;
    } catch (err) {
      if (err instanceof SettingsError) {
        throw new ModelSettingsError(err.message, "internal");
      }
      throw err;
    }

    // 与重启一致的生效值：重读「配置文件 + settings.json + 环境变量」
    const fresh = await options.reload();
    let applyError: string | undefined;
    try {
      options.apply(pickModelKeys(fresh));
    } catch (err) {
      applyError = err instanceof Error ? err.message : String(err);
    }

    const next = snapshot();
    return {
      snapshot: next,
      written,
      overridden: written.filter((key) => isLockedByEnv(key, env)),
      ...(applyError ? { applyError } : {}),
    };
  }

  return { get: snapshot, patch, providers };
}
