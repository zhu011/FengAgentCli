/**
 * @fengagent/web-ui — WebUI 插件装载器测试（S1）
 *
 * 注入 fetch/importImpl 隔离测：装载协议（setup 调用与 ctx 面）、失败隔离
 * （单插件挂不影响其他）、幂等守卫、manifest 不可达静默降级。
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { loadWebUiPlugins, resetWebUiLoaderForTest } from "../module-loader.ts";

beforeEach(() => {
  resetWebUiLoaderForTest();
});

function makeHarness() {
  const registered: Array<{ slotId: string; pluginId: string }> = [];
  const toasts: Array<{ text: string; kind: string }> = [];
  return {
    registered,
    toasts,
    registerSlot: (slotId: string, component: unknown, pluginId: string) => {
      registered.push({ slotId, pluginId });
    },
    toast: (text: string, kind: "info" | "error" = "info") => {
      toasts.push({ text, kind });
    },
  };
}

function manifestFetch(plugins: unknown[]) {
  return (async () =>
    new Response(JSON.stringify({ plugins }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("loadWebUiPlugins", () => {
  test("装载协议：setup 收到完整 ctx，registerSlot/toast 转发宿主", async () => {
    const h = makeHarness();
    const result = await loadWebUiPlugins({
      fetchImpl: manifestFetch([{ id: "p1", name: "P1", version: "1.0", bundleUrl: "http://x/1.mjs" }]),
      importImpl: async () => ({
        setup: (ctx) => {
          ctx.registerSlot("conversation-side-panel", function Panel() {});
          ctx.toast("hello", "info");
          // api/plugin 面存在性
          if (typeof ctx.api !== "function" || ctx.plugin.id !== "p1") throw new Error("ctx 面不完整");
        },
      }),
      registerSlot: h.registerSlot,
      toast: h.toast,
    });
    expect(result.loaded).toEqual(["p1"]);
    expect(result.failed).toEqual([]);
    expect(result.unavailable).toBe(false);
    expect(h.registered).toEqual([{ slotId: "conversation-side-panel", pluginId: "p1" }]);
    expect(h.toasts).toEqual([{ text: "hello", kind: "info" }]);
  });

  test("失败隔离：坏插件（无 setup / import 抛错）不影响其他插件", async () => {
    const h = makeHarness();
    const result = await loadWebUiPlugins({
      fetchImpl: manifestFetch([
        { id: "bad", name: "B", version: "1", bundleUrl: "http://x/b.mjs" },
        { id: "good", name: "G", version: "1", bundleUrl: "http://x/g.mjs" },
      ]),
      importImpl: async (url) => {
        if (url.endsWith("b.mjs")) throw new Error("network down");
        return { setup: (ctx) => void ctx.registerSlot("nav-extension", function N() {}) };
      },
      registerSlot: h.registerSlot,
      toast: h.toast,
    });
    expect(result.loaded).toEqual(["good"]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]!.id).toBe("bad");
    expect(result.failed[0]!.reason).toContain("network down");
    expect(h.registered.length).toBe(1);
  });

  test("default 导出形态（对象带 setup / 函数直挂）都认", async () => {
    const h = makeHarness();
    const result = await loadWebUiPlugins({
      fetchImpl: manifestFetch([
        { id: "obj", name: "O", version: "1", bundleUrl: "http://x/o.mjs" },
        { id: "fn", name: "F", version: "1", bundleUrl: "http://x/f.mjs" },
      ]),
      importImpl: async (url) => {
        if (url.endsWith("o.mjs")) return { default: { setup: (ctx) => void ctx.registerSlot("team-detail-panel", function A() {}) } };
        return { default: (ctx) => void ctx.registerSlot("settings-section", function B() {}) };
      },
      registerSlot: h.registerSlot,
      toast: h.toast,
    });
    expect(result.loaded).toEqual(["obj", "fn"]);
    expect(h.registered.map((x) => x.pluginId)).toEqual(["obj", "fn"]);
  });

  test("幂等：同 id 二次装载跳过", async () => {
    const h = makeHarness();
    const opts = {
      fetchImpl: manifestFetch([{ id: "once", name: "O", version: "1", bundleUrl: "http://x/1.mjs" }]),
      importImpl: async () => ({ setup: (ctx) => void ctx.registerSlot("nav-extension", function N() {}) }),
      registerSlot: h.registerSlot,
      toast: h.toast,
    } as const;
    await loadWebUiPlugins(opts);
    const again = await loadWebUiPlugins(opts);
    expect(again.loaded).toEqual([]); // 已装，跳过
    expect(h.registered.length).toBe(1);
  });

  test("manifest 不可达（404 / 网络错）→ 静默降级 unavailable，不抛", async () => {
    const h = makeHarness();
    const r404 = await loadWebUiPlugins({
      fetchImpl: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
      registerSlot: h.registerSlot,
      toast: h.toast,
    });
    expect(r404.unavailable).toBe(true);
    expect(r404.loaded).toEqual([]);

    const rErr = await loadWebUiPlugins({
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
      registerSlot: h.registerSlot,
      toast: h.toast,
    });
    expect(rErr.unavailable).toBe(true);
  });
});
