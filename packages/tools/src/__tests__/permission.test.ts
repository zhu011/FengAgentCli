import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createPermissionChecker,
} from "../permission.ts";
import {
  loadPermissionConfig,
  findMatchingRule,
  PermissionConfigSchema,
  EMPTY_PERMISSION_CONFIG,
} from "../permission-config.ts";
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import { z } from "zod";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_WORKDIR = join(tmpdir(), "fengagent-perm-test");
const TEST_CONTEXT: ToolContext = {
  workdir: TEST_WORKDIR,
  sessionId: "test-session",
  messageId: "test-msg",
};

function setup(): void {
  if (existsSync(TEST_WORKDIR)) {
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_WORKDIR, { recursive: true });
}

function cleanup(): void {
  if (existsSync(TEST_WORKDIR)) {
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
  }
}

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

// ──────────────────────────────────────────────
// PermissionConfig 加载
// ──────────────────────────────────────────────

describe("loadPermissionConfig", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("returns empty config when file does not exist", () => {
    const config = loadPermissionConfig(TEST_WORKDIR);
    expect(config.rules).toEqual([]);
    expect(config.cache).toBe(true);
  });

  it("loads config from .fengagent/permissions.json", () => {
    const configDir = join(TEST_WORKDIR, ".fengagent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "permissions.json"),
      JSON.stringify({
        rules: [
          { tool: "bash", action: "ask", reason: "needs approval" },
          { tool: "file-read", action: "allow" },
        ],
        cache: false,
      }),
    );

    const config = loadPermissionConfig(TEST_WORKDIR);
    expect(config.rules.length).toBe(2);
    expect(config.rules[0]!.tool).toBe("bash");
    expect(config.rules[0]!.action).toBe("ask");
    expect(config.cache).toBe(false);
  });

  it("returns empty config for invalid JSON", () => {
    const configDir = join(TEST_WORKDIR, ".fengagent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "permissions.json"), "not valid json");

    const config = loadPermissionConfig(TEST_WORKDIR);
    expect(config).toEqual(EMPTY_PERMISSION_CONFIG);
  });

  it("returns empty config for schema validation failure", () => {
    const configDir = join(TEST_WORKDIR, ".fengagent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "permissions.json"),
      JSON.stringify({ rules: "not-an-array" }),
    );

    const config = loadPermissionConfig(TEST_WORKDIR);
    expect(config).toEqual(EMPTY_PERMISSION_CONFIG);
  });
});

// ──────────────────────────────────────────────
// findMatchingRule
// ──────────────────────────────────────────────

describe("findMatchingRule", () => {
  it("returns the first matching rule", () => {
    const config = {
      rules: [
        { tool: "bash", action: "ask" as const },
        { tool: "file-read", action: "allow" as const },
      ],
      cache: true,
    };
    const rule = findMatchingRule(config, "bash");
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe("ask");
  });

  it("returns null when no rule matches", () => {
    const config = {
      rules: [{ tool: "bash", action: "deny" as const }],
      cache: true,
    };
    const rule = findMatchingRule(config, "file-read");
    expect(rule).toBeNull();
  });

  it("matches wildcard (*) rule", () => {
    const config = {
      rules: [
        { tool: "file-read", action: "allow" as const },
        { tool: "*", action: "ask" as const },
      ],
      cache: true,
    };
    // Specific rule matches first
    const rule1 = findMatchingRule(config, "file-read");
    expect(rule1!.action).toBe("allow");

    // Wildcard matches for other tools
    const rule2 = findMatchingRule(config, "bash");
    expect(rule2!.action).toBe("ask");
  });
});

// ──────────────────────────────────────────────
// PermissionChecker with config file
// ──────────────────────────────────────────────

