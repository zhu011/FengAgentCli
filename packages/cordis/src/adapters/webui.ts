/**
 * @fengagent/cordis — WebUI 插件装载器
 *
 * 插件 id: feng.webui
 * 提供 ctx.webui 服务：扫描 `<dataRoot>/plugins` 的 `fengagent.webui` 声明，
 * 供 `/api/webui/manifest` 与 `/api/webui/assets/*` 使用（S1 地基）。
 */

import type { Context } from "@deepseek-ai/cordis";
import { resolveDataRoot } from "@fengagent/shared";
import { WebuiServiceImpl } from "../services.ts";
import type { WebuiService } from "../types.ts";
import { resolveWebuiPluginsRoot, WebuiRegistry } from "../webui.ts";

export interface WebuiPluginOptions {
  /** 插件根目录（默认 `<dataRoot>/plugins`） */
  pluginsRoot?: string;
}

/** WebUI 注册表插件 — 提供 ctx.webui */
export function webuiPlugin(options: WebuiPluginOptions = {}) {
  return function webuiPluginEntry(ctx: Context) {
    const registry = new WebuiRegistry(options.pluginsRoot ?? resolveWebuiPluginsRoot(resolveDataRoot()));
    const service = new WebuiServiceImpl(ctx, registry);
    return service as WebuiService;
  };
}
