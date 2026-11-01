/**
 * @fengagent/dsh-compat — 适配器单元测试
 *
 * 用**真实的** `defineTool`（@deepseek-ai/dsh-tools）构造 dsh 工具定义，
 * 验证适配后的 schema 直通、校验、执行、渲染与取消语义。
 */

import { describe, expect, test } from "bun:test";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolContext } from "@fengagent/core";
import { adaptDshTool, isDshToolDefinition } from "../adapter.ts";

function fakeToolContext(): ToolContext {
  return { workdir: ".", sessionId: "s", messageId: "m" };
}

const greetTool = defineTool({
  name: "demo_greet",
  description: "Greet someone (dsh demo plugin, tools-only)",
  parameters: {
    who: { type: "string", required: true, description: "Who to greet" },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        ok: { type: "boolean", required: true },
        id: { type: "string", required: true },
      },
    },
    render: (_args, value) => [{ type: "text", text: `${value.greeting}: ${value.who}` }],
  },
  async execute(args) {
    return { ok: true, id: `greet-${args.who}`, greeting: "hello", who: args.who };
  },
});

describe("isDshToolDefinition", () => {
  test("defineTool 产物可识别", () => {
    expect(isDshToolDefinition(greetTool)).toBe(true);
  });

  test("FengAgentCli 原生定义不被误判", () => {
    const native = {
      name: "native_tool",
      description: "d",
      inputSchema: { parse: (x: unknown) => x },
      execute: async () => ({ content: "" }),
    };
    expect(isDshToolDefinition(native)).toBe(false);
  });

  test("未编译的 author-form（裸 property map）被拒绝", () => {
    const authorForm = {
      name: "x",
      description: "d",
      parameters: { who: { type: "string", required: true } },
      output: { schema: {}, render: () => [] },
      execute: async () => ({}),
    };
    expect(isDshToolDefinition(authorForm)).toBe(false);
  });
});

describe("adaptDshTool", () => {
  test("schema 直通：toJSONSchema 返回 dsh 编译参数", () => {
    const tool = adaptDshTool(greetTool);
    const duck = tool.inputSchema as unknown as {
      toJSONSchema: () => Record<string, unknown>;
    };
    const json = duck.toJSONSchema();
    expect(json["type"]).toBe("object");
    expect(json["properties"]).toHaveProperty("who");
    expect((json["required"] as string[]).includes("who")).toBe(true);
  });

  test("parse 直通（dsh 工具的 execute 自带参数校验）", () => {
    const tool = adaptDshTool(greetTool);
    const duck = tool.inputSchema as unknown as { parse: (x: unknown) => unknown };
    expect(duck.parse({ who: "a" })).toEqual({ who: "a" });
  });

  test("execute：content 走 dsh render，metadata 保留原值", async () => {
    const tool = adaptDshTool(greetTool);
    const result = await tool.execute({ who: "kg" }, fakeToolContext());
    expect(result.content).toBe("hello: kg");
    expect((result.metadata as { ok: boolean }).ok).toBe(true);
    expect(tool.renderResult?.(result)).toBe("hello: kg");
  });

  test("dsh 参数校验错误透传（缺必填 who）", async () => {
    const tool = adaptDshTool(greetTool);
    await expect(tool.execute({}, fakeToolContext())).rejects.toThrow();
  });

  test("timeoutMs：执行超时经 signal 取消", async () => {
    const slowTool = defineTool({
      name: "demo_slow",
      description: "Never finishes on its own",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: { ok: { type: "boolean", required: true } },
        },
        render: () => [{ type: "text", text: "never" }],
      },
      timeoutMs: 50,
      async execute(_args, exec) {
        return await new Promise((_resolve, reject) => {
          exec.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });
    const tool = adaptDshTool(slowTool);
    await expect(tool.execute({}, fakeToolContext())).rejects.toThrow("aborted");
  });

  test("isConcurrencySafe 透传", () => {
    const pickyTool = defineTool({
      name: "demo_picky",
      description: "Concurrency-safe when idle",
      parameters: {
        mode: { type: "string", required: true, enum: ["idle", "busy"] },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: { ok: { type: "boolean", required: true } },
        },
        render: () => [{ type: "text", text: "ok" }],
      },
      isConcurrencySafe: (args) => args.mode === "idle",
      async execute() {
        return { ok: true };
      },
    });
    const tool = adaptDshTool(pickyTool);
    expect(tool.isConcurrencySafe?.({ mode: "idle" })).toBe(true);
    expect(tool.isConcurrencySafe?.({ mode: "busy" })).toBe(false);
  });

  test("render 回退：render 抛错时用 JSON 摘要", async () => {
    const brokenRender = defineTool({
      name: "demo_broken_render",
      description: "Render throws",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: { ok: { type: "boolean", required: true } },
        },
        render: () => {
          throw new Error("bad render");
        },
      },
      async execute() {
        return { ok: true, note: "still fine" };
      },
    });
    const tool = adaptDshTool(brokenRender);
    const result = await tool.execute({}, fakeToolContext());
    expect(result.content).toContain('"ok":true');
    expect(result.content).toContain("still fine");
  });
});
