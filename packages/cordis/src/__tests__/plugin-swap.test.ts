/**
 * @fengagent/cordis — 插件化验收测试：换插件 = 换能力（Phase 2 覆盖验收）
 *
 * 验证 Cordis「插件即积木」：
 * 1. 工具能力由插件注入 — 装上「hello 工具插件」就有该工具，不装就没有；
 * 2. 策略可插拔 — 换上自定义回退策略，ctx.strategy.rollback 立即变成新实现；
 * 3. 服务可被后注册插件覆盖（拔下换一个）。
 */

import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@fengagent/core";
import { createRuntime } from "../runtime.ts";
import { BUILTIN_PLUGINS } from "../types.ts";

function makeRuntime(opts: { withHelloPlugin?: boolean; customRollback?: boolean }) {
  const plugins = [
    { id: BUILTIN_PLUGINS.MODEL, config: { provider: "mock", model: "mock", client: makeMockClient() } },
    { id: BUILTIN_PLUGINS.TOOLS },
    {
      id: BUILTIN_PLUGINS.STRATEGY,
      config: opts.customRollback
        ? {
            overrides: {
              rollback: {
                shouldRollback: () => true,
                chooseTarget: (node: { parentId: string | null }) => node.parentId,
              },
            },
          }
        : undefined,
    },
    { id: BUILTIN_PLUGINS.CONTEXT, config: { manager: makeMockContextManager() } },
    { id: BUILTIN_PLUGINS.STORAGE, config: { sessionStore: makeMemoryStore() } },
    { id: BUILTIN_PLUGINS.GRAPH },
  ];
  if (opts.withHelloPlugin) {
    // 用户插件：id 为模块路径（resolvePluginFactory 动态 import，相对 cordis/src 解析）
    plugins.push({ id: "./__tests__/fixtures/hello-plugin.ts", config: {} } as never);
  }
  return createRuntime({
    workdir: ".",
    plugins: plugins as never,
  });
}

function makeMockClient() {
  return {
    async *stream() {
      yield { type: "text-delta", text: "ok" };
      yield { type: "finish", reason: "end_turn" };
    },
    async generate() {
      return { id: "m", model: "mock", content: [{ type: "text", text: "ok" }], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "end_turn" };
    },
  };
}

function makeMockContextManager() {
  return {
    async assemble(session: { messages: unknown[] }) {
      return { system: "s", messages: session.messages, tokenCount: 10 };
    },
    shouldCompact: () => false,
    async compact(messages: unknown[]) {
      return { summary: "", recent: messages };
    },
    estimateTokens: (c: unknown) => (typeof c === "string" ? c.length : 10),
    invalidateSystemPrompt: () => {},
  };
}

function makeMemoryStore() {
  const map = new Map<string, unknown>();
  return {
    saveSession: (s: { id: string }) => void map.set(s.id, s),
    loadSession: (id: string) => map.get(id),
    listSessions: () => [...map.values()],
    deleteSession: (id: string) => void map.delete(id),
  };
}

describe("插件化 — 换插件即换能力", () => {
  test("不装 hello 插件 → 没有 hello-tool 工具", async () => {
    const runtime = makeRuntime({});
    await runtime.start();
    const ctx = runtime.ctx as unknown as { tools: { listNames(): string[] } };
    expect(ctx.tools.listNames()).not.toContain("hello-tool");
    await runtime.stop();
  });

  test("装上 hello 插件 → hello-tool 工具立即可用（能力随插件注入）", async () => {
    const runtime = makeRuntime({ withHelloPlugin: true });
    await runtime.start();
    const ctx = runtime.ctx as unknown as {
      tools: { listNames(): string[]; get(name: string): ToolDefinition | undefined };
    };
    expect(ctx.tools.listNames()).toContain("hello-tool");
    expect(ctx.tools.get("hello-tool")).toBeDefined();
    await runtime.stop();
  });

  test("策略可插拔 — 自定义回退策略替换默认实现", async () => {
    const runtime = makeRuntime({ customRollback: true });
    await runtime.start();
    const ctx = runtime.ctx as unknown as {
      strategy: {
        rollback: { shouldRollback(signal: { userRejected?: boolean }): boolean };
      };
    };
    // 自定义策略：任何信号都回退（shouldRollback → true）
    expect(ctx.strategy.rollback.shouldRollback({ userRejected: false })).toBe(true);
    await runtime.stop();
  });

  test("默认策略 — 无负反馈不回退", async () => {
    const runtime = makeRuntime({});
    await runtime.start();
    const ctx = runtime.ctx as unknown as {
      strategy: {
        rollback: { shouldRollback(signal: { userRejected?: boolean; toolErrorCount?: number; score?: number }): boolean };
      };
    };
    expect(ctx.strategy.rollback.shouldRollback({ userRejected: false, toolErrorCount: 0 })).toBe(false);
    expect(ctx.strategy.rollback.shouldRollback({ userRejected: true })).toBe(true);
    await runtime.stop();
  });
});
