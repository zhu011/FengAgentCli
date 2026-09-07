/**
 * SSE 消费端断开行为验证（AGE-29 09-07 批次「真后台并发」重做后的语义）
 *
 * 重做前（旧）：HTTP 路由直接 for-await 消费 sessionManager.sendMessage 生成器，
 * 客户端断开 / 切换会话 abort SSE fetch 后，生成器被丢弃（无 return）→
 * runningTasks 悬挂 → 该会话后续 sendMessage 被「已有正在执行的任务」永久拒绝
 * （zombie task，见上一版本脚本场景 A 的预期）。
 *
 * 重做后（本次）：后台运行（Loop 泵送）由 SessionManager 拥有，与任何单个 HTTP
 * 连接解耦 ——
 *   - 客户端断开 / 取消订阅 → 仅解除订阅，后台运行**继续**（真后台语义）；
 *   - 运行结束（正常完成 / interrupt / 异常）→ SessionManager 的 pumpRun finally
 *     无条件清理 runningTasks 并广播 run-end —— 不再遗留悬挂任务；
 *   - 事件按会话路由：只推送给订阅该会话的客户端（隔离）。
 *
 * 场景 A（SessionManager 层）：订阅 → 断开 → 后台运行照常完成 → 会话可再次发送
 * 场景 B（HTTP 层）：POST 启动后取消响应体 → 后台运行完成 → 再次 POST 成功
 *
 * 运行：bun scripts/verify-sse-abandon.ts
 */
import type { LLMClient, LLMRequest, LLMResponse, LLMEvent } from "@fengagent/llm";
import type { Config, AgentEvent } from "@fengagent/core";
import { createToolRegistry, createToolExecutor } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { Agent } from "@fengagent/agent";
import { SessionStore } from "@fengagent/agent/session";
import { SessionManager } from "../packages/server/src/session-manager.ts";
import type { SessionEvent } from "../packages/server/src/session-manager.ts";
import { createApp } from "../packages/server/src/server.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

class MockLLMClient implements LLMClient {
  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    yield { type: "text-delta", text: "后台运行回答" } as LLMEvent;
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

let dbCounter = 0;
const tempDirs: string[] = [];
function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), `feng-abandon-${dbCounter++}-`));
  tempDirs.push(dir);
  return join(dir, "test.db");
}

function createTestAgent(): Agent {
  const config = createTestConfig();
  const mockLLM = new MockLLMClient();
  const toolRegistry = createToolRegistry();
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

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(
  cond: () => boolean,
  timeoutMs = 3000,
  name = "condition",
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`until timeout: ${name}`);
    }
    await sleep(10);
  }
}

// ── 场景 A：客户端断开（unsubscribe）→ 后台运行照常完成 → 会话可再次发送 ──
{
  const manager = new SessionManager({ createAgent: createTestAgent });
  const sid = manager.createSession("A-disconnect").id;

  // 观察者（服务端视角，始终在线）记录整轮事件并接收 run-end ——
  // 「客户端」订阅者运行中会断开；run-end 的接收不依赖那个已断开的客户端，
  // 否则断言与场景语义自相矛盾（断开后自然收不到广播，只能靠仍在线的观察者确认）。
  let runEnded = false;
  const got: SessionEvent[] = [];
  const unsubObserver = manager.subscribeSessionEvents(sid, (e) => {
    got.push(e);
    if (e.type === "run-end") runEnded = true;
  });

  const started = manager.startMessageRun(sid, "第一问");
  check("A: 后台启动成功", started.ok === true);
  if (!started.ok) process.exit(1);

  // 模拟客户端：订阅 → 收到首个事件后「断开」（只解除订阅，不中止后台运行）
  const clientGot: SessionEvent[] = [];
  const unsubClient = manager.subscribeSessionEvents(sid, (e) => {
    clientGot.push(e);
  });
  (async () => {
    await until(
      () => clientGot.some((e) => e.type === "session-start"),
      3000,
      "session-start",
    );
    unsubClient(); // 客户端断开 —— 后台运行不受影响
    console.log("  （客户端已断开，后台运行继续…）");
  })();

  // 后台运行应照常结束（run-end 由 pumpRun finally 广播；观察者仍在线可收到）
  await until(() => runEnded, 4000, "run-end received");
  check("A: 断开后后台运行仍完成并自动清理（无悬挂任务）", !manager.isRunning(sid));
  check("A: 事件按会话送达（运行期间收到过会话事件）", got.length > 0, got.length);
  check("A: 客户端断开前收到过事件", clientGot.length > 0, clientGot.length);
  unsubObserver();

  // 会话随后可再次发送：不再被「已有正在执行的任务」卡死
  const second = manager.sendMessage(sid, "第二问");
  const evs: string[] = [];
  for await (const e of second) {
    evs.push(e.type);
    if (evs.length > 6) break;
  }
  check("A: 再次发送正常开始（无 zombie 拒绝）", evs.includes("session-start"), evs);
}

// ── 场景 B：HTTP 层 POST 启动后取消响应体（客户端断开）→ 后台运行完成 → 再次 POST 成功 ──
{
  const result = createApp({
    config: createTestConfig(),
    createAgent: createTestAgent,
  });
  const { app, sessionManager } = result;

  const createRes = await app.fetch(
    new Request("http://localhost/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "B-http" }),
    }),
  );
  const session = (await createRes.json()) as { id: string };
  const sid = session.id;

  const msgRes = await app.fetch(
    new Request(`http://localhost/api/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "第一问" }),
    }),
  );
  await until(() => sessionManager.isRunning(sid), 3000, "B run started");
  await msgRes.body?.cancel(); // 客户端立即断开 SSE

  // 运行仍在后台继续（未被断开中止）
  check("B: 断开后后台运行仍在", sessionManager.isRunning(sid));

  // 后台运行自然完成 → 自动清理
  await until(() => !sessionManager.isRunning(sid), 3000, "B run finished");
  check("B: 后台运行完成并清理（无残留）", !sessionManager.isRunning(sid));

  // 再次 POST 成功（不再被拒绝）
  const msgRes2 = await app.fetch(
    new Request(`http://localhost/api/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "第二问" }),
    }),
  );
  const text2 = await msgRes2.text();
  check("B: 再次发送成功（含 session-start）", text2.includes('"session-start"'), text2.slice(0, 120));

  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL PASS — SSE 断开不再遗留悬挂任务：后台运行继续、结束自动清理、会话可再次发送");
