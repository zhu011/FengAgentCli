/**
 * @fengagent/llm — ReloadableLLMClient 测试
 */

import { describe, test, expect } from "bun:test";
import { ReloadableLLMClient } from "../reloadable.ts";
import type { LLMClient, LLMRequest, LLMResponse, LLMEvent } from "../client.ts";

class StubClient implements LLMClient {
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    yield { type: "text-delta", text: this.tag };
  }
  async generate(request: LLMRequest): Promise<LLMResponse> {
    return {
      id: this.tag,
      model: request.model,
      content: [{ type: "text", text: this.tag }],
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "end_turn",
    };
  }
}

const REQ = { model: "m", system: "", messages: [] };

describe("ReloadableLLMClient", () => {
  test("初始代理到传入的 client", async () => {
    const reloadable = new ReloadableLLMClient(new StubClient("a"));
    expect(await reloadable.generate(REQ)).toMatchObject({
      id: "a",
    });
    const events: LLMEvent[] = [];
    for await (const ev of reloadable.stream(REQ)) {
      events.push(ev);
    }
    expect(events[0]).toEqual({ type: "text-delta", text: "a" });
  });

  test("setClient 后后续请求走新 client（热替换）", async () => {
    const reloadable = new ReloadableLLMClient(new StubClient("old"));
    expect(await reloadable.generate(REQ)).toMatchObject({
      id: "old",
    });

    reloadable.setClient(new StubClient("new"));
    expect(await reloadable.generate(REQ)).toMatchObject({
      id: "new",
    });

    // getClient 返回当前生效的 client
    expect((reloadable.getClient() as StubClient).tag).toBe("new");
  });

  test("流式输出也走新 client", async () => {
    const reloadable = new ReloadableLLMClient(new StubClient("old"));
    reloadable.setClient(new StubClient("swapped"));
    const events: LLMEvent[] = [];
    for await (const ev of reloadable.stream(REQ)) {
      events.push(ev);
    }
    expect(events[0]).toEqual({ type: "text-delta", text: "swapped" });
  });
});
