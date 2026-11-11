/**
 * 权限「收回」HTTP 路由级测试（AGE-35：Permissions 面板撤销）。
 *
 * 覆盖链路：
 * 1. `GET  /api/sessions/:id/permissions/grants` —— 已授权项（会话级 + permissions.json）；
 * 2. `POST /api/sessions/:id/permissions/:reqId { scope: "session" }` —— 「本会话允许」；
 * 3. `DELETE /api/sessions/:id/permissions/grants` —— 收回会话级放行（收回后重新弹窗）；
 * 4. `DELETE /api/sessions/:id/permissions/rules` —— 撤销永久规则（落盘 + 触发 reload）；
 * 5. 未配置规则面 → 503（不会误写真实配置文件），会话不存在 → 404。
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

/** 一次运行的 LLM 响应：一次 danger 工具调用 + 一段收尾文本 */
function toolRun(id: string): LLMEvent[][] {
  return [
    [
      { type: "tool-call", id, name: "danger", input: { action: "delete" } },
      { type: "finish", reason: "tool_use" },
    ],
    [{ type: "text-delta", text: "done" }, { type: "finish", reason: "end_turn" }],
  ];
}

interface PendingPermission {
  reqId: string;
  toolName: string;
}

/** 轮询待处理权限，直到出现一条（或超时） */
async function waitForPending(
  app: ReturnType<typeof createApp>["app"],
  sessionId: string,
  timeoutMs = 5000,
): Promise<PendingPermission[]> {
  const deadline = Date.now() + timeoutMs;
  let pending: PendingPermission[] = [];
  while (Date.now() < deadline) {
    const res = await app.fetch(
      new Request(`http://localhost/api/sessions/${sessionId}/permissions`),
    );
    pending = (await res.json()) as PendingPermission[];
    if (pending.length > 0) return pending;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return pending;
}

async function startRun(
  app: ReturnType<typeof createApp>["app"],
  sessionId: string,
  content: string,
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }),
  );
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

  test("会话级放行 → 列表可见 → 撤销后重新弹窗", async () => {
    const llm = new MockLLMClient();
    llm.setResponses([...toolRun("call-1"), ...toolRun("call-2"), ...toolRun("call-3")]);
    const workdir = makeTempDir("feng-perm-revoke-workdir-");
    const { app, sessionManager } = createApp({
      config: createTestConfig({ autoApproveTools: false }),
      createAgent: () => createTestAgent(llm),
      permissionRules: { workdir },
    });
    const session = sessionManager.createSession("revoke test");

    // 第一次：弹窗 → 「本会话允许」
    const run1 = startRun(app, session.id, "run1");
    const pending1 = await waitForPending(app, session.id);
    expect(pending1).toHaveLength(1);
    expect(pending1[0]!.toolName).toBe("danger");

    const responded = await app.fetch(
      new Request(
        `http://localhost/api/sessions/${session.id}/permissions/${pending1[0]!.reqId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "allow", scope: "session" }),
        },
      ),
    );
    expect(responded.status).toBe(200);
    const respondedBody = (await responded.json()) as {
      responded: boolean;
      grants: { session: Array<{ tool: string; grantedAt: number }> };
    };
    expect(respondedBody.responded).toBe(true);
    expect(respondedBody.grants.session.map((g) => g.tool)).toEqual(["danger"]);
    await (await run1).text();

    // 第二次：会话级放行生效 —— 不再弹窗，工具直接执行
    const run2 = await startRun(app, session.id, "run2");
    const events2 = parseSSE(await run2.text());
    expect(
      events2.some(
        (e) =>
          e.type === "tool-call-result" &&
          (e.result as { content?: string } | undefined)?.content === "Executed: delete",
      ),
    ).toBe(true);
    const pending2 = await waitForPending(app, session.id, 300);
    expect(pending2).toEqual([]);

    const grantsBefore = (await (
      await app.fetch(new Request(`http://localhost/api/sessions/${session.id}/permissions/grants`))
    ).json()) as { session: Array<{ tool: string }>; path: string };
    expect(grantsBefore.session.map((g) => g.tool)).toEqual(["danger"]);
    expect(grantsBefore.path).toBe(PERMISSIONS_CONFIG_PATH);

    // 撤销会话级放行
    const revoked = await app.fetch(
      new Request(`http://localhost/api/sessions/${session.id}/permissions/grants`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "danger" }),
      }),
    );
    expect(revoked.status).toBe(200);
    const revokedBody = (await revoked.json()) as {
      revoked: string[];
      grants: { session: unknown[] };
    };
    expect(revokedBody.revoked).toEqual(["danger"]);
    expect(revokedBody.grants.session).toEqual([]);

    // 第三次：收回了 → 重新弹窗
    const run3 = startRun(app, session.id, "run3");
    const pending3 = await waitForPending(app, session.id);
    expect(pending3).toHaveLength(1);
    await app.fetch(
      new Request(
        `http://localhost/api/sessions/${session.id}/permissions/${pending3[0]!.reqId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "allow" }),
        },
      ),
    );
    await (await run3).text();

    // 只放行一次 → 不产生会话级授权
    const afterOnce = (await (
      await app.fetch(new Request(`http://localhost/api/sessions/${session.id}/permissions/grants`))
    ).json()) as { session: unknown[] };
    expect(afterOnce.session).toEqual([]);
  }, 30000);

  test("永久规则：列出 → 撤销落盘 → 触发 reload", async () => {
    const llm = new MockLLMClient();
    llm.setResponses(toolRun("call-p"));
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
    llm.setResponses(toolRun("call-c"));
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
