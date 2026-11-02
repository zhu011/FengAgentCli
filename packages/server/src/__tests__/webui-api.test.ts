/**
 * WebUI 插件 HTTP 面（S1）：`/api/webui/manifest` + `/api/webui/assets/*`。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebuiRoutes } from "../routes/webui.ts";
import { WebuiRegistry } from "../../../cordis/src/webui.ts";
import { loadWebUiPlugins, resetWebUiLoaderForTest } from "../../../web-ui/src/webui/module-loader.ts";

let root: string;
let pluginsRoot: string;
let app: Hono;

function writePlugin(id: string, pkg: Record<string, unknown>, files: Record<string, string>): void {
  const dir = join(pluginsRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-webui-api-"));
  pluginsRoot = join(root, "plugins");
  mkdirSync(pluginsRoot, { recursive: true });
  writePlugin(
    "demo",
    {
      name: "@acme/plugin-demo",
      version: "0.2.0",
      fengagent: { webui: { entry: "./client.mjs", slots: ["settings-section", "nav-extension"] } },
    },
    { "client.mjs": "export default { hello: 'world' };", "assets/logo.svg": "<svg></svg>" },
  );
  writeFileSync(join(root, "secret.txt"), "top-secret");

  const registry = new WebuiRegistry(pluginsRoot);
  app = new Hono();
  app.route("/api/webui", createWebuiRoutes(registry));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/webui/manifest", () => {
  test("返回插件清单与入口 URL", async () => {
    const res = await app.request("/api/webui/manifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as {
      version: number;
      plugins: Array<{ id: string; version: string; entry: string; slots: string[] }>;
      errors: unknown[];
    };
    expect(body.version).toBe(1);
    expect(body.errors).toEqual([]);
    expect(body.plugins).toHaveLength(1);
    expect(body.plugins[0]).toMatchObject({
      id: "demo",
      version: "0.2.0",
      entry: "/api/webui/assets/demo/client.mjs",
      // 前端 ModuleLoader 按 bundleUrl 取入口：两个字段必须同值
      bundleUrl: "/api/webui/assets/demo/client.mjs",
      slots: ["settings-section", "nav-extension"],
    });
  });

  test("manifest → ModuleLoader → slot 注册（前后端契约对齐）", async () => {
    resetWebUiLoaderForTest();
    const slots: string[] = [];
    const toasts: string[] = [];
    let importedFrom: string | undefined;

    const result = await loadWebUiPlugins({
      fetchImpl: ((url: string, init?: RequestInit) => app.request(url, init)) as unknown as typeof fetch,
      importImpl: async (url: string) => {
        importedFrom = url;
        return {
          setup: (ctx) => {
            ctx.registerSlot("nav-extension", () => null);
            ctx.toast("来自插件");
          },
        };
      },
      registerSlot: (slotId, _component, pluginId) => slots.push(`${pluginId}:${slotId}`),
      toast: (text) => toasts.push(text),
    });

    expect(result.loaded).toEqual(["demo"]);
    expect(result.failed).toEqual([]);
    expect(importedFrom).toBe("/api/webui/assets/demo/client.mjs");
    expect(slots).toEqual(["demo:nav-extension"]);
    expect(toasts).toEqual(["来自插件"]);
  });
});

describe("GET /api/webui/assets/*", () => {
  test("返回入口文件与正确 Content-Type", async () => {
    const res = await app.request("/api/webui/assets/demo/client.mjs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("hello");
  });

  test("子目录资源可读（svg）", async () => {
    const res = await app.request("/api/webui/assets/demo/assets/logo.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
  });

  test("目录穿越 / 未知插件 / 不存在的文件 → 404", async () => {
    for (const path of [
      "/api/webui/assets/demo/../secret.txt",
      "/api/webui/assets/demo/assets/../../secret.txt",
      "/api/webui/assets/ghost/client.mjs",
      "/api/webui/assets/demo/nope.mjs",
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
    }
  });

  test("穿越目标内容绝不外泄", async () => {
    const res = await app.request("/api/webui/assets/demo/..%2F..%2Fsecret.txt");
    if (res.status === 200) {
      expect(await res.text()).not.toContain("top-secret");
    } else {
      expect(res.status).toBe(404);
    }
  });
});
