import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createToolRegistry,
  createToolExecutor,
  createPermissionChecker,
  truncateOutput,
  registerBuiltinTools,
} from "../index.ts";
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import { z } from "zod";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_WORKDIR = join(tmpdir(), "fengagent-tools-test");
const TEST_CONTEXT: ToolContext = {
  workdir: TEST_WORKDIR,
  sessionId: "test-session",
  messageId: "test-msg",
};

function setup(): void {
  if (!existsSync(TEST_WORKDIR)) {
    mkdirSync(TEST_WORKDIR, { recursive: true });
  }
}

function cleanup(): void {
  if (existsSync(TEST_WORKDIR)) {
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────
// ToolRegistry
// ──────────────────────────────────────────────

describe("ToolRegistry", () => {
  const registry = createToolRegistry();

  const testTool: ToolDefinition<{ name: string }> = {
    name: "test-tool",
    description: "A test tool",
    inputSchema: z.object({ name: z.string() }),
    async execute(input) {
      return { content: `Hello ${input.name}` };
    },
  };

  it("registers a tool", () => {
    registry.register(testTool);
    const found = registry.get("test-tool");
    expect(found).toBeDefined();
    expect(found!.name).toBe("test-tool");
  });

  it("throws on duplicate registration", () => {
    expect(() => registry.register(testTool)).toThrow();
  });

  it("throws on invalid name", () => {
    expect(() =>
      registry.register({
        ...testTool,
        name: "123bad",
      }),
    ).toThrow();
  });

  it("lists all registered tools", () => {
    const tools = registry.list();
    expect(tools.length).toBeGreaterThanOrEqual(1);
  });

  it("materializes with no filter returns all", () => {
    const tools = registry.materialize();
    expect(tools.length).toBeGreaterThanOrEqual(1);
  });

  it("materializes with allowed filter", () => {
    const tools = registry.materialize({ allowed: ["test-tool"] });
    expect(tools.length).toBe(1);
    expect(tools[0]!.name).toBe("test-tool");
  });

  it("materializes with denied filter", () => {
    const tools = registry.materialize({ denied: ["test-tool"] });
    expect(tools.find((t) => t.name === "test-tool")).toBeUndefined();
  });

  it("materializes with autoApprove returns all", () => {
    const tools = registry.materialize({ autoApprove: true });
    expect(tools.length).toBeGreaterThanOrEqual(1);
  });

  it("materializes with allowed * returns all", () => {
    const tools = registry.materialize({ allowed: ["*"] });
    expect(tools.length).toBeGreaterThanOrEqual(1);
  });

  it("unregisters a tool", () => {
    const reg = createToolRegistry();
    reg.register(testTool);
    expect(reg.get("test-tool")).toBeDefined();
    reg.unregister("test-tool");
    expect(reg.get("test-tool")).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// registerBuiltinTools
// ──────────────────────────────────────────────

describe("registerBuiltinTools", () => {
  it("registers all 11 built-in tools", () => {
    const reg = createToolRegistry();
    registerBuiltinTools(reg);
    const names = reg.list().map((t) => t.name).sort();
    expect(names).toEqual([
      "bash",
      "file-edit",
      "file-read",
      "file-write",
      "glob",
      "grep",
      "memory-list",
      "memory-save",
      "memory-search",
      "skill",
      "task",
    ]);
  });
});

// ──────────────────────────────────────────────
// PermissionChecker
// ──────────────────────────────────────────────

describe("PermissionChecker", () => {
  const checker = createPermissionChecker();

  const readOnlyTool: ToolDefinition = {
    name: "read-tool",
    description: "A read-only tool",
    inputSchema: z.object({}),
    execute: async () => ({ content: "ok" }),
    isReadOnly: () => true,
    isDestructive: () => false,
  };

  const destructiveTool: ToolDefinition = {
    name: "destructive-tool",
    description: "A destructive tool",
    inputSchema: z.object({}),
    execute: async () => ({ content: "ok" }),
    isReadOnly: () => false,
    isDestructive: () => true,
  };

  it("allows read-only tools", () => {
    const result = checker.checkPermissions(
      readOnlyTool,
      {},
      TEST_CONTEXT,
    );
    expect(result.decision).toBe("allow");
  });

  it("auto-approves when FENG_AUTO_APPROVE_TOOLS is set", () => {
    process.env.FENG_AUTO_APPROVE_TOOLS = "true";
    try {
      const autoChecker = createPermissionChecker();
      const result = autoChecker.checkPermissions(
        destructiveTool,
        {},
        TEST_CONTEXT,
      );
      expect(result.decision).toBe("allow");
    } finally {
      delete process.env.FENG_AUTO_APPROVE_TOOLS;
    }
  });

  it("denies when tool not in FENG_ALLOWED_TOOLS", () => {
    process.env.FENG_ALLOWED_TOOLS = "safe-only";
    try {
      const allowChecker = createPermissionChecker();
      const result = allowChecker.checkPermissions(
        readOnlyTool,
        {},
        TEST_CONTEXT,
      );
      expect(result.decision).toBe("deny");
    } finally {
      delete process.env.FENG_ALLOWED_TOOLS;
    }
  });

  it("denies when tool in FENG_DENIED_TOOLS", () => {
    process.env.FENG_DENIED_TOOLS = "read-tool";
    try {
      const denyChecker = createPermissionChecker();
      const result = denyChecker.checkPermissions(
        readOnlyTool,
        {},
        TEST_CONTEXT,
      );
      expect(result.decision).toBe("deny");
    } finally {
      delete process.env.FENG_DENIED_TOOLS;
    }
  });

  it("asks for destructive tools without permission callback", () => {
    const result = checker.checkPermissions(
      destructiveTool,
      {},
      TEST_CONTEXT,
    );
    expect(result.decision).toBe("deny");
  });

  it("asks when permission callback is available for destructive tools", () => {
    const ctx: ToolContext = {
      ...TEST_CONTEXT,
      requestPermission: async () => ({ decision: "ask" as const }),
    };
    const result = checker.checkPermissions(destructiveTool, {}, ctx);
    expect(result.decision).toBe("ask");
  });
});

// ──────────────────────────────────────────────
// Truncate
// ──────────────────────────────────────────────

describe("truncateOutput", () => {
  it("returns content unchanged when within limit", () => {
    const result = truncateOutput("short text");
    expect(result.content).toBe("short text");
    expect(result.overflowFile).toBeUndefined();
  });

  it("truncates and writes overflow file", () => {
    const longText = "x".repeat(3000);
    const result = truncateOutput(longText);
    expect(result.content.length).toBeLessThan(longText.length);
    expect(result.overflowFile).toBeDefined();
    if (result.overflowFile) {
      expect(existsSync(result.overflowFile)).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────
// ToolExecutor
// ──────────────────────────────────────────────

describe("ToolExecutor", () => {
  const executor = createToolExecutor();

  const echoTool: ToolDefinition<{ text: string }> = {
    name: "echo",
    description: "Echoes text back",
    inputSchema: z.object({ text: z.string() }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    async execute(input) {
      return { content: input.text };
    },
  };

  const failTool: ToolDefinition<{ message: string }> = {
    name: "failer",
    description: "Always fails",
    inputSchema: z.object({ message: z.string() }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    async execute(input) {
      throw new Error(input.message);
    },
  };

  beforeAll(() => { if (!existsSync(TEST_WORKDIR)) mkdirSync(TEST_WORKDIR, { recursive: true }); });
  afterAll(cleanup);

  it("executes a single tool", async () => {
    const result = await executor.execute(echoTool, { text: "hello" }, TEST_CONTEXT);
    expect(result.content).toBe("hello");
    expect(result.isError).toBeFalsy();
  });

  it("catches tool errors gracefully", async () => {
    const result = await executor.execute(failTool, { message: "boom" }, TEST_CONTEXT);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom");
  });

  it("validates input with schema", async () => {
    const result = await executor.execute(echoTool, { text: 123 }, TEST_CONTEXT);
    expect(result.isError).toBe(true);
  });

  it("executes multiple tools in parallel (concurrency safe)", async () => {
    const results = await executor.executeMany(
      [
        { tool: echoTool, input: { text: "a" } },
        { tool: echoTool, input: { text: "b" } },
        { tool: echoTool, input: { text: "c" } },
      ],
      TEST_CONTEXT,
    );
    expect(results.length).toBe(3);
    const contents = results.map((r) => r.result.content).sort();
    expect(contents).toEqual(["a", "b", "c"]);
  });

  it("handles mixed success and failure in batch", async () => {
    const results = await executor.executeMany(
      [
        { tool: echoTool, input: { text: "ok" } },
        { tool: failTool, input: { message: "err" } },
      ],
      TEST_CONTEXT,
    );
    expect(results.length).toBe(2);
    expect(results.find((r) => r.toolName === "echo")!.result.content).toBe("ok");
    expect(results.find((r) => r.toolName === "failer")!.result.isError).toBe(true);
  });

  it("executes non-concurrency-safe tools serially", async () => {
    const serialTool: ToolDefinition = {
      name: "serial-tool",
      description: "Must run serially",
      inputSchema: z.object({}),
      isConcurrencySafe: () => false,
      async execute() {
        return { content: "serial" };
      },
    };

    const results = await executor.executeMany(
      [
        { tool: serialTool, input: {} },
        { tool: serialTool, input: {} },
      ],
      TEST_CONTEXT,
    );
    expect(results.length).toBe(2);
    expect(results.every((r) => r.result.content === "serial")).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Built-in: file-read
// ──────────────────────────────────────────────

describe("file-read tool", () => {
  const reg = createToolRegistry();
  registerBuiltinTools(reg);

  beforeAll(setup);
  afterAll(cleanup);

  it("reads a file", async () => {
    const filePath = join(TEST_WORKDIR, "hello.txt");
    writeFileSync(filePath, "line 1\nline 2\nline 3");
    const tool = reg.get("file-read")!;
    const result = await tool.execute({ filePath: "hello.txt" }, TEST_CONTEXT);
    expect(result.content).toContain("line 1");
    expect(result.content).toContain("line 3");
  });

  it("returns error for non-existent file", async () => {
    const tool = reg.get("file-read")!;
    const result = await tool.execute({ filePath: "missing.txt" }, TEST_CONTEXT);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("File not found");
  });

  it("supports offset and limit", async () => {
    const filePath = join(TEST_WORKDIR, "numbered.txt");
    writeFileSync(filePath, "1\n2\n3\n4\n5");
    const tool = reg.get("file-read")!;
    const result = await tool.execute(
      { filePath: "numbered.txt", offset: 2, limit: 2 },
      TEST_CONTEXT,
    );
    expect(result.content).toContain("2:");
    expect(result.content).not.toContain("1:");
    expect(result.content).not.toContain("5:");
  });

  it("is read-only", () => {
    const tool = reg.get("file-read")!;
    expect(tool.isReadOnly!("")).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Built-in: file-write
// ──────────────────────────────────────────────

describe("file-write tool", () => {
  const reg = createToolRegistry();
  registerBuiltinTools(reg);

  beforeAll(setup);
  afterAll(cleanup);

  it("writes a new file", async () => {
    const tool = reg.get("file-write")!;
    const result = await tool.execute(
      { filePath: "new.txt", content: "test content" },
      TEST_CONTEXT,
    );
    expect(result.content).toContain("Successfully created");
    const filePath = join(TEST_WORKDIR, "new.txt");
    expect(existsSync(filePath)).toBe(true);
  });

  it("is destructive", () => {
    const tool = reg.get("file-write")!;
    expect(tool.isDestructive!("")).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Built-in: file-edit
// ──────────────────────────────────────────────

describe("file-edit tool", () => {
  const reg = createToolRegistry();
  registerBuiltinTools(reg);

  beforeAll(setup);
  afterAll(cleanup);

  it("replaces text in a file", async () => {
    const filePath = join(TEST_WORKDIR, "edit.txt");
    writeFileSync(filePath, "hello world");
    const tool = reg.get("file-edit")!;
    const result = await tool.execute(
      { filePath: "edit.txt", oldString: "hello", newString: "hi" },
      TEST_CONTEXT,
    );
    expect(result.isError).toBeFalsy();
  });

  it("rejects when oldString not found", async () => {
    const filePath = join(TEST_WORKDIR, "edit2.txt");
    writeFileSync(filePath, "hello world");
    const tool = reg.get("file-edit")!;
    const result = await tool.execute(
      { filePath: "edit2.txt", oldString: "xyz", newString: "abc" },
      TEST_CONTEXT,
    );
    expect(result.isError).toBe(true);
  });

  it("supports replaceAll", async () => {
    const filePath = join(TEST_WORKDIR, "edit3.txt");
    writeFileSync(filePath, "a a a");
    const tool = reg.get("file-edit")!;
    const result = await tool.execute(
      { filePath: "edit3.txt", oldString: "a", newString: "b", replaceAll: true },
      TEST_CONTEXT,
    );
    expect(result.content).toContain("3 occurrence");
  });
});

// ──────────────────────────────────────────────
// Built-in: glob
// ──────────────────────────────────────────────

describe("glob tool", () => {
  const reg = createToolRegistry();
  registerBuiltinTools(reg);

  beforeAll(setup);
  afterAll(cleanup);

  it("finds files by pattern", async () => {
    writeFileSync(join(TEST_WORKDIR, "a.ts"), "");
    writeFileSync(join(TEST_WORKDIR, "b.ts"), "");
    writeFileSync(join(TEST_WORKDIR, "c.js"), "");

    const tool = reg.get("glob")!;
    const result = await tool.execute({ pattern: "*.ts" }, TEST_CONTEXT);
    expect(result.content).toContain("a.ts");
    expect(result.content).toContain("b.ts");
    expect(result.content).not.toContain("c.js");
  });

  it("returns no match message for empty results", async () => {
    const tool = reg.get("glob")!;
    const result = await tool.execute(
      { pattern: "nonexistent*.zzz" },
      TEST_CONTEXT,
    );
    expect(result.content).toContain("No files matched");
  });

  it("is read-only", () => {
    const tool = reg.get("glob")!;
    expect(tool.isReadOnly!("")).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Built-in: grep
// ──────────────────────────────────────────────

describe("grep tool", () => {
  const reg = createToolRegistry();
  registerBuiltinTools(reg);

  beforeAll(setup);
  afterAll(cleanup);

  it("finds matches in files", async () => {
    writeFileSync(join(TEST_WORKDIR, "search.txt"), "hello world\nfoo bar\nhello again");
    const tool = reg.get("grep")!;
    const result = await tool.execute(
      { pattern: "hello", include: "*.txt" },
      TEST_CONTEXT,
    );
    expect(result.content).toContain("hello world");
    expect(result.content).toContain("hello again");
  });

  it("handles invalid regex gracefully", async () => {
    const tool = reg.get("grep")!;
    const result = await tool.execute(
      { pattern: "[invalid" },
      TEST_CONTEXT,
    );
    expect(result.isError).toBe(true);
  });

  it("returns no match message when nothing found", async () => {
    writeFileSync(join(TEST_WORKDIR, "empty.txt"), "nothing here");
    const tool = reg.get("grep")!;
    const result = await tool.execute(
      { pattern: "zzzzz" },
      TEST_CONTEXT,
    );
    expect(result.content).toContain("No matches found");
  });

  it("is read-only", () => {
    const tool = reg.get("grep")!;
    expect(tool.isReadOnly!("")).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Built-in: bash
// ──────────────────────────────────────────────

describe("bash tool", () => {
  const reg = createToolRegistry();
  registerBuiltinTools(reg);

  it("can be retrieved from registry", () => {
    const tool = reg.get("bash")!;
    expect(tool).toBeDefined();
    expect(tool.name).toBe("bash");
  });

  it("is destructive", () => {
    const tool = reg.get("bash")!;
    expect(tool.isDestructive!("")).toBe(true);
    expect(tool.isReadOnly!("")).toBe(false);
  });

  it("is not concurrency safe", () => {
    const tool = reg.get("bash")!;
    expect(tool.isConcurrencySafe!("")).toBe(false);
  });

  it("executes a simple command", async () => {
    setup();
    const tool = reg.get("bash")!;
    const result = await tool.execute(
      { command: "echo hello-from-bash", timeout: 10000 },
      TEST_CONTEXT,
    );
    expect(result.content).toContain("hello-from-bash");
    cleanup();
  });
});
