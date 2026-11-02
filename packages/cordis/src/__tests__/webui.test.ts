/**
 * WebUI 插件注册表单测（S1）— 扫描 / manifest / assets 白名单与防穿越。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebuiRegistry } from "../webui.ts";
import { PluginStore } from "../plugin-store.ts";

let root: string;
let pluginsRoot: string;

function writePlugin(
  id: string,
  pkg: Record<string, unknown>,
  files: Record<string, string> = {},
): void {
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
  root = mkdtempSync(join(tmpdir(), "feng-webui-"));
  pluginsRoot = join(root, "plugins");
  mkdirSync(pluginsRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("WebuiRegistry.list", () => {
  test("对象声明：manifest 含 id/版本/entry URL/slots", () => {
    writePlugin(
      "demo",
      {
        name: "@acme/plugin-demo",
        version: "0.1.0",
        fengagent: { webui: { entry: "./client.mjs", slots: ["settings-section"] } },
      },
      { "client.mjs": "export default 1;" },
    );

    const registry = new WebuiRegistry(pluginsRoot);
    const { plugins, errors } = registry.list();

    expect(errors).toEqual([]);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!).toEqual({
      id: "demo",
      name: "@acme/plugin-demo",
      version: "0.1.0",
      entry: "/api/webui/assets/demo/client.mjs",
      bundleUrl: "/api/webui/assets/demo/client.mjs",
      slots: ["settings-section"],
      assetsBase: "/api/webui/assets/demo",
    });
  });

  test("字符串简写 + 无 name/version 时回退", () => {
    writePlugin("plain", { fengagent: { webui: "client.js" } }, { "client.js": "export {};" });

    const { plugins } = new WebuiRegistry(pluginsRoot).list();

    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      id: "plain",
      name: "plain",
      version: "0.0.0",
      entry: "/api/webui/assets/plain/client.js",
      slots: [],
    });
  });

  test("未声明 webui 的插件不参与 UI 装载（也不算错误）", () => {
    writePlugin("tools-only", { name: "tools-only", version: "1.0.0" });

    const { plugins, errors } = new WebuiRegistry(pluginsRoot).list();

    expect(plugins).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("坏包只进 errors，不影响其它插件（失败隔离）", () => {
    writePlugin("good", { fengagent: { webui: "client.mjs" } }, { "client.mjs": "export {};" });
    const brokenDir = join(pluginsRoot, "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "package.json"), "{ not json");

    const { plugins, errors } = new WebuiRegistry(pluginsRoot).list();

    expect(plugins.map((p) => p.id)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.id).toBe("broken");
  });

  test("entry 文件缺失 → 错误条目", () => {
    writePlugin("missing-entry", { fengagent: { webui: "./client.mjs" } });

    const { plugins, errors } = new WebuiRegistry(pluginsRoot).list();

    expect(plugins).toEqual([]);
    expect(errors[0]).toMatchObject({ id: "missing-entry" });
  });

  test("entry 越界（../ 逃逸）→ 错误条目", () => {
    writePlugin("escape", { fengagent: { webui: "../outside.mjs" } });

    const { plugins, errors } = new WebuiRegistry(pluginsRoot).list();

    expect(plugins).toEqual([]);
    expect(errors[0]).toMatchObject({ id: "escape" });
  });

  test("插件目录不存在时返回空清单（不是错误）", () => {
    const registry = new WebuiRegistry(join(root, "nope"));
    expect(registry.manifest()).toEqual({ version: 1, plugins: [], errors: [] });
  });
});

describe("WebuiRegistry.resolveAsset", () => {
  beforeEach(() => {
    writePlugin(
      "demo",
      { fengagent: { webui: "./client.mjs" } },
      { "client.mjs": "export default 1;", "assets/style.css": "body{}" },
    );
    writeFileSync(join(root, "secret.txt"), "top-secret");
  });

  test("正常资源：返回绝对路径与 Content-Type", () => {
    const asset = new WebuiRegistry(pluginsRoot).resolveAsset("demo", "client.mjs");
    expect(asset).not.toBeNull();
    expect(asset!.path.endsWith(join("demo", "client.mjs"))).toBe(true);
    expect(asset!.contentType).toBe("text/javascript; charset=utf-8");

    const css = new WebuiRegistry(pluginsRoot).resolveAsset("demo", "assets/style.css");
    expect(css!.contentType).toBe("text/css; charset=utf-8");
  });

  test("目录穿越一律拒绝", () => {
    const registry = new WebuiRegistry(pluginsRoot);
    expect(registry.resolveAsset("demo", "../secret.txt")).toBeNull();
    expect(registry.resolveAsset("demo", "..%2Fsecret.txt")).toBeNull(); // %2F 不当作分隔符
    expect(registry.resolveAsset("demo", "a/../../secret.txt")).toBeNull();
    expect(registry.resolveAsset("demo", "/etc/passwd")).toBeNull();
    expect(registry.resolveAsset("demo", "C:\\Windows\\win.ini")).toBeNull();
    expect(registry.resolveAsset("demo", "a\0b")).toBeNull();
  });

  test("非法/未声明插件 id 拒绝", () => {
    const registry = new WebuiRegistry(pluginsRoot);
    expect(registry.resolveAsset("..", "client.mjs")).toBeNull();
    expect(registry.resolveAsset("../demo", "client.mjs")).toBeNull();
    expect(registry.resolveAsset("ghost", "client.mjs")).toBeNull();
  });

  test("未声明 webui 的插件不提供资源", () => {
    writePlugin("tools-only", { name: "tools-only" });
    writeFileSync(join(pluginsRoot, "tools-only", "index.js"), "export {};");
    expect(new WebuiRegistry(pluginsRoot).resolveAsset("tools-only", "index.js")).toBeNull();
  });

  test("目录不是文件 → null", () => {
    expect(new WebuiRegistry(pluginsRoot).resolveAsset("demo", "assets")).toBeNull();
  });

  test("坏包（package.json 非法）→ null，不抛错（HTTP 面不会变 500）", () => {
    const dir = join(pluginsRoot, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(new WebuiRegistry(pluginsRoot).resolveAsset("broken", "client.mjs")).toBeNull();
  });

  test("package.json 带 UTF-8 BOM 仍可解析（Windows 工具常见）", () => {
    const dir = join(pluginsRoot, "bom");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      `\uFEFF${JSON.stringify({ name: "bom", version: "1.0.0", fengagent: { webui: "./client.mjs" } })}`,
    );
    writeFileSync(join(dir, "client.mjs"), "export {};");

    const { plugins, errors } = new WebuiRegistry(pluginsRoot).list();
    expect(errors).toEqual([]);
    expect(plugins.map((plugin) => plugin.id)).toContain("bom");
  });
});

describe("WebuiRegistry + plugins.json（S2 启停）", () => {
  beforeEach(() => {
    writePlugin("demo", { fengagent: { webui: "./client.mjs" } }, { "client.mjs": "export default 1;" });
  });

  test("停用插件：manifest 不返回、assets 一律 404", () => {
    const store = new PluginStore(join(root, "plugins.json"));
    store.setEnabled("demo", false);

    const registry = new WebuiRegistry(pluginsRoot, { store });
    expect(registry.manifest().plugins).toEqual([]);
    expect(registry.resolveAsset("demo", "client.mjs")).toBeNull();
  });

  test("重新启用后立即恢复（无需重建注册表）", () => {
    const store = new PluginStore(join(root, "plugins.json"));
    store.setEnabled("demo", false);
    const registry = new WebuiRegistry(pluginsRoot, { store });

    store.setEnabled("demo", true);

    expect(registry.manifest().plugins.map((p) => p.id)).toEqual(["demo"]);
    expect(registry.resolveAsset("demo", "client.mjs")).not.toBeNull();
  });

  test("未登记状态 = 默认启用（手工放目录仍可用）", () => {
    const store = new PluginStore(join(root, "plugins.json"));
    const registry = new WebuiRegistry(pluginsRoot, { store });
    expect(registry.manifest().plugins.map((p) => p.id)).toEqual(["demo"]);
  });
});
