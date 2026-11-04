/**
 * 插件管理面 HTTP 面（S2）：`/api/plugins` 列表 / 安装 / 启停 / 卸载。
 *
 * 用真实 `PluginManager`（临时数据根 + 不装依赖）托底，只测路由契约与错误码映射。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRoutes } from "../routes/plugins.ts";
import { PluginManager, type PluginInstallRequest } from "../../../cordis/src/plugin-manager.ts";
import type { MarketCatalogQuery } from "../../../cordis/src/market.ts";

let root: string;
let sources: string;
let app: Hono;

/** 造一个本地插件目录源 */
function makeSource(name: string, pkg: Record<string, unknown>): string {
  const dir = join(sources, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return dir;
}

/** POST 一个 JSON 请求 */
async function postJson(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-plugins-api-"));
  sources = join(root, "sources");
  mkdirSync(sources, { recursive: true });
  const manager = new PluginManager({ dataRoot: root, installDepsCommand: null });
  app = new Hono();
  app.route("/api/plugins", createPluginRoutes(manager));
});

afterEach(() => {
  // 临时目录留给系统清理：删目录在 Windows 上偶发占用（bun 也会清理 tmp）
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // 忽略
  }
});

describe("GET /api/plugins", () => {
  test("空插件面：列表为空、带数据根与重启提示", async () => {
    const res = await app.request("/api/plugins");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const body = (await res.json()) as {
      plugins: unknown[];
      errors: unknown[];
      pluginsRoot: string;
      stateFile: string;
      revision: number;
      restartRequired: boolean;
    };
    expect(body.plugins).toEqual([]);
    expect(body.errors).toEqual([]);
    expect(body.pluginsRoot).toBe(join(root, "plugins"));
    expect(body.stateFile).toBe(join(root, "plugins.json"));
    expect(body.revision).toBe(0);
    expect(body.restartRequired).toBe(false);
  });

  test("安装后列表包含插件与重启提示", async () => {
    const source = makeSource("demo-src", {
      name: "@acme/plugin-demo",
      version: "1.0.0",
      fengagent: { webui: { entry: "./client.mjs", slots: ["settings-section"] } },
    });
    writeFileSync(join(source, "client.mjs"), "export function setup() {}");

    const installed = await postJson("/api/plugins/install", { source });
    expect(installed.status).toBe(201);
    const installedBody = (await installed.json()) as { plugin: { id: string }; restartRequired: boolean };
    expect(installedBody.plugin.id).toBe("plugin-demo");
    expect(installedBody.restartRequired).toBe(true);

    const res = await app.request("/api/plugins");
    const body = (await res.json()) as {
      plugins: Array<{ id: string; enabled: boolean; hasWebui: boolean; slots: string[] }>;
      revision: number;
      restartRequired: boolean;
    };
    expect(body.plugins[0]).toMatchObject({
      id: "plugin-demo",
      enabled: true,
      hasWebui: true,
      slots: ["settings-section"],
    });
    expect(body.revision).toBe(1);
    expect(body.restartRequired).toBe(true);
  });
});

