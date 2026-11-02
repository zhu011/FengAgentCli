/**
 * @fengagent/cordis — 插件管理面（S2）
 *
 * 「装 / 卸 / 启停」三件事全部落在 `<dataRoot>/plugins` 与 `<dataRoot>/plugins.json`：
 * 插件文件是事实源，状态文件只记启用状态与安装来源（见 `plugin-store.ts`）。
 *
 * 边界（与方案 S1/S2 的安全口径一致）：
 * - 只接受**本地**源（目录或 `.tgz`/`.tar.gz`），远程 URL / git 地址一律拒绝 ——
 *   管理面不替用户去公网拉包；
 * - 插件 id 必须是单个目录名（复用 `isSafePluginId`），任何解析结果都要落在
 *   `pluginsRoot` 之内，杜绝目录穿越；
 * - 安装失败会回滚已复制的目录；依赖安装失败只告警，不把插件打成半装状态；
 * - 装/卸/启停后 `revision` 变化 → 插件面给出「需重启」提示（工具/服务面要重启
 *   才重新装载），但 WebUI manifest 立即生效（刷新页面即可）。
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { PluginStore, type PluginRecord } from "./plugin-store.ts";
import {
  isSafePluginId,
  readPluginPackageJson,
  readWebuiDeclaration,
  webuiAssetsBase,
  webuiEntryUrl,
  type WebuiDeclaration,
  type WebuiPluginError,
} from "./webui.ts";

/** 插件管理面的错误码（route 层据此映射 HTTP 状态） */
export type PluginErrorCode = "bad_request" | "not_found" | "conflict" | "unsupported";

/** 带错误码的插件管理异常 */
export class PluginError extends Error {
  readonly code: PluginErrorCode;

  constructor(message: string, code: PluginErrorCode = "bad_request") {
    super(message);
    this.name = "PluginError";
    this.code = code;
  }
}

/** `GET /api/plugins` 的单条插件 */
export interface PluginListEntry {
  /** 插件 id（目录名，同时用于 assets URL） */
  id: string;
  /** package.json `name`（缺失回退 id） */
  name: string;
  /** package.json `version`（缺失回退 `0.0.0`） */
  version: string;
  /** package.json `description` */
  description?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 是否声明了 `fengagent.webui`（UI 型插件） */
  hasWebui: boolean;
  /** 声明的 slot（`hasWebui=false` 时为空数组） */
  slots: string[];
  /** 入口 URL（与 `/api/webui/manifest` 同一份，浏览器可直接 import） */
  entry?: string;
  /** 入口 URL 的前端字段名（与 `entry` 同值，见 `WebuiPluginInfo.bundleUrl`） */
  bundleUrl?: string;
  /** assets 前缀 URL（插件自带图片/字体等相对资源在此之下） */
  assetsBase?: string;
  /** 安装来源（手工放置的插件无此字段） */
  source?: string;
  /** 安装时间（ISO 8601） */
  installedAt?: string;
  /** package.json / webui 声明解析失败的原因（插件仍列出，便于卸载或修复） */
  error?: string;
}

/** `GET /api/plugins` 响应 */
export interface PluginListResult {
  plugins: PluginListEntry[];
  /** 坏包错误（与 `/api/webui/manifest` 的 `errors` 同源口径） */
  errors: WebuiPluginError[];
  /** 插件目录（绝对路径，供「数据根」展示） */
  pluginsRoot: string;
  /** 状态文件（绝对路径） */
  stateFile: string;
  /** 状态写回计数 */
  revision: number;
  /** 本次进程启动后插件面发生过变更 → 建议重启宿主（工具/服务面重载） */
  restartRequired: boolean;
}

/** `POST /api/plugins/install` 请求体 */
export interface PluginInstallRequest {
  /** 本地源：插件目录，或 `.tgz`/`.tar.gz` 包 */
  source?: string;
  /** 显式插件 id（缺省由包名推导：`@scope/name` → `name`） */
  id?: string;
  /** 装完是否启用（默认 true） */
  enable?: boolean;
  /** 是否安装 npm 依赖（默认 true；仅当 package.json 声明了 dependencies 才执行） */
  installDeps?: boolean;
  /**
   * 状态里记录的来源标签（缺省用 `source` 路径）。
   *
   * 上传安装时 `source` 是会被清理的临时路径，用它长期记录没有意义，
   * 路由层用 `upload:<原文件名>` 代替。
   */
  sourceLabel?: string;
}

/** 装/启停的结果 */
export interface PluginMutationResult {
  plugin: PluginListEntry;
  revision: number;
  restartRequired: boolean;
  /** 非致命告警（依赖安装失败等） */
  warnings?: string[];
}

