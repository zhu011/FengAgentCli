/**
 * D · 启动期插件装载器：协议路由 / 顺序 / 失败隔离 / 关闸 / staging 清理。
 *
 * 全部在临时目录里跑，入口模块是真实 `.mjs` 文件（真 `import()`），
 * 只把「装载进 Cordis」这一步换成结构等价的假 ctx，避免拉起完整 runtime。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PluginStore } from "../plugin-store.ts";
import { createRuntime } from "../runtime.ts";
import { BUILTIN_PLUGINS } from "../types.ts";
import {
  isPluginBootDisabled,
  loadBootPlugins,
  PluginBootState,
  readInstalledPluginManifests,
  resolvePluginEntry,
  type PluginBootContext,
  type PluginBootLoader,
} from "../plugin-runtime.ts";
import { loadDshPlugin, type DshLoadContext } from "../../../dsh-compat/src/loader.ts";

let root: string;
let pluginsRoot: string;
let stateFile: string;

/** 造一个插件目录：package.json + 入口文件 */
function makePlugin(id: string, pkg: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = join(pluginsRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

/** 工具型插件源码（apply 里注册一个工具） */
function toolSource(tool: string): string {
  return `export function apply(ctx) { ctx.tools.register({ name: ${JSON.stringify(tool)} }); }\n`;
}

/** 结构等价的假 ctx：记录工具、执行插件的 apply/default */
function makeCtx(): PluginBootContext & { tools: string[] } {
  const tools: string[] = [];
  const ctx: PluginBootContext & { tools: string[] } = {
    tools,
    reflect: {
      get(name: string) {
        if (name !== "tools") return undefined;
        return { listNames: () => [...tools] };
      },
    },
    async plugin(plugin: unknown) {
      const record = plugin as { apply?: (c: unknown) => unknown } | ((c: unknown) => unknown);
      const apply = typeof record === "function" ? record : record.apply;
      if (typeof apply !== "function") throw new Error("not a plugin");
      await apply({
        tools: {
          register(tool: { name: string }) {
            tools.push(tool.name);
          },
        },
      });
      return { dispose: async () => {} };
    },
  };
  return ctx;
}

/** 真 `import()` 入口 + 假 ctx 的装载函数（等价于 loadDshPlugin 的导入段） */
const loadPlugin: PluginBootLoader = async (ctx, entry) => {
  const mod = (await import(entry)) as Record<string, unknown>;
  return ctx.plugin(mod.default ?? mod);
};

/** 写 plugins.json 的启用/顺序（用 recordInstall 保证顺序稳定） */
function seedState(ids: Array<{ id: string; enabled?: boolean; protocol?: string }>): PluginStore {
  const store = new PluginStore(stateFile);
  for (const item of ids) {
    store.recordInstall(item.id, {
      enabled: item.enabled !== false,
      ...(item.protocol ? { protocol: item.protocol } : {}),
    });
  }
  return store;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-plugin-boot-"));
  pluginsRoot = join(root, "plugins");
  stateFile = join(root, "plugins.json");
  mkdirSync(pluginsRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("协议路由", () => {
  test("按 plugins.json 顺序装载 dsh/cordis，跳过 webui/停用，unknown 记 error", async () => {
    // 先造目录，再写状态，保证状态里记录顺序 = b, a, ui, off, weird
    makePlugin("a", { name: "a", version: "1.0.0", dsh: {} }, { "index.mjs": toolSource("tool-a") });
    makePlugin("b", { name: "b", version: "1.0.0", main: "./lib/main.mjs" }, {
      "lib/main.mjs": `export default function (ctx) { ctx.tools.register({ name: "tool-b" }); }\n`,
    });
    makePlugin("ui", { name: "ui", version: "1.0.0", fengagent: { webui: "./client.mjs" } }, {
      "client.mjs": "export function setup() {}\n",
    });
    makePlugin("off", { name: "off", version: "1.0.0", dsh: {} }, { "index.mjs": toolSource("tool-off") });
    makePlugin("weird", { name: "weird", version: "1.0.0" });

    const store = seedState([
      { id: "b" },
      { id: "a" },
      { id: "ui" },
      { id: "off", enabled: false },
      { id: "weird" },
    ]);
    const revisionBefore = store.revision();
    const ctx = makeCtx();
    const state = new PluginBootState();

    const result = await loadBootPlugins({
      dataRoot: root,
      ctx,
      loadPlugin,
      state,
      env: {},
      onFailure: () => {}, // 本用例只断言状态，静音 stderr
    });

    expect(result.enabled).toBe(true);
    expect(result.scanned.sort()).toEqual(["a", "b", "off", "ui", "weird"]);
    // 顺序：plugins.json 的 b 在前，a 在后；未登记的 id 不会出现
    expect(result.loaded).toEqual(["b", "a"]);
    expect(ctx.tools).toEqual(["tool-b", "tool-a"]);
    expect(result.skipped.map((item) => item.id).sort()).toEqual(["off", "ui"]);
    expect(result.failed.map((item) => item.id)).toEqual(["weird"]);
    expect(result.failed[0]?.protocol).toBe("unknown");
    expect(state.errorOf("weird")).toContain("未识别插件协议");
    expect(state.isLoaded("a")).toBe(true);
    expect(state.isLoaded("weird")).toBe(false);

    // 协议落盘（webui/unknown 也记），但启动写协议不递增 revision
    expect(store.read().plugins.a?.protocol).toBe("dsh");
    expect(store.read().plugins.b?.protocol).toBe("cordis");
    expect(store.read().plugins.ui?.protocol).toBe("webui");
    expect(store.read().plugins.weird?.protocol).toBe("unknown");
    expect(store.revision()).toBe(revisionBefore);
  });

  test("exports 条件对象 / 数组 / main 入口都能解析到插件目录内的真实文件", () => {
    const pkg = { exports: { ".": { import: "./dist/index.mjs", require: "./dist/index.cjs" } } };
    const dir = makePlugin("exp", { name: "exp", ...pkg }, {
      "dist/index.mjs": "export function apply() {}\n",
      "dist/index.cjs": "module.exports = function () {}\n",
    });
    const resolved = resolvePluginEntry(dir, pkg);
    expect(resolved.entry).toBe(join(dir, "dist", "index.mjs"));

    const arrayPkg = { exports: ["./a.mjs"] };
    const arrayDir = makePlugin("arr", { name: "arr", ...arrayPkg }, { "a.mjs": "export function apply() {}\n" });
    expect(resolvePluginEntry(arrayDir, arrayPkg).entry).toBe(join(arrayDir, "a.mjs"));
  });

  test("越界入口（../outside.js）不装载并给出可读错误", async () => {
    writeFileSync(join(root, "outside.mjs"), toolSource("outside"));
    makePlugin("escape", { name: "escape", dsh: {}, main: "../outside.mjs" });
    const result = await loadBootPlugins({
      dataRoot: root,
      ctx: makeCtx(),
      loadPlugin,
      env: {},
      onFailure: () => {},
    });
    expect(result.failed[0]?.id).toBe("escape");
    expect(result.failed[0]?.error).toContain("找不到插件入口文件");
  });
});

describe("失败隔离", () => {
  test("apply 抛错的插件不阻断其它插件，错误进 state 与 /api/plugins 查询", async () => {
    makePlugin("bad", { name: "bad", dsh: {} }, {
      "index.mjs": "export function apply() { throw new Error('boom-apply'); }\n",
    });
    makePlugin("good", { name: "good", dsh: {} }, { "index.mjs": toolSource("good-tool") });

    const state = new PluginBootState();
    const ctx = makeCtx();
    const result = await loadBootPlugins({
      dataRoot: root,
      ctx,
      loadPlugin,
      state,
      env: {},
      onFailure: () => {},
    });

    expect(result.loaded).toEqual(["good"]);
    expect(ctx.tools).toEqual(["good-tool"]);
    expect(result.failed.map((item) => item.id)).toEqual(["bad"]);
    expect(state.errorOf("bad")).toContain("boom-apply");
    expect(state.errors().get("bad")).toContain("boom-apply");
  });

  test("真 loadDshPlugin 的 inject 预检：缺服务插件失败，其它插件照常装载", async () => {
    makePlugin("need-service", { name: "need-service", dsh: {} }, {
      "index.mjs": "export const inject = ['missingService'];\nexport function apply() {}\n",
    });
    makePlugin("ok", { name: "ok", dsh: {} }, { "index.mjs": toolSource("ok-tool") });

    const result = await loadBootPlugins({
      dataRoot: root,
      ctx: makeCtx(),
      loadPlugin: (ctx, entry, options) =>
        loadDshPlugin(ctx as unknown as DshLoadContext, entry, {}, { timeoutMs: options.timeoutMs }),
      env: {},
      onFailure: () => {},
    });

    expect(result.loaded).toEqual(["ok"]);
    expect(result.failed[0]?.id).toBe("need-service");
    expect(result.failed[0]?.error).toContain("missingService");
  });

  test("坏 package.json 只影响自己", async () => {
    makePlugin("broken", { name: "broken", dsh: {} }, { "index.mjs": toolSource("broken") });
    writeFileSync(join(pluginsRoot, "broken", "package.json"), "{ not json");
    makePlugin("healthy", { name: "healthy", dsh: {} }, { "index.mjs": toolSource("healthy") });

    const result = await loadBootPlugins({
      dataRoot: root,
      ctx: makeCtx(),
      loadPlugin,
      env: {},
      onFailure: () => {},
    });

    expect(result.loaded).toEqual(["healthy"]);
    expect(result.failed[0]?.id).toBe("broken");
    expect(result.failed[0]?.error).toContain("package.json 解析失败");
  });
});

describe("关闸 / 清理", () => {
  test("FENG_PLUGIN_BOOT=0 不装载（也认 false/off/no）", async () => {
    makePlugin("a", { name: "a", dsh: {} }, { "index.mjs": toolSource("a") });
    expect(isPluginBootDisabled({ FENG_PLUGIN_BOOT: "0" })).toBe(true);
    expect(isPluginBootDisabled({ FENG_PLUGIN_BOOT: "false" })).toBe(true);
    expect(isPluginBootDisabled({ FENG_PLUGIN_BOOT: "off" })).toBe(true);
    expect(isPluginBootDisabled({ FENG_PLUGIN_BOOT: "1" })).toBe(false);

    const ctx = makeCtx();
    const result = await loadBootPlugins({
      dataRoot: root,
      ctx,
      loadPlugin,
      env: { FENG_PLUGIN_BOOT: "0" },
    });
    expect(result.enabled).toBe(false);
    expect(result.loaded).toEqual([]);
    expect(ctx.tools).toEqual([]);
  });

  test("启动清理 .staging-* 残留，不碰正式插件目录", async () => {
    makePlugin("keep", { name: "keep", dsh: {} }, { "index.mjs": toolSource("keep") });
    mkdirSync(join(pluginsRoot, ".staging-dead"), { recursive: true });
    writeFileSync(join(pluginsRoot, ".staging-dead", "junk.txt"), "x");

    await loadBootPlugins({ dataRoot: root, ctx: makeCtx(), loadPlugin, env: {}, onFailure: () => {} });

    expect(existsSync(join(pluginsRoot, ".staging-dead"))).toBe(false);
    expect(existsSync(join(pluginsRoot, "keep", "package.json"))).toBe(true);
  });
});

describe("真实 runtime 接线（工具面真的长出来）", () => {
  test("runtime.ctx.tools 增量：启动装载后工具可调用，失败插件不影响宿主", async () => {
    makePlugin("real-tool", { name: "real-tool", dsh: {} }, {
      "index.mjs":
        "export const inject = ['tools'];\nexport function apply(ctx) { ctx.tools.register({ name: 'boot-tool', description: 'boot', inputSchema: { type: 'object', properties: {} } }); }\n",
    });
    makePlugin("real-bad", { name: "real-bad", dsh: {} }, {
      "index.mjs": "export function apply() { throw new Error('bad-boot'); }\n",
    });

    const runtime = createRuntime({
      workdir: root,
      plugins: [{ id: BUILTIN_PLUGINS.TOOLS }],
    });
    await runtime.start();
    try {
      const result = await loadBootPlugins({
        dataRoot: root,
        ctx: runtime.ctx as unknown as PluginBootContext,
        loadPlugin: (ctx, entry, options) =>
          loadDshPlugin(ctx as unknown as DshLoadContext, entry, {}, { timeoutMs: options.timeoutMs }),
        env: {},
        onFailure: () => {},
      });
      expect(result.failed).toEqual([{ id: "real-bad", protocol: "dsh", error: "bad-boot" }]);
      expect(result.loaded).toEqual(["real-tool"]);
      expect(runtime.ctx.tools.listNames()).toContain("boot-tool");
    } finally {
      await runtime.stop();
    }
  });
});

describe("本地已装索引（市场档位 hint）", () => {
  test("按包名与目录 id 建索引，坏包跳过", () => {
    makePlugin("better-edit", { name: "dsh-better-edit", version: "1.2.0", dsh: {} }, {
      "index.mjs": "export function apply() {}\n",
    });
    makePlugin("bad", { name: "bad" });
    writeFileSync(join(pluginsRoot, "bad", "package.json"), "{ broken");
    const index = readInstalledPluginManifests(root);
    expect(index.get("dsh-better-edit")?.version).toBe("1.2.0");
    expect(index.get("better-edit")?.name).toBe("dsh-better-edit");
    expect(index.has("bad")).toBe(false);
  });
});
