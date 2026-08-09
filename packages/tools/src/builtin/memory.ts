/**
 * @fengagent/tools — memory 内置工具
 *
 * 提供记忆保存、搜索、列表三个工具，供 Agent 在对话中使用。
 *
 * - `memory-save`：保存记忆条目到向量存储
 * - `memory-search`：搜索相关记忆（向量检索）
 * - `memory-list`：列出所有记忆条目
 *
 * 记忆存储路径：`.fengagent/memory/vector-store.json`
 * 参考 ARCHITECTURE.md 第 6.7 节。
 */

import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "@fengagent/core/tool";
import { ALLOW } from "@fengagent/core/permission";
import { z } from "zod";
import {
  createVectorMemory,
  type VectorMemory,
} from "@fengagent/context/vector-memory";

// ──────────────────────────────────────────────
// 共享：向量存储实例管理
// ──────────────────────────────────────────────

/**
 * 获取或创建工作目录对应的向量存储实例。
 * 缓存实例避免重复加载。
 */
const storeCache = new Map<string, VectorMemory>();

async function getStore(workdir: string): Promise<VectorMemory> {
  let store = storeCache.get(workdir);
  if (!store) {
    store = createVectorMemory({ workdir });
    await store.load();
    storeCache.set(workdir, store);
  }
  return store;
}

// ──────────────────────────────────────────────
// memory-save 工具
// ──────────────────────────────────────────────

const saveSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe("The memory content to save"),
  category: z
    .string()
    .describe("Memory category: project, user, technical, or custom"),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional metadata key-value pairs"),
});

type SaveInput = z.infer<typeof saveSchema>;

export const memorySave: ToolDefinition<SaveInput> = {
  name: "memory-save",
  description: [
    "Save a memory entry to the local vector memory store.",
    "The content will be vectorized (TF-IDF) and persisted to disk.",
    "Use this to persist important information for future conversations.",
  ].join("\n"),

  inputSchema: saveSchema,

  isReadOnly(): boolean {
    return false;
  },

  isDestructive(): boolean {
    return false;
  },

  isConcurrencySafe(): boolean {
    return false;
  },

  checkPermissions() {
    return ALLOW;
  },

  async execute(input: SaveInput, context: ToolContext): Promise<ToolResult> {
    try {
      const store = await getStore(context.workdir);
      const entry = await store.save(
        input.content,
        input.category,
        input.metadata,
      );

      return {
        content: `Memory saved successfully.\nID: ${entry.id}\nCategory: ${entry.category}\nContent: ${entry.content.length > 100 ? entry.content.slice(0, 100) + "..." : entry.content}`,
        metadata: {
          id: entry.id,
          category: entry.category,
          createdAt: entry.createdAt,
          totalMemories: store.size(),
        },
      };
    } catch (err) {
      return {
        content: `Error saving memory: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },

  renderUse(input: SaveInput): string {
    return `memory-save: [${input.category}] ${input.content.slice(0, 60)}${input.content.length > 60 ? "..." : ""}`;
  },
};

// ──────────────────────────────────────────────
// memory-search 工具
// ──────────────────────────────────────────────

const searchSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Search query text"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe("Maximum number of results to return (default 5)"),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.01)
    .describe("Minimum similarity score threshold (default 0.01)"),
});

type SearchInput = z.input<typeof searchSchema>;

export const memorySearch: ToolDefinition<SearchInput> = {
  name: "memory-search",
  description: [
    "Search the vector memory store for relevant memories.",
    "Uses TF-IDF cosine similarity to find the most relevant entries.",
    "Returns matching memories with similarity scores.",
  ].join("\n"),

  inputSchema: searchSchema,

  isReadOnly(): boolean {
    return true;
  },

  isDestructive(): boolean {
    return false;
  },

  isConcurrencySafe(): boolean {
    return true;
  },

  checkPermissions() {
    return ALLOW;
  },

  async execute(input: SearchInput, context: ToolContext): Promise<ToolResult> {
    try {
      const store = await getStore(context.workdir);
      const results = await store.search(
        input.query,
        input.limit,
        input.minScore,
      );

      if (results.length === 0) {
        return {
          content: "No matching memories found.",
          metadata: { resultCount: 0 },
        };
      }

      const lines: string[] = [`Found ${results.length} matching memor${results.length === 1 ? "y" : "ies"}:`];
      lines.push("");

      for (const { entry, score } of results) {
        lines.push(`─── ${entry.id} ───`);
        lines.push(`Category: ${entry.category}`);
        lines.push(`Score: ${score.toFixed(3)}`);
        lines.push(`Created: ${new Date(entry.createdAt).toISOString()}`);
        lines.push(`Content: ${entry.content}`);
        lines.push("");
      }

      return {
        content: lines.join("\n"),
        metadata: {
          resultCount: results.length,
          results: results.map((r) => ({
            id: r.entry.id,
            category: r.entry.category,
            score: r.score,
          })),
        },
      };
    } catch (err) {
      return {
        content: `Error searching memories: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },

  renderUse(input: SearchInput): string {
    return `memory-search: "${input.query}" (limit ${input.limit})`;
  },
};

// ──────────────────────────────────────────────
// memory-list 工具
// ──────────────────────────────────────────────

const listSchema = z.object({
  category: z
    .string()
    .optional()
    .describe("Filter by category (omit to list all)"),
});

type ListInput = z.infer<typeof listSchema>;

export const memoryList: ToolDefinition<ListInput> = {
  name: "memory-list",
  description: [
    "List all stored memory entries, optionally filtered by category.",
    "Returns IDs, categories, and content previews.",
  ].join("\n"),

  inputSchema: listSchema,

  isReadOnly(): boolean {
    return true;
  },

  isDestructive(): boolean {
    return false;
  },

  isConcurrencySafe(): boolean {
    return true;
  },

  checkPermissions() {
    return ALLOW;
  },

  async execute(input: ListInput, context: ToolContext): Promise<ToolResult> {
    try {
      const store = await getStore(context.workdir);
      let entries = store.list();

      if (input.category) {
        entries = entries.filter((e) => e.category === input.category);
      }

      if (entries.length === 0) {
        return {
          content: input.category
            ? `No memories found in category "${input.category}".`
            : "No memories stored yet.",
          metadata: { totalCount: 0 },
        };
      }

      // 按创建时间降序
      entries.sort((a, b) => b.createdAt - a.createdAt);

      const lines: string[] = [`Total: ${entries.length} memor${entries.length === 1 ? "y" : "ies"}`];
      lines.push("");

      for (const entry of entries) {
        const preview =
          entry.content.length > 80
            ? entry.content.slice(0, 80) + "..."
            : entry.content;
        lines.push(`[${entry.id}] (${entry.category}) ${preview}`);
      }

      return {
        content: lines.join("\n"),
        metadata: {
          totalCount: entries.length,
          entries: entries.map((e) => ({
            id: e.id,
            category: e.category,
            createdAt: e.createdAt,
            contentLength: e.content.length,
          })),
        },
      };
    } catch (err) {
      return {
        content: `Error listing memories: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },

  renderUse(input: ListInput): string {
    return input.category
      ? `memory-list: category=${input.category}`
      : "memory-list: all";
  },
};
