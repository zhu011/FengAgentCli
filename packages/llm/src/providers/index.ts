/**
 * @fengagent/llm — Provider 注册表
 *
 * 根据 provider 名称创建对应的 LLMClient。
 */

import type { LLMClient } from "../client.ts";
import type { AnthropicClientOptions } from "./anthropic.ts";
import type { OpenAIClientOptions } from "./openai.ts";
import type { OpenAICompatibleOptions } from "./openai-compatible.ts";
import type { BedrockClientOptions } from "./bedrock.ts";
import type { GoogleClientOptions } from "./google.ts";

import { createAnthropicClient } from "./anthropic.ts";
import { createOpenAIClient } from "./openai.ts";
import { createOpenAICompatibleClient } from "./openai-compatible.ts";
import { createBedrockClient } from "./bedrock.ts";
import { createGoogleClient } from "./google.ts";

export {
  createAnthropicClient,
  createOpenAIClient,
  createOpenAICompatibleClient,
  createBedrockClient,
  createGoogleClient,
};

export type { AnthropicClientOptions } from "./anthropic.ts";
export type { OpenAIClientOptions } from "./openai.ts";
export type { OpenAICompatibleOptions } from "./openai-compatible.ts";
export type { BedrockClientOptions } from "./bedrock.ts";
export type { GoogleClientOptions } from "./google.ts";

export type ClientCreateOptions =
  | ({ provider: "anthropic" } & AnthropicClientOptions)
  | ({ provider: "openai" } & OpenAIClientOptions)
  | ({ provider: "openai-compatible" } & OpenAICompatibleOptions)
  | ({ provider: "bedrock" } & BedrockClientOptions)
  | ({ provider: "google" } & GoogleClientOptions);

export function createClient(options: ClientCreateOptions): LLMClient {
  switch (options.provider) {
    case "anthropic": {
      const { provider: _p, ...rest } = options;
      return createAnthropicClient(rest as AnthropicClientOptions);
    }
    case "openai": {
      const { provider: _p, ...rest } = options;
      return createOpenAIClient(rest as OpenAIClientOptions);
    }
    case "openai-compatible": {
      const { provider: _p, ...rest } = options;
      return createOpenAICompatibleClient(rest as OpenAICompatibleOptions);
    }
    case "bedrock": {
      const { provider: _p, ...rest } = options;
      return createBedrockClient(rest as BedrockClientOptions);
    }
    case "google": {
      const { provider: _p, ...rest } = options;
      return createGoogleClient(rest as GoogleClientOptions);
    }
    default: {
      const unknown = options as { provider: string };
      throw new Error(`Unknown provider: ${unknown.provider}`);
    }
  }
}
