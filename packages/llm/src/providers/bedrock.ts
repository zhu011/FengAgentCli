/**
 * @fengagent/llm — AWS Bedrock Provider (stub)
 *
 * 计划中的 Bedrock 集成，待后续 Stage 实现。
 */

import type { LLMClient, LLMRequest, LLMEvent, LLMResponse } from "../client.ts";

export interface BedrockClientOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  modelId: string;
}

export function createBedrockClient(_options: BedrockClientOptions): LLMClient {
  return {
    async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
      yield {
        type: "error",
        error: { message: "Bedrock provider not yet implemented" },
      };
    },
    async generate(_request: LLMRequest): Promise<LLMResponse> {
      throw new Error("Bedrock provider not yet implemented");
    },
  };
}
