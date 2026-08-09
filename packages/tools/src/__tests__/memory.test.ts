/**
 * @fengagent/tools — memory 工具测试
 *
 * 测试 memory-save、memory-search、memory-list 工具。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ToolContext } from "@fengagent/core/tool";
import { memorySave, memorySearch, memoryList } from "../builtin/memory.ts";

// ──────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────

let tmpDir: string;
let context: ToolContext;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "feng-mem-tools-"));
  context = {
    workdir: tmpDir,
    sessionId: "test-session",
    messageId: "test-msg",
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// memory-save
// ──────────────────────────────────────────────

describe("memory-save", () => {
  test("保存记忆成功", async () => {
    const result = await memorySave.execute(
      { content: "User prefers TypeScript", category: "user" },
      context,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Memory saved");
    expect(result.content).toContain("TypeScript");
    expect(result.metadata).toBeDefined();
    expect((result.metadata as { id: string }).id).toBeDefined();
  });

  test("带元数据保存", async () => {
    const result = await memorySave.execute(
      {
        content: "Project uses Bun",
        category: "project",
        metadata: { source: "conversation" },
      },
      context,
    );

    expect(result.isError).toBeFalsy();
    expect((result.metadata as { category: string }).category).toBe("project");
  });

  test("isReadOnly 返回 false", () => {
    expect(memorySave.isReadOnly!({ content: "x", category: "y" })).toBe(false);
  });

  test("isDestructive 返回 false", () => {
    expect(memorySave.isDestructive!({ content: "x", category: "y" })).toBe(false);
  });

  test("checkPermissions 返回 allow", () => {
    const perm = memorySave.checkPermissions!({ content: "x", category: "y" }, context);
    expect(perm.decision).toBe("allow");
  });

  test("renderUse 格式正确", () => {
    const text = memorySave.renderUse!({
      content: "This is a long content that should be truncated",
      category: "test",
    });
    expect(text).toContain("memory-save");
    expect(text).toContain("test");
  });
});

// ──────────────────────────────────────────────
// memory-search
// ──────────────────────────────────────────────

describe("memory-search", () => {
  test("搜索无记忆时返回提示", async () => {
    const result = await memorySearch.execute(
      { query: "anything", limit: 5, minScore: 0.01 },
      context,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("No matching memories");
  });

  test("保存后可搜索到", async () => {
    await memorySave.execute(
      { content: "The user prefers dark mode for coding", category: "user" },
      context,
    );

    const result = await memorySearch.execute(
      { query: "dark mode preference", limit: 5, minScore: 0.01 },
      context,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("dark mode");
  });

  test("isReadOnly 返回 true", () => {
    expect(
      memorySearch.isReadOnly!({ query: "x", limit: 5, minScore: 0.01 }),
    ).toBe(true);
  });

  test("isConcurrencySafe 返回 true", () => {
    expect(
      memorySearch.isConcurrencySafe!({ query: "x", limit: 5, minScore: 0.01 }),
    ).toBe(true);
  });
});

// ──────────────────────────────────────────────
// memory-list
// ──────────────────────────────────────────────

describe("memory-list", () => {
  test("无记忆时返回提示", async () => {
    const result = await memoryList.execute({}, context);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("No memories stored");
  });

  test("列出所有记忆", async () => {
    await memorySave.execute(
      { content: "Memory 1", category: "project" },
      context,
    );
    await memorySave.execute(
      { content: "Memory 2", category: "user" },
      context,
    );

    const result = await memoryList.execute({}, context);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Total: 2 memories");
    expect(result.content).toContain("Memory 1");
    expect(result.content).toContain("Memory 2");
  });

  test("按分类过滤", async () => {
    await memorySave.execute(
      { content: "Project note", category: "project" },
      context,
    );
    await memorySave.execute(
      { content: "User note", category: "user" },
      context,
    );

    const result = await memoryList.execute({ category: "user" }, context);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Total: 1 memory");
    expect(result.content).toContain("User note");
    expect(result.content).not.toContain("Project note");
  });

  test("isReadOnly 返回 true", () => {
    expect(memoryList.isReadOnly!({})).toBe(true);
  });
});
