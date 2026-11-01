// fengagent-compat — 插件本体测试（stub dsh ctx，node --test）

import { test } from "node:test";
import assert from "node:assert/strict";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { apply, name, inject } from "../src/plugin.mjs";

function makeStubCtx() {
  const registered = [];
  return {
    registered,
    tools: {
      register(def) {
        registered.push(def);
        return () => registered.splice(registered.indexOf(def), 1);
      },
    },
  };
}

test("插件形状：name/inject", () => {
  assert.equal(name, "fengagent-compat");
  assert.deepEqual(inject, ["tools"]);
});

test("apply 后：feng 定义被适配注册，dsh 定义直通", async () => {
  const ctx = makeStubCtx();
  apply(ctx, {});

  const dshTool = defineTool({
    name: "native_tool",
    description: "dsh native",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
      render: () => [{ type: "text", text: "ok" }],
    },
    async execute() {
      return { ok: true };
    },
  });
  const nativeDispose = ctx.tools.register(dshTool);
  assert.equal(ctx.registered[0], dshTool); // 同一对象直通
  assert.equal(typeof nativeDispose, "function");

  ctx.tools.register({
    name: "feng_tool",
    description: "feng shaped",
    inputSchema: { parse: (x) => x },
    async execute() {
      return { content: "hi" };
    },
  });
  const adapted = ctx.registered[1];
  assert.notEqual(adapted, undefined);
  assert.equal(adapted.name, "feng_tool");
  assert.equal(typeof adapted.output.render, "function"); // dsh 形状
  assert.equal(adapted.parameters.type, "object"); // 宽松回退（parse-only schema）
  assert.equal(typeof ctx.tools.register, "function");

  // 适配后的 execute 可跑通（feng → dsh 桥）
  const value = await adapted.execute({}, {});
  assert.equal(value.content, "hi");
});

test("重复 apply 幂等（不重复打补丁）", () => {
  const ctx = makeStubCtx();
  apply(ctx, {});
  const patched = ctx.tools.register;
  apply(ctx, {});
  assert.equal(ctx.tools.register, patched);
});

test("ctx.tools 缺失时明确报错", () => {
  assert.throws(() => apply({ tools: null }, {}), /ctx\.tools/);
});

test("config.plugins 装载：补丁先于装载，feng 插件经适配注册", async () => {
  const registered = [];
  const tools = {
    register(def) {
      registered.push(def);
      return () => {};
    },
  };
  const childCtxs = [];
  const ctx = {
    tools,
    effect(fn) {
      fn();
      return () => {};
    },
    async plugin(p, c) {
      const child = { tools };
      childCtxs.push(child);
      await p.apply(child, c);
    },
  };
  apply(ctx, {
    plugins: ["../test/fixture-feng-plugin/plugin.mjs"],
    configs: { "../test/fixture-feng-plugin/plugin.mjs": {} },
  });
  // 等装载完成（effect 内 async）
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(childCtxs.length, 1);
  const adapted = registered.find((d) => d.name === "hello_feng");
  assert.ok(adapted, "hello_feng 已注册");
  assert.equal(typeof adapted.output.render, "function"); // dsh 形状
  const value = await adapted.execute({ name: "e2e" }, {});
  assert.equal(value.content, "hello from feng tool: e2e");
});
