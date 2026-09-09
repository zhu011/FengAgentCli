/**
 * @fengagent/server — 会话间真并发 + 按会话隔离测试（AGE-29 后台运行重做）
 *
 * 覆盖重做后的并发模型：
 * 1. 服务端会话间并发 —— 多个会话的 Loop 可同时运行（每会话独立上下文/消息）；
 * 2. SSE 事件按会话路由 —— 会话 A 的事件只推给订阅 A 的客户端，不污染 B；
 * 3. 客户端断开（取消订阅）不中止后台运行、不遗留悬挂任务 —— 运行结束自动
 *    清理（runningTasks），会话随后可再次发送；
 * 4. 晚加入订阅者经回放缓冲补看运行进度（GET /:id/events / subscribe 语义）。
 *
 * 运行：bun test packages/server/src/__tests__/session-concurrency.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMEvent,
} from "@fengagent/llm";
import type { Config } from "@fengagent/core";
import { createToolRegistry, createToolExecutor } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { Agent } from "@fengagent/agent";
import { SessionStore } from "@fengagent/agent/session";
import { createApp } from "../server.ts";
import type { SessionEvent } from "../session-manager.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ──────────────────────────────────────────────
// Gated LLM：stream 先阻塞在闸门上，放行后才产出文本 —— 用闸门精确控制
// 「谁先运行 / 谁还在跑」，从而确定性验证并发与隔离。
// ──────────────────────────────────────────────
class GatedLLMClient implements LLMClient {
  /** 每个 stream 调用一个放行函数（按调用顺序入队） */
  public gates: Array<() => void> = [];
  /** stream 已进入的次数（用于断言确有两个并发调用） */
  public entered = 0;

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    this.entered++;
    const text = this.lastUserText(request);
    // 阻塞直到测试放行
    await new Promise<void>((resolve) => {
      this.gates.push(resolve);
    });
    yield { type: "text-delta", text: `reply-to:${text}` };
    yield { type: "usage", inputTokens: 5, outputTokens: 3 };
    yield { type: "finish", reason: "end_turn" };
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    return {
      id: "gated-gen",
      model: request.model,
      content: [{ type: "text", text: "摘要" }],
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: "end_turn",
    };
  }

  releaseAll(): void {
    for (const release of this.gates.splice(0)) release();
  }

  private lastUserText(request: LLMRequest): string {
    for (let i = request.messages.length - 1; i >= 0; i--) {
      const msg = request.messages[i]!;
      if (msg.role === "user") {
        const text = msg.content
          .map((b) => ("text" in b ? b.text : ""))
          .join("");
        if (text) return text.slice(0, 40);
      }
    }
    return "(no-user-text)";
  }
}

// ──────────────────────────────────────────────
// 测试辅助（与 integration.test.ts 同构）
// ──────────────────────────────────────────────
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
    autoApproveTools: true,
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
  const config = createTestConfig();
  const dbPath = join(
    mkdtempSync(join(tmpdir(), `feng-concurrency-${dbCounter++}-`)),
    "test.db",
  );
  tempDirs.push(dbPath);
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

function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timeout"));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** 解析 SSE 文本 → 事件列表（含内部 run-end 标记） */
function parseSSE(text: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const frame of text.split("\n\n")) {
    const lines = frame.trim().split("\n");
    let dataLine = "";
    for (const line of lines) {
      if (line.startsWith("data: ")) dataLine += line.slice(6);
    }
    if (!dataLine) continue;
    try {
      events.push(JSON.parse(dataLine) as SessionEvent);
    } catch {
      // skip non-JSON
    }
  }
  return events;
}

function allText(events: SessionEvent[]): string {
  return events
    .filter((e): e is Extract<SessionEvent, { type: "text-delta" }> =>
      e.type === "text-delta",
    )
    .map((e) => e.text)
    .join("");
}

// ──────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────

