/**
 * @fengagent/group-plugin — dsh 侧装载入口（bundle 构建）
 *
 * `bun run build` 产出自包含单文件 `bundle/feng-group-plugin.mjs`（Node 可跑，
 * 无 bun:sqlite 依赖——便携 store），经 fengagent-compat 的 config.plugins
 * 装进 dsh。默认导出为函数插件（挂 inject: ["tools"]）。
 */
import groupPluginDefault from "./index.ts";

export default groupPluginDefault;
export const name = "group-plugin";
export { groupPlugin, PortableGroupStore } from "./index.ts";
