/**
 * @fengagent/context — 记忆系统测试
 *
 * 测试 MEMORY.md 加载、截断、记忆目录、向量存储。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  truncateMemoryContent,
  inferCategory,
  loadMemory,
  buildMemoryPrompt,
  MAX_MEMORY_LINES,
  MAX_MEMORY_BYTES,
} from "../memory.ts";
import {
  createVectorMemory,
  tokenize,
  computeTermFrequency,
  computeTfIdf,
  cosineSimilarity,
  extractMemoriesFromConversation,
  buildVectorMemoryPrompt,
} from "../vector-memory.ts";
import { loadSystemContext } from "../system-context.ts";

// ──────────────────────────────────────────────
// 辅助：创建临时目录
// ──────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "feng-mem-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// MEMORY.md 截断
// ──────────────────────────────────────────────

describe("truncateMemoryContent", () => {
  test("短内容不截断", () => {
    const result = truncateMemoryContent("Hello world");
    expect(result.wasLineTruncated).toBe(false);
    expect(result.wasByteTruncated).toBe(false);
    expect(result.content).toBe("Hello world");
    expect(result.lineCount).toBe(1);
  });

  test("超过行数限制时截断", () => {
    const lines = Array.from({ length: MAX_MEMORY_LINES + 50 }, (_, i) => `Line ${i}`);
    const raw = lines.join("\n");
    const result = truncateMemoryContent(raw);
    expect(result.wasLineTruncated).toBe(true);
    expect(result.content.split("\n").length).toBe(MAX_MEMORY_LINES);
  });

  test("空内容返回空字符串", () => {
    const result = truncateMemoryContent("   \n  \n  ");
    expect(result.content).toBe("");
  });
});

// ──────────────────────────────────────────────
// 分类推断
// ──────────────────────────────────────────────

describe("inferCategory", () => {
  test("user 前缀 → user", () => {
    expect(inferCategory("user-preferences.md")).toBe("user");
  });

  test("tech 前缀 → technical", () => {
    expect(inferCategory("tech-notes.md")).toBe("technical");
  });

  test("其他 → project", () => {
    expect(inferCategory("architecture.md")).toBe("project");
  });
});

// ──────────────────────────────────────────────
// loadMemory
// ──────────────────────────────────────────────

describe("loadMemory", () => {
  test("无记忆文件时返回空提示", async () => {
    const { prompt, memoryMd, dirEntries } = await loadMemory(tmpDir);
    expect(prompt).toBe("");
    expect(memoryMd).toBeNull();
    expect(dirEntries).toHaveLength(0);
  });

  test("加载 MEMORY.md", async () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "# My Memory\n\n- Remember to use bun");

    const { prompt, memoryMd } = await loadMemory(tmpDir);
    expect(memoryMd).not.toBeNull();
    expect(memoryMd!.content).toContain("My Memory");
    expect(prompt).toContain("MEMORY.md");
    expect(prompt).toContain("bun");
  });

  test("加载记忆目录下的文件", async () => {
    mkdirSync(join(tmpDir, ".fengagent", "memory"), { recursive: true });
    writeFileSync(join(tmpDir, "MEMORY.md"), "# Index");
    writeFileSync(
      join(tmpDir, ".fengagent", "memory", "user-preferences.md"),
      "User prefers TypeScript",
    );
    writeFileSync(
      join(tmpDir, ".fengagent", "memory", "tech-stack.md"),
      "Using Bun runtime",
    );

    const { dirEntries, prompt } = await loadMemory(tmpDir);
    expect(dirEntries).toHaveLength(2);
    expect(prompt).toContain("user memories");
    expect(prompt).toContain("User prefers TypeScript");
    expect(prompt).toContain("technical memories");
    expect(prompt).toContain("Using Bun runtime");
  });

  test("截断超长 MEMORY.md", async () => {
    const longContent = "x".repeat(MAX_MEMORY_BYTES + 1000);
    writeFileSync(join(tmpDir, "MEMORY.md"), longContent);

    const { memoryMd } = await loadMemory(tmpDir);
    expect(memoryMd).not.toBeNull();
    expect(memoryMd!.wasByteTruncated).toBe(true);
  });
});

// ──────────────────────────────────────────────
// buildMemoryPrompt
// ──────────────────────────────────────────────

describe("buildMemoryPrompt", () => {
  test("返回非空字符串当记忆存在", async () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "# Test Memory");
    const prompt = await buildMemoryPrompt(tmpDir);
    expect(prompt).toContain("Test Memory");
  });

  test("返回空字符串当无记忆", async () => {
    const prompt = await buildMemoryPrompt(tmpDir);
    expect(prompt).toBe("");
  });
});

// ──────────────────────────────────────────────
// TF-IDF
// ──────────────────────────────────────────────

describe("tokenize", () => {
  test("英文分词", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
  });

  test("中文保留", () => {
    expect(tokenize("你好 world")).toEqual(["你好", "world"]);
  });

  test("空字符串", () => {
    expect(tokenize("")).toEqual([]);
  });

  test("特殊字符分割", () => {
    expect(tokenize("foo--bar__baz")).toEqual(["foo", "bar", "baz"]);
  });

  test("undefined 输入不崩溃（返回空数组）", () => {
    expect(tokenize(undefined as unknown as string)).toEqual([]);
  });

  test("null 输入不崩溃（返回空数组）", () => {
    expect(tokenize(null as unknown as string)).toEqual([]);
  });
});

describe("computeTermFrequency", () => {
  test("正确计算词频", () => {
    const tf = computeTermFrequency(["hello", "hello", "world"]);
    expect(tf["hello"]).toBeCloseTo(2 / 3, 5);
    expect(tf["world"]).toBeCloseTo(1 / 3, 5);
  });

  test("空数组返回空对象", () => {
    expect(computeTermFrequency([])).toEqual({});
  });
});

describe("computeTfIdf", () => {
  test("生成归一化向量", () => {
    const tokens = ["hello", "world", "hello"];
    const df = { hello: 2, world: 1 };
    const vector = computeTfIdf(tokens, df, 5);

    // L2 范数应为 1
    const norm = Math.sqrt(
      Object.values(vector).reduce((sum, v) => sum + v * v, 0),
    );
    expect(norm).toBeCloseTo(1, 5);
  });

  test("新词获得非零 IDF", () => {
    const tokens = ["newword"];
    const vector = computeTfIdf(tokens, {}, 0);
    expect(vector["newword"]).toBeGreaterThan(0);
  });
});

describe("cosineSimilarity", () => {
  test("相同向量返回 1", () => {
    const v = { a: 0.6, b: 0.8 };
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  test("正交向量返回 0", () => {
    const a = { a: 1 };
    const b = { b: 1 };
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("部分重叠", () => {
    const a = { a: 0.5, b: 0.5 };
    const b = { a: 0.5, c: 0.5 };
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

// ──────────────────────────────────────────────
// VectorMemory 存储
// ──────────────────────────────────────────────

describe("VectorMemory", () => {
  test("save 和 list", async () => {
    const store = createVectorMemory({ workdir: tmpDir });
    await store.load();

    const entry = await store.save("Hello world", "test");
    expect(entry.id).toBeDefined();
    expect(entry.content).toBe("Hello world");
    expect(entry.category).toBe("test");

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(entry.id);
  });

  test("search 返回相关结果", async () => {
    const store = createVectorMemory({ workdir: tmpDir });
    await store.load();

    await store.save("The user prefers TypeScript over JavaScript", "user");
    await store.save("Project uses Bun as the runtime", "project");
    await store.save("The database is PostgreSQL", "project");

    const results = await store.search("TypeScript preference", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.content).toContain("TypeScript");
  });

  test("search 空存储返回空数组", async () => {
    const store = createVectorMemory({ workdir: tmpDir });
    await store.load();
    const results = await store.search("anything", 5);
    expect(results).toEqual([]);
  });

  test("delete 删除条目", async () => {
    const store = createVectorMemory({ workdir: tmpDir });
    await store.load();

    const entry = await store.save("To be deleted", "test");
    expect(store.size()).toBe(1);

    const deleted = await store.delete(entry.id);
    expect(deleted).toBe(true);
    expect(store.size()).toBe(0);
  });

  test("delete 不存在的 ID 返回 false", async () => {
    const store = createVectorMemory({ workdir: tmpDir });
    await store.load();
    const deleted = await store.delete("nonexistent-id");
    expect(deleted).toBe(false);
  });

  test("clear 清空所有", async () => {
    const store = createVectorMemory({ workdir: tmpDir });
    await store.load();

    await store.save("Entry 1", "a");
    await store.save("Entry 2", "b");
    expect(store.size()).toBe(2);

    await store.clear();
    expect(store.size()).toBe(0);
  });

  test("persist 和 load 持久化", async () => {
    const store1 = createVectorMemory({ workdir: tmpDir });
    await store1.load();
    await store1.save("Persistent memory", "test");

    // 新实例从同一目录加载
    const store2 = createVectorMemory({ workdir: tmpDir });
    await store2.load();
    expect(store2.size()).toBe(1);
    expect(store2.list()[0]!.content).toBe("Persistent memory");
  });

  test("size 返回正确数量", async () => {
    const store = createVectorMemory({ workdir: tmpDir });
    await store.load();
    expect(store.size()).toBe(0);

    await store.save("A", "x");
    expect(store.size()).toBe(1);

    await store.save("B", "x");
    expect(store.size()).toBe(2);
  });
});

// ──────────────────────────────────────────────
// extractMemoriesFromConversation
// ──────────────────────────────────────────────

describe("extractMemoriesFromConversation", () => {
  test("从消息中提取文本", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Remember to use bun for this project" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Got it, I'll use bun." }],
      },
    ];

    const extracted = extractMemoriesFromConversation(messages, 3);
    expect(extracted).toHaveLength(2);
    expect(extracted.some((e) => e.includes("bun"))).toBe(true);
  });

  test("跳过过短内容", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "This is a longer response that should be kept" }] },
    ];

    const extracted = extractMemoriesFromConversation(messages, 3);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toContain("longer response");
  });

  test("限制最大条数", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: "user",
      content: [{ type: "text", text: `Message number ${i} with enough text` }],
    }));

    const extracted = extractMemoriesFromConversation(messages, 2);
    expect(extracted).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────
// buildVectorMemoryPrompt
// ──────────────────────────────────────────────

describe("buildVectorMemoryPrompt", () => {
  test("有记忆时返回提示片段", async () => {
    const store = createVectorMemory({ workdir: tmpDir });
    await store.load();
    await store.save("User likes TypeScript", "user");

    const prompt = await buildVectorMemoryPrompt(store, "TypeScript", 5);
    expect(prompt).toContain("Relevant Memories");
    expect(prompt).toContain("TypeScript");
  });

  test("无记忆时返回空字符串", async () => {
    const store = createVectorMemory({ workdir: tmpDir });
    await store.load();

    const prompt = await buildVectorMemoryPrompt(store, "anything", 5);
    expect(prompt).toBe("");
  });
});

// ──────────────────────────────────────────────
// 系统上下文集成记忆
// ──────────────────────────────────────────────

describe("系统上下文记忆集成", () => {
  test("loadSystemContext 包含 MEMORY.md 内容", async () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "# Project Memory\n\n- Use bun");

    const ctx = await loadSystemContext({ workdir: tmpDir });
    expect(ctx).toContain("AI coding assistant");
    expect(ctx).toContain("Project Memory");
    expect(ctx).toContain("bun");
  });

  test("loadMemory=false 时不加载记忆", async () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "# Should Not Appear");

    const ctx = await loadSystemContext({
      workdir: tmpDir,
      loadMemory: false,
    });
    expect(ctx).not.toContain("Should Not Appear");
  });

  test("memoryPrompt 手动注入", async () => {
    const ctx = await loadSystemContext({
      workdir: tmpDir,
      memoryPrompt: "## Custom Memory\n\nManual injection",
    });
    expect(ctx).toContain("Custom Memory");
    expect(ctx).toContain("Manual injection");
  });

  test("无 MEMORY.md 时不崩溃", async () => {
    const ctx = await loadSystemContext({ workdir: tmpDir });
    expect(ctx).toContain("AI coding assistant");
    expect(ctx).toContain("Current date");
  });
});
