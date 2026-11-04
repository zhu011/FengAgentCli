/**
 * @fengagent/cordis — 启动期插件装载器（D / P2）
 *
 * 把「装上即用」补成闭环：宿主启动时真正扫描 `<dataRoot>/plugins/<id>`，
 * 按包内 `package.json` 判定协议并装载 host 侧插件，而不是只落文件等提示重启。
 *
 * 边界（与 S1/S2 的插件目录口径一致）：
 * - 只认一层目录 + `isSafePluginId`，所有路径都落在 `pluginsRoot` 之内；
 * - `fengagent.webui` 插件交给 WebUI manifest（刷新即生效），启动装载器跳过；
 * - `dsh` / `cordis` 形状统一走调用方注入的 `loadPlugin`（server 侧接
 *   `loadDshPlugin` 的三道硬门），模块必须从**插件自身目录的入口文件**导入；
 * - 单插件失败只记 `error`，不阻断宿主启动；`FENG_PLUGIN_BOOT=0` 一键关闸；
 * - 装载顺序按 `plugins.json` 记录顺序稳定排序，未登记的插件排在后面按 id 排序；
 * - 启动时清掉上次进程残留的 `.staging-*`。
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { detectProtocol, type PluginProtocol } from "./plugin-manager.ts";
import { PluginStore } from "./plugin-store.ts";
import { isInside, isSafePluginId, readPluginPackageJson } from "./webui.ts";

/** 装载器需要的上下文面（结构类型，避免把 cordis Context 绑死在这里） */
export interface PluginBootContext {
  plugin: (plugin: unknown, config?: unknown) => unknown;
  reflect?: { get(name: string, strict?: boolean): unknown };
}

/** 实际装载一个入口（server 注入 `loadDshPlugin`；测试可注入假实现） */
export type PluginBootLoader = (
  ctx: PluginBootContext,
  entry: string,
  options: { timeoutMs: number },
) => Promise<unknown>;

/** 单个插件装载失败 */
export interface BootPluginFailure {
  id: string;
  /** package.json 探测出的协议（坏包/未识别时为 unknown） */
  protocol: PluginProtocol;
  error: string;
}

/** 装载结果（诊断 / 测试用） */
export interface BootPluginResult {
  /** `FENG_PLUGIN_BOOT=0` 时为 false（其余字段为空） */
  enabled: boolean;
  /** 扫描到的候选插件 id（未过滤启用状态） */
  scanned: string[];
  /** 成功装载的插件 id（按装载顺序） */
  loaded: string[];
  /** 有意跳过的插件（webui / 停用） */
  skipped: Array<{ id: string; reason: string }>;
  /** 失败插件（宿主继续启动） */
  failed: BootPluginFailure[];
}

/** 启动装载选项 */
export interface LoadBootPluginsOptions {
  /** 数据根（插件目录与状态文件的默认位置） */
  dataRoot: string;
  /** Cordis 根上下文（`runtime.ctx`） */
  ctx: PluginBootContext;
  /** 入口装载函数（server 侧传 `loadDshPlugin`） */
  loadPlugin: PluginBootLoader;
  /** 覆盖插件目录（默认 `<dataRoot>/plugins`） */
  pluginsRoot?: string;
  /** 覆盖状态文件（默认 `<dataRoot>/plugins.json`） */
  stateFile?: string;
  /** 状态存储覆盖（测试用；默认按 dataRoot 新建） */
  store?: PluginStore;
  /** 装载失败集合（与 `/api/plugins` 共享；默认内部新建） */
  state?: PluginBootState;
  /** 环境变量（默认 `process.env`；`FENG_PLUGIN_BOOT=0` 关闸） */
  env?: Record<string, string | undefined>;
  /** 单插件装载超时（毫秒，默认 15000；0 = 不限） */
  timeoutMs?: number;
  /** 是否把探测出的 protocol 写回 plugins.json（默认 true） */
  persistProtocol?: boolean;
  /** 失败告警（默认写 stderr） */
  onFailure?: (failure: BootPluginFailure) => void;
}

/**
 * 进程内启动装载状态 — `PluginManager.list()` 读它把装载失败合并进条目的 `error`。
 *
 * 只存「启动装载」这一层的失败：安装/包解析错误仍由 manager 自己算，两边合并展示。
 */
export class PluginBootState {
  private readonly failures = new Map<string, string>();
  private readonly loadedIds = new Set<string>();

  /** 记录一次失败（同一 id 后一次覆盖前一次） */
  setFailure(id: string, error: string): void {
    this.failures.set(id, error);
    this.loadedIds.delete(id);
  }

  /** 记录一次成功（清掉同 id 的历史失败） */
  setLoaded(id: string): void {
    this.failures.delete(id);
    this.loadedIds.add(id);
  }

