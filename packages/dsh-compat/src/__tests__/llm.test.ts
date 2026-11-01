/**
 * @fengagent/dsh-compat — P3 `ctx.llm` 映射验收
 *
 * 覆盖：
 * 1. 回落 `ctx.model` 的流式桥：text / reasoning / tool-call / usage / finish 的 chunk 形状；
 * 2. 失败规范化：模型抛错、provider 未注册、abort → 终态 finish（不把异常抛给消费者）；
 * 3. 适配器注册表：路由独占、disposer、`replace` 原子换路、直通 stream；
 * 4. `prepareCall` 单次派发与 config 一致性；
 * 5. `providerRetryPolicy` / `listModels` / `resolveModelInfo` 的回落口径；
 * 6. 不支持面（configurable providers / model discovery）显式抛 `dsh_contract_unsupported`；
 * 7. 消息与内容块互转（id 保留、tool-call 参数 JSON、图片严格失败）。
 */

import { describe, expect, test } from "bun:test";
import type { Message } from "@fengagent/core";
import type { LLMEvent, LLMRequest } from "@fengagent/llm";
import {
  DshContractError,
  DshContractUnsupportedError,
  type DshGenerateOptions,
  type DshStreamChunk,
} from "../contracts.ts";
import { DEFAULT_DSH_RETRY_POLICY, LlmCompat, toLlmRequest, type DshModelLike } from "../llm.ts";
import {
  dshMessageText,
  fromDshMessage,
  requireFengMessage,
  toDshMessage,
  toDshUserMessage,
} from "../messages.ts";

/** 假模型：按给定事件序列流式吐事件，并记录收到的请求 */
function makeModel(
  events: LLMEvent[] | (() => LLMEvent[]),
  capture?: (request: LLMRequest) => void,
): DshModelLike {
  return {
    provider: "fake",
    model: "fake-1",
    async *stream(request: LLMRequest) {
      capture?.(request);
      const list = typeof events === "function" ? events() : events;
      for (const event of list) yield event;
    },
  };
}

const userMessage = (text: string, id = "m1"): DshGenerateOptions["messages"][number] => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
});

const options = (overrides: Partial<DshGenerateOptions> = {}): DshGenerateOptions => ({
  provider: "fake",
  model: "fake-1",
  messages: [userMessage("hi")],
  ...overrides,
});

async function collect(stream: AsyncIterable<DshStreamChunk>): Promise<DshStreamChunk[]> {
  const chunks: DshStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("ctx.llm：回落 ctx.model 的流式桥", () => {
  test("文本 + usage + finish → block-start/deltas/block-end/finish(stop)", async () => {
    let captured: LLMRequest | undefined;
    const llm = new LlmCompat(
      makeModel(
        [
          { type: "text-delta", text: "Hel" },
          { type: "text-delta", text: "lo" },
          { type: "usage", inputTokens: 3, outputTokens: 2, cacheReadTokens: 1 },
          { type: "finish", reason: "end_turn" },
        ],
        (request) => {
          captured = request;
        },
      ),
    );

    const chunks = await collect(llm.stream(options({ system: "be brief" })));

    expect(chunks).toEqual([
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "Hel" },
      { type: "text-delta", index: 0, text: "lo" },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1 } },
      { type: "block-end", index: 0, block: { type: "text", text: "Hello" } },
      { type: "finish", reason: { kind: "stop" } },
    ]);
    expect(captured?.system).toBe("be brief");
    expect(captured?.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  test("thinking-delta → reasoning 块（与可见文本分开）", async () => {
    const llm = new LlmCompat(
      makeModel([
        { type: "thinking-delta", text: "plan" },
        { type: "text-delta", text: "done" },
        { type: "finish", reason: "stop" },
      ]),
    );
    const chunks = await collect(llm.stream(options()));

    expect(chunks[0]).toEqual({ type: "block-start", index: 0, blockType: "reasoning" });
    expect(chunks[1]).toEqual({ type: "reasoning-delta", index: 0, text: "plan" });
    expect(chunks[2]).toEqual({ type: "block-start", index: 1, blockType: "text" });
    expect(chunks).toContainEqual({ type: "block-end", index: 0, block: { type: "reasoning", text: "plan" } });
    expect(chunks.at(-1)).toEqual({ type: "finish", reason: { kind: "stop" } });
  });

  test("tool-call → tool-call-delta + block-end（arguments 是 JSON 字符串）", async () => {
    const llm = new LlmCompat(
      makeModel([
        { type: "tool-call", id: "c1", name: "write", input: { filePath: "a.txt" } },
        { type: "finish", reason: "tool_use" },
      ]),
    );
    const chunks = await collect(llm.stream(options()));

    expect(chunks).toEqual([
      { type: "block-start", index: 0, blockType: "tool-call" },
      { type: "tool-call-delta", index: 0, id: "c1", name: "write", argumentsDelta: '{"filePath":"a.txt"}' },
      {
        type: "block-end",
        index: 0,
        block: { type: "tool-call", id: "c1", name: "write", arguments: '{"filePath":"a.txt"}' },
      },
      { type: "finish", reason: { kind: "tool-calls" } },
    ]);
  });

  test("模型抛错 → 终态 error finish（含 code/status）", async () => {
    const failing: DshModelLike = {
      provider: "fake",
      model: "fake-1",
      // eslint-disable-next-line require-yield
      async *stream() {
        throw Object.assign(new Error("boom"), { code: "AUTH", status: 401 });
      },
    };
    const llm = new LlmCompat(failing);
    const chunks = await collect(llm.stream(options()));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: "finish",
      reason: { kind: "error", failure: { code: "AUTH", message: "boom", status: 401 } },
    });
  });

  test("provider 与 ctx.model 不一致且无适配器 → NO_ADAPTER（不静默用错模型）", async () => {
    let called = false;
    const llm = new LlmCompat(makeModel([{ type: "finish", reason: "stop" }], () => (called = true)));
    const chunks = await collect(llm.stream(options({ provider: "other" })));

    expect(called).toBe(false);
    expect(chunks[0]).toMatchObject({ type: "finish", reason: { kind: "error", failure: { code: "NO_ADAPTER" } } });
  });

  test("没有模型服务 → NO_ADAPTER 终态（装载期不炸）", async () => {
    const llm = new LlmCompat(undefined);
    const chunks = await collect(llm.stream(options()));
    expect(chunks[0]).toMatchObject({ type: "finish", reason: { kind: "error", failure: { code: "NO_ADAPTER" } } });
  });

  test("带 tools 但没注入 schema 转换器 → dsh_contract_unsupported（不静默丢工具）", async () => {
    const llm = new LlmCompat(makeModel([{ type: "finish", reason: "stop" }]));
    const chunks = await collect(
      llm.stream(
        options({ tools: [{ name: "write", description: "w", parameters: { type: "object" } }] }),
      ),
    );
    expect(chunks[0]).toMatchObject({
      type: "finish",
      reason: { kind: "error", failure: { code: "dsh_contract_unsupported" } },
    });
  });
});