/** 卸载结果 */
export interface PluginRemoveResult {
  id: string;
  removed: true;
  /** 删除前的快照（便于前端回显） */
  plugin?: PluginListEntry;
  revision: number;
  restartRequired: boolean;
}

/** 构造选项 */
export interface PluginManagerOptions {
  /** 数据根（插件目录与状态文件默认都在其下） */
  dataRoot: string;
  /** 覆盖插件目录（默认 `<dataRoot>/plugins`） */
  pluginsRoot?: string;
  /** 覆盖状态文件（默认 `<dataRoot>/plugins.json`） */
  stateFile?: string;
  /**
   * 依赖安装命令（默认 `bun`；`null` 表示不装依赖）。
   *
   * 测试注入 `null` 或假命令，避免真去联网装包。
   */
  installDepsCommand?: string | null;
  /**
   * 解包器覆盖（默认调用系统 `tar`）。
   *
   * 用法：测试注入一个「把准备好的目录直接当解包结果」的假实现，
   * 这样在禁止子进程的环境里也能覆盖 `.tgz` 安装流程。
   */
  extractTarball?: (source: string) => { dir: string; cleanup?: () => void };
}

/** 复制插件时跳过的目录/文件（构建产物与版本库不该跟着搬家） */
const COPY_SKIP = new Set(["node_modules", ".git", ".DS_Store", "plugins.json"]);

/** `~` 展开（与 shared 的 expandTilde 同语义，避免给 cordis 引额外入口） */
function expandTilde(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return input;
}

