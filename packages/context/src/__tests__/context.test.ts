/**
 * @fengagent/context — 上下文管理测试
 *
 * 测试 Token 估算、系统上下文加载、压缩引擎、上下文管理器。
 */

import { describe, test, expect } from "bun:test";
import type { Message, ContentBlock } from "@fengagent/core";
import { createSession, createUserMessage, createAssistantMessage } from "@fengagent/core";
import {
  countTokensInText,
  countTokensInBlock,
  countTokensInMessage,
  countTokensInMessages,
  findCutPoint,
  compact,
  createContextManager,
  loadSystemContext,
} from "../index.ts";
import type { SummaryGenerator } from "../index.ts";

// ──────────────────────────────────────────────
// Token 估算
// ──────────────────────────────────────────────

describe("Token 估算", () => {
  test("countTokensInText: chars / 4 向上取整", () => {
    expect(countTokensInText("")).toBe(0);
    expect(countTokensInText("ab")).toBe(1); // 2/4 = 0.5 → 1
    expect(countTokensInText("abcd")).toBe(1); // 4/4 = 1
    expect(countTokensInText("abcde")).toBe(2); // 5/4 = 1.25 → 2
    expect(countTokensInText("Hello world!")).toBe(3); // 12/4 = 3
  });

  test("countTokensInBlock: 各类型内容块", () => {
    const textBlock: ContentBlock = { type: "text", text: "Hello world!" };
    expect(countTokensInBlock(textBlock)).toBe(3);

    const thinkingBlock: ContentBlock = { type: "thinking", text: "Let me think..." };
    expect(countTokensInBlock(thinkingBlock)).toBe(4); // 15/4 → 4

    const toolUseBlock: ContentBlock = {
      type: "tool-use",
      id: "tool-1",
      name: "bash",
      input: { command: "ls" },
    };
    // name("bash"=4/4=1) + input(JSON.stringify=16/4=4) + 20 = 25
    expect(countTokensInBlock(toolUseBlock)).toBeGreaterThan(20);

    const toolResultBlock: ContentBlock = {
      type: "tool-result",
      toolUseId: "tool-1",
      content: "file.txt",
    };
    // content(8/4=2) + 10 = 12
    expect(countTokensInBlock(toolResultBlock)).toBe(12);
  });

  test("countTokensInMessage: 内容块 + 消息开销", () => {
    const msg: Message = {
      id: "msg-1",
      role: "user",
      content: [{ type: "text", text: "Hello world!" }],
      createdAt: Date.now(),
    };
    // text(3) + overhead(10) = 13
    expect(countTokensInMessage(msg)).toBe(13);
  });

  test("countTokensInMessages: 多条消息求和", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
        createdAt: 1,
      },
      {
        id: "msg-2",
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
        createdAt: 2,
      },
    ];
    // msg1: "Hello"(5/4=2) + 10 = 12; msg2: "Hi there!"(9/4=3) + 10 = 13; total = 25
    expect(countTokensInMessages(messages)).toBe(25);
  });
});

// ──────────────────────────────────────────────
// 系统上下文
// ──────────────────────────────────────────────

describe("系统上下文加载", () => {
  test("loadSystemContext 返回基础身份和日期", async () => {
    const ctx = await loadSystemContext({ workdir: "." });
    expect(ctx).toContain("AI coding assistant");
    expect(ctx).toContain("Current date");
  });

  test("loadSystemContext 包含额外指令", async () => {
    const ctx = await loadSystemContext({
      extraInstructions: "Be concise.",
    });
    expect(ctx).toContain("Be concise.");
  });

  test("loadSystemContext 读取 AGENTS.md（如果存在）", async () => {
    // 使用实际项目根目录的 AGENTS.md
    const ctx = await loadSystemContext({ workdir: "." });
    // AGENTS.md 存在时应包含其内容
    if (await Bun.file("AGENTS.md").exists()) {
      expect(ctx).toContain("AGENTS.md");
    }
  });
});

// ──────────────────────────────────────────────
// 压缩引擎
// ──────────────────────────────────────────────

/** Mock 摘要生成器 */
function createMockSummaryGenerator(summaryText = "这是摘要。"): SummaryGenerator {
  return {
    async generate() {
      return {
        content: [{ type: "text" as const, text: summaryText }],
      };
    },
  };
}