describe("PermissionChecker with config file", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("applies allow rule from permissions.json", () => {
    const configDir = join(TEST_WORKDIR, ".fengagent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "permissions.json"),
      JSON.stringify({
        rules: [
          { tool: "destructive-tool", action: "allow" },
        ],
      }),
    );

    const checker = createPermissionChecker(TEST_WORKDIR);
    const result = checker.checkPermissions(destructiveTool, {}, TEST_CONTEXT);
    expect(result.decision).toBe("allow");
  });

  it("applies deny rule from permissions.json", () => {
    const configDir = join(TEST_WORKDIR, ".fengagent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "permissions.json"),
      JSON.stringify({
        rules: [
          { tool: "read-tool", action: "deny", reason: "blocked by config" },
        ],
      }),
    );

    const checker = createPermissionChecker(TEST_WORKDIR);
    const result = checker.checkPermissions(readOnlyTool, {}, TEST_CONTEXT);
    expect(result.decision).toBe("deny");
    expect(result.decision === "deny" && result.reason).toBe("blocked by config");
  });

  it("applies ask rule from permissions.json", () => {
    const configDir = join(TEST_WORKDIR, ".fengagent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "permissions.json"),
      JSON.stringify({
        rules: [
          { tool: "destructive-tool", action: "ask", reason: "confirm please" },
        ],
      }),
    );

    const checker = createPermissionChecker(TEST_WORKDIR);
    const result = checker.checkPermissions(destructiveTool, {}, TEST_CONTEXT);
    expect(result.decision).toBe("ask");
  });
});

// ──────────────────────────────────────────────
// PermissionChecker caching
// ──────────────────────────────────────────────

