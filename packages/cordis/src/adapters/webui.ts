/**
 * @fengagent/cordis — WebUI 插件装载器
 *
 * 插件 id: feng.webui
 * 提供 ctx.webui 服务：扫描 `<dataRoot>/plugins` 的 `fengagent.webui` 声明，
 * 供 `/api/webui/manifest` 与 `/api/webui/assets/*` 使用（S1 地基）。
 *
 * S2 起额外接 `plugins.json`：停用的插件不进 manifest、assets 也不再服务，
 * 与 `/api/plugins` 管理面共享同一份注册表与状态。
 */

import type { Context } from "@deepseek-ai/cordis";
import { dirname, join } from "node:path";
import { resolveDataRoot } from "@fengagent/shared";
import { PluginStore } from "../plugin-store.ts";
import { WebuiServiceImpl } from "../services.ts";
import type { WebuiService } from "../types.ts";
import { resolveWebuiPluginsRoot, WebuiRegistry } from "../webui.ts";

export interface WebuiPluginOptions {
  /** 数据根（缺省时按 resolveDataRoot()；用于推导插件目录与状态文件） */
  dataRoot?: string;
  /** 插件根目录（默认 `<dataRoot>/plugins`） */
  pluginsRoot?: string;
  /** 插件状态文件（默认与插件目录同级：`<dataRoot>/plugins.json`） */
  stateFile?: string;
}

/** WebUI 注册表插件 — 提供 ctx.webui */
export function webuiPlugin(options: WebuiPluginOptions = {}) {
  return function webuiPluginEntry(ctx: Context) {
    const dataRoot = options.dataRoot ?? resolveDataRoot();
    const pluginsRoot = options.pluginsRoot ?? resolveWebuiPluginsRoot(dataRoot);
    // 状态文件跟着插件目录走：只覆盖 pluginsRoot 时也不会读到另一个数据根的启用状态
    const store = new PluginStore(options.stateFile ?? join(dirname(pluginsRoot), "plugins.json"));
    const registry = new WebuiRegistry(pluginsRoot, { store });
    const service = new WebuiServiceImpl(ctx, registry);
    return service as WebuiService;
  };
}