describe("会话间真并发 + 按会话隔离（AGE-29 后台运行重做）", () => {
  let llm: GatedLLMClient;
  let app: ReturnType<typeof createApp>["app"];
  let manager: ReturnType<typeof createApp>["sessionManager"];

  beforeEach(() => {
    llm = new GatedLLMClient();
    const result = createApp({
      config: createTestConfig(),
      createAgent: () => createTestAgent(llm),
    });
    app = result.app;
    manager = result.sessionManager;
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(join(dir, ".."), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  const createSession = async (title: string): Promise<string> => {
    const res = await app.fetch(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }),
    );
    const session = (await res.json()) as { id: string };
    return session.id;
  };

  const postMessage = (
    sessionId: string,
    content: string,
  ): Promise<Response> =>
    app.fetch(
      new Request(`http://localhost/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }),
    ) as Promise<Response>;

  test("1) 双会话同时运行互不干扰：双 POST 并发 + SSE 按会话隔离 + 同会话并发拒绝", async () => {
    const idA = await createSession("A");
    const idB = await createSession("B");

    // 会话 A 先发送（LLM 闸门阻塞 → 运行挂起在后台）
    const postA = postMessage(idA, "hello-A");
    await waitFor(() => manager.isRunning(idA));

    // A 运行期间向会话 B 发送 —— 必须被接受（会话间并发，不再被全局单流挡住）
    const postB = postMessage(idB, "hello-B");
    await waitFor(() => manager.isRunning(idB));

    // 两会话同时处于运行中 → 服务端会话间并发成立
    expect(manager.isRunning(idA)).toBe(true);
    expect(manager.isRunning(idB)).toBe(true);
    // 两个 LLM 调用均已进入闸门（两会话的 Loop 都在推进）
    await waitFor(() => llm.entered >= 2);

    // 同一会话并发防护：A 运行期间再向 A 发送 → 明确拒绝（不重复执行）
    const busyRes = await postMessage(idA, "hello-A2");
    const busyText = await busyRes.text();
    expect(busyText).toContain("已有正在执行的任务");

    // 放行 → 两个后台运行各自完成
    llm.releaseAll();

    const eventsA = parseSSE(await postA.then((r) => r.text()));
    const eventsB = parseSSE(await postB.then((r) => r.text()));

    // A 的流只含 A 自己的内容，不含 B 的内容（消息隔离）
    expect(allText(eventsA)).toContain("reply-to:hello-A");
    expect(allText(eventsA)).not.toContain("reply-to:hello-B");
    // B 的流只含 B 自己的内容
    expect(allText(eventsB)).toContain("reply-to:hello-B");
    expect(allText(eventsB)).not.toContain("reply-to:hello-A");

    // 两边都以 session-start 开头、session-end 结尾
    expect(eventsA[0]?.type).toBe("session-start");
    expect(eventsA.some((e) => e.type === "session-end")).toBe(true);
    expect(eventsB.some((e) => e.type === "session-end")).toBe(true);

    // 运行结束 → 会话可再次发送（无任务残留）
    await waitFor(() => !manager.isRunning(idA) && !manager.isRunning(idB));
    expect(manager.isRunning(idA)).toBe(false);
    expect(manager.isRunning(idB)).toBe(false);
  });

  test("2) 客户端断开不中止后台运行、不遗留悬挂任务，会话随后可再次发送", async () => {
    const idS = await createSession("S");

    // 发送并等运行真正开始（LLM 调用已进入闸门）
    const post1 = postMessage(idS, "first");
    await waitFor(() => manager.isRunning(idS));
    await waitFor(() => llm.entered >= 1);

    // 客户端立即断开（取消响应体读取 —— 对应切换/关闭页面时 fetch abort）
    const res1 = await post1;
    await res1.body?.cancel();
    await waitFor(() => manager.isRunning(idS)); // 断开后运行仍在（后台继续）

    // 放行 → 后台运行自然完成并自动清理
    llm.releaseAll();
    await waitFor(() => !manager.isRunning(idS));
    expect(manager.isRunning(idS)).toBe(false);

    // 会话可再次发送：不再被「已有正在执行的任务」卡死（无僵尸任务）
    const post2 = postMessage(idS, "second");
    await waitFor(() => manager.isRunning(idS));
    await waitFor(() => llm.entered >= 2);
    llm.releaseAll();
    const events2 = parseSSE(await post2.then((r) => r.text()));
    expect(events2.some((e) => e.type === "session-start")).toBe(true);
    expect(allText(events2)).toContain("reply-to:second");
    expect(events2.some((e) => e.type === "session-end")).toBe(true);
  });

  test("3) 晚加入订阅者回放补看后台运行进度（subscribeSessionEvents 回放缓冲）", async () => {
    const sid = manager.createSession("replay").id;

    // 订阅者 1：接收运行开头的事件后「断开」
    const got1: SessionEvent[] = [];
    const unsub1 = manager.subscribeSessionEvents(sid, (e) => {
      got1.push(e);
    });

    const started = manager.startMessageRun(sid, "hello");
    expect(started.ok).toBe(true);
    await waitFor(() => got1.some((e) => e.type === "session-start"));
    expect(got1.some((e) => e.type === "message-start")).toBe(true);
    unsub1(); // 模拟客户端断开

    // 订阅者 2 晚加入：订阅瞬间应同步回放本次运行已产生的事件
    const got2: SessionEvent[] = [];
    let resolveDone: () => void;
    const done2 = new Promise<void>((r) => (resolveDone = r));
    manager.subscribeSessionEvents(sid, (e) => {
      got2.push(e);
      if (e.type === "run-end") resolveDone();
    });

    // 回放在订阅时同步发生：不必等运行结束就能看到 session-start
    expect(got2.some((e) => e.type === "session-start")).toBe(true);

    await waitFor(() => llm.entered >= 1);
    llm.releaseAll();
    await done2;

    // 订阅者 2 收到完整进度：从回放的 session-start 到收尾
    expect(got2.some((e) => e.type === "text-delta")).toBe(true);
    expect(allText(got2)).toContain("reply-to:hello");
    expect(got2.some((e) => e.type === "session-end")).toBe(true);
    expect(manager.isRunning(sid)).toBe(false);
  });

  test("4) 订阅按会话路由：A 的订阅者收不到 B 的运行事件（事件隔离）", async () => {
    const idA = manager.createSession("iso-A").id;
    const idB = manager.createSession("iso-B").id;

    const eventsA: SessionEvent[] = [];
    manager.subscribeSessionEvents(idA, (e) => eventsA.push(e));

    const eventsB: SessionEvent[] = [];
    let resolveDoneB: () => void;
    const doneB = new Promise<void>((r) => (resolveDoneB = r));
    manager.subscribeSessionEvents(idB, (e) => {
      eventsB.push(e);
      if (e.type === "run-end") resolveDoneB();
    });

    expect(manager.startMessageRun(idA, "qa").ok).toBe(true);
    expect(manager.startMessageRun(idB, "qb").ok).toBe(true);
    await waitFor(() => manager.isRunning(idA) && manager.isRunning(idB));
    await waitFor(() => llm.entered >= 2);

    llm.releaseAll();
    await doneB;
    await waitFor(() => !manager.isRunning(idA));

    // A 的订阅者：只收到 A 自己的事件，绝无 B 的内容
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsA.some((e) => e.type === "session-end")).toBe(true);
    expect(allText(eventsA)).toContain("reply-to:qa");
    expect(allText(eventsA)).not.toContain("reply-to:qb");

    // B 的订阅者：只收到 B 自己的事件
    expect(allText(eventsB)).toContain("reply-to:qb");
    expect(allText(eventsB)).not.toContain("reply-to:qa");
  });

  test("5) GET /:id/events 订阅通道：订阅期间运行的事件实时送达（HTTP 层）", async () => {
    const idS = await createSession("events");

    // 用 POST 启动后台运行（LLM 闸门阻塞），随后完全断开 POST 连接
    const post1 = postMessage(idS, "live");
    const res1 = await post1;
    await res1.body?.cancel();
    await waitFor(() => manager.isRunning(idS));

    // 打开 GET /:id/events 订阅：应收到从订阅时刻起（含放行后）的实时事件
    const subRes = await app.fetch(
      new Request(`http://localhost/api/sessions/${idS}/events`),
    );
    expect(subRes.status).toBe(200);
    expect(subRes.headers.get("content-type")).toContain("text/event-stream");

    const reader = subRes.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    const received: SessionEvent[] = [];
    const deadline = Date.now() + 4000;

    // 等 LLM 调用真正进入闸门后再放行（避免闸门登记晚于放行的竞态）
    await waitFor(() => llm.entered >= 1);
    llm.releaseAll();

    // 读到 session-end 即代表本轮完整事件已送达（随后可关闭订阅）
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = chunk
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("");
        if (dataLine) {
          try {
            const ev = JSON.parse(dataLine) as SessionEvent;
            received.push(ev);
            if (ev.type === "session-end") {
              await reader.cancel();
              expect(allText(received)).toContain("reply-to:live");
              return;
            }
          } catch {
            // skip
          }
        }
      }
    }
    throw new Error(
      `GET /events 未在期限内收到 session-end；已收: ${received.map((e) => e.type).join(",")}`,
    );
  });
});
