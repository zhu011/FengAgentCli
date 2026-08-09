/**
 * @fengagent/llm — Google Gemini Provider (stub)
 *
 * 计划中的 Gemini 集成，待后续 Stage 实现。
 */

import type { LLMClient, LLMRequest, LLMEvent, LLMResponse } from "../client.ts";

export interface GoogleClientOptions {
  apiKey: string;
  baseURL?: string;
}

export function createGoogleClient(_options: GoogleClientOptions): LLMClient {
  return {
    async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
      yield {
        type: "error",
        error: { message: "Google Gemini provider not yet implemented" },
      };
    },
    async generate(_request: LLMRequest): Promise<LLMResponse> {
      throw new Error("Google Gemini provider not yet implemented");
    },
  };
}
