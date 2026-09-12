/**
 * HITL 改参（human-in-the-loop 工具入参修正）HTTP 路由级端到端测试。
 *
 * 覆盖链路：POST /api/sessions/:id/messages（SSE）→ 工具触发权限 ask
 * → POST /api/sessions/:id/permissions/:reqId { decision: "allow", input: 修改后入参 }
 * → 工具以修改后的参数执行 → tool-call-result 事件与会话历史均携带实际执行入参
 *（WebUI「✏️ 已改参」标记的数据来源）。
 *
 * 与既有测试的分工：tools/hitl-retry.test.ts 覆盖 executor 改参执行；
 * integration.test.ts 直接调 sessionManager.respondPermission（绕过 HTTP 路由）。
 * 本文件走真实 HTTP 路由，防止「路由丢 input」类缺口回归。
 */

import { describe, test, expect, afterEach } from "bun:test";
import type { LLMClient, LLMRequest, LLMResponse, LLMEvent } from "@fengagent/llm";
import type { Config } from "@fengagent/core";
import { createToolRegistry, createToolExecutor } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { Agent } from "@fengagent/agent";
import { SessionStore } from "@fengagent/agent/session";
import { createApp } from "../server.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

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
    for (const event of events) yield event;
  }
  async generate(request: LLMRequest): Promise<LLMResponse> {
    return {
      id: "mock-gen",
      model: request.model,
      content: [{ type: "text", text: "摘要" }],
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: "end_turn",
    };
  }
}

function createTestConfig(overrides?: Partial<Config>): Config {
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
    autoApproveTools: false,
    allowedTools: "*",
    bashTimeout: 120_000,
    maxToolConcurrency: 10,
    maxTurns: 50,
    logLevel: "info",
    dataDir: "~/.fengagent",
    ...overrides,
  };
}

let dbCounter = 0;
const tempDirs: string[] = [];

function createTestAgent(llm: LLMClient): Agent {
  const config = createTestConfig({ autoApproveTools: false });
  const dbPath = join(
    mkdtempSync(join(tmpdir(), `feng-hitl-route-${dbCounter++}-`)),
    "test.db",
  );
  tempDirs.push(dbPath);
  const toolRegistry = createToolRegistry();
  toolRegistry.register({
    name: "danger",
    description: "destructive tool for permission testing",
    inputSchema: z.object({ action: z.string() }),
    async execute(input: { action: string }) {
      return { content: `Executed: ${input.action}` };
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false,
    checkPermissions() {
      return { decision: "ask" as const, message: "This is destructive" };
    },
  });
  const toolExecutor = createToolExecutor();
  const contextManager = createContextManager({
    config: {
      contextWindow: config.contextWindow,
      compactThreshold: config.compactThreshold,
      compactKeepTokens: config.compactKeepTokens,
      disableCompact: config.disableCompact,
      smallModel: config.smallModel,
    },
    summaryGenerator: llm,
    systemContextOptions: { workdir: "." },
  });
  const sessionStore = new SessionStore(dbPath);
  return new Agent({
    llmClient: llm,
    toolRegistry,
    toolExecutor,
    contextManager,
    config,
    workdir: ".",
    sessionStore,
  });
}

function parseSSE(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const frame of text.split("\n\n")) {
    let dataLine = "";
    for (const line of frame.trim().split("\n")) {
      if (line.startsWith("data: ")) dataLine += line.slice(6);
    }
    if (!dataLine) continue;
    try {
      events.push(JSON.parse(dataLine) as Record<string, unknown>);
    } catch {
      // 忽略无法解析的帧
    }
  }
  return events;
}

describe("HITL 改参 — HTTP 路由级端到端", () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(join(dir, ".."), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tempDirs.length = 0;
  });

  test("allow 携带 input → 工具以修改后参数执行，事件与历史均带实际入参", async () => {
    const llm = new MockLLMClient();
    llm.setResponses([
      [
        { type: "tool-call", id: "call-1", name: "danger", input: { action: "delete" } },
        { type: "finish", reason: "tool_use" },
      ],
      [{ type: "text-delta", text: "done" }, { type: "finish", reason: "end_turn" }],
    ]);
    const agent = createTestAgent(llm);
    const config = createTestConfig({ autoApproveTools: false });
    const result = createApp({ config, createAgent: () => agent });
    const app = result.app;
    const session = result.sessionManager.createSession("HITL route test");

    // 启动消息（SSE），不 await 完成——权限请求在流中途挂起等待响应
    const resPromise = app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "do something" }),
      }),
    );

    // 轮询待处理权限（与 WebUI 检查器相同路径）
    let pending: Array<{ reqId: string; input: unknown }> = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = await app.fetch(
        new Request(`http://localhost/api/sessions/${session.id}/permissions`),
      );
      pending = (await r.json()) as Array<{ reqId: string; input: unknown }>;
      if (pending.length > 0) break;
      await new Promise((r2) => setTimeout(r2, 20));
    }
    expect(pending.length).toBe(1);
    expect(pending[0]!.input).toEqual({ action: "delete" });

    // 用户改参（delete → rename）后 Allow —— 走 HTTP 路由，检验 input 透传
    const respond = await app.fetch(
      new Request(
        `http://localhost/api/sessions/${session.id}/permissions/${pending[0]!.reqId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "allow", input: { action: "rename" } }),
        },
      ),
    );
    expect(respond.status).toBe(200);

    const res = await resPromise;
    const events = parseSSE(await res.text());
    const toolResult = events.find((e) => e.type === "tool-call-result") as
      | { result: { content: string }; input?: unknown }
      | undefined;
    expect(toolResult).toBeDefined();
    // 工具实际以修改后的参数执行
    expect(toolResult!.result.content).toBe("Executed: rename");
    // 事件携带实际执行入参（WebUI「✏️ 已改参」标记的依据）
    expect(toolResult!.input).toEqual({ action: "rename" });

    // 历史同步：会话历史中的 tool-use 块 input 同步为实际执行入参（可溯源）
    const sessRes = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}`),
    );
    const sessJson = (await sessRes.json()) as {
      messages: Array<{
        role: string;
        content: Array<{ type: string; id?: string; input?: unknown }>;
      }>;
    };
    const assistantMsg = sessJson.messages.find((m) => m.role === "assistant");
    const toolUseBlock = assistantMsg?.content.find(
      (b) => b.type === "tool-use" && b.id === "call-1",
    );
    expect(toolUseBlock?.input).toEqual({ action: "rename" });
  }, 15000);
});
