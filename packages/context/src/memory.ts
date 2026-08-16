/**
 * @fengagent/context — MEMORY.md 记忆加载
 *
 * 从工作目录加载 MEMORY.md（max 200 行 / 25KB），
 * 以及数据根 `memory/` 目录下的分类记忆文件（新分支先读 `<dataRoot>/memory`，
 * 空则回退 main 的 `.fengagent/memory`，只读回退、绝不写入）。
 * 注入到系统提示供 Agent 使用。
 *
 * 参考 Hummingbird memdir 和 ARCHITECTURE.md 第 6.7 节。
 */

import { expandTilde, resolveDataRoot } from "@fengagent/shared";
import { join } from "node:path";

/** MEMORY.md 最大行数 */
export const MAX_MEMORY_LINES = 200;

/** MEMORY.md 最大字节数 */
export const MAX_MEMORY_BYTES = 25_000;

/** 记忆文件分类 */
export type MemoryCategory = "project" | "user" | "technical";

/** 所有合法分类 */
export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "project",
  "user",
  "technical",
] as const;

/** main 记忆目录路径（相对工作目录，只读回退） */
export const MEMORY_DIR = ".fengagent/memory";

/** MEMORY.md 文件名 */
export const MEMORY_FILE = "MEMORY.md";

/** MEMORY.md 截断结果 */
export interface MemoryTruncation {
  content: string;
  lineCount: number;
  byteCount: number;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
}

/**
 * 截断 MEMORY.md 内容到行数和字节上限。
 * 先按行截断（自然边界），再按字节截断到最后一个换行符。
 */
export function truncateMemoryContent(raw: string): MemoryTruncation {
  const trimmed = raw.trim();
  const contentLines = trimmed.split("\n");
  const lineCount = contentLines.length;
  const byteCount = trimmed.length;

  const wasLineTruncated = lineCount > MAX_MEMORY_LINES;
  const wasByteTruncated = byteCount > MAX_MEMORY_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    };
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_MEMORY_LINES).join("\n")
    : trimmed;

  if (Buffer.byteLength(truncated, "utf-8") > MAX_MEMORY_BYTES) {
    // 按字节截断到最后的换行符
    const buf = Buffer.from(truncated, "utf-8");
    if (buf.length > MAX_MEMORY_BYTES) {
      const slice = buf.subarray(0, MAX_MEMORY_BYTES).toString("utf-8");
      const lastNewline = slice.lastIndexOf("\n");
      truncated = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
    }
  }

  return {
    content: truncated,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  };
}

/** 记忆目录文件扫描结果 */
export interface MemoryDirEntry {
  /** 文件名（不含路径） */
  filename: string;
  /** 分类 */
  category: MemoryCategory;
  /** 文件内容 */
  content: string;
}

/** 记忆加载结果 */
export interface LoadedMemory {
  /** MEMORY.md 原始内容（截断后） */
  memoryMd: MemoryTruncation | null;
  /** 记忆目录下的文件 */
  dirEntries: MemoryDirEntry[];
  /** 组装后的系统提示片段 */
  prompt: string;
}

/**
 * 从分类名推断记忆分类。
 * 文件名前缀或目录名匹配时返回对应分类，否则默认 "project"。
 */
export function inferCategory(filename: string): MemoryCategory {
  const lower = filename.toLowerCase();
  if (lower.startsWith("user") || lower.includes("/user")) return "user";
  if (lower.startsWith("tech") || lower.includes("/tech")) return "technical";
  return "project";
}

/** 异步读取文件内容，文件不存在或读取失败时返回 null */
async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    const expanded = expandTilde(filePath);
    const file = Bun.file(expanded);
    if (await file.exists()) {
      return await file.text();
    }
  } catch {
    // 文件不存在或读取失败 — 忽略
  }
  return null;
}

/** 异步列出目录下的 .md 文件名 */
async function listMdFiles(dirPath: string): Promise<string[]> {
  try {
    const expanded = expandTilde(dirPath);
    // 使用 node:fs 的 readdir 列出目录内容
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(expanded, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 加载 MEMORY.md 和数据根 `memory/` 目录下的记忆文件。
 *
 * @param workdir - 工作目录
 * @returns 组装后的记忆提示片段
 */
export async function loadMemory(workdir: string): Promise<LoadedMemory> {
  const parts: string[] = [];
  const dirEntries: MemoryDirEntry[] = [];

  // 1. 加载 MEMORY.md
  const memoryMdPath = join(workdir, MEMORY_FILE);
  const rawMd = await readFileSafe(memoryMdPath);
  let memoryMd: MemoryTruncation | null = null;

  if (rawMd && rawMd.trim()) {
    memoryMd = truncateMemoryContent(rawMd);
    parts.push(`## Memory (MEMORY.md)`);
    parts.push("");
    parts.push(memoryMd.content);
    if (memoryMd.wasLineTruncated || memoryMd.wasByteTruncated) {
      parts.push("");
      parts.push(
        `> ⚠️ MEMORY.md 已截断（行数或字节超限）。请精简内容，将详情移至记忆目录下的独立文件。`,
      );
    }
  }

  // 2. 加载数据根 memory/ 目录下的文件（新分支先读 <dataRoot>/memory，
  //    空则回退 main 的 .fengagent/memory — 只读回退、绝不写入）
  const dataRoot = resolveDataRoot({ workdir });
  const cordisMemDir = join(dataRoot, "memory");
  const mainMemDir = join(workdir, MEMORY_DIR);

  let memDirPath = cordisMemDir;
  if ((await listMdFiles(cordisMemDir)).length === 0) {
    memDirPath = mainMemDir;
  }
  const mdFiles = await listMdFiles(memDirPath);

  if (mdFiles.length > 0) {
    // 分类标签
    const categorized: Record<MemoryCategory, MemoryDirEntry[]> = {
      project: [],
      user: [],
      technical: [],
    };

    for (const filename of mdFiles) {
      if (filename === MEMORY_FILE) continue; // MEMORY.md 已单独处理
      const filePath = join(memDirPath, filename);
      const content = await readFileSafe(filePath);
      if (content && content.trim()) {
        const entry: MemoryDirEntry = {
          filename,
          category: inferCategory(filename),
          content: content.trim(),
        };
        dirEntries.push(entry);
        categorized[entry.category].push(entry);
      }
    }

    // 按分类输出
    for (const cat of MEMORY_CATEGORIES) {
      const entries = categorized[cat];
      if (entries.length === 0) continue;

      parts.push("");
      parts.push(`### ${cat} memories`);
      parts.push("");
      for (const entry of entries) {
        parts.push(`#### ${entry.filename}`);
        parts.push("");
        parts.push(entry.content);
        parts.push("");
      }
    }
  }

  const prompt = parts.length > 0 ? parts.join("\n") : "";

  return {
    memoryMd,
    dirEntries,
    prompt,
  };
}

/**
 * 构建记忆系统提示片段。
 * 如果没有记忆文件，返回空字符串。
 */
export async function buildMemoryPrompt(workdir: string): Promise<string> {
  const { prompt } = await loadMemory(workdir);
  return prompt;
}
