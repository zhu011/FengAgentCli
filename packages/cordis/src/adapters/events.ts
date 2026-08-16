/**
 * @fengagent/cordis — 事件插件（Phase 1）
 *
 * 插件 id: feng.events
 * 提供 ctx.eventLog 服务：事件日志写路径（每会话单文件 append-only）、
 * 重放读取、尾部半行崩溃自愈、运行时注册表（ctx.eventLog.register()）。
 *
 * 事件日志目录默认 <数据根>/events（resolveDataRoot）。
 * 命名说明：cordis 框架自带事件总线占用 ctx.events，故本服务挂 ctx.eventLog。
 */

import type { Context } from "@deepseek-ai/cordis";
import { EventStore } from "@fengagent/events";
import { EventsServiceImpl } from "../services.ts";
import type { EventService } from "../types.ts";
import { resolveDataRoot } from "@fengagent/shared";
import { join } from "node:path";

export interface EventsPluginOptions {
  /** 事件日志根目录（默认 <数据根>/events） */
  dir?: string;
  /** 复用 EventStore（自定义注册表/目录时传入） */
  store?: EventStore;
}

/** 事件插件 — 提供 ctx.eventLog */
export function eventsPlugin(options: EventsPluginOptions = {}) {
  return function eventsPluginEntry(ctx: Context) {
    const store =
      options.store ??
      new EventStore({
        dir: options.dir ?? join(resolveDataRoot(), "events"),
      });
    const service = new EventsServiceImpl(ctx, store);
    return service as EventService;
  };
}
