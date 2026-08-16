/**
 * @fengagent/cordis — 图插件
 *
 * 插件 id: feng.graph
 * 提供 ctx.graph 服务：对话可溯源 + 对话即节点 + 节点回答不佳可回退。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { GraphStore } from "@fengagent/graph";
import { MemoryGraphStore } from "@fengagent/graph";
import { GraphServiceImpl } from "../services.ts";
import type { GraphService } from "../types.ts";
import { resolveDataRoot } from "@fengagent/shared";
import { join } from "node:path";

export interface GraphPluginOptions {
  /** 图存储（默认内存 + JSONL 落盘 <dataRoot>/graph.jsonl） */
  store?: GraphStore;
  /** JSONL 落盘路径 */
  persistPath?: string;
}

/** 图插件 — 提供 ctx.graph */
export function graphPlugin(options: GraphPluginOptions = {}) {
  return function graphPluginEntry(ctx: Context) {
    const store =
      options.store ??
      new MemoryGraphStore({
        persistPath: options.persistPath ?? join(resolveDataRoot(), "graph.jsonl"),
      });
    const service = new GraphServiceImpl(ctx, store);
    return service as GraphService;
  };
}