  /** 清空单条状态（卸载/重装时可用） */
  clear(id: string): void {
    this.failures.delete(id);
    this.loadedIds.delete(id);
  }

  /** 单条失败原因（无失败返回 undefined） */
  errorOf(id: string): string | undefined {
    return this.failures.get(id);
  }

  /** 全部失败原因（只读快照，供 PluginManager 查询） */
  errors(): ReadonlyMap<string, string> {
    return new Map(this.failures);
  }

  /** 本次启动成功装载的 id */
  loaded(): string[] {
    return [...this.loadedIds];
  }

  /** 是否已成功装载 */
  isLoaded(id: string): boolean {
    return this.loadedIds.has(id);
  }
}

/** 关闸判定：`FENG_PLUGIN_BOOT=0`（也接受 false/off/no，大小写不敏感） */
export function isPluginBootDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.FENG_PLUGIN_BOOT?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off" || raw === "no";
}

/** 取第一个字符串（exports 条件对象用） */
function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // 条件顺序：ESM 优先；require 放最后（Bun 能 import CJS，但优先原生 ESM）
    for (const key of ["import", "module", "node", "default", "require"]) {
      if (!(key in record)) continue;
      const found = firstString(record[key]);
      if (found) return found;
    }
  }
  return undefined;
}

/** 从 package.json `exports` 取根入口（只认 `"."` 或字符串/条件对象） */
export function entryFromExports(exportsField: unknown): string | undefined {
  if (typeof exportsField === "string") return exportsField.trim() || undefined;
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return firstString(exportsField);
  }
  const record = exportsField as Record<string, unknown>;
  if ("." in record) return firstString(record["."]);
  const keys = Object.keys(record);
  // 全是子路径（`./client`）时没有根入口；否则按条件对象处理
  if (keys.length > 0 && keys.every((key) => key.startsWith("."))) return undefined;
  return firstString(record);
}

/** 把一个候选入口解析成插件目录内的真实文件；不存在/越界返回 undefined */
function resolveEntryFile(pluginDir: string, raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const candidate = raw.replace(/\\/g, "/");
  if (candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)) return undefined;
  const base = resolve(pluginDir, candidate);
  if (!isInside(pluginDir, base)) return undefined;

  const attempts = [base];
  if (!/\.[A-Za-z0-9]+$/.test(base)) {
    attempts.push(`${base}.js`, `${base}.mjs`, `${base}.cjs`);
  }
  for (const attempt of attempts) {
    try {
      if (!existsSync(attempt)) continue;
      const stat = statSync(attempt);
      if (stat.isFile()) return attempt;
      if (stat.isDirectory()) {
        for (const index of ["index.js", "index.mjs", "index.cjs"]) {
          const nested = join(attempt, index);
          if (existsSync(nested) && statSync(nested).isFile()) return nested;
        }
      }
    } catch {
      // 读不到就试下一个候选
    }
  }
  return undefined;
}

/**
 * 解析插件入口文件的绝对路径。
 *
 * 优先级：`exports["."]` → `module` → `main` → `index.js/mjs/cjs`。
 * 只返回插件目录内的真实文件；解析不到返回 undefined。
 */
export function resolvePluginEntry(
  pluginDir: string,
  pkg: Record<string, unknown>,
): { entry?: string; error?: string } {
  const declared =
    entryFromExports(pkg.exports) ??
    (typeof pkg.module === "string" ? pkg.module : undefined) ??
    (typeof pkg.main === "string" ? pkg.main : undefined);

  const fromDeclared = resolveEntryFile(pluginDir, declared);
  if (fromDeclared) return { entry: fromDeclared };

  for (const index of ["index.js", "index.mjs", "index.cjs"]) {
    const fallback = resolveEntryFile(pluginDir, index);
    if (fallback) return { entry: fallback };
  }

  const detail = declared ? `（package.json 指向 ${declared}，但文件不存在或越界）` : "";
  return {
    error: `找不到插件入口文件${detail}：需要 main/exports 指向插件目录内的 .js/.mjs/.cjs，或提供 index.js`,
  };
}

/** 删掉上次进程残留的 staging 目录（只碰 `.staging-` 前缀） */
function cleanupStaging(pluginsRoot: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".staging-"))
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      rmSync(join(pluginsRoot, name), { recursive: true, force: true });
    } catch {
      // 被占用就留给下次；不影响本次装载
    }
  }
}

/** 扫描插件目录（一层目录 + 安全 id，点开头不算） */
function scanPluginIds(pluginsRoot: string): string[] {
  try {
    return readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .filter((id) => isSafePluginId(id))
      .sort();
  } catch {
    return [];
  }
}

