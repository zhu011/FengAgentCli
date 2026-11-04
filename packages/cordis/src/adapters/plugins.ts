/**
 * @fengagent/cordis — 插件管理面装载器
 *
 * 插件 id: feng.plugins
 * 提供 ctx.plugins 服务：`/api/plugins` 的装/卸/启停都走它（S2）。
 * 与 `feng.webui` 共用 `<dataRoot>/plugins` 与 `<dataRoot>/plugins.json`。
 */

import type { Context } from "@deepseek-ai/cordis";
import { resolveDataRoot } from "@fengagent/shared";
import { PluginManager } from "../plugin-manager.ts";
import { PluginsServiceImpl } from "../services.ts";
import type { PluginsService } from "../types.ts";

export interface PluginsPluginOptions {
  /** 数据根（缺省时按 resolveDataRoot()） */
  dataRoot?: string;
  /** 插件根目录（默认 `<dataRoot>/plugins`） */
  pluginsRoot?: string;
  /** 插件状态文件（默认 `<dataRoot>/plugins.json`） */
  stateFile?: string;
  /** 依赖安装命令覆盖（默认 bun；null 表示不装依赖） */
  installDepsCommand?: string | null;
  /** 启动装载失败查询（`PluginBootState.errors()`，列表并进 `error`） */
  bootErrors?: () => ReadonlyMap<string, string>;
}

/** 插件管理面 — 提供 ctx.plugins */
export function pluginsPlugin(options: PluginsPluginOptions = {}) {
  return function pluginsPluginEntry(ctx: Context) {
    const manager = new PluginManager({
      dataRoot: options.dataRoot ?? resolveDataRoot(),
      ...(options.pluginsRoot ? { pluginsRoot: options.pluginsRoot } : {}),
      ...(options.stateFile ? { stateFile: options.stateFile } : {}),
      ...(options.installDepsCommand === undefined ? {} : { installDepsCommand: options.installDepsCommand }),
      ...(options.bootErrors ? { bootErrors: options.bootErrors } : {}),
    });
    return new PluginsServiceImpl(ctx, manager) as PluginsService;
  };
}
