/**
 * @fengagent/cordis — 工具插件（适配既有 @fengagent/tools）
 *
 * 插件 id: feng.tools
 * 把 ToolRegistry 包装成 Cordis 的 tools 服务；工具本身也是可插拔积木，
 * 任何插件都可以通过 ctx.tools.register() 挂新工具。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ToolRegistry } from "@fengagent/tools";
import { createToolRegistry } from "@fengagent/tools";
import { ToolServiceImpl } from "../services.ts";
import type { ToolPluginConfig, ToolService } from "../types.ts";

export interface ToolPluginOptions extends ToolPluginConfig {
  /** 复用既有注册表（兼容现有调用方） */
  registry?: ToolRegistry;
}

/** 工具插件 — 提供 ctx.tools */
export function toolPlugin(options: ToolPluginOptions = {}) {
  return function toolPluginEntry(ctx: Context) {
    const registry = options.registry ?? createToolRegistry();
    const service = new ToolServiceImpl(ctx, registry);

    // 初始工具（内置工具由调用方注入）
    for (const tool of options.tools ?? []) {
      service.register(tool);
    }

    return service as ToolService;
  };
}