/** 按 plugins.json 记录顺序排，未登记的后排按 id */
function orderByState(ids: string[], recorded: string[]): string[] {
  const present = new Set(ids);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of recorded) {
    if (!present.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  for (const id of [...ids].sort()) {
    if (seen.has(id)) continue;
    ordered.push(id);
  }
  return ordered;
}

/** 读 package.json（坏包不抛，交给调用方记 error） */
function readPackageJson(pluginDir: string): Record<string, unknown> {
  const pkg = readPluginPackageJson(pluginDir);
  if (!pkg || typeof pkg !== "object") throw new Error("package.json 必须是 JSON 对象");
  return pkg;
}

/**
 * 扫描已安装插件，返回 `package.json`（按包名与目录 id 建索引）。
 *
 * 市场目录用它把「已装插件的本地协议」作为分类依据：离线也准，不必为了
 * 一个徽标再去 registry 逐条探测。
 */
export function readInstalledPluginManifests(
  dataRoot: string,
  pluginsRoot?: string,
): Map<string, Record<string, unknown>> {
  const root = resolve(pluginsRoot ?? join(dataRoot, "plugins"));
  const manifests = new Map<string, Record<string, unknown>>();
  for (const id of scanPluginIds(root)) {
    const dir = resolve(root, id);
    if (!dir.startsWith(root + sep) && dir !== root) continue;
    try {
      const pkg = readPackageJson(dir);
      const name = typeof pkg.name === "string" && pkg.name ? pkg.name : undefined;
      if (name && !manifests.has(name)) manifests.set(name, pkg);
      if (!manifests.has(id)) manifests.set(id, pkg);
    } catch {
      // 坏包不参与市场分类 hint
    }
  }
  return manifests;
}

/**
 * 启动时装载 `<dataRoot>/plugins` 下的 host 侧插件。
 *
 * 调用时机：`runtime.start()` 之后（内置服务都已在线，插件可以 inject）。
 * 单个插件失败只进 `state`/返回值，宿主照常启动。
 */
export async function loadBootPlugins(options: LoadBootPluginsOptions): Promise<BootPluginResult> {
  const dataRoot = resolve(options.dataRoot);
  const pluginsRoot = resolve(options.pluginsRoot ?? join(dataRoot, "plugins"));
  const stateFile = resolve(options.stateFile ?? join(dataRoot, "plugins.json"));
  const store = options.store ?? new PluginStore(stateFile);
  const state = options.state ?? new PluginBootState();
  const env = options.env ?? process.env;

  cleanupStaging(pluginsRoot);

  if (isPluginBootDisabled(env)) {
    return { enabled: false, scanned: [], loaded: [], skipped: [], failed: [] };
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  const persistProtocol = options.persistProtocol !== false;
  const onFailure = options.onFailure ?? ((failure) => {
    process.stderr.write(`Warn: 插件 ${failure.id} 启动装载失败（${failure.protocol}）：${failure.error}\n`);
  });

  const scanned = scanPluginIds(pluginsRoot);
  const savedState = store.read();
  const ids = orderByState(scanned, Object.keys(savedState.plugins));
  const loaded: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const failed: BootPluginFailure[] = [];

  const fail = (id: string, protocol: PluginProtocol, error: string): void => {
    const failure: BootPluginFailure = { id, protocol, error };
    failed.push(failure);
    state.setFailure(id, error);
    onFailure(failure);
  };

  for (const id of ids) {
    if (!store.isEnabled(id)) {
      skipped.push({ id, reason: "plugins.json 标记为停用" });
      continue;
    }

    const pluginDir = resolve(pluginsRoot, id);
    let pkg: Record<string, unknown>;
    try {
      pkg = readPackageJson(pluginDir);
    } catch (error) {
      fail(id, "unknown", `package.json 解析失败: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const protocol = detectProtocol(pkg);
    if (persistProtocol) {
      try {
        store.recordProtocol(id, protocol);
      } catch {
        // 状态文件写不进去不影响本次装载
      }
    }

    if (protocol === "webui") {
      skipped.push({ id, reason: "webui 插件由 /api/webui/manifest 装载" });
      continue;
    }
    if (protocol === "unknown") {
      fail(
        id,
        protocol,
        "未识别插件协议：package.json 既没有 fengagent.webui，也没有 dsh/cordis 入口（main/exports）",
      );
      continue;
    }

    const resolved = resolvePluginEntry(pluginDir, pkg);
    if (!resolved.entry) {
      fail(id, protocol, resolved.error ?? "找不到插件入口文件");
      continue;
    }

    try {
      await options.loadPlugin(options.ctx, pathToFileURL(resolved.entry).href, { timeoutMs });
      state.setLoaded(id);
      loaded.push(id);
    } catch (error) {
      fail(id, protocol, error instanceof Error ? error.message : String(error));
    }
  }

  return { enabled: true, scanned, loaded, skipped, failed };
}
