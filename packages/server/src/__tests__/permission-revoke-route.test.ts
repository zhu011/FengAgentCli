/**
 * 权限「收回」HTTP 路由级测试（AGE-35：Permissions 面板撤销）。
 *
 * 覆盖链路：
 * 1. `GET  /api/sessions/:id/permissions/grants` —— 全局权限规则（permissions.json）；
 * 2. `DELETE /api/sessions/:id/permissions/rules` —— 撤销永久规则（落盘 + 触发 reload）；
 * 3. 未配置规则面 → 503（不会误写真实配置文件），会话不存在 → 404。
 *
 * 会话级放行（「本会话允许」）已按 owner 决策移除（2026-11-11）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import type { LLMClient, LLMRequest, LLMResponse, LLMEvent } from "@fengagent/llm";
import type { Config } from "@fengagent/core";
import {
  createToolRegistry,
  createToolExecutor,
  loadPermissionConfig,
  PERMISSIONS_CONFIG_PATH,
} from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { Agent } from "@fengagent/agent";
import { SessionStore } from "@fengagent/agent/session";
import { createApp } from "../server.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createTestAgent(llm: LLMClient): Agent {
  const config = createTestConfig({ autoApproveTools: false });
  const dbPath = join(makeTempDir("feng-perm-revoke-route-"), "test.db");
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
    toolExecutor: createToolExecutor(),
    contextManager,
    config,
    workdir: ".",
    sessionStore,
  });
}

describe("权限收回 — HTTP 路由级", () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tempDirs.length = 0;
  });

  test("永久规则：列出 → 撤销落盘 → 触发 reload", async () => {
    const llm = new MockLLMClient();
    llm.setResponses([]);
    const workdir = makeTempDir("feng-perm-rule-workdir-");
    mkdirSync(join(workdir, ".fengagent"), { recursive: true });
    writeFileSync(
      join(workdir, PERMISSIONS_CONFIG_PATH),
      JSON.stringify({
        rules: [
          { tool: "bash", action: "allow", reason: "永久放行" },
          { tool: "grep", action: "ask" },
        ],
      }),
      "utf-8",
    );

    let reloads = 0;
    const { app, sessionManager } = createApp({
      config: createTestConfig(),
      createAgent: () => createTestAgent(llm),
      permissionRules: { workdir, reload: () => void (reloads += 1) },
    });
    const session = sessionManager.createSession("permanent rules");

    const listed = (await (
      await app.fetch(new Request(`http://localhost/api/sessions/${session.id}/permissions/grants`))
    ).json()) as { permanent: Array<{ tool: string; action: string }> };
    expect(listed.permanent.map((r) => `${r.tool}:${r.action}`)).toEqual(["bash:allow", "grep:ask"]);

    const removed = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/permissions/rules`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "bash", action: "allow" }),
      }),
    );
    expect(removed.status).toBe(200);
    const removedBody = (await removed.json()) as {
      removed: number;
      rules: Array<{ tool: string; action: string }>;
      grants: { permanent: Array<{ tool: string; action: string }> };
    };
    expect(removedBody.removed).toBe(1);
    expect(removedBody.rules).toEqual([{ tool: "grep", action: "ask" }]);
    expect(removedBody.grants.permanent).toEqual([{ tool: "grep", action: "ask" }]);
    expect(reloads).toBe(1);

    // 磁盘上的规则确实被删掉了（不是只改了响应）
    expect(loadPermissionConfig(workdir).rules).toEqual([{ tool: "grep", action: "ask" }]);

    // 再撤销一条不存在的规则：removed=0，不触发 reload
    const again = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/permissions/rules`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "bash" }),
      }),
    );
    expect(((await again.json()) as { removed: number }).removed).toBe(0);
    expect(reloads).toBe(1);
  }, 20000);

  test("参数与配置校验：缺 tool → 400，未接规则面 → 503，会话不存在 → 404", async () => {
    const llm = new MockLLMClient();
    llm.setResponses([]);
    const { app, sessionManager } = createApp({
      config: createTestConfig(),
      createAgent: () => createTestAgent(llm),
    });
    const session = sessionManager.createSession("validation");

    const missingTool = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/permissions/rules`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(missingTool.status).toBe(503); // 未接规则面时优先报能力缺失

    const noRulesFace = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/permissions/rules`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "bash" }),
      }),
    );
    expect(noRulesFace.status).toBe(503);

    const withRules = createApp({
      config: createTestConfig(),
      createAgent: () => createTestAgent(llm),
      permissionRules: { workdir: makeTempDir("feng-perm-rule-400-") },
    });
    const session2 = withRules.sessionManager.createSession("validation-2");
    const badAction = await withRules.app.fetch(
      new Request(`http://localhost/api/sessions/${session2.id}/permissions/rules`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "bash", action: "nope" }),
      }),
    );
    expect(badAction.status).toBe(400);

    const noTool = await withRules.app.fetch(
      new Request(`http://localhost/api/sessions/${session2.id}/permissions/rules`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(noTool.status).toBe(400);

    const missingSession = await withRules.app.fetch(
      new Request(`http://localhost/api/sessions/does-not-exist/permissions/grants`),
    );
    expect(missingSession.status).toBe(404);
  }, 20000);
});
