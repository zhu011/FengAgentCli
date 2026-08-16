/**
 * @fengagent/cordis — Agent Loop 插件
 *
 * 插件 id: feng.loop
 * agent loop 本身也是可插拔插件：它注入 model/tools/context/strategy/graph
 * 服务并驱动循环；换成别的 loop 实现（如 Graph 编排器）不会影响其他插件。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Config, SubagentRunner } from "@fengagent/core";
import { LoopServiceImpl } from "../services.ts";
import type { LoopService } from "../types.ts";

export interface LoopPluginOptions {
  config: Pick<Config, "maxTurns" | "maxTokens" | "temperature">;
  workdir: string;
  spawnSubagent?: SubagentRunner;
  agentDepth?: number;
}

/** Loop 插件 — 提供 ctx.loop */
export function loopPlugin(options: LoopPluginOptions) {
  function loopPluginEntry(ctx: Context) {
    const model = ctx.model;
    const tools = ctx.tools;
    const context = ctx.context;
    const strategy = ctx.strategy;
    const graph = ctx.graph;
    if (!model || !tools || !context || !strategy || !graph) {
      throw new Error(
        "loopPlugin requires services: model, tools, context, strategy, graph",
      );
    }
    const service = new LoopServiceImpl(ctx, {
      model,
      tools,
      context,
      strategy,
      graph,
      config: options.config,
      workdir: options.workdir,
      spawnSubagent: options.spawnSubagent,
      agentDepth: options.agentDepth,
    });
    return service as LoopService;
  }
  // 声明依赖注入：模型/工具/上下文/策略/图 服务就绪后才启动 loop 插件
  loopPluginEntry.inject = ["model", "tools", "context", "strategy", "graph"];
  return loopPluginEntry;
}
