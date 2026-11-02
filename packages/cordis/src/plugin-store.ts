/**
 * @fengagent/cordis — 插件状态存储（S2）
 *
 * `<dataRoot>/plugins.json` 只记录「插件目录之外」的元信息：启用状态与安装来源。
 * 插件本体（package.json、client bundle、工具代码）仍以目录为准 —— 文件是事实源，
 * 状态文件是可丢弃的旁路记录：删掉它等于「全部插件默认启用」。
 *
 * ```json
 * { "version": 1, "revision": 3,
 *   "plugins": { "demo": { "enabled": true, "source": "D:\\plugins\\demo", "installedAt": "..." } } }
 * ```
 *
 * `revision` 每次写回自增：宿主启动时记下基线，之后的任何装/卸/启停都会让它
 * 偏离基线，插件管理面据此给出「需重启生效」提示（工具/服务面要重启才重载）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** 单个插件的持久化记录 */
export interface PluginRecord {
  /** 是否启用（缺省 true） */
  enabled: boolean;
  /** 安装来源（本地目录或 .tgz 路径；手工放置的插件无此字段） */
  source?: string;
  /** 安装时间（ISO 8601） */
  installedAt?: string;
  /** 安装时的包名（仅用于诊断，事实源仍是 package.json） */
  name?: string;
  /** 安装时的版本（仅用于诊断） */
  version?: string;
}

/** `plugins.json` 结构 */
export interface PluginState {
  version: 1;
  /** 写回计数：任何变更 +1（重启提示的基线） */
  revision: number;
  plugins: Record<string, PluginRecord>;
}

/** 空状态（初始化 / 坏文件回退） */
function emptyState(): PluginState {
  return { version: 1, revision: 0, plugins: {} };
}

/** 把未知 JSON 收敛成合法状态（字段级校验，坏字段按缺省处理） */
function normalizeState(raw: unknown): PluginState {
  if (!raw || typeof raw !== "object") return emptyState();
  const record = raw as Record<string, unknown>;
  const plugins: Record<string, PluginRecord> = {};
  const rawPlugins = record.plugins;
  if (rawPlugins && typeof rawPlugins === "object") {
    for (const [id, value] of Object.entries(rawPlugins as Record<string, unknown>)) {
      if (!id || !value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      const plugin: PluginRecord = { enabled: entry.enabled !== false };
      if (typeof entry.source === "string" && entry.source) plugin.source = entry.source;
      if (typeof entry.installedAt === "string" && entry.installedAt) plugin.installedAt = entry.installedAt;
      if (typeof entry.name === "string" && entry.name) plugin.name = entry.name;
      if (typeof entry.version === "string" && entry.version) plugin.version = entry.version;
      plugins[id] = plugin;
    }
  }
  const revision = typeof record.revision === "number" && Number.isFinite(record.revision) ? record.revision : 0;
  return { version: 1, revision, plugins };
}

/**
 * 插件状态存储。
 *
 * 无缓存：每次读写都落盘，这样「另一个进程 / 手工编辑 plugins.json」也不会被
 * 内存快照覆盖。文件坏掉时按空状态处理（不让一个坏 JSON 拦住插件面）。
 */
export class PluginStore {
  /** 状态文件绝对路径 */
  readonly stateFile: string;

  constructor(stateFile: string) {
    this.stateFile = resolve(stateFile);
  }

  /** 读取当前状态（文件缺失/损坏 → 空状态） */
  read(): PluginState {
    try {
      return normalizeState(JSON.parse(readFileSync(this.stateFile, "utf8")));
    } catch {
      return emptyState();
    }
  }

  /** 当前写回计数 */
  revision(): number {
    return this.read().revision;
  }

  /** 插件是否启用（未登记 = 启用，保留「手工放目录即可用」的行为） */
  isEnabled(id: string): boolean {
    const record = this.read().plugins[id];
    return record ? record.enabled !== false : true;
  }

  /** 启用/停用（权限与存在性由调用方校验） */
  setEnabled(id: string, enabled: boolean): PluginState {
    const state = this.read();
    const record: PluginRecord = { ...(state.plugins[id] ?? { enabled: true }), enabled };
    state.plugins[id] = record;
    return this.write(state);
  }

  /** 登记一次安装（会同时写入启用状态） */
  recordInstall(id: string, record: PluginRecord): PluginState {
    const state = this.read();
    state.plugins[id] = { ...record, enabled: record.enabled !== false };
    return this.write(state);
  }

  /** 忘记一个插件（卸载后清掉状态，避免残留记录影响重装） */
  forget(id: string): PluginState {
    const state = this.read();
    if (state.plugins[id]) delete state.plugins[id];
    return this.write(state);
  }

  /** 原子写回：临时文件 + rename，避免半截 JSON 被读到 */
  private write(state: PluginState): PluginState {
    const next: PluginState = {
      version: 1,
      revision: state.revision + 1,
      plugins: state.plugins,
    };
    const dir = dirname(this.stateFile);
    try {
      if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      renameSync(tmp, this.stateFile);
    } catch {
      // rename 被占用等（Windows 偶发）：退化为直接覆盖，状态比原子性更重要
      try {
        rmSync(`${this.stateFile}.tmp`, { force: true });
      } catch {
        // 忽略
      }
      writeFileSync(this.stateFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    }
    return next;
  }
}
