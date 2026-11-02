/**
 * @fengagent/cordis — WebUI 插件注册表（S1 地基）
 *
 * 插件包在 `package.json` 里声明 WebUI 入口：
 *
 * ```json
 * { "name": "@acme/feng-plugin-demo", "version": "0.1.0",
 *   "fengagent": { "webui": { "entry": "./client.mjs", "slots": ["settings-section"] } } }
 * ```
 *
 * `fengagent.webui` 也接受字符串简写（等价于 `{ "entry": "<value>" }`）。
 * 注册表只做两件事：
 *   1. 扫描 `<dataRoot>/plugins/*` 生成 manifest（宿主 WebUI 免重启拉取）；
 *   2. 把 `/api/webui/assets/<id>/<rel>` 解析成插件目录内的真实文件（白名单 + 防目录穿越）。
 *
 * 失败隔离：单个插件 package.json 损坏只进 `errors[]`，不影响其它插件与宿主。
 */

import { extname, isAbsolute, resolve, sep } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { PluginStore } from "./plugin-store.ts";

/** 单个可装载插件的 manifest 条目 */
export interface WebuiPluginInfo {
  /** 插件 id（`<dataRoot>/plugins` 下的目录名，同时用于 assets URL） */
  id: string;
  /** package.json `name`（缺失时回退 id） */
  name: string;
  /** package.json `version`（缺失时 `0.0.0`） */
  version: string;
  /** 入口 URL（浏览器侧 `import()` 用） */
  entry: string;
  /**
   * 入口 URL 的前端字段名（与 `entry` 同值）。
   *
   * WebUI 的 ModuleLoader 按 `bundleUrl` 取入口；两个名字同时给，避免宿主与
   * 装载器对字段名的理解漂移（客户端契约以 `bundleUrl` 为兼容名）。
   */
  bundleUrl: string;
  /** 插件声明的 slot（`settings-section` 等） */
  slots: string[];
  /** assets 前缀 URL（相对资源在此之下） */
  assetsBase: string;
}

/** 扫描期错误（坏包不阻断其它插件） */
export interface WebuiPluginError {
  id: string;
  error: string;
}

/** `GET /api/webui/manifest` 响应 */
export interface WebuiManifest {
  version: 1;
  plugins: WebuiPluginInfo[];
  errors: WebuiPluginError[];
}

/** `resolveAsset` 结果 */
export interface WebuiAsset {
  /** 绝对路径（已确认落在插件目录内） */
  path: string;
  /** Content-Type（文本类型带 charset） */
  contentType: string;
}

/** 插件声明的 WebUI 入口 */
export interface WebuiDeclaration {
  entry: string;
  slots: string[];
}

const CONTENT_TYPES: Record<string, string> = {
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".html": "text/html; charset=utf-8",
};

/** 插件 id 合法性：单个目录名，不允许路径分隔符与 `..` */
export function isSafePluginId(id: string): boolean {
  return id.length > 0 && id !== "." && id !== ".." && /^[A-Za-z0-9._@-]+$/.test(id);
}

/**
 * 插件内相对路径校验：拒绝绝对路径、盘符、空段、`.`/`..`、NUL。
 * 返回规范化后的相对路径（`./` 前缀剥离、`\\` → `/`）。
 */
