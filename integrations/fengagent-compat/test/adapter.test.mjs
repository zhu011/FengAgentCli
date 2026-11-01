// fengagent-compat — 适配器单元测试（node --test）
// 用真实 zod v3（feng 同款）与真实 dsh-tools 的校验面做断言。

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineTool, assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import { adaptFengTool, isFengToolDefinition } from "../src/adapter.mjs";

/** feng 形状的工具（真 zod v3 schema） */
const zodFengTool = {
  name: "demo_zod",
  description: "feng tool with real zod v3 schema",
  inputSchema: z.object({
    who: z.string().describe("who to greet"),
    times: z.number().optional(),
  }),
  async execute(input) {
    return { content: `hi ${input.who}` };
  },
};

/** feng 形状的工具（鸭子 schema：自带 toJSONSchema + parse） */
const duckFengTool = {
  name: "demo_duck",
  description: "feng tool with duck schema",
  inputSchema: {
    toJSONSchema: () => ({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }),
    parse: (x) => x,
  },
  async execute() {
    return { content: "ok" };
  },
};

test("isFengToolDefinition：feng 形状识别、dsh defineTool 产物不误判", () => {
  assert.equal(isFengToolDefinition(zodFengTool), true);
  assert.equal(isFengToolDefinition(duckFengTool), true);

  const dshTool = defineTool({
    name: "demo_dsh",
    description: "dsh native",
    parameters: { a: { type: "string", required: true } },
    output: {
      schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
      render: () => [{ type: "text", text: "ok" }],
    },
    async execute() {
      return { ok: true };
    },
  });
  assert.equal(isFengToolDefinition(dshTool), false);
  assert.equal(isFengToolDefinition(null), false);
  assert.equal(isFengToolDefinition({ name: "x" }), false);
});

test("真 zod v3 schema → dsh parameters（zod-to-json-schema 转换，去 $schema、显式 additionalProperties）", () => {
  const adapted = adaptFengTool(zodFengTool);
  const params = adapted.parameters;
  assert.equal(params.type, "object");
  assert.equal(params.properties.who.type, "string");
  assert.equal(params.properties.who.description, "who to greet");
  assert.deepEqual(params.required, ["who"]);
  assert.equal(params.properties.times.type, "number");
  assert.equal(params.additionalProperties, false);
  assert.equal("$schema" in params, false);
});

test("鸭子 toJSONSchema schema → 直通规整", () => {
  const adapted = adaptFengTool(duckFengTool);
  assert.equal(adapted.parameters.properties.a.type, "string");
  assert.deepEqual(adapted.parameters.required, ["a"]);
});

test("无 schema 形状（仅 parse）→ 宽松回退（与 feng providers 现状同底）", () => {
  const adapted = adaptFengTool({
    name: "demo_loose",
    description: "x",
    inputSchema: { parse: (x) => x },
    async execute() {
      return { content: "ok" };
    },
  });
  assert.equal(adapted.parameters.type, "object");
  assert.deepEqual(adapted.parameters.properties, {});
  assert.equal(adapted.parameters.additionalProperties, true);
});

test("output.schema 通过 dsh 真实校验 assertSupportedJsonSchema", () => {
  for (const tool of [zodFengTool, duckFengTool]) {
    const adapted = adaptFengTool(tool);
    assert.doesNotThrow(() => assertSupportedJsonSchema(adapted.output.schema));
  }
});

test("execute 桥接：ToolResult → dsh value；render 展示 content；isError 前缀", async () => {
  const adapted = adaptFengTool({
    name: "demo_exec",
    description: "x",
    inputSchema: z.object({ who: z.string() }),
    async execute(input) {
      return { content: `hi ${input.who}`, metadata: { n: 1 } };
    },
  });
  const value = await adapted.execute({ who: "kg" }, {});
  assert.equal(value.content, "hi kg");
  assert.deepEqual(value.metadata, { n: 1 });
  const blocks = adapted.output.render({}, value);
  assert.equal(blocks[0].type, "text");
  assert.equal(blocks[0].text, "hi kg");

  const errValue = await adaptFengTool({
    name: "demo_err",
    description: "x",
    inputSchema: { parse: (x) => x },
    async execute() {
      return { content: "boom", isError: true };
    },
  }).execute({}, {});
  assert.equal(adapted.output.render({}, errValue)[0].text, "⚠ boom");
});

test("zod 校验失败 → execute 拒绝（与 feng executor 同语义）", async () => {
  const adapted = adaptFengTool(zodFengTool);
  await assert.rejects(() => adapted.execute({ who: 123 }, {}));
});

test("timeoutMs / isConcurrencySafe 透传", async () => {
  const adapted = adaptFengTool({
    name: "demo_opts",
    description: "x",
    inputSchema: { parse: (x) => x },
    timeoutMs: 5000,
    isConcurrencySafe: (input) => input?.mode === "idle",
    async execute() {
      return { content: "ok" };
    },
  });
  assert.equal(adapted.timeoutMs, 5000);
  assert.equal(adapted.isConcurrencySafe({ mode: "idle" }), true);
  assert.equal(adapted.isConcurrencySafe({ mode: "busy" }), false);

  const plain = adaptFengTool(duckFengTool);
  assert.equal("timeoutMs" in plain, false);
  assert.equal("isConcurrencySafe" in plain, false);
});
