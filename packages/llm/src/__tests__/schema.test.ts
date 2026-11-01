/**
 * @fengagent/llm — 工具入参 schema 转换测试
 *
 * 回归目标：zod v3 实例没有 `toJSONSchema()`，旧实现只调该方法，导致所有原生工具的
 * `parameters` 恒为空 schema（模型看不到任何参数）。这里同时覆盖共享转换层与
 * provider 真实请求体。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { createUserMessage } from "@fengagent/core";
import type { ToolDefinition } from "@fengagent/core";
import {
  PERMISSIVE_TOOL_SCHEMA,
  toAnthropicInputSchema,
  toOpenAIToolParameters,
  zodToJsonSchemaCompat,
} from "../providers/schema.ts";
import { createOpenAICompatibleClient } from "../providers/openai-compatible.ts";
import type { LLMEvent } from "../types.ts";

const fileToolSchema = z.object({
  path: z.string().describe("要读取的文件路径"),
  mode: z.enum(["read", "write"]).optional(),
  limit: z.number().int().positive().optional(),
});

describe("zod v3 → JSON Schema", () => {
  test("回归：zod v3 schema 产出真实 properties（而不是空 schema）", () => {
    const json = zodToJsonSchemaCompat(fileToolSchema);

    expect(json["type"]).toBe("object");
    const properties = json["properties"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(["path", "mode", "limit"]);
    expect(properties["path"]?.["description"]).toBe("要读取的文件路径");
    expect(properties["mode"]?.["enum"]).toEqual(["read", "write"]);
    // 必填只含非 optional 字段
    expect(json["required"]).toEqual(["path"]);
    // draft 元数据对模型调用无意义，统一剥掉
    expect(json["$schema"]).toBeUndefined();
  });

  test("嵌套对象的 required 保留", () => {
    const json = zodToJsonSchemaCompat(
      z.object({ nested: z.object({ x: z.number(), y: z.boolean().optional() }) }),
    );
    const nested = (json["properties"] as Record<string, Record<string, unknown>>)["nested"];
    expect(nested?.["type"]).toBe("object");
    expect(nested?.["required"]).toEqual(["x"]);
  });

  test("优先使用实例自带的 toJSONSchema()（zod v4 / dsh 直通 schema）", () => {
    const duck = {
      _def: {},
      toJSONSchema: () => ({
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      }),
    };
    const json = zodToJsonSchemaCompat(duck);
    expect(json["properties"]).toEqual({ q: { type: "string" } });
    expect(json["required"]).toEqual(["q"]);
  });

  test("已是 JSON Schema 对象时规范化直通", () => {
    const raw = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    const json = zodToJsonSchemaCompat(raw);
    expect(json["$schema"]).toBeUndefined();
    expect(json["required"]).toEqual(["id"]);
  });

  test("无法识别时退化为宽松 schema，而不是伪装成无参数", () => {
    for (const bad of [null, undefined, 42, "nope", {}, { foo: "bar" }]) {
      const json = zodToJsonSchemaCompat(bad);
      expect(json["type"]).toBe("object");
      expect(json["additionalProperties"]).toBe(true);
      expect(json).not.toBe(PERMISSIVE_TOOL_SCHEMA as unknown as Record<string, unknown>);
    }
  });

  test("OpenAI parameters 根必须是 object", () => {
    expect(toOpenAIToolParameters(fileToolSchema)["type"]).toBe("object");
    expect(toOpenAIToolParameters(z.string())["type"]).toBe("object");
    expect(toOpenAIToolParameters(z.string())["additionalProperties"]).toBe(true);
  });

  test("Anthropic input_schema 保留 required（旧实现丢掉了）", () => {
    const input = toAnthropicInputSchema(fileToolSchema);
    expect(input["type"]).toBe("object");
    expect(input["required"]).toEqual(["path"]);
    expect((input["properties"] as Record<string, unknown>)["path"]).toBeDefined();
  });
});

describe("provider 请求体中的工具参数", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("openai-compatible：请求体带上真实 JSON Schema", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const tool: ToolDefinition = {
      name: "read_file",
      description: "读取文件",
      inputSchema: fileToolSchema,
      execute: async () => ({ content: "ok" }),
    };

    const client = createOpenAICompatibleClient({
      apiKey: "test-key",
      baseURL: "https://example.invalid",
    });

    const events: LLMEvent[] = [];
    for await (const event of client.stream({
      model: "test-model",
      system: "",
      messages: [createUserMessage("hi")],
      tools: [tool],
    })) {
      events.push(event);
    }

    const tools = body?.["tools"] as Array<Record<string, Record<string, unknown>>>;
    const parameters = tools[0]?.["function"]?.["parameters"] as Record<string, unknown>;
    expect(Object.keys(parameters["properties"] as object)).toEqual(["path", "mode", "limit"]);
    expect(parameters["required"]).toEqual(["path"]);
  });
});