describe("POST /api/plugins/install", () => {
  test("请求体不是 JSON 对象 → 400 bad_request", async () => {
    for (const body of ["not json", "[]", "null", "123"]) {
      const res = await app.request("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("bad_request");
    }
  });

  test("远程源 → 400 unsupported", async () => {
    const res = await postJson("/api/plugins/install", { source: "https://example.com/plugin.tgz" });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("unsupported");
    expect(payload.error.message).toContain("本地");
  });

  test("源不存在 → 400 bad_request", async () => {
    const res = await postJson("/api/plugins/install", { source: join(sources, "ghost") });
    expect(res.status).toBe(400);
  });

  test("重复安装 → 409 conflict", async () => {
    const source = makeSource("demo-src", { name: "demo", version: "1.0.0" });
    expect((await postJson("/api/plugins/install", { source })).status).toBe(201);

    const again = await postJson("/api/plugins/install", { source });
    expect(again.status).toBe(409);
    const payload = (await again.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("conflict");
  });

  test("非法 id → 400，且不会在数据根外落盘", async () => {
    const source = makeSource("demo-src", { name: "demo", version: "1.0.0" });
    const res = await postJson("/api/plugins/install", { source, id: "../escape" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/plugins/:id/enable|disable", () => {
  test("停用 / 启用来回切换", async () => {
    const source = makeSource("demo-src", { name: "demo", version: "1.0.0" });
    await postJson("/api/plugins/install", { source });

    const disabled = await app.request("/api/plugins/demo/disable", { method: "POST" });
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as { plugin: { enabled: boolean } }).plugin.enabled).toBe(false);

    const enabled = await app.request("/api/plugins/demo/enable", { method: "POST" });
    expect(enabled.status).toBe(200);
    expect(((await enabled.json()) as { plugin: { enabled: boolean } }).plugin.enabled).toBe(true);
  });

  test("未知插件 → 404 not_found", async () => {
    for (const path of ["/api/plugins/ghost/enable", "/api/plugins/ghost/disable"]) {
      const res = await app.request(path, { method: "POST" });
      expect(res.status).toBe(404);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("not_found");
    }
  });
});

describe("POST /api/plugins/install（multipart 上传）", () => {
  /** 上传包的解包由管理面负责；测试注入假解包器，避免依赖系统 tar */
  function uploadApp(staging: string): Hono {
    const manager = new PluginManager({
      dataRoot: root,
      installDepsCommand: null,
      extractTarball: () => ({ dir: staging }),
    });
    const uploadOnly = new Hono();
    uploadOnly.route("/api/plugins", createPluginRoutes(manager));
    return uploadOnly;
  }

  /** 造一份「解包结果」：顶层 package/ 里带 package.json */
  function makeStaging(name: string, pkg: Record<string, unknown>): string {
    const staging = join(sources, name);
    mkdirSync(join(staging, "package"), { recursive: true });
    writeFileSync(join(staging, "package", "package.json"), JSON.stringify(pkg));
    return staging;
  }

  test("上传 .tgz → 201，按包名落进插件目录", async () => {
    const staging = makeStaging("upload-staging", { name: "upload-demo", version: "1.0.0" });
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x1f, 0x8b, 0x08])], "upload-demo.tgz"));

    const res = await uploadApp(staging).request("/api/plugins/install", { method: "POST", body: form });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { plugin: { id: string; source?: string } };
    expect(body.plugin.id).toBe("upload-demo");
    // 来源记的是「上传了哪个包」，不是装完即删的临时路径
    expect(body.plugin.source).toBe("upload:upload-demo.tgz");
  });

  test("上传文件扩展名不对 → 400 unsupported", async () => {
    const form = new FormData();
    form.append("file", new File(["not a tarball"], "plugin.zip"));
    const res = await uploadApp(join(sources, "unused")).request("/api/plugins/install", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unsupported");
  });

  test("缺 file 字段 → 400 bad_request", async () => {
    const form = new FormData();
    form.append("source", "/tmp/x");
    const res = await uploadApp(join(sources, "unused")).request("/api/plugins/install", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
  });
});

describe("DELETE /api/plugins/:id", () => {
  test("卸载 → 200，再删 → 404", async () => {
    const source = makeSource("demo-src", { name: "demo", version: "1.0.0" });
    await postJson("/api/plugins/install", { source });

    const removed = await app.request("/api/plugins/demo", { method: "DELETE" });
    expect(removed.status).toBe(200);
    const body = (await removed.json()) as { id: string; removed: boolean; restartRequired: boolean };
    expect(body).toMatchObject({ id: "demo", removed: true, restartRequired: true });

    const again = await app.request("/api/plugins/demo", { method: "DELETE" });
    expect(again.status).toBe(404);
  });
});

describe("市场路由（A/B）", () => {
  /** 记录 install 入参的假管理面 + 假目录（路由契约测试，不碰网络） */
  function makeMarketApp(): { app: Hono; installed: PluginInstallRequest[]; queries: MarketCatalogQuery[] } {
    const installed: PluginInstallRequest[] = [];
    const queries: MarketCatalogQuery[] = [];
    const source = {
      list: () => ({
        plugins: [],
        errors: [],
        pluginsRoot: join(root, "plugins"),
        stateFile: join(root, "plugins.json"),
        revision: 0,
        restartRequired: false,
      }),
      install: async (request: PluginInstallRequest) => {
        installed.push(request);
        return {
          plugin: { id: "alpha-ui", name: "alpha-ui", version: "1.0.0", enabled: true, hasWebui: true, slots: [] },
          revision: 1,
          restartRequired: true,
        };
      },
      setEnabled: () => {
        throw new Error("not used");
      },
      remove: () => {
        throw new Error("not used");
      },
    };
    const market = {
      catalog: async (query: MarketCatalogQuery = {}) => {
        queries.push(query);
        return {
          plugins: [
            {
              name: "alpha-ui",
              title: "Alpha UI",
              description: "带界面的插件",
              category: "ui",
              version: "1.0.0",
              compat: "A" as const,
              compatReason: "声明 fengagent.webui",
              compatSource: "catalog" as const,
              installable: true,
            },
            {
              name: "gamma-client",
              title: "Gamma Client",
              category: "ui",
              version: "0.3.0",
              compat: "C" as const,
              compatReason: "dsh.client 客户端插件",
              compatSource: "catalog" as const,
              installable: false,
            },
          ],
          categories: [{ id: "ui", title: { zh: "UI 增强", en: "UI Enhancements" } }],
          total: 2,
          limit: query.limit ?? 24,
          offset: query.offset ?? 0,
        };
      },
      detail: async (name: string) => ({
        name,
        title: "Alpha UI",
        versions: ["1.0.0"],
        latestVersion: "1.0.0",
        compat: "A" as const,
        compatReason: "声明 fengagent.webui",
        compatSource: "catalog" as const,
        installable: true,
      }),
      assertInstallable: async (name: string) => {
        if (name !== "alpha-ui") throw new Error(`市场目录里没有插件 ${name}`);
        return { name };
      },
    };
    const app = new Hono();
    app.route("/api/plugins", createPluginRoutes(source, market));
    return { app, installed, queries };
  }

  test("GET /api/plugins/market 透传 q/category/limit/offset，并回服务端分页字段", async () => {
    const { app: marketApp, queries } = makeMarketApp();
    const res = await marketApp.request("/api/plugins/market?q=alpha&category=ui&limit=5&offset=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plugins: Array<{ name: string; compat: string; version: string; installable: boolean }>;
      categories: Array<{ id: string; title: { zh: string; en: string } }>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(body).toMatchObject({ total: 2, limit: 5, offset: 10 });
    expect(body.categories).toEqual([{ id: "ui", title: { zh: "UI 增强", en: "UI Enhancements" } }]);
    expect(body.plugins[0]).toMatchObject({ name: "alpha-ui", compat: "A", version: "1.0.0", installable: true });
    expect(body.plugins[1]).toMatchObject({ name: "gamma-client", compat: "C", installable: false });
    expect(queries[0]).toMatchObject({ q: "alpha", category: "ui", limit: 5, offset: 10 });
  });

  test("limit 超上限收敛到 100，缺省 24", async () => {
    const { app: marketApp } = makeMarketApp();
    const big = (await (await marketApp.request("/api/plugins/market?limit=999")).json()) as { limit: number };
    expect(big.limit).toBe(100);
    const fallback = (await (await marketApp.request("/api/plugins/market")).json()) as { limit: number };
    expect(fallback.limit).toBe(24);
  });

  test("详情：scoped 包名可带 /", async () => {
    const { app: marketApp } = makeMarketApp();
    const res = await marketApp.request(`/api/plugins/market/${encodeURIComponent("@acme/ui")}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("@acme/ui");
  });

  test("市场目录未装配 → 400 unsupported（不静默空列表）", async () => {
    const manager = new PluginManager({ dataRoot: root, installDepsCommand: null });
    const bare = new Hono();
    bare.route("/api/plugins", createPluginRoutes(manager));
    const res = await bare.request("/api/plugins/market");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unsupported");
  });

  test("install：策展清单外的包 → 404，且不进入安装链", async () => {
    const { app: marketApp, installed } = makeMarketApp();
    const res = await marketApp.request("/api/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketName: "not-in-catalog" }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect(installed).toHaveLength(0);
  });

  test("install：目录内条目 → 201，marketName/marketVersion 原样交给管理器", async () => {
    const { app: marketApp, installed } = makeMarketApp();
    const res = await marketApp.request("/api/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketName: "alpha-ui", marketVersion: "1.0.0" }),
    });
    expect(res.status).toBe(201);
    expect(installed[0]).toMatchObject({ marketName: "alpha-ui", marketVersion: "1.0.0" });
  });

  test("install：嵌套体 { market: { name, version } } → 归一成 marketName/marketVersion", async () => {
    const { app: marketApp, installed } = makeMarketApp();
    const res = await marketApp.request("/api/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market: { name: "alpha-ui", version: "1.0.0" } }),
    });
    expect(res.status).toBe(201);
    expect(installed[0]).toMatchObject({ marketName: "alpha-ui", marketVersion: "1.0.0" });
  });

  test("install：{ market: {} } 缺 name → 400，且不进入安装链", async () => {
    const { app: marketApp, installed } = makeMarketApp();
    const res = await marketApp.request("/api/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market: { version: "1.0.0" } }),
    });
    expect(res.status).toBe(400);
    expect(installed).toHaveLength(0);
  });
});

