/**
 * @fengagent/dsh-compat — dsh 插件兼容层（P1/M1）
 *
 * 让 tools-only dsh 插件直接装进 FengAgentCli 运行时：
 * - `apply` 补丁运行中的 tools 服务，`ctx.tools.register(defineTool(...))` 即插即用；
 * - 适配器把 dsh 工具定义（编译后 JSON Schema + render + execute）转成
 *   FengAgentCli 的 ToolDefinition，走与原生工具完全相同的注册/物化/执行管道；
 * - 本模块自身也是合法的 Cordis 对象插件（name/inject/apply），可经 runtime
 *   用户插件路径（`{ id: "..." }`）或 `ctx.plugin(dshCompatPlugin)` 装载。
 */

export {
  adaptDshTool,
  isDshToolDefinition,
  type DshToolDefinition,
} from "./adapter.ts";
export { name, inject, apply, dshCompatPlugin } from "./plugin.ts";
export { importDshPlugin, loadDshPlugin, type DshPluginModule } from "./loader.ts";
export { defineTool } from "@deepseek-ai/dsh-tools";
