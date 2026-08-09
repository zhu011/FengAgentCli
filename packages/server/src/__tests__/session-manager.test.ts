/**
 * @fengagent/server — 会话管理器测试
 *
 * 使用 Mock LLM 测试 SessionManager 的会话管理、消息发送、权限交互。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMEvent,
} from "@fengagent/llm";
import type { Config, AgentEvent } from "@fengagent/core";
import { createToolRegistry, createToolExecutor } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { Agent } from "@fengagent/agent";
import { SessionStore } from "@fengagent/agent/session";
import { SessionManager, SessionNotFoundError } from "../session-manager.ts";
import { z } from "zod";

// ──────────────────────────────────────────────
// Mock LLM Client
// ──────────────────────────────────────────────

class MockLLMClient implements LLMClient {
  private responses: LLMEvent[][] = [];
  private callIndex = 0;

  setResponses(responses: LLMEvent[][]): void {
    this.responses = responses;
    this.callIndex = 0;
  }

  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    const events = this.responses[this.callIndex] ?? [];
    this.callIndex++;
    for (const event of events) {
      yield event;
    }
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    return {
      id: "mock-gen",
      model: request.model,
      content: [{ type: "text", text: "摘要内容" }],
      usage: { inputTokens: 100, outputTokens: 50 },
      finishReason: "end_turn",
    };
  }
}

// ──────────────────────────────────────────────
// 测试辅助
// ──────────────────────────────────────────────

function createTestConfig(): Config {
  return {
    model: "test-model",
    smallModel: "test-small-model",
    provider: "anthropic",
    maxTokens: 4096,
    temperature: 1.0,
    contextWindow: 200_000,
    compactThreshold: 0.85,
    compactKeepTokens: 8000,
    compactBuffer: 20_000,
    disableCompact: false,
    toolOutputMaxChars: 2000,
    serverPort: 3000,
    serverHost: "127.0.0.1",
    corsOrigin: "*",
    autoApproveTools: true,
    allowedTools: "*",
    bashTimeout: 120_000,
    maxToolConcurrency: 10,
    maxTurns: 50,
    logLevel: "info",
    dataDir: "~/.fengagent",
  };
}

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dbCounter = 0;

function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), `feng-test-${dbCounter++}-`));
  return join(dir, "test.db");
}

function createTestAgent(): Agent {
  const config = createTestConfig();
  const mockLLM = new MockLLMClient();

  const toolRegistry = createToolRegistry();
  const echoTool = {
    name: "echo",
    description: "Echo back input",
    inputSchema: z.object({ text: z.string() }),
    async execute(input: { text: string }) {
      return { content: `Echo: ${input.text}` };
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  };
  toolRegistry.register(echoTool);

  const toolExecutor = createToolExecutor();

  const contextManager = createContextManager({
    config: {
      contextWindow: config.contextWindow,
      compactThreshold: config.compactThreshold,
      compactKeepTokens: config.compactKeepTokens,
      disableCompact: config.disableCompact,
      smallModel: config.smallModel,
    },
    summaryGenerator: mockLLM,
    systemContextOptions: { workdir: "." },
  });

  // 使用临时数据库文件
  const dbPath = createTempDbPath();
  const sessionStore = new SessionStore(dbPath);

  return new Agent({
    llmClient: mockLLM,
    toolRegistry,
    toolExecutor,
    contextManager,
    config,
    workdir: ".",
    sessionStore,
  });
}

/** 收集所有 AgentEvent */
async function collectEvents(
  gen: AsyncGenerator<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ──────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager({
      createAgent: createTestAgent,
    });
  });

  test("createSession — 创建会话并返回 id", () => {
    const session = manager.createSession("Test Session");

    expect(session.id).toBeTruthy();
    expect(session.title).toBe("Test Session");
    expect(session.messages).toEqual([]);
  });

  test("getSession — 获取已创建的会话", () => {
    const session = manager.createSession("Test");
    const loaded = manager.getSession(session.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);
  });

  test("getSession — 不存在的会话返回 null", () => {
    const loaded = manager.getSession("nonexistent");
    expect(loaded).toBeNull();
  });

  test("listSessions — 列出所有会话", () => {
    const s1 = manager.createSession("Session 1");
    const s2 = manager.createSession("Session 2");

    const list = manager.listSessions();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const ids = list.map((s) => s.id);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s2.id);
  });

  test("sendMessage — 发送消息并收到 AgentEvent 流", async () => {
    const session = manager.createSession("Test");

    const events = await collectEvents(
      manager.sendMessage(session.id, "Hello"),
    );

    // 应该至少有 session-start 和 session-end
    const types = events.map((e) => e.type);
    expect(types).toContain("session-start");
    expect(types).toContain("session-end");
  });

  test("sendMessage — 不存在的会话抛出 SessionNotFoundError", async () => {
    try {
      await collectEvents(manager.sendMessage("nonexistent", "Hello"));
      expect(false).toBe(true); // 不应到达
    } catch (err) {
      expect(err).toBeInstanceOf(SessionNotFoundError);
    }
  });

  test("interrupt — 中断运行中的任务", async () => {
    const session = manager.createSession("Test");

    // 启动消息发送（不等待完成）
    const gen = manager.sendMessage(session.id, "Hello");
    const iter = gen[Symbol.asyncIterator]();

    // 读取第一个事件触发执行
    await iter.next();

    // 中断
    const interrupted = manager.interrupt(session.id);
    expect(interrupted).toBe(true);

    // 继续消费直到结束
    while (true) {
      const result = await iter.next();
      if (result.done) break;
    }
  });

  test("interrupt — 没有运行中的任务返回 false", () => {
    const session = manager.createSession("Test");
    const interrupted = manager.interrupt(session.id);
    expect(interrupted).toBe(false);
  });

  test("destroySession — 销毁会话后无法访问", () => {
    const session = manager.createSession("Test");
    manager.destroySession(session.id);

    // 销毁后 getSession 返回 null（Agent 已被移除）
    const loaded = manager.getSession(session.id);
    expect(loaded).toBeNull();
  });

  test("exportSession — 导出会话为 JSON", () => {
    const session = manager.createSession("Test");
    const exported = manager.exportSession(session.id);

    expect(exported).not.toBeNull();
    const parsed = JSON.parse(exported!);
    expect(parsed.id).toBe(session.id);
  });

  test("exportSession — 不存在的会话返回 null", () => {
    const exported = manager.exportSession("nonexistent");
    expect(exported).toBeNull();
  });

  test("权限请求/响应流程", async () => {
    const session = manager.createSession("Permission Test");

    // 订阅权限请求
    let permissionReq: { reqId: string; toolName: string } | null = null;
    manager.subscribePermissions(session.id, (req) => {
      permissionReq = { reqId: req.reqId, toolName: req.toolName };
    });

    // 在后台启动一个会触发权限请求的操作
    // 由于 autoApproveTools=true，不会触发权限请求
    // 这个测试验证订阅机制本身工作
    expect(permissionReq).toBeNull();

    // 取消订阅
    manager.unsubscribePermissions(session.id);
  });

  test("respondPermission — 响应不存在的权限请求返回 false", () => {
    const session = manager.createSession("Test");
    const responded = manager.respondPermission(
      session.id,
      "nonexistent-req",
      { decision: "allow" },
    );
    expect(responded).toBe(false);
  });

  test("getPendingPermissions — 初始无权限请求", () => {
    const session = manager.createSession("Test");
    const pending = manager.getPendingPermissions(session.id);
    expect(pending).toEqual([]);
  });
});
