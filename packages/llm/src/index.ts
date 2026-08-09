/**
 * @fengagent/llm — LLM 抽象层
 *
 * Provider 无关的 LLM 调用抽象，支持流式输出。
 * 参考 PRD 第 4.2.4 节。
 */

export type { LLMClient } from "./client.ts";
export type {
  LLMRequest,
  LLMResponse,
  LLMEvent,
  LLMError,
} from "./types.ts";

export type { Protocol, Auth, AuthApiKey, AuthBearer, AuthOAuth, Route } from "./route.ts";
export { routeKey } from "./route.ts";

export {
  createAnthropicClient,
  createOpenAIClient,
  createOpenAICompatibleClient,
  createBedrockClient,
  createGoogleClient,
  createClient,
} from "./providers/index.ts";

export type {
  AnthropicClientOptions,
  OpenAIClientOptions,
  OpenAICompatibleOptions,
  BedrockClientOptions,
  GoogleClientOptions,
  ClientCreateOptions,
} from "./providers/index.ts";

export {
  createClientFromEnv,
} from "./env.ts";
export type {
  LLMEnvDefaults,
  ClientFromEnvResult,
} from "./env.ts";