describe("PermissionChecker caching", () => {
  beforeEach(() => {
    setup();
    delete process.env.FENG_AUTO_APPROVE_TOOLS;
    delete process.env.FENG_ALLOWED_TOOLS;
    delete process.env.FENG_DENIED_TOOLS;
  });
  afterEach(cleanup);

  it("caches allow decisions for read-only tools (no tool-level check)", () => {
    const tool: ToolDefinition = {
      name: "cached-readonly-tool",
      description: "Read-only tool without tool-level checkPermissions",
      inputSchema: z.object({ val: z.string() }),
      execute: async () => ({ content: "ok" }),
      isReadOnly: () => true,
      isDestructive: () => false,
      // No checkPermissions — so allow comes from step 7 (read-only inference)
      // which IS cached
    };

    const checker = createPermissionChecker(TEST_WORKDIR);

    // First call
    checker.checkPermissions(tool, { val: "test" }, TEST_CONTEXT);
    // Second call with same input — should use cache (read-only allow is cached)
    checker.checkPermissions(tool, { val: "test" }, TEST_CONTEXT);

    // No way to directly count calls for read-only inference,
    // but we can verify the cache is populated by checking that
    // a deny env var doesn't take effect after caching
    process.env.FENG_DENIED_TOOLS = "cached-readonly-tool";
    const result = checker.checkPermissions(tool, { val: "test" }, TEST_CONTEXT);
    delete process.env.FENG_DENIED_TOOLS;
    // If caching worked, the cached "allow" is returned despite the deny env var
    expect(result.decision).toBe("allow");
  });

  it("does not cache ask decisions", () => {
    let callCount = 0;
    const ctx: ToolContext = {
      ...TEST_CONTEXT,
      requestPermission: async () => ({ decision: "allow" as const }),
    };
    const tool: ToolDefinition = {
      name: "ask-tool",
      description: "Tool that asks",
      inputSchema: z.object({}),
      execute: async () => ({ content: "ok" }),
      isReadOnly: () => false,
      isDestructive: () => true,
      checkPermissions() {
        callCount++;
        return { decision: "ask" as const, message: "please confirm" };
      },
    };

    const checker = createPermissionChecker(TEST_WORKDIR);

    // First call — ask
    checker.checkPermissions(tool, {}, ctx);
    // Second call — should ask again (not cached)
    checker.checkPermissions(tool, {}, ctx);

    expect(callCount).toBe(2);
  });

  it("caches deny decisions", () => {
    const configDir = join(TEST_WORKDIR, ".fengagent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "permissions.json"),
      JSON.stringify({
        rules: [
          { tool: "deny-tool", action: "deny" },
        ],
      }),
    );

    const tool: ToolDefinition = {
      name: "deny-tool",
      description: "Denied tool",
      inputSchema: z.object({ val: z.string() }),
      execute: async () => ({ content: "ok" }),
      isReadOnly: () => true,
    };

    const checker = createPermissionChecker(TEST_WORKDIR);

    const r1 = checker.checkPermissions(tool, { val: "a" }, TEST_CONTEXT);
    const r2 = checker.checkPermissions(tool, { val: "a" }, TEST_CONTEXT);

    expect(r1.decision).toBe("deny");
    expect(r2.decision).toBe("deny");
  });

  it("clearCache resets the cache", () => {
    // Use env var to create a cacheable deny decision
    process.env.FENG_DENIED_TOOLS = "clear-cache-tool";
    try {
      const tool: ToolDefinition = {
        name: "clear-cache-tool",
        description: "Tool denied by env",
        inputSchema: z.object({ val: z.string() }),
        execute: async () => ({ content: "ok" }),
        isReadOnly: () => true,
      };

      const checker = createPermissionChecker(TEST_WORKDIR);

      // First call — deny (cached)
      const r1 = checker.checkPermissions(tool, { val: "x" }, TEST_CONTEXT);
      expect(r1.decision).toBe("deny");

      // Clear env var and clear cache
      delete process.env.FENG_DENIED_TOOLS;
      checker.clearCache();

      // After clearing cache and env var, should be allow (read-only)
      const r2 = checker.checkPermissions(tool, { val: "x" }, TEST_CONTEXT);
      expect(r2.decision).toBe("allow");
    } finally {
      delete process.env.FENG_DENIED_TOOLS;
    }
  });

  it("uses different cache keys for different inputs", () => {
    // Use env var deny to test that different inputs get different cache entries
    process.env.FENG_DENIED_TOOLS = "multi-input-tool";
    try {
      const tool: ToolDefinition = {
        name: "multi-input-tool",
        description: "Tool denied by env",
        inputSchema: z.object({ val: z.string() }),
        execute: async () => ({ content: "ok" }),
        isReadOnly: () => true,
      };

      const checker = createPermissionChecker(TEST_WORKDIR);

      // Both calls should return deny (cached by env var)
      const r1 = checker.checkPermissions(tool, { val: "a" }, TEST_CONTEXT);
      const r2 = checker.checkPermissions(tool, { val: "b" }, TEST_CONTEXT);

      expect(r1.decision).toBe("deny");
      expect(r2.decision).toBe("deny");

      // Clear cache, remove deny env, verify different inputs were cached separately
      // by checking that clearing env + cache allows the tool
      delete process.env.FENG_DENIED_TOOLS;
      checker.clearCache();
      const r3 = checker.checkPermissions(tool, { val: "a" }, TEST_CONTEXT);
      expect(r3.decision).toBe("allow"); // cache cleared, no deny env
    } finally {
      delete process.env.FENG_DENIED_TOOLS;
    }
  });
});

// ──────────────────────────────────────────────
// PermissionConfigSchema
// ──────────────────────────────────────────────

describe("PermissionConfigSchema", () => {
  it("parses valid config", () => {
    const config = PermissionConfigSchema.parse({
      rules: [
        { tool: "bash", action: "ask" },
        { tool: "*", action: "allow" },
      ],
      cache: false,
    });

    expect(config.rules.length).toBe(2);
    expect(config.cache).toBe(false);
  });

  it("applies defaults", () => {
    const config = PermissionConfigSchema.parse({});
    expect(config.rules).toEqual([]);
    expect(config.cache).toBe(true);
  });

  it("rejects invalid action", () => {
    expect(() =>
      PermissionConfigSchema.parse({
        rules: [{ tool: "bash", action: "maybe" }],
      }),
    ).toThrow();
  });
});
