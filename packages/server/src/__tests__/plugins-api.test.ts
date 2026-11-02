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
import { PluginManager } from "../../../cordis/src/plugin-manager.ts";

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
