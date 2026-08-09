/**
 * @fengagent/llm — LLMClient 接口 + 工厂函数
 *
 * Provider 无关的 LLM 调用抽象。
 * 参考 PRD 第 4.2.4 节。
 */

import type { LLMRequest, LLMResponse, LLMEvent } from "./types.ts";

export interface LLMClient {
  stream(request: LLMRequest): AsyncGenerator<LLMEvent>;
  generate(request: LLMRequest): Promise<LLMResponse>;
}

export type { LLMRequest, LLMResponse, LLMEvent } from "./types.ts";
export { createClient } from "./providers/index.ts";
