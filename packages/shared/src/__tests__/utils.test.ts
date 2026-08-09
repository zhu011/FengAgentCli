import { describe, it, expect } from "bun:test";
import {
  generateId,
  safeJsonParse,
  deepMerge,
  getEnv,
  getEnvNumber,
  getEnvBoolean,
  expandTilde,
  estimateTokens,
  truncate,
  DEFAULT_MODEL,
  MAX_TOKENS,
  CONTEXT_WINDOW,
} from "../index.ts";

describe("generateId", () => {
  it("returns a non-empty string", () => {
    const id = generateId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(100);
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse<unknown>('{"a":1}', null)).toEqual({ a: 1 });
  });

  it("returns fallback on invalid JSON", () => {
    expect(safeJsonParse("not json", "fallback")).toBe("fallback");
  });

  it("returns fallback on empty string", () => {
    expect(safeJsonParse("", { default: true })).toEqual({ default: true });
  });
});

describe("deepMerge", () => {
  it("merges flat objects", () => {
    const base: Record<string, unknown> = { a: 1, b: 2 };
    const override: Record<string, unknown> = { b: 3, c: 4 };
    expect(deepMerge(base, override)).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("recursively merges nested objects", () => {
    const base: Record<string, unknown> = { nested: { x: 1, y: 2 } };
    const override: Record<string, unknown> = { nested: { y: 3, z: 4 } };
    expect(deepMerge(base, override)).toEqual({ nested: { x: 1, y: 3, z: 4 } });
  });

  it("replaces arrays (no element merge)", () => {
    const base: Record<string, unknown> = { arr: [1, 2, 3] };
    const override: Record<string, unknown> = { arr: [4] };
    expect(deepMerge(base, override)).toEqual({ arr: [4] });
  });

  it("returns base when override is null/undefined", () => {
    const base: Record<string, unknown> = { a: 1 };
    expect(deepMerge(base, null as unknown as never)).toEqual({ a: 1 });
  });

  it("preserves base keys not in override", () => {
    const base: Record<string, unknown> = { a: 1, b: 2, c: 3 };
    const override: Record<string, unknown> = { b: 20 };
    expect(deepMerge(base, override)).toEqual({ a: 1, b: 20, c: 3 });
  });
});

describe("getEnv", () => {
  it("returns env value when set", () => {
    process.env.TEST_FENG_GETENV = "hello";
    expect(getEnv("TEST_FENG_GETENV", "fallback")).toBe("hello");
  });

  it("returns fallback when not set", () => {
    delete process.env.TEST_FENG_GETENV_MISSING;
    expect(getEnv("TEST_FENG_GETENV_MISSING", "fallback")).toBe("fallback");
  });

  it("returns fallback when empty string", () => {
    process.env.TEST_FENG_GETENV_EMPTY = "";
    expect(getEnv("TEST_FENG_GETENV_EMPTY", "fallback")).toBe("fallback");
  });
});

describe("getEnvNumber", () => {
  it("parses valid number", () => {
    process.env.TEST_NUM = "42";
    expect(getEnvNumber("TEST_NUM", 0)).toBe(42);
  });

  it("returns fallback for invalid number", () => {
    process.env.TEST_NUM_BAD = "abc";
    expect(getEnvNumber("TEST_NUM_BAD", 99)).toBe(99);
  });

  it("returns fallback when not set", () => {
    delete process.env.TEST_NUM_MISSING;
    expect(getEnvNumber("TEST_NUM_MISSING", 7)).toBe(7);
  });
});

describe("getEnvBoolean", () => {
  it("parses 'true' as true", () => {
    process.env.TEST_BOOL = "true";
    expect(getEnvBoolean("TEST_BOOL", false)).toBe(true);
  });

  it("parses '1' as true", () => {
    process.env.TEST_BOOL = "1";
    expect(getEnvBoolean("TEST_BOOL", false)).toBe(true);
  });

  it("parses 'yes' as true", () => {
    process.env.TEST_BOOL = "yes";
    expect(getEnvBoolean("TEST_BOOL", false)).toBe(true);
  });

  it("returns fallback when not set", () => {
    delete process.env.TEST_BOOL_MISSING;
    expect(getEnvBoolean("TEST_BOOL_MISSING", true)).toBe(true);
  });
});

describe("expandTilde", () => {
  it("expands ~ to home directory", () => {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      expect(expandTilde("~")).toBe(home);
      expect(expandTilde("~/sub")).toBe(`${home}/sub`);
    }
  });

  it("returns path unchanged when no tilde", () => {
    expect(expandTilde("/usr/local")).toBe("/usr/local");
  });
});

describe("estimateTokens", () => {
  it("estimates tokens as chars/4", () => {
    expect(estimateTokens("hello world!")).toBe(3); // 12 chars / 4 = 3
  });

  it("returns at least 1 for non-empty string", () => {
    expect(estimateTokens("a")).toBe(1); // 1 char / 4 = 0.25 → ceil = 1
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("truncate", () => {
  it("returns text unchanged when within limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates and adds ellipsis when over limit", () => {
    expect(truncate("hello world", 8)).toBe("hello...");
  });
});

describe("constants", () => {
  it("exports expected defaults", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-4-20250514");
    expect(MAX_TOKENS).toBe(8192);
    expect(CONTEXT_WINDOW).toBe(200_000);
  });
});
