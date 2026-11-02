/**
 * @fengagent/llm — Provider 目录（WebUI Settings 的只读元数据）
 *
 * 这里只描述「有哪些 Provider、各自需要哪些配置项、对应哪个环境变量」，
 * 不读配置、不建客户端：状态（是否已配置、Key 打码、当前生效值）由调用方
 * （server 的 `/api/settings/providers`）结合运行中的 config 计算。
 *
 * 与 `providers/index.ts` 的注册表一一对应：新增 Provider 时两处一起加，
 * 缺目录项只会让 Settings 少一行，不会影响运行时装载。
 */

/** Provider 配置项类型（前端据此渲染 input 的 type） */
export type ProviderFieldType = "text" | "secret" | "url";

/** 一个 Provider 的配置项描述 */
export interface ProviderField {
  /** 配置键（同时也是 settings.json 的键名） */
  key: string;
  /** 展示名 */
  label: string;
  /** 输入框类型（secret 的值对外一律打码） */
  type: ProviderFieldType;
  /** 对应的环境变量名（设置该变量即锁定本项，UI 改动不会生效于当前进程） */
  env: string;
  /** 是否必填（缺了就无法用该 Provider 建 client） */
  required: boolean;
  /** 输入提示 */
  placeholder?: string;
}

/** 一个 Provider 的目录项 */
export interface ProviderDescriptor {
  /** Provider id（与 `FENG_PROVIDER` / `config.provider` 同值） */
  id: string;
  /** 展示名 */
  label: string;
  /** 一句话说明 */
  description: string;
  /** 该 Provider 支持的配置项 */
  fields: ProviderField[];
  /** 常见模型 id（仅作输入建议，不校验） */
  defaultModels: string[];
  /** 额外的必需环境变量（配置文件里无法提供，例如 AWS 凭据） */
  requiredEnv?: string[];
}

/** 内置 Provider 目录。 */
export const PROVIDER_CATALOG: ProviderDescriptor[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude 官方 API（anthropic.com）",
    fields: [
      {
        key: "anthropicApiKey",
        label: "API Key",
        type: "secret",
        env: "ANTHROPIC_API_KEY",
        required: true,
        placeholder: "sk-ant-…",
      },
      {
        key: "anthropicBaseUrl",
        label: "Base URL",
        type: "url",
        env: "ANTHROPIC_BASE_URL",
        required: false,
        placeholder: "https://api.anthropic.com",
      },
    ],
    defaultModels: [
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-haiku-3",
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "OpenAI 官方 API（api.openai.com）",
    fields: [
      {
        key: "openaiApiKey",
        label: "API Key",
        type: "secret",
        env: "OPENAI_API_KEY",
        required: true,
        placeholder: "sk-…",
      },
      {
        key: "openaiBaseUrl",
        label: "Base URL",
        type: "url",
        env: "OPENAI_BASE_URL",
        required: false,
        placeholder: "https://api.openai.com/v1",
      },
    ],
    defaultModels: ["gpt-4o", "gpt-4o-mini", "o3"],
  },
  {
    id: "openai-compatible",
    label: "OpenAI 兼容",
    description: "任意 OpenAI 兼容网关（DeepSeek / Kimi / 自建反代等）",
    fields: [
      {
        key: "openaiCompatibleApiKey",
        label: "API Key",
        type: "secret",
        env: "OPENAI_COMPATIBLE_API_KEY",
        required: true,
      },
      {
        key: "openaiCompatibleBaseUrl",
        label: "Base URL",
        type: "url",
        env: "OPENAI_COMPATIBLE_BASE_URL",
        required: true,
        placeholder: "https://api.deepseek.com/v1",
      },
      {
        key: "openaiCompatibleModel",
        label: "默认模型",
        type: "text",
        env: "OPENAI_COMPATIBLE_MODEL",
        required: false,
        placeholder: "deepseek-chat",
      },
    ],
    defaultModels: ["deepseek-chat", "kimi-k2", "qwen-max"],
  },
  {
    id: "google",
    label: "Google",
    description: "Gemini API（generativelanguage.googleapis.com）",
    fields: [
      {
        key: "googleApiKey",
        label: "API Key",
        type: "secret",
        env: "GOOGLE_API_KEY",
        required: true,
      },
      {
        key: "googleBaseUrl",
        label: "Base URL",
        type: "url",
        env: "GOOGLE_BASE_URL",
        required: false,
      },
    ],
    defaultModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    id: "bedrock",
    label: "AWS Bedrock",
    description: "Amazon Bedrock（凭据只能来自 AWS 环境变量）",
    fields: [],
    defaultModels: [
      "anthropic.claude-3-sonnet-20240229-v1:0",
      "anthropic.claude-3-haiku-20240307-v1:0",
    ],
    requiredEnv: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  },
];

/**
 * 按 id 取 Provider 目录项。
 *
 * @param id - Provider id
 * @returns 目录项；未知 id 返回 undefined
 */
export function findProvider(id: string): ProviderDescriptor | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

/**
 * 判断配置是否满足某 Provider 的凭据要求。
 *
 * @param provider - 目录项
 * @param values - 配置值（config 或 settings 合并后）
 * @param env - 环境变量（`requiredEnv` 检查用）
 * @returns 是否可直接建 client
 */
export function isProviderConfigured(
  provider: ProviderDescriptor,
  values: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  for (const field of provider.fields) {
    if (!field.required) continue;
    const value = values[field.key];
    if (typeof value !== "string" || value === "") return false;
  }
  for (const key of provider.requiredEnv ?? []) {
    const value = env[key];
    if (value === undefined || value === "") return false;
  }
  return true;
}
