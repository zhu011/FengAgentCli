/**
 * @fengagent/web-ui — WebUI 插件面（S1）
 *
 * - `WebUiProvider` / `SlotHost`：宿主装载链与 slot 渲染（`slot-registry.tsx`）
 * - `loadWebUiPlugins`：manifest → import → setup（`module-loader.ts`）
 * - 插件协议与 manifest 契约：`plugin-context.ts`
 *
 * 插件 client.mjs 协议（react 经 `window.__FENG_REACT__` 共享单例）：
 * ```js
 * export function setup(ctx) {
 *   ctx.registerSlot("conversation-side-panel", MyPanel);
 * }
 * ```
 */

export { WebUiProvider, SlotHost } from "./slot-registry.tsx";
export { loadWebUiPlugins, resetWebUiLoaderForTest } from "./module-loader.ts";
export type { WebUiLoadResult, LoadWebUiPluginsOptions } from "./module-loader.ts";
export type { WebUiPluginContext, WebUiClientModule, WebUiManifest, WebUiManifestEntry, WebUiSlotId } from "./plugin-context.ts";