/** 错误信息归一 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读取 package.json（缺失/坏 JSON 一律抛 PluginError） */
function readPackageJson(dir: string): Record<string, unknown> {
  const pkgPath = resolve(dir, "package.json");
  if (!existsSync(pkgPath)) {
    throw new PluginError(`插件缺少 package.json: ${dir}`);
  }
  let parsed: unknown;
  try {
    parsed = readPluginPackageJson(dir);
  } catch (error) {
    throw new PluginError(`package.json 解析失败: ${messageOf(error)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new PluginError("package.json 必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/** 远程源判定（`https://`、`git+ssh://`、`git@host:path` 等一律不支持） */
function isRemoteSource(source: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return true;
  if (source.startsWith("git@") || source.startsWith("github:")) return true;
  if (/^(github|gitlab|bitbucket):/i.test(source)) return true;
  return false;
}

/**
 * 由包名推导插件 id：`@acme/plugin-demo` → `plugin-demo`。
 *
 * scope 里的 `/` 不能进目录名（也进不了 URL 路径段），因此去 scope 取末段；
 * 不同 scope 的同名插件由调用方显式传 `id` 区分（重名会 409）。
 */
function derivePluginId(pkgName: unknown, root: string): string {
  const raw = typeof pkgName === "string" && pkgName.trim() ? pkgName.trim() : basename(root);
  const unscoped = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  if (!isSafePluginId(unscoped)) {
    throw new PluginError(`无法从包名推导插件 id（${raw}），请显式传 id`);
  }
  return unscoped;
}

/** 在解包目录里定位真正的插件根（兼容 npm pack 的 `package/` 外层） */
function locatePluginRoot(staging: string): string {
  if (existsSync(join(staging, "package.json"))) return staging;
  const children = readdirSync(staging, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  for (const child of children) {
    const candidate = join(staging, child);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  throw new PluginError("压缩包里找不到 package.json（需要插件根目录层级的包）");
}

/**
 * 插件管理器。
 *
 * 进程内单例语义：`bootRevision` 在构造时记下状态基线，之后每次 `list()` 用它
 * 判断「是否发生过变更、需要重启」。
 */
export class PluginManager {
  /** 插件根目录（`<dataRoot>/plugins`） */
  readonly pluginsRoot: string;
  /** 状态存储 */
  readonly store: PluginStore;
  /** 状态文件绝对路径 */
  readonly stateFile: string;
  /** 依赖安装命令（null = 不装） */
  private readonly installDepsCommand: string | null;
  /** 解包器（默认系统 tar；测试可注入假实现） */
  private readonly extract: (source: string) => { dir: string; cleanup?: () => void };
  /** 启动时的状态版本（重启提示基线） */
  private readonly bootRevision: number;

  constructor(options: PluginManagerOptions) {
    const dataRoot = resolve(options.dataRoot);
    this.pluginsRoot = resolve(options.pluginsRoot ?? join(dataRoot, "plugins"));
    // 状态文件默认与插件目录同级（`<dataRoot>/plugins.json`）：只传 pluginsRoot 时
    // 也不会把状态写到另一个数据根，避免「目录与状态各说各话」。
    this.stateFile = resolve(options.stateFile ?? join(dirname(this.pluginsRoot), "plugins.json"));
    this.store = new PluginStore(this.stateFile);
    this.installDepsCommand = options.installDepsCommand === undefined ? "bun" : options.installDepsCommand;
    this.extract = options.extractTarball ?? ((source) => this.extractTarballWithTar(source));
    this.bootRevision = this.store.revision();
  }

  /** 插件面是否需要重启才完全生效 */
  restartRequired(): boolean {
    return this.store.revision() !== this.bootRevision;
  }

  /** 列出全部插件（含坏包，坏包带 `error` 但仍可卸载） */
  list(): PluginListResult {
    const ids = this.scanIds();
    const plugins: PluginListEntry[] = [];
    for (const id of ids) {
      const entry = this.entryFor(id);
      if (entry) plugins.push(entry);
    }
    const errors: WebuiPluginError[] = plugins
      .filter((plugin) => plugin.error !== undefined)
      .map((plugin) => ({ id: plugin.id, error: plugin.error as string }));
    return {
      plugins,
      errors,
      pluginsRoot: this.pluginsRoot,
      stateFile: this.stateFile,
      revision: this.store.revision(),
      restartRequired: this.restartRequired(),
    };
  }

  /**
   * 安装插件（本地目录或 `.tgz`）。
   *
   * 流程：校验源 → 解包/定位插件根 → 复制进 `<pluginsRoot>/<id>` → 按需装依赖
   * → 登记状态。任何一步失败都会清掉已复制的目录，不留半装插件。
   */
  async install(request: PluginInstallRequest = {}): Promise<PluginMutationResult> {
    const rawSource = (request.source ?? "").trim();
    if (!rawSource) {
      throw new PluginError("source 必填：本地插件目录或 .tgz/.tar.gz 路径");
    }
    if (isRemoteSource(rawSource)) {
      throw new PluginError("仅支持本地源（目录或 .tgz/.tar.gz），不支持远程 URL / git 地址", "unsupported");
    }

    const source = resolve(expandTilde(rawSource));
    if (!existsSync(source)) {
      throw new PluginError(`源不存在: ${source}`);
    }

    let stagingRoot = source;
    let cleanup: (() => void) | undefined;
    if (!statSync(source).isDirectory()) {
      if (!/\.(tgz|tar\.gz)$/i.test(source)) {
        throw new PluginError("源必须是目录或 .tgz/.tar.gz 压缩包", "unsupported");
      }
      const extracted = this.extract(source);
      stagingRoot = extracted.dir;
      cleanup = extracted.cleanup;
    }

    let destination: string | null = null;
    /** 是否真的复制出了目录：冲突时 destination 已指向旧插件，绝不能删 */
    let created = false;
    try {
      const pluginRoot = locatePluginRoot(stagingRoot);
      const pkg = readPackageJson(pluginRoot);
      const id = request.id ? this.requireId(request.id) : derivePluginId(pkg.name, pluginRoot);

      const target = this.pluginDir(id);
      if (existsSync(target)) {
        throw new PluginError(`插件 ${id} 已存在（先卸载或换个 id）`, "conflict");
      }

      mkdirSync(this.pluginsRoot, { recursive: true });
      cpSync(pluginRoot, target, {
        recursive: true,
        dereference: false,
        filter: (src) => !COPY_SKIP.has(basename(src)),
      });
      destination = target;
      created = true;

      const warnings = this.installDependencies(destination, pkg, request.installDeps);
      const record: PluginRecord = {
        enabled: request.enable !== false,
        source: request.sourceLabel ?? source,
        installedAt: new Date().toISOString(),
      };
      if (typeof pkg.name === "string" && pkg.name) record.name = pkg.name;
      if (typeof pkg.version === "string" && pkg.version) record.version = pkg.version;
      this.store.recordInstall(id, record);

      const plugin = this.entryFor(id);
      if (!plugin) {
        throw new PluginError(`安装后无法读取插件 ${id}`);
      }
      return {
        plugin,
        revision: this.store.revision(),
        restartRequired: this.restartRequired(),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error) {
      if (destination && created) rmSync(destination, { recursive: true, force: true });
      throw error;
    } finally {
      cleanup?.();
    }
  }

  /** 启用/停用（停用后 manifest 与 assets 立即不再对外，工具面仍需重启） */
  setEnabled(id: string, enabled: boolean): PluginMutationResult {
    const pluginId = this.requireId(id);
    const plugin = this.entryFor(pluginId);
    if (!plugin) throw new PluginError(`插件 ${pluginId} 未安装`, "not_found");
    this.store.setEnabled(pluginId, enabled);
    return {
      plugin: { ...plugin, enabled },
      revision: this.store.revision(),
      restartRequired: this.restartRequired(),
    };
  }

  /** 卸载：删目录 + 清状态（状态不存在也照删，手工放置的插件同路径处理） */
  remove(id: string): PluginRemoveResult {
    const pluginId = this.requireId(id);
    const destination = this.pluginDir(pluginId);
    if (!existsSync(destination)) {
      throw new PluginError(`插件 ${pluginId} 未安装`, "not_found");
    }
    const snapshot = this.entryFor(pluginId);
    rmSync(destination, { recursive: true, force: true });
    this.store.forget(pluginId);
    return {
      id: pluginId,
      removed: true,
      ...(snapshot ? { plugin: snapshot } : {}),
      revision: this.store.revision(),
      restartRequired: this.restartRequired(),
    };
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 校验并规范化插件 id（单段目录名） */
  private requireId(id: string): string {
    if (!isSafePluginId(id)) {
      throw new PluginError(`非法插件 id: ${id}`);
    }
    return id;
  }

  /** 插件目录绝对路径（`requireId` 之后不会越界，这里再兜一层） */
  private pluginDir(id: string): string {
    const dir = resolve(this.pluginsRoot, id);
    if (!dir.startsWith(this.pluginsRoot + sep)) {
      throw new PluginError(`非法插件 id: ${id}`);
    }
    return dir;
  }

  /** 扫描插件目录下的候选 id */
  private scanIds(): string[] {
    try {
      return readdirSync(this.pluginsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .filter((id) => isSafePluginId(id))
        .sort();
    } catch {
      return [];
    }
  }

  /** 组装单个插件条目（目录不存在返回 null） */
  private entryFor(id: string): PluginListEntry | null {
    const dir = this.pluginDir(id);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;

    const record = this.store.read().plugins[id];
    let pkg: Record<string, unknown> | null = null;
    let error: string | undefined;
    try {
      pkg = readPackageJson(dir);
    } catch (err) {
      error = messageOf(err);
    }

    let declaration: WebuiDeclaration | null = null;
    if (pkg) {
      try {
        declaration = readWebuiDeclaration(dir);
      } catch (err) {
        error = error ?? messageOf(err);
      }
    }

    const assetsBase = webuiAssetsBase(id);
    const name = typeof pkg?.name === "string" && pkg.name ? pkg.name : id;
    const version = typeof pkg?.version === "string" && pkg.version ? pkg.version : "0.0.0";
    const description = typeof pkg?.description === "string" && pkg.description ? pkg.description : undefined;

    return {
      id,
      name,
      version,
      ...(description ? { description } : {}),
      enabled: record ? record.enabled !== false : true,
      hasWebui: declaration !== null,
      slots: declaration?.slots ?? [],
      ...(declaration
        ? {
            entry: webuiEntryUrl(id, declaration.entry),
            bundleUrl: webuiEntryUrl(id, declaration.entry),
          }
        : {}),
      ...(record?.source ? { source: record.source } : {}),
      ...(record?.installedAt ? { installedAt: record.installedAt } : {}),
      ...(error ? { error } : {}),
      ...(declaration ? { assetsBase } : {}),
    };
  }

  /** 解包 `.tgz` 到临时目录（Windows 自带 bsdtar；缺失时给出可读错误） */
  private extractTarballWithTar(source: string): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "feng-plugin-"));
    const cleanup = (): void => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 临时目录清理失败不影响安装结果
      }
    };
    const result = spawnSync("tar", ["-xzf", source, "-C", dir], { encoding: "utf8", timeout: 60_000 });
    if (result.error || result.status !== 0) {
      cleanup();
      const detail = result.error?.message ?? (result.stderr || "").trim();
      throw new PluginError(`解包失败（需要系统 tar 命令）: ${detail || "unknown error"}`);
    }
    return { dir, cleanup };
  }

  /**
   * 按需安装 npm 依赖。
   *
   * 只在 package.json 声明了 `dependencies` 时才执行；失败不阻断安装（插件文件
   * 已就位，用户可手动在插件目录里装），只回一条告警。
   */
  private installDependencies(
    dir: string,
    pkg: Record<string, unknown>,
    installDeps: boolean | undefined,
  ): string[] {
    if (installDeps === false || !this.installDepsCommand) return [];
    const deps = pkg.dependencies;
    if (!deps || typeof deps !== "object" || Object.keys(deps as Record<string, unknown>).length === 0) {
      return [];
    }
    const result = spawnSync(this.installDepsCommand, ["install", "--production"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (result.error || result.status !== 0) {
      const stderr = (result.stderr || "").trim().split("\n").slice(-3).join(" ");
      const detail = result.error?.message ?? stderr;
      return [`依赖安装失败（插件已就位，可手动在插件目录执行 bun install）：${detail || "unknown error"}`];
    }
    return [];
  }
}
