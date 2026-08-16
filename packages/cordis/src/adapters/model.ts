/**
 * @fengagent/cordis — 模型插件（适配既有 @fengagent/llm）
 *
 * 插件 id: feng.model
 * 把 LLMClient（含 ReloadableLLMClient 热切换）包装成 Cordis 的 model 服务。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { LLMClient } from "@fengagent/llm";
import { ReloadableLLMClient } from "@fengagent/llm";
import { ModelServiceImpl } from "../services.ts";
import type { ModelPluginConfig, ModelService } from "../types.ts";

export interface ModelPluginOptions extends ModelPluginConfig {
  /** 已构造好的 client（优先于 createClient 工厂） */
  client?: LLMClient;
  /** 切换 provider 时的重解析（/provider、/model 命令底座） */
  onSwitch?: (provider: string, model: string) => LLMClient | Promise<LLMClient>;
}

/**
 * 模型插件 — 提供 ctx.model。
 *
 * 若传入的 client 已是 ReloadableLLMClient（CLI 热切换场景），直接复用同一实例，
 * 避免双重包装导致热切换时外层引用不更新；否则包装一次以支持 onSwitch。
 */
export function modelPlugin(options: ModelPluginOptions) {
  return function modelPluginEntry(ctx: Context) {
    const reloadable =
      options.client instanceof ReloadableLLMClient
        ? options.client
        : new ReloadableLLMClient(
            options.client ??
              options.createClient?.({
                provider: options.provider,
                model: options.model,
              }) ??
              (() => {
                throw new Error(
                  `modelPlugin: no client and no createClient factory for provider "${options.provider}"`,
                );
              })(),
          );

    const service = new ModelServiceImpl(
      ctx,
      {
        provider: options.provider,
        model: options.model,
        client: reloadable,
        onSwitch: options.onSwitch
          ? (provider, model) => {
              const next = options.onSwitch!(provider, model);
              if (next && typeof (next as Promise<LLMClient>).then === "function") {
                return (next as Promise<LLMClient>).then((client) => {
                  reloadable.setClient(client);
                  return reloadable;
                });
              }
              reloadable.setClient(next as LLMClient);
              return reloadable;
            }
          : undefined,
      },
    );

    // Service 构造器已通过 ctx.reflect.provide 注册，随插件卸载自动注销
    return service as ModelService;
  };
}
