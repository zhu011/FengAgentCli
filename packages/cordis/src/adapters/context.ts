/**
 * @fengagent/cordis — 上下文插件（适配既有 @fengagent/context）
 *
 * 插件 id: feng.context
 * 把 ContextManager（压缩 / 记忆 / 系统上下文）包装成 Cordis 的 context 服务。
 * 上下文管理策略完全可插拔：换一个 manager 实现即可。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ContextManager } from "@fengagent/context";
import { ContextServiceImpl } from "../services.ts";
import type { ContextService } from "../types.ts";

export interface ContextPluginOptions {
  manager: ContextManager;
}

/** 上下文插件 — 提供 ctx.context */
export function contextPlugin(options: ContextPluginOptions) {
  return function contextPluginEntry(ctx: Context) {
    const service = new ContextServiceImpl(ctx, options.manager);
    return service as ContextService;
  };
}
