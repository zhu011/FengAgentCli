/**
 * @fengagent/cordis — Cordis 运行时引导
 *
 * createRuntime() 创建 Cordis 根上下文，按配置逐条加载插件。
 * 插件即积木：内置注册表（feng.*）+ 用户插件路径（.fengagent/plugins/*）。
 */

import { Context, type Plugin } from "@deepseek-ai/cordis";
import { modelPlugin } from "./adapters/model.ts";
import { toolPlugin } from "./adapters/tool.ts";
import { contextPlugin } from "./adapters/context.ts";
import { storagePlugin } from "./adapters/storage.ts";
import { strategyPlugin } from "./adapters/strategy.ts";
import { loopPlugin } from "./adapters/loop.ts";
import { graphPlugin } from "./adapters/graph.ts";
import { BUILTIN_PLUGINS, type FengRuntime, type FengRuntimeConfig, type RuntimePluginEntry } from "./types.ts";

/** 内置插件注册表 — 插件 id → 插件工厂（config 驱动） */
export type BuiltinPluginFactory = (config: Record<string, unknown>) => Plugin;

export const BUILTIN_PLUGIN_REGISTRY: Record<string, BuiltinPluginFactory> = {
  [BUILTIN_PLUGINS.MODEL]: (config) =>
    modelPlugin({
      provider: String(config.provider ?? "openai-compatible"),
      model: String(config.model ?? "deepseek-chat"),
      client: config.client as never,
      createClient: config.createClient as never,
      onSwitch: config.onSwitch as never,
    }),
  [BUILTIN_PLUGINS.TOOLS]: (config) =>
    toolPlugin({
      tools: config.tools as never,
      registry: config.registry as never,
    }),
  [BUILTIN_PLUGINS.CONTEXT]: (config) =>
    contextPlugin({ manager: config.manager as never }),
  [BUILTIN_PLUGINS.STORAGE]: (config) =>
    storagePlugin({
      dbPath: config.dbPath as string | undefined,
      sessionStore: config.sessionStore as never,
      graph: config.graph as never,
      graphPath: config.graphPath as string | undefined,
    }),
  [BUILTIN_PLUGINS.STRATEGY]: (config) =>
    strategyPlugin({
      contextWindow: config.contextWindow as number | undefined,
      compactThreshold: config.compactThreshold as number | undefined,
      overrides: config.overrides as never,
    }),
  [BUILTIN_PLUGINS.LOOP]: (config) =>
    loopPlugin({
      config: config.config as never,
      workdir: String(config.workdir ?? "."),
      spawnSubagent: config.spawnSubagent as never,
      agentDepth: config.agentDepth as number | undefined,
    }),
  [BUILTIN_PLUGINS.GRAPH]: (config) =>
    graphPlugin({ store: config.store as never }),
};

/** 创建 Cordis 运行时 */
export function createRuntime(config: FengRuntimeConfig): FengRuntime {
  const ctx = new Context();
  let started = false;
  const disposers: Array<() => Promise<void>> = [];

  async function start(): Promise<void> {
    if (started) return;
    for (const entry of config.plugins) {
      // resolvePluginFactory 已把配置注入插件工厂，返回配置好的插件入口函数
      const plugin = resolvePluginFactory(entry);
      // ctx.plugin() 返回 fiber（可等待加载完成、可 dispose 卸载）
      const fiber = ctx.plugin(plugin);
      disposers.push(() => fiber.dispose());
      await fiber;
    }
    started = true;
  }

  async function stop(): Promise<void> {
    if (!started) return;
    // 逆序卸载全部插件（disposer 逆序执行）
    for (const dispose of [...disposers].reverse()) {
      await dispose().catch(() => {});
    }
    disposers.length = 0;
    started = false;
  }

  return {
    ctx,
    start,
    stop,
    get started() {
      return started;
    },
  };
}

/** 解析插件工厂：内置注册表优先，否则尝试用户插件模块 */
function resolvePluginFactory(entry: RuntimePluginEntry): Plugin {
  const builtin = BUILTIN_PLUGIN_REGISTRY[entry.id];
  if (builtin) return builtin(entry.config ?? {});
  // 用户插件：id 为模块路径（.fengagent/plugins/<name>），动态导入
  return async (ctx: Context) => {
    const mod = await import(/* @vite-ignore */ String(entry.id));
    const plugin = mod.default ?? mod;
    await ctx.plugin(plugin, entry.config ?? {});
  };
}
