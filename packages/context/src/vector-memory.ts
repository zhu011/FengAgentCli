/**
 * @fengagent/context — 向量检索记忆
 *
 * 基于 TF-IDF 的本地向量记忆系统。
 * 对话结束后保存关键信息，新对话开始时检索相关记忆。
 *
 * 可选后端：
 * - 本地 TF-IDF（默认，零外部依赖）
 * - 外部 embeddings API（通过 EmbeddingsProvider 接口注入）
 *
 * 存储格式：JSON 文件（`<dataRoot>/memory/vector-store.json`，dataRoot 见 resolveDataRoot；
 * 新分支记忆写入只落数据根，不写 main 的 `.fengagent/memory`）
 *
 * 参考 hermes-agent memory_manager 和 ARCHITECTURE.md 第 6.7 节。
 */

import { join } from "node:path";
import { expandTilde, resolveDataRoot } from "@fengagent/shared";
import { generateId } from "@fengagent/shared/utils";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

/** 记忆条目 */
export interface MemoryEntry {
  /** 唯一 ID */
  id: string;
  /** 记忆内容 */
  content: string;
  /** 分类标签 */
  category: string;
  /** 创建时间戳 */
  createdAt: number;
  /** TF-IDF 向量（维度 = 词汇表大小，仅存储非零项） */
  vector: Record<string, number>;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/** 搜索结果 */
export interface MemorySearchResult {
  /** 记忆条目 */
  entry: MemoryEntry;
  /** 相似度分数（0~1） */
  score: number;
}

/** Embeddings 提供者接口（可选，外部注入） */
export interface EmbeddingsProvider {
  /** 将文本向量化 */
  embed(text: string): Promise<number[]>;
}

/** 向量存储数据（序列化到 JSON） */
interface VectorStoreData {
  entries: MemoryEntry[];
  /** 词汇表（word → 索引，TF-IDF 模式专用） */
  vocabulary: Record<string, number>;
  /** 每个词的文档频率 */
  docFrequency: Record<string, number>;
  /** 总文档数 */
  totalDocs: number;
}

// ──────────────────────────────────────────────
// TF-IDF 实现
// ──────────────────────────────────────────────

/** 分词：小写化 + 按非字母数字分割 */
export function tokenize(text: string): string[] {
  if (!text || typeof text !== "string") return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length > 0);
}

/** 计算词频（Term Frequency） */
export function computeTermFrequency(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const token of tokens) {
    tf[token] = (tf[token] ?? 0) + 1;
  }
  // 归一化
  const total = tokens.length;
  if (total > 0) {
    for (const key of Object.keys(tf)) {
      tf[key] = (tf[key] ?? 0) / total;
    }
  }
  return tf;
}

/**
 * 计算 TF-IDF 向量。
 *
 * @param tokens - 分词结果
 * @param docFrequency - 每个词的文档频率
 * @param totalDocs - 总文档数
 * @returns TF-IDF 向量（稀疏表示）
 */
export function computeTfIdf(
  tokens: string[],
  docFrequency: Record<string, number>,
  totalDocs: number,
): Record<string, number> {
  const tf = computeTermFrequency(tokens);
  const vector: Record<string, number> = {};

  for (const [word, tfVal] of Object.entries(tf)) {
    const df = docFrequency[word] ?? 0;
    if (df === 0) {
      // 新词：给一个小的 IDF 值（假设出现在 1 个文档中）
      const idf = Math.log((totalDocs + 1) / 1) + 1;
      vector[word] = tfVal * idf;
    } else {
      const idf = Math.log((totalDocs + 1) / (df + 1)) + 1;
      vector[word] = tfVal * idf;
    }
  }

  // L2 归一化
  const norm = Math.sqrt(
    Object.values(vector).reduce((sum, v) => sum + v * v, 0),
  );
  if (norm > 0) {
    for (const key of Object.keys(vector)) {
      vector[key] = (vector[key] ?? 0) / norm;
    }
  }

  return vector;
}

/**
 * 计算两个稀疏向量的余弦相似度。
 */
