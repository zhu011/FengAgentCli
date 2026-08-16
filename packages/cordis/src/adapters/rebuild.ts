/**
 * @fengagent/cordis — 重建插件（Phase 3）
 *
 * 插件 id: feng.rebuild
 * 提供 ctx.rebuild 服务：「以事件为准重建」— SQLite 完全降级为读模型，
 * 从事件日志全量投影重写（含 title/status/meta，#3 不丢），脱双写依赖
 * （重建只读事件日志 + 写读模型，绝不追加事件）。
 *
 * 装配：config { store: EventStore, sessionStore: SessionStoreLike } —
 * sessionStore 传「裸读模型」（生产即 SessionStore，不传双写包装，
 * 保证重建路径与双写解耦）。
 */

import type { Context } from "@deepseek-ai/cordis";
import { EventStore } from "@fengagent/events";
import { RebuildServiceImpl } from "../services.ts";
import type { RebuildService, SessionStoreLike } from "../types.ts";

export interface RebuildPluginOptions {
  /** 事件日志存储（事实源，只读） */
  store: EventStore;
  /** 读模型（裸 SessionStore/SQLite；不传双写包装，脱双写依赖） */
  sessionStore: SessionStoreLike;
}

/** 重建插件 — 提供 ctx.rebuild */
export function rebuildPlugin(options: RebuildPluginOptions) {
  return function rebuildPluginEntry(ctx: Context) {
    const service = new RebuildServiceImpl(ctx, options.store, options.sessionStore);
    return service as RebuildService;
  };
}