describe("压缩引擎", () => {
  function createMessages(count: number): Message[] {
    const messages: Message[] = [];
    for (let i = 0; i < count; i++) {
      messages.push({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: [
          {
            type: "text",
            text: `Message ${i} with some content for testing compaction.`,
          },
        ],
        createdAt: i,
      });
    }
    return messages;
  }

  test("findCutPoint: keepTokens 小时找到正确分割点", () => {
    const messages = createMessages(10);
    const cutPoint = findCutPoint(messages, 50);
    // 每条消息约 (48/4=12 + 10) = 22 tokens
    // 50 / 22 ≈ 2.3 → 保留最后 3 条 → cutPoint = 7
    expect(cutPoint).toBeGreaterThan(0);
    expect(cutPoint).toBeLessThan(10);
  });

  test("findCutPoint: keepTokens 大于总 tokens 时返回 0", () => {
    const messages = createMessages(3);
    const cutPoint = findCutPoint(messages, 100_000);
    expect(cutPoint).toBe(0);
  });

  test("compact: 生成摘要并保留 recent 段", async () => {
    const messages = createMessages(10);
    const generator = createMockSummaryGenerator("Summary of conversation.");

    const result = await compact(
      messages,
      { keepTokens: 50 },
      generator,
    );

    expect(result.summary).toBe("Summary of conversation.");
    expect(result.recent.length).toBeLessThan(10);
    expect(result.recent.length).toBeGreaterThan(0);
  });

  test("compact: 无需压缩时返回空摘要", async () => {
    const messages = createMessages(3);
    const generator = createMockSummaryGenerator();

    const result = await compact(
      messages,
      { keepTokens: 100_000 },
      generator,
    );

    expect(result.summary).toBe("");
    expect(result.recent).toHaveLength(3);
  });
});

// ──────────────────────────────────────────────
// 上下文管理器
// ──────────────────────────────────────────────

describe("上下文管理器", () => {
  function createTestManager(overrides?: {
    contextWindow?: number;
    compactThreshold?: number;
    compactKeepTokens?: number;
    disableCompact?: boolean;
  }) {
    return createContextManager({
      config: {
        contextWindow: overrides?.contextWindow ?? 200_000,
        compactThreshold: overrides?.compactThreshold ?? 0.85,
        compactKeepTokens: overrides?.compactKeepTokens ?? 8000,
        disableCompact: overrides?.disableCompact ?? false,
        smallModel: "test-small-model",
      },
      summaryGenerator: createMockSummaryGenerator("Compacted summary."),
      systemContextOptions: { workdir: "." },
    });
  }

  test("assemble: 组装系统提示 + 消息", async () => {
    const manager = createTestManager();
    const session = createSession("test-model");
    session.messages.push(createUserMessage("Hello"));

    const ctx = await manager.assemble(session);

    expect(ctx.system).toContain("AI coding assistant");
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.tokenCount).toBeGreaterThan(0);
  });

  test("shouldCompact: 未超阈值时返回 false", async () => {
    const manager = createTestManager({ contextWindow: 200_000 });
    const session = createSession("test-model");
    session.messages.push(createUserMessage("Hello"));

    const ctx = await manager.assemble(session);
    expect(manager.shouldCompact(ctx)).toBe(false);
  });

  test("shouldCompact: 超阈值时返回 true", async () => {
    const manager = createTestManager({
      contextWindow: 100,
      compactThreshold: 0.5,
    });

    const session = createSession("test-model");
    // 添加大量消息
    for (let i = 0; i < 20; i++) {
      session.messages.push(
        i % 2 === 0
          ? createUserMessage(`Message ${i} `.repeat(10))
          : createAssistantMessage(`Response ${i} `.repeat(10)),
      );
    }

    const ctx = await manager.assemble(session);
    expect(manager.shouldCompact(ctx)).toBe(true);
  });

  test("shouldCompact: disableCompact 为 true 时始终返回 false", async () => {
    const manager = createTestManager({
      contextWindow: 10,
      compactThreshold: 0.1,
      disableCompact: true,
    });

    const session = createSession("test-model");
    session.messages.push(createUserMessage("Hello world this is a long message"));

    const ctx = await manager.assemble(session);
    expect(manager.shouldCompact(ctx)).toBe(false);
  });

  test("compact: 执行压缩并返回摘要", async () => {
    const manager = createTestManager({ compactKeepTokens: 50 });

    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Message ${i} `.repeat(10) }],
        createdAt: i,
      });
    }

    const result = await manager.compact(messages);
    expect(result.summary).toBe("Compacted summary.");
    expect(result.recent.length).toBeLessThan(10);
  });

  test("estimateTokens: 字符串和消息数组", () => {
    const manager = createTestManager();

    expect(manager.estimateTokens("Hello world!")).toBe(3);

    const messages: Message[] = [
      createUserMessage("Hello"),
    ];
    expect(manager.estimateTokens(messages)).toBeGreaterThan(0);
  });

  test("invalidateSystemPrompt: 清除缓存后重新加载", async () => {
    const manager = createTestManager();
    const session = createSession("test-model");

    const ctx1 = await manager.assemble(session);
    manager.invalidateSystemPrompt();
    const ctx2 = await manager.assemble(session);

    // 系统提示应相同（内容未变）
    expect(ctx2.system).toBe(ctx1.system);
  });
});