function normalizeRelativePath(input: string): string | null {
  if (!input || input.includes("\0")) return null;
  const slashed = input.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) return null;
  const parts: string[] = [];
  for (const raw of slashed.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") return null;
    parts.push(raw);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

/**
 * 读取插件 package.json（容忍 UTF-8 BOM：Windows 上不少工具会带 BOM 写文件）。
 */
export function readPluginPackageJson(pluginDir: string): Record<string, unknown> {
  const raw = readFileSync(resolve(pluginDir, "package.json"), "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * 读取 package.json 的 `fengagent.webui` 声明（未声明返回 null，非法声明抛错）。
 *
 * 插件管理面（S2）复用它做「这个插件有没有 UI 面」的判定，保证 manifest 与
 * `/api/plugins` 对同一份声明给出一致结论。
 */
export function readWebuiDeclaration(pluginDir: string): WebuiDeclaration | null {
  const pkgPath = resolve(pluginDir, "package.json");
  if (!existsSync(pkgPath)) return null;
  const pkg = readPluginPackageJson(pluginDir);
  const fengagent = pkg.fengagent;
  if (!fengagent || typeof fengagent !== "object") return null;
  const webui = (fengagent as Record<string, unknown>).webui;
  if (webui === undefined || webui === null) return null;
  if (typeof webui === "string") {
    const entry = normalizeRelativePath(webui);
    if (!entry) throw new Error(`fengagent.webui entry 非法: ${webui}`);
    return { entry, slots: [] };
  }
  if (typeof webui !== "object") {
    throw new Error("fengagent.webui 声明必须是字符串或对象");
  }
  const record = webui as Record<string, unknown>;
  const entry = typeof record.entry === "string" ? normalizeRelativePath(record.entry) : null;
  if (!entry) throw new Error(`fengagent.webui entry 非法: ${String(record.entry)}`);
  const slots = Array.isArray(record.slots)
    ? record.slots.filter((slot): slot is string => typeof slot === "string" && slot.length > 0)
    : [];
  return { entry, slots };
}

/** assets URL 前缀（manifest 与插件管理面共用，保证两处 URL 完全一致） */
export function webuiAssetsBase(id: string): string {
  return `/api/webui/assets/${encodeURIComponent(id)}`;
}

/** 插件 manifest 条目的入口 URL（`<assetsBase>/<entry>`） */
export function webuiEntryUrl(id: string, entry: string): string {
  return `${webuiAssetsBase(id)}/${entry}`;
}

/**
 * WebUI 插件注册表。
 *
 * 无状态：每次 `manifest()` / `resolveAsset()` 都按磁盘现况读取，
 * 因此「装完插件刷新页面即可」——不需要重启宿主。
 *
 * 传入 `store` 时以 `plugins.json` 的启用状态为准：停用的插件既不出现在
 * manifest 里，其 assets 也不再对外服务（S2 插件管理面）。
 */
export class WebuiRegistry {
  /** 插件根目录（`<dataRoot>/plugins`） */
  readonly pluginsRoot: string;
  /** 可选状态存储（缺省 = 全部插件均启用） */
  private readonly store: PluginStore | undefined;

  constructor(pluginsRoot: string, options: { store?: PluginStore } = {}) {
    this.pluginsRoot = resolve(pluginsRoot);
    this.store = options.store;
  }

  /** 扫描插件根目录，返回可装载条目与坏包错误 */
  list(): { plugins: WebuiPluginInfo[]; errors: WebuiPluginError[] } {
    const plugins: WebuiPluginInfo[] = [];
    const errors: WebuiPluginError[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(this.pluginsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort();
    } catch {
      // 插件目录不存在 = 没有插件，不是错误
      return { plugins, errors };
    }

    for (const id of entries) {
      if (!isSafePluginId(id)) continue;
      if (this.store && !this.store.isEnabled(id)) continue; // 停用 = 不装载
      try {
        const pluginDir = resolve(this.pluginsRoot, id);
        const declaration = readWebuiDeclaration(pluginDir);
        if (!declaration) continue; // 未声明 webui 的插件不参与 UI 装载
        const entryPath = resolve(pluginDir, declaration.entry);
        if (!entryPath.startsWith(pluginDir + sep) || !existsSync(entryPath)) {
          throw new Error(`webui entry 不存在或越界: ${declaration.entry}`);
        }
        const pkg = readPluginPackageJson(pluginDir);
        const assetsBase = webuiAssetsBase(id);
        const entryUrl = webuiEntryUrl(id, declaration.entry);
        plugins.push({
          id,
          name: typeof pkg.name === "string" && pkg.name ? pkg.name : id,
          version: typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0",
          entry: entryUrl,
          bundleUrl: entryUrl,
          slots: declaration.slots,
          assetsBase,
        });
      } catch (error) {
        errors.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return { plugins, errors };
  }

  /** `GET /api/webui/manifest` 的响应体 */
  manifest(): WebuiManifest {
    const { plugins, errors } = this.list();
    return { version: 1, plugins, errors };
  }

  /**
   * 把插件内相对路径解析为可读取的绝对路径。
   *
   * 返回 null 表示：插件 id 非法 / 插件被停用 / 插件未声明 webui / 路径越界 /
   * 文件不存在。任何情况下都不会返回 `pluginsRoot` 之外的文件。
   */
  resolveAsset(pluginId: string, relativePath: string): WebuiAsset | null {
    if (!isSafePluginId(pluginId)) return null;
    if (this.store && !this.store.isEnabled(pluginId)) return null;
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) return null;

    const pluginDir = resolve(this.pluginsRoot, pluginId);
    if (!pluginDir.startsWith(this.pluginsRoot + sep)) return null;
    // 坏包（package.json 不存在/非法）对 assets 一律 404，不把解析错误变成 500
    let declaration: WebuiDeclaration | null = null;
    try {
      declaration = readWebuiDeclaration(pluginDir);
    } catch {
      return null;
    }
    if (!declaration) return null;

    const candidate = resolve(pluginDir, normalized);
    if (!candidate.startsWith(pluginDir + sep)) return null;
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;

    const contentType = CONTENT_TYPES[extname(candidate).toLowerCase()] ?? "application/octet-stream";
    return { path: candidate, contentType };
  }
}

/** 默认插件根：`<dataRoot>/plugins` */
export function resolveWebuiPluginsRoot(dataRoot: string): string {
  return resolve(dataRoot, "plugins");
}

/** 入口文件是否在插件目录内（供注册表与测试复用） */
export function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate.startsWith(resolvedRoot + sep) || resolvedCandidate === resolvedRoot;
}

/** 绝对路径 helper（导出便于 route 层做一致性判断） */
export { isAbsolute };
