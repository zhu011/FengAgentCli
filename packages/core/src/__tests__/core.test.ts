import { describe, it, expect } from "bun:test";
import {
  ConfigSchema,
  loadConfigFromEnv,
} from "../config.ts";
import {
  createSession,
  toSessionMeta,
} from "../session.ts";
import {
  createUserMessage,
  createAssistantMessage,
  createSystemMessage,
} from "../types.ts";
import { ALLOW, deny, ask } from "../permission.ts";

// ──────────────────────────────────────────────
// ConfigSchema
// ──────────────────────────────────────────────

describe("ConfigSchema", () => {
  it("parses empty object and applies all defaults", () => {
    const config = ConfigSchema.parse({});
    expect(config.model).toBe("claude-sonnet-4-20250514");
    expect(config.smallModel).toBe("claude-haiku-3");
    expect(config.provider).toBe("anthropic");
    expect(config.maxTokens).toBe(8192);
    expect(config.temperature).toBe(1.0);
    expect(config.contextWindow).toBe(200_000);
    expect(config.compactThreshold).toBe(0.85);
    expect(config.serverPort).toBe(3000);
    expect(config.serverHost).toBe("127.0.0.1");
    expect(config.maxTurns).toBe(50);
    expect(config.logLevel).toBe("info");
    expect(config.dataDir).toBe(".fengagent-cordis");
    expect(config.autoApproveTools).toBe(false);
    expect(config.allowedTools).toBe("*");
  });

  it("validates and applies partial overrides", () => {
    const config = ConfigSchema.parse({ model: "gpt-4o", serverPort: 8080 });
    expect(config.model).toBe("gpt-4o");
    expect(config.serverPort).toBe(8080);
    // defaults preserved
    expect(config.maxTokens).toBe(8192);
  });

  it("rejects invalid logLevel", () => {
    expect(() => ConfigSchema.parse({ logLevel: "trace" })).toThrow();
  });

  it("rejects negative maxTokens", () => {
    expect(() => ConfigSchema.parse({ maxTokens: -1 })).toThrow();
  });

  it("rejects out-of-range temperature", () => {
    expect(() => ConfigSchema.parse({ temperature: 3 })).toThrow();
    expect(() => ConfigSchema.parse({ temperature: -1 })).toThrow();
  });

  it("rejects invalid serverPort", () => {
    expect(() => ConfigSchema.parse({ serverPort: 0 })).toThrow();
    expect(() => ConfigSchema.parse({ serverPort: 99999 })).toThrow();
  });
});

// ──────────────────────────────────────────────
// loadConfigFromEnv
// ──────────────────────────────────────────────

describe("loadConfigFromEnv", () => {
  it("returns defaults with empty env", () => {
    const config = loadConfigFromEnv(undefined, {});
    expect(config.model).toBe("claude-sonnet-4-20250514");
    expect(config.serverPort).toBe(3000);
  });

  it("applies env variables over defaults", () => {
    const config = loadConfigFromEnv(undefined, {
      FENG_MODEL: "gpt-4o",
      FENG_SERVER_PORT: "9000",
      FENG_MAX_TOKENS: "4096",
      FENG_DISABLE_COMPACT: "true",
    });
    expect(config.model).toBe("gpt-4o");
    expect(config.serverPort).toBe(9000);
    expect(config.maxTokens).toBe(4096);
    expect(config.disableCompact).toBe(true);
  });

  it("CLI args override env vars", () => {
    const config = loadConfigFromEnv(
      { model: "claude-opus-4" },
      { FENG_MODEL: "gpt-4o" },
    );
    expect(config.model).toBe("claude-opus-4");
  });

  it("falls back to config value for invalid env numbers", () => {
    const config = loadConfigFromEnv(undefined, {
      FENG_MAX_TOKENS: "not-a-number",
    });
    expect(config.maxTokens).toBe(8192); // default
  });

  it("handles optional fallbackModel from env", () => {
    const config = loadConfigFromEnv(undefined, {
      FENG_FALLBACK_MODEL: "claude-haiku-3",
    });
    expect(config.fallbackModel).toBe("claude-haiku-3");
  });

  it("handles boolean env vars correctly", () => {
    const config = loadConfigFromEnv(undefined, {
      FENG_AUTO_APPROVE_TOOLS: "true",
    });
    expect(config.autoApproveTools).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Session
// ──────────────────────────────────────────────

describe("createSession", () => {
  it("creates a session with defaults", () => {
    const session = createSession("claude-sonnet-4-20250514");
    expect(session.id).toBeTruthy();
    expect(session.model).toBe("claude-sonnet-4-20250514");
    expect(session.title).toBe("New Session");
    expect(session.messages).toEqual([]);
    expect(session.status).toBe("idle");
    expect(session.tokenCount).toBe(0);
    expect(session.createdAt).toBeGreaterThan(0);
    expect(session.updatedAt).toBe(session.createdAt);
  });

  it("accepts a custom title", () => {
    const session = createSession("gpt-4o", "My Chat");
    expect(session.title).toBe("My Chat");
  });
});

describe("toSessionMeta", () => {
  it("extracts meta without messages", () => {
    const session = createSession("test-model", "Test");
    const meta = toSessionMeta(session);
    expect(meta.id).toBe(session.id);
    expect(meta.title).toBe("Test");
    expect(meta.model).toBe("test-model");
    expect(meta.status).toBe("idle");
    expect(meta.tokenCount).toBe(0);
    expect("messages" in meta).toBe(false);
  });
});

// ──────────────────────────────────────────────
// Message factories
// ──────────────────────────────────────────────

describe("message factories", () => {
  it("createUserMessage", () => {
    const msg = createUserMessage("hello");
    expect(msg.role).toBe("user");
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]!.type).toBe("text");
    expect((msg.content[0] as { text: string }).text).toBe("hello");
    expect(msg.createdAt).toBeGreaterThan(0);
  });

  it("createAssistantMessage", () => {
    const msg = createAssistantMessage("hi there");
    expect(msg.role).toBe("assistant");
    expect(msg.content[0]!.type).toBe("text");
  });

  it("createSystemMessage", () => {
    const msg = createSystemMessage("system prompt");
    expect(msg.role).toBe("system");
    expect(msg.content[0]!.type).toBe("text");
  });

  it("generates unique message IDs", () => {
    const m1 = createUserMessage("a");
    const m2 = createUserMessage("b");
    expect(m1.id).not.toBe(m2.id);
  });
});

// ──────────────────────────────────────────────
// Permission helpers
// ──────────────────────────────────────────────

describe("permission helpers", () => {
  it("ALLOW is { decision: 'allow' }", () => {
    expect(ALLOW).toEqual({ decision: "allow" });
  });

  it("deny() returns deny with reason", () => {
    const result = deny("not allowed");
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toBe("not allowed");
    }
  });

  it("ask() returns ask with message", () => {
    const result = ask("please confirm");
    expect(result.decision).toBe("ask");
    if (result.decision === "ask") {
      expect(result.message).toBe("please confirm");
    }
  });
});
