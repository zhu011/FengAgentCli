/**
 * @fengagent/cordis — 存储插件（适配既有 @fengagent/agent SessionStore）
 *
 * 插件 id: feng.storage
 * 把会话持久化（SQLite SessionStore）+ 图存储（GraphStore）包装成 Cordis 的
 * storage 服务。存储层可插拔：换 SQLite → JSONL → 数据库，行为不变。
 */

import type { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@fengagent/agent/session";
import type { GraphStore } from "@fengagent/graph";
import { MemoryGraphStore } from "@fengagent/graph";
import { StorageServiceImpl } from "../services.ts";
import type { SessionStoreLike, StorageService } from "../types.ts";
import { resolveDataRoot } from "@fengagent/shared";
import { join } from "node:path";

export interface StoragePluginOptions {
  /** SQLite 路径（默认 <dataRoot>/sessions.db） */
  dbPath?: string;
  /** 复用既有 SessionStore（或内存会话存储） */
  sessionStore?: SessionStoreLike;
  /** 图存储（默认 MemoryGraphStore + JSONL 落盘） */
  graph?: GraphStore;
  /** 图 JSONL 落盘路径 */
  graphPath?: string;
}

/** 存储插件 — 提供 ctx.storage */
export function storagePlugin(options: StoragePluginOptions = {}) {
  return function storagePluginEntry(ctx: Context) {
    const store =
      options.sessionStore ??
      new SessionStore(options.dbPath ?? join(resolveDataRoot(), "sessions.db"));
    const graph =
      options.graph ??
      new MemoryGraphStore({
        persistPath: options.graphPath ?? join(resolveDataRoot(), "graph.jsonl"),
      });
    const service = new StorageServiceImpl(ctx, store, { graph });
    return service as StorageService;
  };
}
