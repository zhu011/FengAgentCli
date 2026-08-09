/**
 * @fengagent/context — 上下文管理
 *
 * 上下文窗口管理、对话压缩、系统上下文加载、Token 估算。
 * 参考 PRD 第 4.2.5 节和 ARCHITECTURE.md 第 3 节。
 */

// Token 估算
export {
  countTokensInText,
  countTokensInBlock,
  countTokensInMessage,
  countTokensInMessages,
} from "./token-counter.ts";

// 系统上下文
export { loadSystemContext } from "./system-context.ts";
export type { SystemContextOptions } from "./system-context.ts";

// 记忆系统
export {
  loadMemory,
  buildMemoryPrompt,
  truncateMemoryContent,
  inferCategory,
  MAX_MEMORY_LINES,
  MAX_MEMORY_BYTES,
  MEMORY_DIR,
  MEMORY_FILE,
  MEMORY_CATEGORIES,
} from "./memory.ts";
export type {
  MemoryCategory,
  MemoryTruncation,
  MemoryDirEntry,
  LoadedMemory,
} from "./memory.ts";

export {
  createVectorMemory,
  tokenize,
  computeTermFrequency,
  computeTfIdf,
  cosineSimilarity,
  extractMemoriesFromConversation,
  buildVectorMemoryPrompt,
} from "./vector-memory.ts";
export type {
  MemoryEntry,
  MemorySearchResult,
  EmbeddingsProvider,
  VectorMemoryOptions,
  VectorMemory,
} from "./vector-memory.ts";

// 压缩引擎
export { compact, findCutPoint } from "./compaction.ts";
export type {
  CompactionOptions,
  CompactionResult,
  SummaryGenerator,
} from "./compaction.ts";

// 上下文管理器
export { createContextManager } from "./manager.ts";
export type {
  ContextManager,
  ContextManagerOptions,
  AssembledContext,
} from "./manager.ts";
