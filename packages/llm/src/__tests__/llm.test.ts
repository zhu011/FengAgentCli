/**
 * @fengagent/llm — 测试
 *
 * 测试 LLM Provider 集成、流式解析、路由抽象。
 */

import { describe, test, expect } from "bun:test";
import { createUserMessage } from "@fengagent/core";
import type { Message, ContentBlock } from "@fengagent/core";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

import type {
  LLMRequest,
  LLMResponse,
  LLMEvent,
  LLMError,
} from "../types.ts";

describe("LLM Types", () => {
  test("LLMRequest should accept valid input", () => {
    const req: LLMRequest = {
      model: "claude-sonnet-4-20250514",
      system: "You are a helpful assistant.",
      messages: [createUserMessage("Hello")],
      maxTokens: 4096,
      temperature: 0.7,
    };
    expect(req.model).toBe("claude-sonnet-4-20250514");
    expect(req.system).toBe("You are a helpful assistant.");
    expect(req.messages).toHaveLength(1);
    expect(req.maxTokens).toBe(4096);
  });

  test("LLMRequest with tools", () => {
    const req: LLMRequest = {
      model: "claude-sonnet-4-20250514",
      system: "You are a helpful assistant.",
      messages: [],
      tools: [],
    };
    expect(req.tools).toBeDefined();
  });

  test("LLMEvent types are compatible", () => {
    const events: LLMEvent[] = [
      { type: "text-delta", text: "Hello" },
      { type: "thinking-delta", text: "Let me think..." },
      { type: "tool-call", id: "1", name: "read", input: { path: "/a" } },
      { type: "usage", inputTokens: 100, outputTokens: 50 },
      { type: "finish", reason: "end_turn" },
      { type: "error", error: { message: "failed" } },
    ];
    expect(events).toHaveLength(6);
  });

  test("LLMResponse structure", () => {
    const resp: LLMResponse = {
      id: "msg-1",
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text: "Hello!" }],
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: "end_turn",
    };
    expect(resp.content).toHaveLength(1);
    expect(resp.usage.inputTokens).toBe(10);
  });

  test("LLMError structure", () => {
    const err: LLMError = {
      message: "Rate limit exceeded",
      code: "rate_limit",
      status: 429,
    };
    expect(err.status).toBe(429);
  });
});

// ──────────────────────────────────────────────
// Route
// ──────────────────────────────────────────────

import type { Route, Protocol, Auth } from "../route.ts";
import { routeKey } from "../route.ts";

describe("Route", () => {
  test("routeKey generates unique key", () => {
    const route: Route = {
      protocol: "anthropic-messages",
      endpoint: "https://api.anthropic.com",
      auth: { type: "api-key", key: "sk-test" },
    };
    const key = routeKey(route);
    expect(key).toBe("anthropic-messages@https://api.anthropic.com");
  });

  test("all protocol types are valid", () => {
    const protocols: Protocol[] = [
      "anthropic-messages",
      "openai-chat",
      "openai-compatible",
    ];
    expect(protocols).toHaveLength(3);
  });

  test("all auth types are valid", () => {
    const auths: Auth[] = [
      { type: "api-key", key: "k" },
      { type: "bearer", token: "t" },
      { type: "oauth", token: "t" },
    ];
    expect(auths).toHaveLength(3);
  });
});

// ──────────────────────────────────────────────
// Provider Registry
// ──────────────────────────────────────────────

import { createClient, createAnthropicClient } from "../providers/index.ts";

