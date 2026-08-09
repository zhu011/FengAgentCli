/**
 * @fengagent/llm — 环境变量驱动的 Client 工厂
 *
 * 根据 FENG_PROVIDER 及各 Provider 专属环境变量自动创建 LLMClient。
 * 参考 PRD 第 6 节环境变量设计。
 */

import type { LLMClient } from "./client.ts";
import {
  createClient,
  type ClientCreateOptions,
} from "./providers/index.ts";

/** 环境变量读取的默认请求参数 */
export interface LLMEnvDefaults {
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

/** createClientFromEnv 的返回值 */
export interface ClientFromEnvResult {
  client: LLMClient;
  /** 从环境变量读取的默认参数（FENG_MAX_TOKENS / FENG_TEMPERATURE / OPENAI_COMPATIBLE_MODEL） */
  defaults: LLMEnvDefaults;
}

function envStr(
  env: Record<string, string | undefined>,
  key: string,
  fallback?: string,
): string | undefined {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  return v;
}

function envNum(
  env: Record<string, string | undefined>,
  key: string,
): number | undefined {
  const v = env[key];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * 从环境变量创建 LLMClient。
 *
 * 读取的环境变量：
 * - `FENG_PROVIDER` — Provider 选择（anthropic / openai / openai-compatible，默认 anthropic）
 * - `ANTHROPIC_API_KEY` — Anthropic API 密钥
 * - `OPENAI_API_KEY` — OpenAI API 密钥
 * - `OPENAI_COMPATIBLE_API_KEY` — OpenAI 兼容 API 密钥
 * - `OPENAI_COMPATIBLE_BASE_URL` — OpenAI 兼容 API 地址
 * - `OPENAI_COMPATIBLE_MODEL` — OpenAI 兼容默认模型 ID
 * - `FENG_MAX_TOKENS` — 默认最大输出 Token 数
 * - `FENG_TEMPERATURE` — 默认生成温度
 *
 * @param env - 环境变量对象（默认 process.env）
 * @returns `{ client, defaults }` — LLMClient + 从环境变量读取的默认参数
 */
export function createClientFromEnv(
  env?: Record<string, string | undefined>,
): ClientFromEnvResult {
  const e = env ?? process.env;
  const provider = envStr(e, "FENG_PROVIDER", "anthropic") ?? "anthropic";

  const defaults: LLMEnvDefaults = {
    maxTokens: envNum(e, "FENG_MAX_TOKENS"),
    temperature: envNum(e, "FENG_TEMPERATURE"),
  };

  let options: ClientCreateOptions;

  switch (provider) {
    case "anthropic": {
      const apiKey = envStr(e, "ANTHROPIC_API_KEY");
      if (!apiKey) {
        throw new Error(
          "ANTHROPIC_API_KEY is required when FENG_PROVIDER=anthropic",
        );
      }
      options = {
        provider: "anthropic",
        apiKey,
        baseURL: envStr(e, "ANTHROPIC_BASE_URL"),
      };
      break;
    }

    case "openai": {
      const apiKey = envStr(e, "OPENAI_API_KEY");
      if (!apiKey) {
        throw new Error(
          "OPENAI_API_KEY is required when FENG_PROVIDER=openai",
        );
      }
      options = {
        provider: "openai",
        apiKey,
        baseURL: envStr(e, "OPENAI_BASE_URL"),
      };
      break;
    }

    case "openai-compatible": {
      const apiKey = envStr(e, "OPENAI_COMPATIBLE_API_KEY");
      const baseURL = envStr(e, "OPENAI_COMPATIBLE_BASE_URL");
      if (!apiKey) {
        throw new Error(
          "OPENAI_COMPATIBLE_API_KEY is required when FENG_PROVIDER=openai-compatible",
        );
      }
      if (!baseURL) {
        throw new Error(
          "OPENAI_COMPATIBLE_BASE_URL is required when FENG_PROVIDER=openai-compatible",
        );
      }
      const defaultModel = envStr(e, "OPENAI_COMPATIBLE_MODEL");
      if (defaultModel) {
        defaults.model = defaultModel;
      }
      options = {
        provider: "openai-compatible",
        apiKey,
        baseURL,
        defaultModel,
      };
      break;
    }

    case "bedrock": {
      const region = envStr(e, "AWS_BEDROCK_REGION", "us-east-1") ?? "us-east-1";
      const accessKeyId = envStr(e, "AWS_ACCESS_KEY_ID");
      const secretAccessKey = envStr(e, "AWS_SECRET_ACCESS_KEY");
      const modelId = envStr(e, "AWS_BEDROCK_MODEL_ID", "anthropic.claude-3-sonnet-20240229-v1:0") ?? "";
      if (!accessKeyId || !secretAccessKey) {
        throw new Error(
          "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required when FENG_PROVIDER=bedrock",
        );
      }
      options = {
        provider: "bedrock",
        region,
        accessKeyId,
        secretAccessKey,
        modelId,
      };
      break;
    }

    case "google": {
      const apiKey = envStr(e, "GOOGLE_API_KEY");
      if (!apiKey) {
        throw new Error(
          "GOOGLE_API_KEY is required when FENG_PROVIDER=google",
        );
      }
      options = {
        provider: "google",
        apiKey,
        baseURL: envStr(e, "GOOGLE_BASE_URL"),
      };
      break;
    }

    default: {
      throw new Error(`Unknown FENG_PROVIDER: ${provider}`);
    }
  }

  const client = createClient(options);
  return { client, defaults };
}
