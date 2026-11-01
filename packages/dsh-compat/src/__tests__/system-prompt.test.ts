/**
 * @fengagent/dsh-compat — `ctx.systemPrompt` 兼容面验收（P3 收尾）
 *
 * 覆盖：注册/注销、order 排序、同名引用计数、槽位表、变量插值、装配与
 * `complete` 段落、变更通知——对齐 `dsh-better-edit` / `dsh-persona` 这类
 * `inject: ["systemPrompt"]` 插件的真实调用形态。
 */

import { describe, expect, test } from "bun:test";
import {
  SECTION_ORDERS,
  SystemPromptCompat,
  renderContextSnapshot,
  renderPrompt,
} from "../system-prompt.ts";

describe("systemPrompt：注册面", () => {
  test("section 按 order 升序、同序按 name 装配；空段落丢弃", async () => {
    const registry = new SystemPromptCompat();
    registry.section({ name: "later", order: 20, text: "B" });
    registry.section({ name: "empty", order: 10, text: "" });
    registry.section({ name: "first", order: 10, text: "A" });

    const assembly = await registry.assemble();
    expect(assembly.sections.map((section) => section.name)).toEqual(["first", "later"]);
    expect(renderPrompt(assembly)).toBe("A\n\nB");
  });

  test("text 支持函数形式，每次装配都求值一次", async () => {
    const registry = new SystemPromptCompat();
    let calls = 0;
    registry.section({ name: "dynamic", order: 1, text: () => `call-${++calls}` });

    expect(renderPrompt(await registry.assemble())).toBe("call-1");
    expect(renderPrompt(await registry.assemble())).toBe("call-2");
  });

  test("disposer 精确注销；同名再注册按引用计数，最后一个 disposer 才移除", async () => {
    const registry = new SystemPromptCompat();
    const disposeFirst = registry.section({ name: "shared", order: 1, text: "v1" });
    const disposeSecond = registry.section({ name: "shared", order: 1, text: "v2" });

    disposeFirst();
    // 第二个注册仍在（引用计数 1），文本是最后注册者
    expect((await registry.assemble()).sections).toHaveLength(1);
    expect(renderPrompt(await registry.assemble())).toBe("v2");

    disposeSecond();
    disposeSecond(); // 幂等
    expect((await registry.assemble()).sections).toHaveLength(0);
  });

  test("非法定义：空 name / 非有限 order 直接拒绝", () => {
    const registry = new SystemPromptCompat();
    expect(() => registry.section({ name: "", order: 1, text: "x" })).toThrow(/section.name/);
    expect(() =>
      registry.section({ name: "bad", order: Number.POSITIVE_INFINITY, text: "x" }),
    ).toThrow(/finite/);
  });

  test("getSectionOrder / getContextOrder 与上游槽位表一致，未知名字抛错", () => {
    const registry = new SystemPromptCompat();
    expect(registry.getSectionOrder("TOOL_WRITE")).toBe(SECTION_ORDERS.TOOL_WRITE);
    expect(registry.getSectionOrder("HARNESS_IDENTITY")).toBe(-1000);
    expect(registry.getContextOrder("WORKING_DIRECTORY")).toBe(100);
    expect(() => registry.getSectionOrder("NOPE" as never)).toThrow(/unknown section order/);
    expect(() => registry.getContextOrder("NOPE" as never)).toThrow(/unknown context order/);
  });
});

describe("systemPrompt：装配面", () => {
  test("complete 段落独占系统提示词（取最后一个，不把宿主打挂）", async () => {
    const registry = new SystemPromptCompat();
    registry.section({ name: "normal", order: 1, text: "ignored" });
    registry.section({ name: "complete", order: 2, text: "only-this", complete: true });

    expect(renderPrompt(await registry.assemble())).toBe("only-this");
  });

  test("{{variable}} 严格插值：未定义 / 未知都抛错，interpolate:false 原样保留", async () => {
    const registry = new SystemPromptCompat();
    registry.variable("model", () => "deepseek-v4-pro");
    registry.section({ name: "with-var", order: 1, text: "model={{model}}" });
    registry.section({ name: "literal", order: 2, text: "{{not_a_var}}", interpolate: false });

    const assembly = await registry.assemble();
    expect(renderPrompt(assembly)).toBe("model=deepseek-v4-pro\n\n{{not_a_var}}");

    registry.variable("ghost", () => undefined);
    registry.section({ name: "undefined-var", order: 3, text: "{{ghost}}" });
    const withGhost = await registry.assemble();
    expect(() => renderPrompt(withGhost)).toThrow(/undefined variable/);
  });

  test("变量名必须是 [a-z][a-z0-9_]*", () => {
    const registry = new SystemPromptCompat();
    expect(() => registry.variable("Bad-Name", () => "x")).toThrow(/invalid variable name/);
    expect(() => registry.variable("ok_name2", () => "x")).not.toThrow();
  });

  test("context / suppressRuntimeContext：可选上下文被压制，required 保留", async () => {
    const registry = new SystemPromptCompat();
    registry.context({ name: "cwd", order: 100, text: "cwd=/repo" });
    registry.context({ name: "policy", order: 110, text: "policy=strict", required: true });

    expect(renderContextSnapshot(await registry.assemble())).toBe("cwd=/repo\n\npolicy=strict");

    const restore = registry.suppressRuntimeContext();
    expect(renderContextSnapshot(await registry.assemble())).toBe("policy=strict");
    restore();
    expect(renderContextSnapshot(await registry.assemble())).toBe("cwd=/repo\n\npolicy=strict");
  });

  test("tools 提供者与变量进入装配结果；provider 抛错向上传播", async () => {
    const registry = new SystemPromptCompat();
    registry.tools(() => ({ schemas: [{ name: "tool-a" }] }));
    registry.variable("provider", () => "deepseek");

    const assembly = await registry.assemble();
    expect(assembly.tools).toEqual([{ name: "tool-a" }]);
    expect(assembly.variables.provider).toBe("deepseek");

    const dispose = registry.tools(() => {
      throw new Error("boom");
    });
    await expect(registry.assemble()).rejects.toThrow("boom");
    dispose();
    await expect(registry.assemble()).resolves.toBeDefined();
  });

  test("onChange：注册与注销都通知，监听器抛错被吞掉", async () => {
    const registry = new SystemPromptCompat();
    let changes = 0;
    registry.onChange(() => {
      changes += 1;
    });
    registry.onChange(() => {
      throw new Error("listener failure");
    });

    const dispose = registry.section({ name: "s", order: 1, text: "x" });
    dispose();
    expect(changes).toBe(2);
  });
});
