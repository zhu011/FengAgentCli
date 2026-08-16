/**
 * @fengagent/cordis — Cordis 集成层
 *
 * 以 Cordis 为一等公民：模型、工具、策略、存储、上下文、agent loop、图
 * 全部插件化。此包提供：
 * - 插件域类型（types）
 * - Cordis 服务实现（services）
 * - 适配既有 @fengagent 模块的插件（adapters/*）
 * - 配置驱动的运行时引导（runtime）
 */

export * from "./types.ts";
export * from "./services.ts";
export * from "./runtime.ts";
export { modelPlugin } from "./adapters/model.ts";
export { toolPlugin } from "./adapters/tool.ts";
export { contextPlugin } from "./adapters/context.ts";
export { storagePlugin } from "./adapters/storage.ts";
export { strategyPlugin } from "./adapters/strategy.ts";
export { loopPlugin } from "./adapters/loop.ts";
export { graphPlugin } from "./adapters/graph.ts";

// 重新导出 Cordis 核心（让使用者直接从 @fengagent/cordis 拿 Context/Service）
export { Context, Service } from "@deepseek-ai/cordis";
export type { Plugin } from "@deepseek-ai/cordis";
