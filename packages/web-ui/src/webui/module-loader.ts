/**
 * @fengagent/web-ui — WebUI 插件装载器（S1）
 *
 * fetch manifest（`GET /api/webui/manifest`）→ 逐插件动态 `import(bundleUrl)`
 * → 调 `setup(ctx)` 完成注册。三条守卫：
 * - **失败隔离**：单插件 fetch/import/setup 挂掉只记 console.warn，不影响宿主与其他插件；
 * - **优雅降级**：后端未装配 manifest API（404/网络错）→ 静默返回空清单，UI 零影响；
 * - **重复装载守卫**：同 id 只装一次（重复调用幂等）。
 *
 * react 外部共享：宿主入口把 React 挂到 `window.__FENG_REACT__`，插件 bundle
 * 构建时 react 作 external、运行时从该全局取——单例共享，无多实例。
 */

import type { WebUiClientModule, WebUiManifest, WebUiManifestEntry, WebUiPluginContext } from "./plugin-context.ts";

/** 装载结果（供诊断/测试） */
export interface WebUiLoadResult {
  loaded: string[];
  failed: Array<{ id: string; reason: string }>;
  /** manifest 不可达（后端未装配）——非错误，静默降级 */
  unavailable: boolean;
}

/** 已装载插件 id 集合（幂等守卫） */
const loadedIds = new Set<string>();

type RegisterSlot = (slotId: string, component: unknown, pluginId: string) => void;
type Toast = (text: string, kind?: "info" | "error") => void;

export interface LoadWebUiPluginsOptions {
  /** manifest 地址（默认 /api/webui/manifest，相对当前 origin） */
  manifestUrl?: string;
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /** 注入 import（测试用；生产用动态 import(url)） */
  importImpl?: (url: string) => Promise<WebUiClientModule>;
  /** registerSlot 回调（由 slot registry 提供） */
  registerSlot: RegisterSlot;
  /** toast（由宿主提供） */
  toast: Toast;
}

/**
 * 装载全部 WebUI 插件（幂等）。返回诊断结果。
 */
export async function loadWebUiPlugins(options: LoadWebUiPluginsOptions): Promise<WebUiLoadResult> {
  const { registerSlot, toast } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const doImport =
    options.importImpl ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<WebUiClientModule>);

  const result: WebUiLoadResult = { loaded: [], failed: [], unavailable: false };

  // ① manifest（不可达 → 静默降级）
  let manifest: WebUiManifest;
  try {
    const res = await doFetch(options.manifestUrl ?? "/api/webui/manifest", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      result.unavailable = true;
      return result;
    }
    manifest = (await res.json()) as WebUiManifest;
  } catch {
    result.unavailable = true;
    return result;
  }

  // ② 逐插件装载（失败隔离）
  for (const entry of manifest.plugins ?? []) {
    if (!entry?.id || typeof entry.bundleUrl !== "string") continue;
    if (loadedIds.has(entry.id)) continue;

    try {
      const mod = await doImport(entry.bundleUrl);
      const setup = resolveSetup(mod);
      if (typeof setup !== "function") {
        throw new Error("client.mjs 未导出 setup(ctx) 或 default.setup");
      }
      const ctx: WebUiPluginContext = {
        registerSlot: (slotId, component) => registerSlot(slotId, component, entry.id),
        toast,
        api: (path, init) => fetch(path, init),
        plugin: { id: entry.id, name: entry.name ?? entry.id, version: entry.version ?? "0" },
      };
      setup(ctx);
      loadedIds.add(entry.id);
      result.loaded.push(entry.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[webui] 插件 "${entry.id}" 装载失败（已隔离）: ${reason}`);
      result.failed.push({ id: entry.id, reason });
    }
  }
  return result;
}

/** 兼容 setup 导出的三种形态：命名 setup / default.setup / default 为函数 */
function resolveSetup(mod: WebUiClientModule): ((ctx: WebUiPluginContext) => void) | undefined {
  if (typeof mod.setup === "function") return mod.setup;
  const d = mod.default;
  if (typeof d === "function") return d;
  if (d !== null && typeof d === "object" && typeof d.setup === "function") return d.setup;
  return undefined;
}

/** 测试辅助：清空幂等守卫 */
export function resetWebUiLoaderForTest(): void {
  loadedIds.clear();
}

export type { WebUiManifest, WebUiManifestEntry };
