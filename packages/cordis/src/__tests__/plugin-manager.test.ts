/**
 * 插件管理面（S2）：安装 / 启停 / 卸载 / 状态落盘。
 *
 * 全部在临时目录里跑，`installDepsCommand: null` 避免真去联网装依赖；
 * 只看「插件目录 + plugins.json」这两份事实源的最终状态。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PluginError, PluginManager, type PluginManagerOptions } from "../plugin-manager.ts";
import { PluginStore } from "../plugin-store.ts";

let root: string;
let sources: string;
let pluginsRoot: string;

/** 造一个「本地插件目录」源 */
function makeSource(name: string, pkg: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = join(sources, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  for (const [file, content] of Object.entries(files)) {
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

/** 默认不装依赖的管理器（测试不联网） */
function makeManager(options: { extractTarball?: PluginManagerOptions["extractTarball"] } = {}): PluginManager {
  return new PluginManager({
    dataRoot: root,
    installDepsCommand: null,
    ...(options.extractTarball ? { extractTarball: options.extractTarball } : {}),
  });
}

/** 断言错误码（PluginError 才带 code） */
function expectPluginError(error: unknown, code: PluginError["code"]): void {
  expect(error).toBeInstanceOf(PluginError);
  expect((error as PluginError).code).toBe(code);
}

/** 把同步抛错变成值（用来断言错误码） */
function attempt<T>(fn: () => T): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("应当抛错，但调用成功了");
}

/** 把异步抛错变成值（用来断言错误码） */
async function attemptAsync<T>(fn: () => Promise<T>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("应当抛错，但调用成功了");
}

/** 系统 tar 可用吗（沙箱里子进程可能被禁；不可用时真实解包用例跳过） */
const TAR_AVAILABLE = (() => {
  const probe = spawnSync("tar", ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
})();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-plugins-"));
  sources = join(root, "sources");
  pluginsRoot = join(root, "plugins");
  mkdirSync(sources, { recursive: true });
  mkdirSync(pluginsRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("PluginManager.install（本地目录）", () => {
  test("复制到 <dataRoot>/plugins 并登记来源，id 由包名去 scope 推导", async () => {
    const source = makeSource(
      "demo-src",
      {
        name: "@acme/plugin-demo",
        version: "1.2.3",
        description: "示例插件",
        fengagent: { webui: { entry: "./client.mjs", slots: ["nav-extension"] } },
      },
      { "client.mjs": "export function setup() {}" },
    );

    const manager = makeManager();
    const result = await manager.install({ source });

    expect(result.plugin).toMatchObject({
      id: "plugin-demo",
      name: "@acme/plugin-demo",
      version: "1.2.3",
      description: "示例插件",
      enabled: true,
      hasWebui: true,
      slots: ["nav-extension"],
      entry: "/api/webui/assets/plugin-demo/client.mjs",
      bundleUrl: "/api/webui/assets/plugin-demo/client.mjs",
      source,
    });
    expect(result.revision).toBe(1);
    expect(result.restartRequired).toBe(true);
    expect(result.warnings).toBeUndefined();

    // 文件是事实源：包体真的落在插件目录里
    expect(existsSync(join(pluginsRoot, "plugin-demo", "package.json"))).toBe(true);
    expect(readFileSync(join(pluginsRoot, "plugin-demo", "client.mjs"), "utf8")).toContain("setup");

    // 状态是旁路记录：来源/时间/包名都写进 plugins.json
    const state = JSON.parse(readFileSync(join(root, "plugins.json"), "utf8")) as {
      version: number;
      revision: number;
      plugins: Record<string, { enabled: boolean; source?: string; installedAt?: string; name?: string; version?: string }>;
    };
    expect(state.version).toBe(1);
    expect(state.revision).toBe(1);
    expect(state.plugins["plugin-demo"]).toMatchObject({
      enabled: true,
      source,
      name: "@acme/plugin-demo",
      version: "1.2.3",
    });
    expect(typeof state.plugins["plugin-demo"]?.installedAt).toBe("string");
  });

  test("显式 id 覆盖包名推导", async () => {
    const source = makeSource("demo-src", { name: "@acme/plugin-demo", version: "1.0.0" });
    const result = await makeManager().install({ source, id: "custom-id" });
    expect(result.plugin.id).toBe("custom-id");
    expect(existsSync(join(pluginsRoot, "custom-id", "package.json"))).toBe(true);
  });

  test("enable: false 装完即停用", async () => {
    const source = makeSource("demo-src", { name: "demo", version: "1.0.0" });
    const result = await makeManager().install({ source, enable: false });
    expect(result.plugin.enabled).toBe(false);
    expect(makeManager().list().plugins[0]?.enabled).toBe(false);
  });

  test("重名 → conflict，原插件不被覆盖", async () => {
    const source = makeSource("demo-src", { name: "demo", version: "1.0.0" });
    const manager = makeManager();
    await manager.install({ source });

    expectPluginError(await attemptAsync(() => manager.install({ source })), "conflict");
    // 冲突回滚不能把已装的旧插件删掉
    expect(makeManager().list().plugins).toHaveLength(1);
    expect(existsSync(join(pluginsRoot, "demo", "package.json"))).toBe(true);
  });

  test("缺 source / 源不存在 → bad_request", async () => {
    const manager = makeManager();
    expectPluginError(await attemptAsync(() => manager.install({})), "bad_request");
    expectPluginError(await attemptAsync(() => manager.install({ source: join(sources, "ghost") })), "bad_request");
  });

  test("远程 URL / git 地址 → unsupported（管理面不替用户拉公网）", async () => {
    const manager = makeManager();
    for (const source of [
      "https://example.com/plugin.tgz",
      "git+ssh://git@example.com/acme/plugin.git",
      "github:acme/plugin",
    ]) {
      expectPluginError(await attemptAsync(() => manager.install({ source })), "unsupported");
    }
  });

  test("非压缩包的普通文件 → unsupported", async () => {
    const file = join(sources, "notes.txt");
    writeFileSync(file, "not a plugin");
    expectPluginError(await attemptAsync(() => makeManager().install({ source: file })), "unsupported");
  });

  test("缺 package.json → bad_request，不留下半装目录", async () => {
    const empty = join(sources, "empty");
    mkdirSync(empty, { recursive: true });
    expectPluginError(await attemptAsync(() => makeManager().install({ source: empty })), "bad_request");
    expect(existsSync(join(pluginsRoot, "empty"))).toBe(false);
  });

  test("非法 id（路径穿越）→ bad_request，且不会写到 plugins 目录之外", async () => {
    const source = makeSource("demo-src", { name: "demo", version: "1.0.0" });
    const manager = makeManager();
    for (const id of ["..", "../escape", "a/b", "C:\\temp", "x\u0000y"]) {
      expectPluginError(await attemptAsync(() => manager.install({ source, id })), "bad_request");
    }
    expect(existsSync(join(root, "escape"))).toBe(false);
    expect(existsSync(join(pluginsRoot, "a"))).toBe(false);
  });
});

describe("PluginManager.install（.tgz）", () => {
  /** 按 npm pack 的布局造一份「解包结果」：顶层是 `package/` */
  function makeStagedPackage(
    name: string,
    pkg: Record<string, unknown>,
    files: Record<string, string> = {},
  ): { staging: string; tarball: string } {
    const staging = join(sources, `${name}-staging`);
    const pluginDir = join(staging, "package");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify(pkg, null, 2));
    for (const [file, content] of Object.entries(files)) {
      const target = join(pluginDir, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    // 只要求源是个存在的 `.tgz` 文件；解包交给注入的假解包器
    const tarball = join(sources, `${name}.tgz`);
    writeFileSync(tarball, "fake-tarball");
    return { staging, tarball };
  }

  test("解包安装（兼容 npm pack 的 package/ 外层）", async () => {
    const { staging, tarball } = makeStagedPackage(
      "tarball-demo",
      { name: "@acme/plugin-tar", version: "2.0.0", fengagent: { webui: "./client.mjs" } },
      { "client.mjs": "export function setup() {}" },
    );

    let cleaned = false;
    const manager = makeManager({
      extractTarball: () => ({ dir: staging, cleanup: () => void (cleaned = true) }),
    });
    const result = await manager.install({ source: tarball });

    expect(result.plugin).toMatchObject({
      id: "plugin-tar",
      version: "2.0.0",
      hasWebui: true,
      slots: [],
    });
    expect(existsSync(join(pluginsRoot, "plugin-tar", "client.mjs"))).toBe(true);
    // 解包临时目录一定会被清理
    expect(cleaned).toBe(true);
    // 状态里记的是源包路径（不是解包临时目录）
    const state = JSON.parse(readFileSync(join(root, "plugins.json"), "utf8")) as {
      plugins: Record<string, { source?: string }>;
    };
    expect(state.plugins["plugin-tar"]?.source).toBe(tarball);
  });

  test("解包后仍缺 package.json → bad_request，且不落盘", async () => {
    const staging = join(sources, "no-package-staging");
    mkdirSync(staging, { recursive: true });
    const tarball = join(sources, "no-package.tgz");
    writeFileSync(tarball, "fake-tarball");

    const manager = makeManager({ extractTarball: () => ({ dir: staging }) });
    expectPluginError(await attemptAsync(() => manager.install({ source: tarball })), "bad_request");
    expect(makeManager().list().plugins).toEqual([]);
  });

  test.skipIf(!TAR_AVAILABLE)("真实 tar 解包（系统 tar 可用时）", async () => {
    const staging = join(sources, "real-tar-staging");
    const pluginDir = join(staging, "package");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "real-tar", version: "3.0.0" }));
    const tarball = join(sources, "real-tar.tgz");
    // 相对路径 + cwd 建包：绝对路径带盘符冒号时 GNU tar 需要 --force-local，
    // 而 Windows 自带 bsdtar 不认这个选项——绕开冒号两种 tar 都能跑。
    const tar = spawnSync("tar", ["-czf", "real-tar.tgz", "-C", "real-tar-staging", "package"], {
      cwd: sources,
      encoding: "utf8",
    });
    expect(tar.status).toBe(0);

    const result = await makeManager().install({ source: tarball });
    expect(result.plugin).toMatchObject({ id: "real-tar", version: "3.0.0" });
  });
});

describe("PluginManager 启停 / 卸载", () => {
  async function installDemo(): Promise<string> {
    const source = makeSource("demo-src", { name: "demo", version: "1.0.0" });
    await makeManager().install({ source });
    return join(pluginsRoot, "demo");
  }

  test("停用 → plugins.json 记录 enabled=false，manifest 立即生效（重启提示为 true）", async () => {
    await installDemo();
    const manager = makeManager();

    const disabled = manager.setEnabled("demo", false);
    expect(disabled.plugin.enabled).toBe(false);
    expect(disabled.revision).toBeGreaterThan(1);
    expect(disabled.restartRequired).toBe(true);
    expect(makeManager().list().plugins[0]?.enabled).toBe(false);

    const enabled = manager.setEnabled("demo", true);
    expect(enabled.plugin.enabled).toBe(true);
    expect(makeManager().list().plugins[0]?.enabled).toBe(true);
  });

  test("未安装的插件启停 → not_found", async () => {
    const manager = makeManager();
    expectPluginError(attempt(() => manager.setEnabled("ghost", true)), "not_found");
    expectPluginError(attempt(() => manager.setEnabled("ghost", false)), "not_found");
  });

  test("非法 id 启停 → bad_request", async () => {
    expectPluginError(attempt(() => makeManager().setEnabled("../escape", true)), "bad_request");
  });

  test("卸载 → 删目录 + 清状态；同 id 可重装", async () => {
    const dir = await installDemo();
    const manager = makeManager();

    const removed = manager.remove("demo");
    expect(removed).toMatchObject({ id: "demo", removed: true });
    expect(removed.plugin?.name).toBe("demo");
    expect(existsSync(dir)).toBe(false);
    expect(manager.list().plugins).toEqual([]);

    const state = JSON.parse(readFileSync(join(root, "plugins.json"), "utf8")) as { plugins: Record<string, unknown> };
    expect(state.plugins.demo).toBeUndefined();

    // 重装不受残留状态影响
    const source = makeSource("demo-again", { name: "demo", version: "1.1.0" });
    const reinstalled = await manager.install({ source });
    expect(reinstalled.plugin.version).toBe("1.1.0");
    expect(reinstalled.plugin.enabled).toBe(true);
  });

  test("卸载未安装的插件 → not_found", async () => {
    expectPluginError(attempt(() => makeManager().remove("ghost")), "not_found");
  });

  test("重启提示以「本进程启动时的 revision」为基线，跨实例变更也能反映", async () => {
    const source = makeSource("demo-src", { name: "demo", version: "1.0.0" });
    const booted = makeManager();
    expect(booted.restartRequired()).toBe(false);

    await makeManager().install({ source });
    expect(booted.restartRequired()).toBe(true);
    expect(booted.list().restartRequired).toBe(true);
  });
});

describe("PluginManager.list", () => {
  test("坏包：列出但带 error，且 errors[] 与 webui 口径一致", async () => {
    const good = makeSource("good-src", { name: "good", version: "1.0.0" });
    const manager = makeManager();
    await manager.install({ source: good });

    // 手工放一个坏包（package.json 非法 JSON）
    const broken = join(pluginsRoot, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "package.json"), "{ not json");

    const list = manager.list();
    expect(list.plugins.map((plugin) => plugin.id)).toEqual(["broken", "good"]);
    const brokenEntry = list.plugins.find((plugin) => plugin.id === "broken");
    expect(brokenEntry?.error).toContain("package.json 解析失败");
    expect(brokenEntry?.enabled).toBe(true);
    expect(list.errors.map((error) => error.id)).toEqual(["broken"]);
    expect(list.errors[0]?.error).toBe(brokenEntry?.error);
  });

  test("手工放置的插件（无 plugins.json 记录）= 默认启用、无来源", async () => {
    const manual = join(pluginsRoot, "manual");
    mkdirSync(manual, { recursive: true });
    writeFileSync(join(manual, "package.json"), JSON.stringify({ name: "manual", version: "0.0.1" }));

    const list = makeManager().list();
    expect(list.plugins[0]).toMatchObject({ id: "manual", name: "manual", enabled: true, hasWebui: false });
    expect(list.plugins[0]?.source).toBeUndefined();
    expect(list.restartRequired).toBe(false);
    expect(list.pluginsRoot).toBe(pluginsRoot);
    expect(list.stateFile).toBe(join(root, "plugins.json"));
  });

  test("状态文件损坏 → 按空状态处理，插件仍默认启用", async () => {
    const source = makeSource("demo-src", { name: "demo", version: "1.0.0" });
    await makeManager().install({ source });
    writeFileSync(join(root, "plugins.json"), "{ broken");

    const list = makeManager().list();
    expect(list.plugins[0]?.enabled).toBe(true);
    expect(list.revision).toBe(0);
  });

  test("插件目录不存在 → 空列表（不是错误）", () => {
    rmSync(pluginsRoot, { recursive: true, force: true });
    const list = makeManager().list();
    expect(list.plugins).toEqual([]);
    expect(list.errors).toEqual([]);
  });
});

describe("PluginManager.install（市场源）", () => {
  /** 准备一个「解包后」的插件目录（市场安装只测解析/下载/校验/登记，tar 在本地源用例覆盖） */
  function marketSource(name: string, pkg: Record<string, unknown>): string {
    return makeSource(`market-${name.replace(/[@/]/g, "-")}`, pkg, { "client.mjs": "export function setup() {}" });
  }

  /** registry + tarball 的假 fetch（tarball 字节固定，integrity 用同一份算） */
  function npmFetch(
    name: string,
    version: string,
    tarball: Buffer,
    pkg: Record<string, unknown>,
  ): { fetchImpl: typeof fetch; integrity: string } {
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    const tarballUrl = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const decoded = decodeURIComponent(url);
      if (decoded === `https://registry.npmjs.org/${name}/${version}`) {
        return new Response(
          JSON.stringify({
            name,
            version,
            ...pkg,
            dist: { tarball: tarballUrl, integrity },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === tarballUrl) return new Response(new Uint8Array(tarball));
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, integrity };
  }

  test("marketName + marketVersion：校验 tarball、落 sourceLabel/protocol/resolvedVersion", async () => {
    const staging = marketSource("dsh-better-edit", {
      name: "dsh-better-edit",
      version: "1.2.0",
      dsh: { service: {} },
    });
    const tarball = Buffer.from("fake-tarball-bytes");
    const { fetchImpl, integrity } = npmFetch("dsh-better-edit", "1.2.0", tarball, { dsh: { service: {} } });
    const manager = new PluginManager({
      dataRoot: root,
      installDepsCommand: null,
      fetchImpl,
      extractTarball: () => ({ dir: staging }),
    });

    const result = await manager.install({ marketName: "dsh-better-edit", marketVersion: "1.2.0" });
    expect(result.plugin).toMatchObject({
      id: "dsh-better-edit",
      protocol: "dsh",
      sourceLabel: "market:dsh-better-edit",
    });

    const state = JSON.parse(readFileSync(join(root, "plugins.json"), "utf8")) as {
      plugins: Record<string, Record<string, unknown>>;
    };
    expect(state.plugins["dsh-better-edit"]).toMatchObject({
      enabled: true,
      source: "market:dsh-better-edit@1.2.0",
      sourceLabel: "market:dsh-better-edit",
      resolvedVersion: "1.2.0",
      protocol: "dsh",
      integrity,
    });
  });

  test("scoped 包名 → id 带 scope（不撞同名不同 scope）", async () => {
    const staging = marketSource("@acme/ui", { name: "@acme/ui", version: "0.1.0" });
    const { fetchImpl } = npmFetch("@acme/ui", "0.1.0", Buffer.from("x"), {});
    const manager = new PluginManager({
      dataRoot: root,
      installDepsCommand: null,
      fetchImpl,
      extractTarball: () => ({ dir: staging }),
    });
    const result = await manager.install({ marketName: "@acme/ui", marketVersion: "0.1.0" });
    expect(result.plugin).toMatchObject({ id: "acme-ui", protocol: "unknown" });
  });

  test("integrity 不匹配 → 整体失败且不留目录/记录", async () => {
    const staging = marketSource("tampered", { name: "tampered", version: "1.0.0" });
    const tarball = Buffer.from("good-bytes");
    const { fetchImpl } = npmFetch("tampered", "1.0.0", tarball, {});
    const manager = new PluginManager({
      dataRoot: root,
      installDepsCommand: null,
      // 下载到的字节被换掉：哈希对不上
      fetchImpl: (async (input: RequestInfo | URL) => {
        const response = await fetchImpl(input);
        if (String(input).endsWith(".tgz")) return new Response(Buffer.from("tampered-bytes"));
        return response;
      }) as unknown as typeof fetch,
      extractTarball: () => ({ dir: staging }),
    });
    const error = await attemptAsync(() => manager.install({ marketName: "tampered", marketVersion: "1.0.0" }));
    expectPluginError(error, "unsupported");
    expect(existsSync(join(pluginsRoot, "tampered"))).toBe(false);
    expect(new PluginStore(join(root, "plugins.json")).read().plugins).toEqual({});
  });

  test("不开放任意 npm spec；marketVersion 必须是确切版本", async () => {
    expectPluginError(
      await attemptAsync(() => makeManager().install({ source: "npm:left-pad@1.3.0" })),
      "unsupported",
    );
    expectPluginError(
      await attemptAsync(() => makeManager().install({ marketName: "alpha", marketVersion: "^1.0.0" })),
      "bad_request",
    );
    expectPluginError(await attemptAsync(() => makeManager().install({ marketVersion: "1.0.0" })), "bad_request");
  });
});

describe("PluginStore", () => {
  test("revision 每次写回自增，读回一致", () => {
    const store = new PluginStore(join(root, "state", "plugins.json"));
    expect(store.revision()).toBe(0);

    store.setEnabled("demo", false);
    expect(store.revision()).toBe(1);
    expect(store.isEnabled("demo")).toBe(false);

    store.setEnabled("demo", true);
    expect(store.revision()).toBe(2);
    expect(store.isEnabled("demo")).toBe(true);

    // 新实例读同一份文件
    expect(new PluginStore(store.stateFile).revision()).toBe(2);
  });

  test("forget 清记录；未知插件 isEnabled 默认 true", () => {
    const store = new PluginStore(join(root, "plugins.json"));
    store.setEnabled("demo", false);
    store.forget("demo");
    expect(store.isEnabled("demo")).toBe(true);
    expect(store.isEnabled("never-seen")).toBe(true);
  });

  test("recordProtocol 落盘但不递增 revision（启动写协议不误报需重启）", () => {
    const store = new PluginStore(join(root, "plugins.json"));
    store.recordInstall("demo", { enabled: true });
    const before = store.revision();
    store.recordProtocol("demo", "dsh");
    expect(store.revision()).toBe(before);
    expect(store.read().plugins.demo?.protocol).toBe("dsh");
    expect(store.isEnabled("demo")).toBe(true);

    // 同值重复写不产生额外写回
    store.recordProtocol("demo", "dsh");
    expect(store.revision()).toBe(before);
  });
});

describe("启动装载失败并入插件列表", () => {
  test("bootErrors 的 error 与包解析错误合并展示，不影响其它条目", () => {
    const demo = join(pluginsRoot, "demo");
    mkdirSync(demo, { recursive: true });
    writeFileSync(join(demo, "package.json"), JSON.stringify({ name: "demo", dsh: {} }));
    const healthy = join(pluginsRoot, "healthy");
    mkdirSync(healthy, { recursive: true });
    writeFileSync(join(healthy, "package.json"), JSON.stringify({ name: "healthy", dsh: {} }));

    const bootErrors = new Map([["demo", "inject 的服务未提供：missingService"]]);
    const manager = new PluginManager({
      dataRoot: root,
      installDepsCommand: null,
      bootErrors: () => bootErrors,
    });

    const list = manager.list();
    const byId = new Map(list.plugins.map((plugin) => [plugin.id, plugin]));
    expect(byId.get("demo")?.error).toContain("inject 的服务未提供");
    expect(byId.get("healthy")?.error).toBeUndefined();
    expect(list.errors.map((item) => item.id)).toEqual(["demo"]);
  });
});