describe("ctx.llm：适配器注册表", () => {
  test("注册的 provider 直通 adapter.stream；disposer 释放后回落", async () => {
    const llm = new LlmCompat(makeModel([{ type: "text-delta", text: "model" }, { type: "finish", reason: "stop" }]));
    const dispose = llm.registerAdapter(["dsh-x"], {
      async *stream() {
        yield { type: "text-delta", index: 0, text: "adapter" } as const;
        yield { type: "finish", reason: { kind: "stop" } } as const;
      },
    });

    const first = await collect(llm.stream(options({ provider: "dsh-x" })));
    expect(first).toContainEqual({ type: "text-delta", index: 0, text: "adapter" });

    dispose();
    const after = await collect(llm.stream(options({ provider: "dsh-x" })));
    expect(after[0]).toMatchObject({ type: "finish", reason: { kind: "error", failure: { code: "NO_ADAPTER" } } });
  });

  test("同一 provider 二次注册 → DUPLICATE_ADAPTER；replace 先全量校验", async () => {
    const llm = new LlmCompat(undefined);
    const first = llm.registerAdapter(["a"], { async *stream() {} });
    expect(() => llm.registerAdapter(["a"], { async *stream() {} })).toThrow(DshContractError);

    const second = llm.registerAdapter(["b"], { async *stream() {} });
    // replace 与另一注册冲突：拒绝且保留原路由
    expect(() => second.replace(["a"])).toThrow(/DUPLICATE_ADAPTER/);
    expect(llm.listProviders().map((p) => p.id)).toEqual(["a", "b"]);
    // 合法 replace：a 空出后 b 换到 c
    first();
    second.replace(["c"]);
    expect(llm.listProviders().map((p) => p.id)).toEqual(["c"]);
    // 已释放的注册不能 replace
    expect(() => second.replace([])).not.toThrow();
  });

  test("listProviders 合并模型路由与适配器路由；providerInfo 生效", () => {
    const llm = new LlmCompat(makeModel([]));
    llm.registerAdapter(["p2"], {
      async *stream() {},
      providerInfo: (id) => ({ id, name: "P2 显示名" }),
    });
    expect(llm.listProviders()).toEqual([
      { id: "fake", name: "fake-1" },
      { id: "p2", name: "P2 显示名" },
    ]);
  });

  test("providerRetryPolicy：默认策略 / 适配器覆盖", () => {
    const llm = new LlmCompat(undefined);
    expect(llm.providerRetryPolicy("unknown")).toEqual(DEFAULT_DSH_RETRY_POLICY);
    llm.registerAdapter(["slow"], {
      async *stream() {},
      providerRetryPolicy: () => ({
        mode: "always",
        initialDelayMs: 100,
        maxDelayMs: 1_000,
        jitterRatio: 0,
      }),
    });
    expect(llm.providerRetryPolicy("slow")).toMatchObject({ mode: "always", initialDelayMs: 100 });
  });

  test("listModels / resolveModelInfo：适配器优先，回落只报当前模型身份", async () => {
    const llm = new LlmCompat(makeModel([]));
    expect(await llm.listModels("fake")).toEqual([{ provider: "fake", id: "fake-1", name: "fake-1" }]);
    expect(await llm.listModels("nope")).toEqual([]);
    expect(await llm.resolveModelInfo("fake", "x")).toEqual({ provider: "fake", id: "x", name: "x" });

    llm.registerAdapter(["dsh-y"], {
      async *stream() {},
      listModels: async (provider) => [{ provider, id: "m", name: "M" }],
      resolveModel: async (provider, model) => ({ provider, id: model, name: model, context: { contextWindow: 128 } }),
    });
    expect(await llm.listModels("dsh-y")).toEqual([{ provider: "dsh-y", id: "m", name: "M" }]);
    expect(await llm.resolveModelInfo("dsh-y", "m")).toMatchObject({ context: { contextWindow: 128 } });
  });

  test("prepareCall：config 冻结、单次派发、不一致拒绝", async () => {
    const llm = new LlmCompat(makeModel([{ type: "finish", reason: "stop" }]));
    const prepared = llm.prepareCall(options({ temperature: 0.2 }));
    await collect(prepared.stream(options({ temperature: 0.2 })));
    expect(() => prepared.stream(options({ temperature: 0.2 }))).toThrow(/INVALID_PREPARED_CALL/);

    const other = llm.prepareCall(options({ maxTokens: 10 }));
    expect(() => other.stream(options({ maxTokens: 20 }))).toThrow(/INVALID_PREPARED_CALL/);
  });

  test("不支持面显式抛错（可诊断，不静默）", () => {
    const llm = new LlmCompat(undefined);
    expect(() => llm.registerConfigurableProviders([{}])).toThrow(DshContractUnsupportedError);
    try {
      llm.registerModelDiscovery("llm", () => undefined);
      throw new Error("expected registerModelDiscovery to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DshContractUnsupportedError);
      expect((err as DshContractUnsupportedError).code).toBe("dsh_contract_unsupported");
      expect((err as DshContractUnsupportedError).contract).toBe("llm.registerModelDiscovery");
    }
  });
});

describe("消息 / 内容块互转", () => {
  const fengMessage: Message = {
    id: "msg-42",
    role: "assistant",
    createdAt: 1,
    content: [
      { type: "thinking", text: "plan" },
      { type: "text", text: "done" },
      { type: "tool-use", id: "c1", name: "write", input: { filePath: "a.txt" } },
      { type: "tool-result", toolUseId: "c1", content: "ok" },
    ],
  };

  test("Feng → dsh → Feng 往返：id 与块语义保留", () => {
    const dsh = toDshMessage(fengMessage, { provider: "deepseek", model: "v4" });
    expect(dsh.id).toBe("msg-42");
    expect(dsh.source).toEqual({ kind: "model", provider: "deepseek", model: "v4" });

    const { message, loss } = fromDshMessage(dsh);
    expect(loss).toBeUndefined();
    expect(message?.id).toBe("msg-42");
    expect(message?.content).toEqual([
      { type: "thinking", text: "plan" },
      { type: "text", text: "done" },
      { type: "tool-use", id: "c1", name: "write", input: { filePath: "a.txt" } },
      { type: "tool-result", toolUseId: "c1", content: "ok" },
    ]);
  });

  test("tool-call 参数是原始 JSON 字符串；解析失败保留原文", () => {
    const { message } = fromDshMessage({
      id: "m",
      role: "assistant",
      content: [{ type: "tool-call", id: "c", name: "t", arguments: "{not json" }],
    });
    expect(message?.content).toEqual([{ type: "tool-use", id: "c", name: "t", input: "{not json" }]);
  });

  test("图片块无等价物：严格模式抛错，宽松模式记 loss", () => {
    const withImage = {
      id: "m",
      role: "assistant",
      content: [{ type: "image", attachment: { id: "a" } }],
    } as never;
    expect(() => requireFengMessage(withImage)).toThrow(DshContractError);
    expect(fromDshMessage(withImage).loss).toEqual({ messageId: "m", blocks: ["image"] });
  });

  test("toDshUserMessage：铸 user 消息、默认 source、空内容拒绝", () => {
    const message = toDshUserMessage("hello");
    expect(message.role).toBe("user");
    expect(message.source).toEqual({ kind: "user" });
    expect(message.id.length).toBeGreaterThan(0);
    expect(dshMessageText(message)).toBe("hello");
    expect(() => toDshUserMessage([])).toThrow(/at least one content block/);
  });

  test("toLlmRequest：system 消息折入 system 槽，id 保留", () => {
    const request = toLlmRequest(
      options({
        system: "base",
        messages: [
          { id: "s1", role: "system", content: [{ type: "text", text: "extra" }] },
          userMessage("hi", "u1"),
        ],
      }),
      { provider: "fake", model: "fake-1" },
    );
    expect(request.system).toBe("base\n\nextra");
    expect(request.messages.map((m) => m.id)).toEqual(["u1"]);
  });
});