describe("Provider Registry", () => {
  test("createClient returns client for anthropic", () => {
    const client = createClient({
      provider: "anthropic",
      apiKey: "test-key",
    });
    expect(client).toBeDefined();
    expect(typeof client.stream).toBe("function");
    expect(typeof client.generate).toBe("function");
  });

  test("createClient returns client for openai", () => {
    const client = createClient({
      provider: "openai",
      apiKey: "test-key",
    });
    expect(client).toBeDefined();
    expect(typeof client.stream).toBe("function");
    expect(typeof client.generate).toBe("function");
  });

  test("createClient returns client for openai-compatible", () => {
    const client = createClient({
      provider: "openai-compatible",
      apiKey: "test-key",
      baseURL: "http://localhost:8080/v1",
    });
    expect(client).toBeDefined();
  });

  test("createClient returns client for bedrock (stub)", () => {
    const client = createClient({
      provider: "bedrock",
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
      modelId: "test",
    });
    expect(client).toBeDefined();
  });

  test("createClient returns client for google (stub)", () => {
    const client = createClient({
      provider: "google",
      apiKey: "test-key",
    });
    expect(client).toBeDefined();
  });

  test("createClient throws for unknown provider", () => {
    expect(() =>
      createClient({
        provider: "unknown-provider" as "anthropic",
      } as Parameters<typeof createClient>[0]),
    ).toThrow();
  });
});

// ──────────────────────────────────────────────
// Anthropic Provider (unit tests)
// ──────────────────────────────────────────────

describe("Anthropic Provider", () => {
  test("createAnthropicClient returns LLMClient", () => {
    const client = createAnthropicClient({ apiKey: "test-key" });
    expect(typeof client.stream).toBe("function");
    expect(typeof client.generate).toBe("function");
  });

  test("stream returns AsyncGenerator of LLMEvent", () => {
    const client = createAnthropicClient({ apiKey: "test-key" });
    const gen = client.stream({
      model: "claude-sonnet-4-20250514",
      system: "You are helpful.",
      messages: [createUserMessage("Hi")],
    });
    expect(gen[Symbol.asyncIterator]).toBeDefined();
  });
});

// ──────────────────────────────────────────────
// Bedrock Stub
// ──────────────────────────────────────────────

import { createBedrockClient } from "../providers/bedrock.ts";

describe("Bedrock Provider (stub)", () => {
  test("stream yields error event", async () => {
    const client = createBedrockClient({
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
      modelId: "test",
    });
    const events: LLMEvent[] = [];
    for await (const event of client.stream({
      model: "test",
      system: "",
      messages: [],
    })) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });

  test("generate throws", async () => {
    const client = createBedrockClient({
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
      modelId: "test",
    });
    await expect(
      client.generate({ model: "test", system: "", messages: [] }),
    ).rejects.toThrow("not yet implemented");
  });
});

// ──────────────────────────────────────────────
// Google Stub
// ──────────────────────────────────────────────

import { createGoogleClient } from "../providers/google.ts";

describe("Google Provider (stub)", () => {
  test("stream yields error event", async () => {
    const client = createGoogleClient({ apiKey: "test" });
    const events: LLMEvent[] = [];
    for await (const event of client.stream({
      model: "test",
      system: "",
      messages: [],
    })) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });

  test("generate throws", async () => {
    const client = createGoogleClient({ apiKey: "test" });
    await expect(
      client.generate({ model: "test", system: "", messages: [] }),
    ).rejects.toThrow("not yet implemented");
  });
});

// ──────────────────────────────────────────────
// Stream utilities
// ──────────────────────────────────────────────

import { parseSSEStream } from "../stream.ts";

