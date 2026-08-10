/**
 * @fengagent/llm — Mock LLM 响应单元测试
 *
 * 使用 mock 模拟 Anthropic / OpenAI / OpenAI-Compatible 的 API 响应，
 * 验证 Provider 正确解析流式响应为 LLMEvent。
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { LLMEvent } from "../types.ts";
import { createUserMessage } from "@fengagent/core";

// ──────────────────────────────────────────────
// Anthropic SDK Mock
// ──────────────────────────────────────────────

// Mutable mock data — tests set these before calling the provider
let anthropicStreamEvents: unknown[] = [];
let anthropicCreateResponse: unknown = null;

mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    constructor(_opts: { apiKey: string; baseURL?: string }) {}
    messages = {
      stream(_params: unknown) {
        const events = anthropicStreamEvents;
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
          },
          async finalMessage() {
            return anthropicCreateResponse ?? {
              stop_reason: "end_turn",
              id: "msg_mock",
              model: "claude-3",
            };
          },
        };
      },
      async create(_params: unknown) {
        return anthropicCreateResponse ?? {
          id: "msg_mock",
          model: "claude-3",
          content: [{ type: "text", text: "Mock response" }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: "end_turn",
        };
      },
    };
  },
}));

// ──────────────────────────────────────────────
// OpenAI SDK Mock
// ──────────────────────────────────────────────

let openaiStreamChunks: unknown[] = [];
let openaiCreateResponse: unknown = null;

mock.module("openai", () => ({
  default: class MockOpenAI {
    constructor(_opts: { apiKey: string; baseURL?: string }) {}
    chat = {
      completions: {
        async create(params: unknown) {
          const p = params as { stream?: boolean };
          if (p.stream) {
            const chunks = openaiStreamChunks;
            return {
              async *[Symbol.asyncIterator]() {
                for (const c of chunks) yield c;
              },
            };
          }
          return openaiCreateResponse ?? {
            id: "chatcmpl_mock",
            model: "gpt-4",
            choices: [
              {
                message: { content: "Mock response" },
                finish_reason: "stop",
                index: 0,
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        },
      },
    };
  },
}));

// Import providers after mock.module is set up (mock.module is hoisted)
import { createAnthropicClient } from "../providers/anthropic.ts";
import { createOpenAIClient } from "../providers/openai.ts";
import { createOpenAICompatibleClient } from "../providers/openai-compatible.ts";
import { createClientFromEnv } from "../env.ts";
import type { LLMRequest } from "../types.ts";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

async function collectEvents(
  gen: AsyncGenerator<LLMEvent>,
): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function createSSEResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function createJSONResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const baseRequest: LLMRequest = {
  model: "claude-sonnet-4-20250514",
  system: "You are a helpful assistant.",
  messages: [createUserMessage("Hello")],
  maxTokens: 4096,
};

// ──────────────────────────────────────────────
// Anthropic Provider (mocked SDK)
// ──────────────────────────────────────────────

describe("Anthropic Provider (mocked)", () => {
  beforeEach(() => {
    anthropicStreamEvents = [];
    anthropicCreateResponse = null;
  });

  test("stream parses text deltas and finish", async () => {
    anthropicStreamEvents = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-3",
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];

    const client = createAnthropicClient({ apiKey: "test-key" });
    const events = await collectEvents(client.stream(baseRequest));

    const textDeltas = events.filter((e) => e.type === "text-delta");
    expect(textDeltas).toHaveLength(2);
    expect((textDeltas[0] as { text: string }).text).toBe("Hello");
    expect((textDeltas[1] as { text: string }).text).toBe(" world");

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toBeDefined();
    expect((finish as { reason: string }).reason).toBe("end_turn");

    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
    expect((usageEvents[0] as { inputTokens: number }).inputTokens).toBe(10);
  });

  test("stream parses tool-use blocks", async () => {
    anthropicCreateResponse = {
      stop_reason: "tool_use",
      id: "msg_2",
      model: "claude-3",
      content: [{ type: "tool_use", id: "tool_1", name: "bash", input: { command: "ls" } }],
      usage: { input_tokens: 15, output_tokens: 10 },
    };
    anthropicStreamEvents = [
      {
        type: "message_start",
        message: { id: "msg_2", model: "claude-3", usage: { input_tokens: 15, output_tokens: 0 } },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tool_1", name: "bash", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ];

    const client = createAnthropicClient({ apiKey: "test-key" });
    const events = await collectEvents(client.stream(baseRequest));

    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    const tc = toolCalls[0] as { id: string; name: string; input: unknown };
    expect(tc.id).toBe("tool_1");
    expect(tc.name).toBe("bash");

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toBeDefined();
    expect((finish as { reason: string }).reason).toBe("tool_use");
  });

  test("stream parses thinking deltas", async () => {
    anthropicStreamEvents = [
      {
        type: "message_start",
        message: { id: "msg_3", model: "claude-3", usage: { input_tokens: 5, output_tokens: 0 } },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think..." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Answer" },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];

    const client = createAnthropicClient({ apiKey: "test-key" });
    const events = await collectEvents(client.stream(baseRequest));

    const thinking = events.filter((e) => e.type === "thinking-delta");
    expect(thinking).toHaveLength(1);
    expect((thinking[0] as { text: string }).text).toBe("Let me think...");

    const textDeltas = events.filter((e) => e.type === "text-delta");
    expect(textDeltas).toHaveLength(1);
    expect((textDeltas[0] as { text: string }).text).toBe("Answer");
  });

  test("generate returns LLMResponse with content and usage", async () => {
    anthropicCreateResponse = {
      id: "msg_gen",
      model: "claude-3",
      content: [{ type: "text", text: "Generated response" }],
      usage: { input_tokens: 20, output_tokens: 10 },
      stop_reason: "end_turn",
    };

    const client = createAnthropicClient({ apiKey: "test-key" });
    const response = await client.generate(baseRequest);

    expect(response.id).toBe("msg_gen");
    expect(response.model).toBe("claude-3");
    expect(response.content).toHaveLength(1);
    expect(response.content[0]?.type).toBe("text");
    expect((response.content[0] as { text: string }).text).toBe("Generated response");
    expect(response.usage.inputTokens).toBe(20);
    expect(response.usage.outputTokens).toBe(10);
    expect(response.finishReason).toBe("end_turn");
  });

  test("generate returns tool-use content blocks", async () => {
    anthropicCreateResponse = {
      id: "msg_tool",
      model: "claude-3",
      content: [
        { type: "text", text: "Let me run that." },
        { type: "tool_use", id: "tool_gen_1", name: "bash", input: { command: "echo hi" } },
      ],
      usage: { input_tokens: 15, output_tokens: 12 },
      stop_reason: "tool_use",
    };

    const client = createAnthropicClient({ apiKey: "test-key" });
    const response = await client.generate(baseRequest);

    expect(response.content).toHaveLength(2);
    expect(response.content[0]?.type).toBe("text");
    expect(response.content[1]?.type).toBe("tool-use");
    expect((response.content[1] as { name: string }).name).toBe("bash");
    expect(response.finishReason).toBe("tool_use");
  });
});

// ──────────────────────────────────────────────
// OpenAI Provider (mocked SDK)
// ──────────────────────────────────────────────

describe("OpenAI Provider (mocked)", () => {
  beforeEach(() => {
    openaiStreamChunks = [];
    openaiCreateResponse = null;
  });

  test("stream parses text deltas and finish", async () => {
    openaiStreamChunks = [
      { id: "c1", choices: [{ delta: { content: "Hello" }, index: 0 }] },
      { id: "c1", choices: [{ delta: { content: " world" }, index: 0 }] },
      {
        id: "c1",
        choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ];

    const client = createOpenAIClient({ apiKey: "test-key" });
    const events = await collectEvents(
      client.stream({ ...baseRequest, model: "gpt-4" }),
    );

    const textDeltas = events.filter((e) => e.type === "text-delta");
    expect(textDeltas).toHaveLength(2);
    expect((textDeltas[0] as { text: string }).text).toBe("Hello");
    expect((textDeltas[1] as { text: string }).text).toBe(" world");

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toBeDefined();
    expect((finish as { reason: string }).reason).toBe("end_turn");

    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    expect((usage as { inputTokens: number }).inputTokens).toBe(10);
  });

  test("stream parses tool calls", async () => {
    openaiStreamChunks = [
      {
        id: "c2",
        choices: [
          {
            delta: {
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "bash", arguments: "" } },
              ],
            },
            index: 0,
          },
        ],
      },
      {
        id: "c2",
        choices: [
          {
            delta: { tool_calls: [{ function: { arguments: '{"command":"ls"}' } }] },
            index: 0,
          },
        ],
      },
      {
        id: "c2",
        choices: [{ delta: {}, index: 0, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 15, completion_tokens: 10 },
      },
    ];

    const client = createOpenAIClient({ apiKey: "test-key" });
    const events = await collectEvents(
      client.stream({ ...baseRequest, model: "gpt-4" }),
    );

    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    const tc = toolCalls[0] as { id: string; name: string; input: unknown };
    expect(tc.id).toBe("call_1");
    expect(tc.name).toBe("bash");

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toBeDefined();
    expect((finish as { reason: string }).reason).toBe("tool_use");
  });

  test("generate returns LLMResponse with content and usage", async () => {
    openaiCreateResponse = {
      id: "chatcmpl_gen",
      model: "gpt-4",
      choices: [
        {
          message: { content: "Generated response" },
          finish_reason: "stop",
          index: 0,
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    };

    const client = createOpenAIClient({ apiKey: "test-key" });
    const response = await client.generate({ ...baseRequest, model: "gpt-4" });

    expect(response.id).toBe("chatcmpl_gen");
    expect(response.model).toBe("gpt-4");
    expect(response.content).toHaveLength(1);
    expect(response.content[0]?.type).toBe("text");
    expect(response.usage.inputTokens).toBe(20);
    expect(response.usage.outputTokens).toBe(10);
    expect(response.finishReason).toBe("end_turn");
  });

  test("generate returns tool-use content blocks", async () => {
    openaiCreateResponse = {
      id: "chatcmpl_tool",
      model: "gpt-4",
      choices: [
        {
          message: {
            content: "Let me check.",
            tool_calls: [
              {
                id: "call_gen_1",
                function: { name: "bash", arguments: '{"command":"ls"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
          index: 0,
        },
      ],
      usage: { prompt_tokens: 15, completion_tokens: 10 },
    };

    const client = createOpenAIClient({ apiKey: "test-key" });
    const response = await client.generate({ ...baseRequest, model: "gpt-4" });

    expect(response.content).toHaveLength(2);
    expect(response.content[0]?.type).toBe("text");
    expect(response.content[1]?.type).toBe("tool-use");
    expect((response.content[1] as { name: string }).name).toBe("bash");
    expect(response.finishReason).toBe("tool_use");
  });
});

// ──────────────────────────────────────────────
// OpenAI-Compatible Provider (mocked fetch)
// ──────────────────────────────────────────────

describe("OpenAI-Compatible Provider (mocked fetch)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("stream parses SSE text deltas", async () => {
    const sseData = [
      'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    globalThis.fetch = mock(() =>
      Promise.resolve(createSSEResponse([sseData])),
    ) as unknown as typeof fetch;

    const client = createOpenAICompatibleClient({
      apiKey: "test-key",
      baseURL: "http://localhost:8080/v1",
    });
    const events = await collectEvents(
      client.stream({ ...baseRequest, model: "local-model" }),
    );

    const textDeltas = events.filter((e) => e.type === "text-delta");
    expect(textDeltas).toHaveLength(2);
    expect((textDeltas[0] as { text: string }).text).toBe("Hello");
    expect((textDeltas[1] as { text: string }).text).toBe(" world");

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toBeDefined();
    expect((finish as { reason: string }).reason).toBe("end_turn");

    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    expect((usage as { inputTokens: number }).inputTokens).toBe(10);
  });

  test("stream parses SSE tool calls", async () => {
    const sseData = [
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"bash","arguments":""}}]},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"command\\":\\"ls\\"}"}}]},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":15,"completion_tokens":10}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    globalThis.fetch = mock(() =>
      Promise.resolve(createSSEResponse([sseData])),
    ) as unknown as typeof fetch;

    const client = createOpenAICompatibleClient({
      apiKey: "test-key",
      baseURL: "http://localhost:8080/v1",
    });
    const events = await collectEvents(
      client.stream({ ...baseRequest, model: "local-model" }),
    );

    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    const tc = toolCalls[0] as { id: string; name: string; input: unknown };
    expect(tc.id).toBe("call_1");
    expect(tc.name).toBe("bash");

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toBeDefined();
    expect((finish as { reason: string }).reason).toBe("tool_use");
  });

  test("generate returns LLMResponse", async () => {
    const responseData = {
      id: "chatcmpl_compat",
      model: "local-model",
      choices: [
        { message: { content: "Generated response" }, finish_reason: "stop", index: 0 },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(createJSONResponse(responseData)),
    ) as unknown as typeof fetch;

    const client = createOpenAICompatibleClient({
      apiKey: "test-key",
      baseURL: "http://localhost:8080/v1",
    });
    const response = await client.generate({ ...baseRequest, model: "local-model" });

    expect(response.id).toBe("chatcmpl_compat");
    expect(response.model).toBe("local-model");
    expect(response.content).toHaveLength(1);
    expect(response.content[0]?.type).toBe("text");
    expect(response.usage.inputTokens).toBe(20);
    expect(response.usage.outputTokens).toBe(10);
    expect(response.finishReason).toBe("end_turn");
  });

  test("stream yields error on HTTP failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    ) as unknown as typeof fetch;

    const client = createOpenAICompatibleClient({
      apiKey: "test-key",
      baseURL: "http://localhost:8080/v1",
    });
    const events = await collectEvents(
      client.stream({ ...baseRequest, model: "local-model" }),
    );

    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { error: { status?: number } }).error.status).toBe(500);
  });

  test("request model takes priority over defaultModel", async () => {
    let capturedBody: { model?: string } | null = null;
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string) as { model?: string };
      return Promise.resolve(
        createJSONResponse({
          id: "test",
          model: "local-model",
          choices: [{ message: { content: "ok" }, finish_reason: "stop", index: 0 }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    }) as unknown as typeof fetch;

    const client = createOpenAICompatibleClient({
      apiKey: "test-key",
      baseURL: "http://localhost:8080/v1",
      defaultModel: "env-model",
    });
    await client.generate({ ...baseRequest, model: "local-model" });

    const body = capturedBody as { model?: string } | null;
    expect(body?.model).toBe("local-model");
  });

  test("defaultModel used when request model is empty", async () => {
    let capturedBody: { model?: string } | null = null;
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string) as { model?: string };
      return Promise.resolve(
        createJSONResponse({
          id: "test",
          model: "env-model",
          choices: [{ message: { content: "ok" }, finish_reason: "stop", index: 0 }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    }) as unknown as typeof fetch;

    const client = createOpenAICompatibleClient({
      apiKey: "test-key",
      baseURL: "http://localhost:8080/v1",
      defaultModel: "env-model",
    });
    await client.generate({ ...baseRequest, model: "" });

    const body = capturedBody as { model?: string } | null;
    expect(body?.model).toBe("env-model");
  });
});

// ──────────────────────────────────────────────
// createClientFromEnv
// ──────────────────────────────────────────────

describe("createClientFromEnv", () => {
  test("creates anthropic client", () => {
    const { client, defaults } = createClientFromEnv({
      FENG_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-test",
    });
    expect(client).toBeDefined();
    expect(typeof client.stream).toBe("function");
    expect(typeof client.generate).toBe("function");
    expect(defaults.maxTokens).toBeUndefined();
    expect(defaults.temperature).toBeUndefined();
  });

  test("creates openai client", () => {
    const { client } = createClientFromEnv({
      FENG_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
    });
    expect(client).toBeDefined();
    expect(typeof client.stream).toBe("function");
  });

  test("creates openai-compatible client with defaultModel", () => {
    const { client, defaults } = createClientFromEnv({
      FENG_PROVIDER: "openai-compatible",
      OPENAI_COMPATIBLE_API_KEY: "sk-test",
      OPENAI_COMPATIBLE_BASE_URL: "http://localhost:8080/v1",
      OPENAI_COMPATIBLE_MODEL: "local-model",
    });
    expect(client).toBeDefined();
    expect(defaults.model).toBe("local-model");
  });

  test("reads FENG_MAX_TOKENS and FENG_TEMPERATURE", () => {
    const { defaults } = createClientFromEnv({
      FENG_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-test",
      FENG_MAX_TOKENS: "4096",
      FENG_TEMPERATURE: "0.5",
    });
    expect(defaults.maxTokens).toBe(4096);
    expect(defaults.temperature).toBe(0.5);
  });

  test("defaults to anthropic when FENG_PROVIDER unset", () => {
    const { client } = createClientFromEnv({
      ANTHROPIC_API_KEY: "sk-test",
    });
    expect(client).toBeDefined();
    expect(typeof client.stream).toBe("function");
  });

  test("throws when API key missing", () => {
    expect(() => createClientFromEnv({ FENG_PROVIDER: "anthropic" })).toThrow(
      "ANTHROPIC_API_KEY",
    );
    expect(() => createClientFromEnv({ FENG_PROVIDER: "openai" })).toThrow(
      "OPENAI_API_KEY",
    );
    expect(() =>
      createClientFromEnv({ FENG_PROVIDER: "openai-compatible" }),
    ).toThrow("OPENAI_COMPATIBLE_API_KEY");
  });

  test("throws when OPENAI_COMPATIBLE_BASE_URL missing", () => {
    expect(() =>
      createClientFromEnv({
        FENG_PROVIDER: "openai-compatible",
        OPENAI_COMPATIBLE_API_KEY: "sk-test",
      }),
    ).toThrow("OPENAI_COMPATIBLE_BASE_URL");
  });

  test("throws for unknown provider", () => {
    expect(() => createClientFromEnv({ FENG_PROVIDER: "unknown" })).toThrow(
      "Unknown FENG_PROVIDER",
    );
  });
});

// ──────────────────────────────────────────────
// sseToEvents (realistic data)
// ──────────────────────────────────────────────

import { sseToEvents } from "../stream.ts";

describe("sseToEvents", () => {
  test("parses OpenAI-style SSE stream", async () => {
    const data = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(data));
        controller.close();
      },
    });

    const events: LLMEvent[] = [];
    for await (const event of sseToEvents(stream, (raw) => {
      const parsed = JSON.parse(raw) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content) {
        return { type: "text-delta", text: delta.content };
      }
      return null;
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect((events[0] as { text: string }).text).toBe("Hi");
    expect((events[1] as { text: string }).text).toBe(" there");
  });

  test("handles multi-line data fields (SSE spec)", async () => {
    const data = 'data: {"line":1}\ndata: {"line":2}\n\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(data));
        controller.close();
      },
    });

    const received: string[] = [];
    for await (const _event of sseToEvents(stream, (raw) => {
      received.push(raw);
      return null;
    })) {
      // parser returns null → no events yielded
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toBe('{"line":1}\n{"line":2}');
  });

  test("handles null body gracefully", async () => {
    const events: LLMEvent[] = [];
    for await (const event of sseToEvents(null, () => null)) {
      events.push(event);
    }
    expect(events).toHaveLength(0);
  });

  test("handles data without space after colon", async () => {
    const data = 'data:{"choices":[{"delta":{"content":"X"}}]}\n\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(data));
        controller.close();
      },
    });

    const events: LLMEvent[] = [];
    for await (const event of sseToEvents(stream, (raw) => {
      const parsed = JSON.parse(raw) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const content = parsed.choices?.[0]?.delta?.content;
      if (content) return { type: "text-delta", text: content };
      return null;
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect((events[0] as { text: string }).text).toBe("X");
  });
});
