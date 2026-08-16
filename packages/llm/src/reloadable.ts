/**
 * @fengagent/llm — 可热替换的 LLM Client 包装器
 *
 * ReloadableLLMClient 实现 LLMClient 接口，内部持有一个「当前生效」的 client，
 * 通过 setClient() 可在运行时无损替换底层客户端（Provider / API Key / BaseURL 变更后
 * 无需重建 Agent，Agent 持有的引用不变，后续请求自动走新客户端）。
 * 参考 /provider 命令的「立即生效」机制。
 */

import type { LLMClient } from "./client.ts";
import type { LLMRequest, LLMResponse, LLMEvent } from "./types.ts";

/**
 * 可热替换的 LLMClient 包装器。
 *
 * 用法：
 * ```ts
 * const reloadable = new ReloadableLLMClient(createClientFromEnv().client);
 * // 运行时切换底层客户端（Agent 无需重建）
 * reloadable.setClient(createClientFromEnv(newEnv).client);
 * ```
 */
export class ReloadableLLMClient implements LLMClient {
  private inner: LLMClient;

  constructor(inner: LLMClient) {
    this.inner = inner;
  }

  /** 替换底层客户端（线程安全：同步替换，stream/generate 在下一次调用时生效） */
  setClient(client: LLMClient): void {
    this.inner = client;
  }

  /** 获取当前生效的底层客户端（用于校验/测试） */
  getClient(): LLMClient {
    return this.inner;
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    yield* this.inner.stream(request);
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    return this.inner.generate(request);
  }
}
