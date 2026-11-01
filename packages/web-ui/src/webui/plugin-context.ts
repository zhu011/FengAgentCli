/**
 * @fengagent/web-ui — WebUI 插件上下文（S1）
 *
 * 插件 client.mjs（ESM bundle，react 经 window.__FENG_REACT__ 共享单例）的入口协议：
 *
 * ```js
 * export function setup(ctx) {
 *   ctx.registerSlot("conversation-side-panel", MyPanel); // React 组件
 * }
 * ```
 *
 * ctx 面：`registerSlot(slotId, component)`、`toast(text, kind?)`、`api`（带 base
 * 的 fetch 封装）。插件挂掉只影响自己（ModuleLoader 逐插件隔离），不影响宿主。
 */

export type WebUiSlotId =
  | "settings-section"
  | "conversation-side-panel"
  | "team-detail-panel"
  | "nav-extension";

/** 插件 client 的上下文（第一批面，S2 扩 primitives） */
export interface WebUiPluginContext {
  /** 向 slot 注册组件（同 slot 多插件按注册序渲染） */
  registerSlot(slotId: WebUiSlotId, component: unknown): void;
  /** 全局 toast（宿主极简实现） */
  toast(text: string, kind?: "info" | "error"): void;
  /** 带基址的 fetch 封装（同源 API） */
  api(path: string, init?: RequestInit): Promise<Response>;
  /** 插件自身信息（来自 manifest） */
  plugin: { id: string; name: string; version: string };
}

/** 插件 client.mjs 模块形状 */
export interface WebUiClientModule {
  setup?: (ctx: WebUiPluginContext) => void;
  default?: { setup?: (ctx: WebUiPluginContext) => void } | ((ctx: WebUiPluginContext) => void);
}

/** manifest 单插件条目（GET /api/webui/manifest 的形状，与 S1 后端契约） */
export interface WebUiManifestEntry {
  id: string;
  name: string;
  version: string;
  /** bundle URL（/api/webui/assets/…） */
  bundleUrl: string;
  /** 声明要挂的 slot（仅文档性，实际以 registerSlot 调用为准） */
  slots?: string[];
}

/** manifest 响应 */
export interface WebUiManifest {
  plugins: WebUiManifestEntry[];
}