export function cosineSimilarity(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  // 取较小向量的键遍历
  const [smaller, larger] =
    Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];

  let dotProduct = 0;
  for (const [key, val] of Object.entries(smaller)) {
    const otherVal = larger[key];
    if (otherVal !== undefined) {
      dotProduct += val * otherVal;
    }
  }

  // 向量已 L2 归一化，cosine = dotProduct
  return dotProduct;
}

// ──────────────────────────────────────────────
// 向量记忆存储
// ──────────────────────────────────────────────

/** 向量记忆存储选项 */
export interface VectorMemoryOptions {
  /** 工作目录 */
  workdir: string;
  /** 可选的 embeddings 提供者（注入后使用外部 API） */
  embeddingsProvider?: EmbeddingsProvider;
  /** 存储文件名（默认 vector-store.json） */
  storeFilename?: string;
}

/**
 * 创建向量记忆存储实例。
 *
 * 职责：
 * - `save()` — 保存记忆条目（自动向量化）
 * - `search()` — 搜索相关记忆（余弦相似度）
 * - `list()` — 列出所有记忆
 * - `delete()` — 删除记忆条目
 * - `load()` — 从磁盘加载
 * - `persist()` — 持久化到磁盘
 */
export function createVectorMemory(options: VectorMemoryOptions) {
  const storePath = join(
    resolveDataRoot({ workdir: options.workdir }),
    "memory",
    options.storeFilename ?? "vector-store.json",
  );

  let data: VectorStoreData = {
    entries: [],
    vocabulary: {},
    docFrequency: {},
    totalDocs: 0,
  };

  /** 从磁盘加载 */
  async function load(): Promise<void> {
    try {
      const expanded = expandTilde(storePath);
      const file = Bun.file(expanded);
      if (await file.exists()) {
        const text = await file.text();
        const parsed = JSON.parse(text) as VectorStoreData;
        data = {
          entries: parsed.entries ?? [],
          vocabulary: parsed.vocabulary ?? {},
          docFrequency: parsed.docFrequency ?? {},
          totalDocs: parsed.totalDocs ?? 0,
        };
      }
    } catch {
      // 文件不存在或解析失败 — 使用空存储
    }
  }

  /** 持久化到磁盘 */
  async function persist(): Promise<void> {
    try {
      const expanded = expandTilde(storePath);
      // 确保目录存在
      const { mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(expanded), { recursive: true });

      const json = JSON.stringify(data, null, 2);
      await Bun.write(expanded, json);
    } catch {
      // 持久化失败 — 忽略（内存中仍可用）
    }
  }

  /**
   * 保存一条记忆。
   *
   * @param content - 记忆内容
   * @param category - 分类
   * @param metadata - 额外元数据
   * @returns 创建的记忆条目
   */
  async function save(
    content: string,
    category: string,
    metadata?: Record<string, unknown>,
  ): Promise<MemoryEntry> {
    // 防御空值：content 可能为 undefined/null/空字符串
    const safeContent = content ?? "";
    const safeCategory = category ?? "general";
    let vector: Record<string, number>;

    if (options.embeddingsProvider) {
      // 使用外部 embeddings API
      const denseVector = await options.embeddingsProvider.embed(safeContent);
      vector = denseToSparse(denseVector);
    } else {
      // 使用本地 TF-IDF
      const tokens = tokenize(safeContent);
      vector = computeTfIdf(tokens, data.docFrequency, data.totalDocs);
    }

    const entry: MemoryEntry = {
      id: generateId(),
      content: safeContent,
      category: safeCategory,
      createdAt: Date.now(),
      vector,
      metadata,
    };

    // 更新文档频率
    if (!options.embeddingsProvider) {
      const tokens = tokenize(safeContent);
      const uniqueTokens = new Set(tokens);
      for (const token of uniqueTokens) {
        data.docFrequency[token] = (data.docFrequency[token] ?? 0) + 1;
        if (!(token in data.vocabulary)) {
          data.vocabulary[token] = Object.keys(data.vocabulary).length;
        }
      }
      data.totalDocs += 1;
    }

    data.entries.push(entry);
    await persist();

    return entry;
  }

  /**
   * 搜索相关记忆。
   *
   * @param query - 查询文本
   * @param limit - 返回条数上限（默认 5）
   * @param minScore - 最小相似度阈值（默认 0.01）
   * @returns 按相似度降序排列的结果
   */
  async function search(
    query: string,
    limit = 5,
    minScore = 0.01,
  ): Promise<MemorySearchResult[]> {
    if (data.entries.length === 0) {
      return [];
    }

    // 防御空值：query 可能为 undefined/null/空字符串
    const safeQuery = query ?? "";
    let queryVector: Record<string, number>;

    if (options.embeddingsProvider) {
      const denseVector = await options.embeddingsProvider.embed(safeQuery);
      queryVector = denseToSparse(denseVector);
    } else {
      const tokens = tokenize(safeQuery);
      queryVector = computeTfIdf(tokens, data.docFrequency, data.totalDocs);
    }

    const results: MemorySearchResult[] = data.entries
      .map((entry) => ({
        entry,
        score: cosineSimilarity(queryVector, entry.vector),
      }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return results;
  }

  /** 列出所有记忆条目 */
  function list(): MemoryEntry[] {
    return [...data.entries];
  }

  /** 删除指定记忆 */
  async function remove(id: string): Promise<boolean> {
    const idx = data.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    data.entries.splice(idx, 1);
    await persist();
    return true;
  }

  /** 清空所有记忆 */
  async function clear(): Promise<void> {
    data = {
      entries: [],
      vocabulary: {},
      docFrequency: {},
      totalDocs: 0,
    };
    await persist();
  }

  /** 获取条目数量 */
  function size(): number {
    return data.entries.length;
  }

  return {
    load,
    persist,
    save,
    search,
    list,
    delete: remove,
    clear,
    size,
  };
}

/** 向量记忆存储实例类型 */
export type VectorMemory = ReturnType<typeof createVectorMemory>;

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

/** 将稠密向量转换为稀疏表示（只保留非零项，以索引为键） */
function denseToSparse(vector: number[]): Record<string, number> {
  const sparse: Record<string, number> = {};
  for (let i = 0; i < vector.length; i++) {
    const val = vector[i]!;
    if (val !== 0) {
      sparse[String(i)] = val;
    }
  }
  return sparse;
}

/**
 * 从对话历史中提取关键信息用于保存。
 *
 * 这是一个启发式提取器：提取最后几轮对话的文本内容，
 * 裁剪到合理长度后返回。未来可扩展为 LLM 驱动提取。
 *
 * @param messages - 对话消息
 * @param maxEntries - 最大提取条数（默认 3）
 * @returns 提取的记忆文本数组
 */
export function extractMemoriesFromConversation(
  messages: { role: string; content: { type: string; text?: string }[] }[],
  maxEntries = 3,
): string[] {
  const result: string[] = [];

  // 从最近的对话开始向前扫描
  for (let i = messages.length - 1; i >= 0 && result.length < maxEntries; i--) {
    const msg = messages[i];
    if (!msg) continue;

    const textParts = msg.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);

    const fullText = textParts.join(" ").trim();
    if (fullText.length < 10) continue; // 跳过过短内容

    // 截断到 500 字符
    const truncated =
      fullText.length > 500 ? fullText.slice(0, 500) + "..." : fullText;

    result.push(`[${msg.role}] ${truncated}`);
  }

  return result.reverse();
}

/**
 * 构建向量记忆检索的系统提示片段。
 * 在新对话开始时调用，检索与查询相关的记忆。
 *
 * @param store - 向量记忆存储实例
 * @param query - 查询文本（通常是用户的第一条消息）
 * @param limit - 返回条数上限
 * @returns 系统提示片段（无记忆时返回空字符串）
 */
export async function buildVectorMemoryPrompt(
  store: VectorMemory,
  query: string,
  limit = 5,
): Promise<string> {
  const results = await store.search(query, limit);
  if (results.length === 0) {
    return "";
  }

  const lines: string[] = ["## Relevant Memories (vector retrieval)"];
  lines.push("");

  for (const { entry, score } of results) {
    lines.push(
      `### ${entry.category} (score: ${score.toFixed(3)}, ${new Date(entry.createdAt).toISOString()})`,
    );
    lines.push("");
    lines.push(entry.content);
    lines.push("");
  }

  return lines.join("\n");
}