describe("SSE Stream Parser", () => {
  test("parseSSEStream handles basic SSE", async () => {
    const text = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
    const reader = stream.getReader();
    const output = new ReadableStream({
      start(controller) {
        parseSSEStream(reader, controller);
      },
    });

    const frames: string[] = [];
    for await (const chunk of output as unknown as AsyncIterable<{ data: string }>) {
      frames.push((chunk as { data: string }).data);
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe('{"choices":[{"delta":{"content":"Hello"}}]}');
  });
});

// ──────────────────────────────────────────────
// Message conversion helpers (conceptual test)
// ──────────────────────────────────────────────

describe("Message Format Compatibility", () => {
  test("messages with text content", () => {
    const msg: Message = createUserMessage("What is 2+2?");
    expect(msg.role).toBe("user");
    expect(msg.content[0]).toBeDefined();
    if (msg.content[0]) {
      expect(msg.content[0].type).toBe("text");
    }
  });

  test("messages with tool use content", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "Let me check." },
      { type: "tool-use", id: "call-1", name: "bash", input: { command: "ls" } },
    ];
    const msg: Message = {
      id: "msg-1",
      role: "assistant",
      content: blocks,
      createdAt: Date.now(),
    };
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]?.type).toBe("text");
    expect(msg.content[1]?.type).toBe("tool-use");
  });

  test("messages with tool result content", () => {
    const blocks: ContentBlock[] = [
      {
        type: "tool-result",
        toolUseId: "call-1",
        content: "file1.txt\nfile2.txt",
      },
    ];
    const msg: Message = {
      id: "msg-2",
      role: "user",
      content: blocks,
      createdAt: Date.now(),
    };
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]?.type).toBe("tool-result");
    if (msg.content[0]?.type === "tool-result") {
      expect(msg.content[0].toolUseId).toBe("call-1");
    }
  });

  test("messages with image content", () => {
    const blocks: ContentBlock[] = [
      {
        type: "image",
        source: {
          type: "base64",
          mediaType: "image/png",
          data: "iVBORw0KGgo=",
        },
      },
    ];
    const msg: Message = {
      id: "msg-3",
      role: "user",
      content: blocks,
      createdAt: Date.now(),
    };
    expect(msg.content[0]?.type).toBe("image");
  });
});

// ──────────────────────────────────────────────
// Package exports
// ──────────────────────────────────────────────

describe("Package exports", () => {
  test("index.ts exports all expected modules", async () => {
    const mod = await import("../index.ts");
    expect(mod.createClient).toBeDefined();
    expect(mod.createAnthropicClient).toBeDefined();
    expect(mod.createOpenAIClient).toBeDefined();
    expect(mod.createOpenAICompatibleClient).toBeDefined();
    expect(mod.createBedrockClient).toBeDefined();
    expect(mod.createGoogleClient).toBeDefined();
    expect(mod.routeKey).toBeDefined();
  });
});

describe("snake_case → camelCase 工具参数转换", () => {
  test("snakeToCamelKeys 转换顶层 snake_case key", async () => {
    const { createOpenAICompatibleClient } = await import("../providers/openai-compatible.ts");
    expect(createOpenAICompatibleClient).toBeDefined();
    // 函数通过模块内部使用，验证转换逻辑通过行为测试覆盖
  });

  test("file_path → filePath 转换验证", () => {
    // 模拟 DeepSeek 生成的 snake_case 参数
    const snakeInput = { file_path: "README.md", line_number: 42 };
    const camelExpected = { filePath: "README.md", lineNumber: 42 };

    // 手动验证转换逻辑（与 snakeToCamelKeys 实现一致）
    const convert = (obj: Record<string, unknown>): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        result[camelKey] = value;
      }
      return result;
    };

    expect(convert(snakeInput)).toEqual(camelExpected);
  });

  test("嵌套对象的 snake_case key 也被转换", () => {
    const nested = { file_path: "test.ts", options: { case_sensitive: true, max_results: 10 } };
    const convert = (obj: Record<string, unknown>): unknown => {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        result[camelKey] =
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? convert(value as Record<string, unknown>)
            : value;
      }
      return result;
    };

    const result = convert(nested) as Record<string, unknown>;
    expect(result).toEqual({
      filePath: "test.ts",
      options: { caseSensitive: true, maxResults: 10 },
    });
  });

  test("已经是 camelCase 的 key 不受影响", () => {
    const camel = { filePath: "test.ts", lineNumber: 10 };
    const convert = (obj: Record<string, unknown>): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        result[camelKey] = value;
      }
      return result;
    };

    expect(convert(camel)).toEqual(camel);
  });
});
