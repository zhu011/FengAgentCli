/**
 * @fengagent/server — ACP stdio JSON-RPC 测试
 *
 * 回归目标：Multica 守护进程 spawn `fengagent acp` 后走 stdin/stdout 的 ACP
 * 握手；此前该子命令只起 HTTP server，从不读 stdin，宿主侧只能看到
 * “hermes initialize failed: hermes process exited”。
 *
 * 本测试用一个假 Agent + 内存管道完整跑一遍：
 * initialize → session/new → session/prompt（含 session/update 流）→ stopReason，
 * 并逐条校验 JSON-RPC 帧的形状（与 @deepseek-ai/dsh-acp 的线格式对齐）。
 */

import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  startAcpStdioServer,
  acpPromptToText,
  promptHasUnsupportedContent,
  turnEndToStopReason,
  ACP_PROTOCOL_VERSION,
  redirectConsoleToStderr,
  type AcpSessionUpdate,
} from "../acp-stdio.ts";
import type { AgentEvent, Session } from "@fengagent/core";
import type { Agent } from "@fengagent/agent";

/** 内存输出端：按行收集协议帧（遵循 AcpFrameWriter 契约，写完即回调） */
class FrameCollector {
  lines: string[] = [];

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.lines.push(chunk);
    callback?.();
    return true;
  }

  /** 已收到的完整协议帧 */
  frames(): Array<Record<string, unknown>> {
    return this.lines
      .join("")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** 等待某一类帧出现（按谓词） */
  async waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs = 2000,
  ): Promise<Record<string, unknown>> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const hit = this.frames().find(predicate);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`等待协议帧超时；已收到:\n${this.lines.join("")}`);
  }
}

/** 造一个按脚本产出事件的假 Agent */
function makeFakeAgent(
  script: AgentEvent[] | ((text: string) => AgentEvent[]),
  options: { delayMs?: number; knownSessions?: Record<string, Session> } = {},
) {
  const delayMs = options.delayMs ?? 0;
  const created: Array<{ workdir: string; session: Session }> = [];
  let seq = 0;

  const factory = (workdir: string): Agent => {
    const session = {
      id: `ses_${++seq}`,
      title: "fake",
      messages: [],
      model: "fake-model",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "idle",
      tokenCount: 0,
    } as unknown as Session;
    created.push({ workdir, session });

    const agent = {
      createSession: () => session,
      async *prompt(text: string): AsyncGenerator<AgentEvent> {
        const events = typeof script === "function" ? script(text) : script;
        for (const event of events) {
          yield event;
          // 让出一次事件循环，模拟真实流式节奏（delayMs > 0 时用于构造「在飞」窗口）
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      },
    } as unknown as Agent;

    return agent;
  };

  /**
   * 假的「按 sessionId 恢复」工厂：`knownSessions` 命中则回该会话（模拟跨进程
   * 从持久化数据恢复上下文），未命中则回一个与宿主同 id 的空会话。
   */
  const resumed: Array<{ workdir: string; sessionId: string; hit: boolean }> = [];
  const resumeAgent = (workdir: string, sessionId: string) => {
    const agent = factory(workdir);
    const hit = options.knownSessions?.[sessionId];
    resumed.push({ workdir, sessionId, hit: hit !== undefined });
    const session = hit ?? ({ ...factorySessionStub(sessionId) } as Session);
    return { agent, session };
  };

  return { factory, created, resumeAgent, resumed };
}

/** 与宿主 id 对齐的空会话桩（resume 未命中时的保底形状） */
function factorySessionStub(sessionId: string): Session {
  return {
    id: sessionId,
    title: "resumed",
    messages: [],
    model: "fake-model",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "idle",
    tokenCount: 0,
  } as Session;
}

/** 长时间在飞的脚本：用于取消 / 并发抢占（配合 delayMs 拉长窗口） */
function longTurn(): AgentEvent[] {
  return Array.from({ length: 40 }, (_, index) => ({
    type: "text-delta",
    messageId: "m1",
    text: `tick${index} `,
  }));
}

/** 建一个受控的连接 */
function connect(
  factory: (workdir: string) => Agent,
  resumeAgent?: (workdir: string, sessionId: string) => { agent: Agent; session: Session },
) {
  const input = new EventEmitter();
  const output = new FrameCollector();
  const connection = startAcpStdioServer({
    createAgent: factory,
    ...(resumeAgent ? { resumeAgent } : {}),
    config: { contextWindow: 100000 },
    input,
    output,
    exitOnClose: false,
    // 测试里静音（临时打开可打印到 stderr 排查）
    log: (level, message) => {
      if (process.env.FENG_ACP_TEST_LOG) process.stderr.write(`[acp] ${level} ${message}\n`);
    },
  });

  let nextId = 0;
  const send = (message: Record<string, unknown>): void => {
    input.emit("data", `${JSON.stringify(message)}\n`);
  };

  return {
    input,
    output,
    connection,
    request(method: string, params?: unknown): { id: number; promise: Promise<Record<string, unknown>> } {
      const id = ++nextId;
      send({ jsonrpc: "2.0", id, method, params });
      const promise = output.waitFor((frame) => frame.id === id);
      return { id, promise };
    },
    notify(method: string, params?: unknown): void {
      send({ jsonrpc: "2.0", method, params });
    },
  };
}

/** 一轮正常对话的事件脚本 */
function normalTurn(text: string): AgentEvent[] {
  return [
    { type: "message-start", messageId: "m1", role: "assistant" },
    { type: "text-delta", messageId: "m1", text: `echo:${text}` },
    {
      type: "tool-call-start",
      toolUseId: "t1",
      name: "bash",
      input: { command: "echo hi" },
    },
    {
      type: "tool-call-result",
      toolUseId: "t1",
      result: { content: "hi", isError: false },
    },
    { type: "usage", inputTokens: 10, outputTokens: 5 },
    { type: "message-end", messageId: "m1" },
    { type: "turn-end", reason: "end_turn" },
    { type: "session-end" },
  ];
}

/** 取出某条 session/update 通知的 update 负载 */
function updatesOf(
  frames: Array<Record<string, unknown>>,
  sessionId: string,
): AcpSessionUpdate[] {
  return frames
    .filter((frame) => frame.method === "session/update")
    .map((frame) => (frame.params as { sessionId: string; update: AcpSessionUpdate }))
    .filter((params) => params.sessionId === sessionId)
    .map((params) => params.update);
}

describe("ACP stdio — 握手", () => {
  it("initialize 返回协议版本 1 与 baseline-only 能力（对标 dsh-acp）", async () => {
    const { factory } = makeFakeAgent([]);
    const conn = connect(factory);

    const res = await conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    }).promise;

    expect(res["jsonrpc"]).toBe("2.0");
    expect(res["error"]).toBeUndefined();
    expect(res["result"]).toMatchObject({
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        // 续聊能力：守护进程按它判断「带老 sessionId 回来」是否安全
        sessionCapabilities: { resume: {} },
      },
      authMethods: [],
    });
    expect(
      (res["result"] as { agentInfo: { name: string } }).agentInfo.name.length,
    ).toBeGreaterThan(0);

    conn.connection.dispose();
  });

  it("authenticate 是空实现（未声明任何 auth method）", async () => {
    const { factory } = makeFakeAgent([]);
    const conn = connect(factory);

    const res = await conn.request("authenticate", { methodId: "none" }).promise;
    expect(res["error"]).toBeUndefined();
    expect(res["result"]).toEqual({});

    conn.connection.dispose();
  });

  it("未知方法返回 -32601，措辞与 SDK 一致", async () => {
    const { factory } = makeFakeAgent([]);
    const conn = connect(factory);

    const res = await conn.request("session/archive", { sessionId: "x" }).promise;
    expect(res["result"]).toBeUndefined();
    expect(res["error"]).toMatchObject({
      code: -32601,
      message: '"Method not found": session/archive',
      data: { method: "session/archive" },
    });

    conn.connection.dispose();
  });
});

describe("ACP stdio — 会话与对话", () => {
  it("session/new 用宿主给的 cwd 建会话并返回 sessionId", async () => {
    const { factory, created } = makeFakeAgent([]);
    const conn = connect(factory);

    const res = await conn.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    }).promise;

    const sessionId = (res["result"] as { sessionId: string }).sessionId;
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);
    expect(created).toHaveLength(1);
    expect(created[0]!.workdir).toBe(process.cwd());

    conn.connection.dispose();
  });

  it("session/new 携带非空 mcpServers 时接受但忽略（不阻断握手）", async () => {
    const { factory } = makeFakeAgent([]);
    const conn = connect(factory);

    const res = await conn.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [{ name: "multica", command: "node", args: [] }],
    }).promise;

    expect(res["error"]).toBeUndefined();
    expect((res["result"] as { sessionId: string }).sessionId).toBeTruthy();

    conn.connection.dispose();
  });

  it("完整一轮：text/tool/usage 通知 + stopReason=end_turn", async () => {
    const { factory } = makeFakeAgent(normalTurn);
    const conn = connect(factory);

    const newRes = await conn.request("session/new", { cwd: process.cwd() }).promise;
    const sessionId = (newRes["result"] as { sessionId: string }).sessionId;

    const promptRes = await conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "你好" }],
    }).promise;

    expect(promptRes["error"]).toBeUndefined();
    expect(promptRes["result"]).toEqual({ stopReason: "end_turn" });

    const updates = updatesOf(conn.output.frames(), sessionId);
    const kinds = updates.map((u) => u.sessionUpdate);
    expect(kinds).toContain("agent_message_chunk");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_call_update");
    expect(kinds).toContain("usage_update");

    // 助手文本按 ACP 形状推送（守护进程按 chunk 追加）
    const messageChunk = updates.find((u) => u.sessionUpdate === "agent_message_chunk");
    expect(messageChunk).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "echo:你好" },
    });

    // 工具调用上线形状
    const toolCall = updates.find((u) => u.sessionUpdate === "tool_call");
    expect(toolCall).toMatchObject({
      toolCallId: "t1",
      title: "bash",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "echo hi" },
    });

    const toolUpdate = updates.find((u) => u.sessionUpdate === "tool_call_update");
    expect(toolUpdate).toMatchObject({ toolCallId: "t1", status: "completed" });

    // usage_update 必须带 ACP 规定的 used/size
    const usage = updates.find((u) => u.sessionUpdate === "usage_update");
    expect(usage).toMatchObject({ used: 15, size: 100000 });

    conn.connection.dispose();
  });

  it("prompt 响应一定晚于它触发的 session/update 通知", async () => {
    const { factory } = makeFakeAgent(normalTurn);
    const conn = connect(factory);

    const newRes = await conn.request("session/new", { cwd: process.cwd() }).promise;
    const sessionId = (newRes["result"] as { sessionId: string }).sessionId;
    await conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "顺序" }],
    }).promise;

    const frames = conn.output.frames();
    const lastUpdateIdx = frames.map((f) => f.method).lastIndexOf("session/update");
    const promptResponseIdx = frames.findIndex(
      (f) => f.method === undefined && (f["result"] as { stopReason?: string })?.stopReason,
    );
    expect(lastUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(promptResponseIdx).toBeGreaterThan(lastUpdateIdx);

    conn.connection.dispose();
  });

  it("未声明的能力之外的内容块被拒绝（-32602）", async () => {
    const { factory } = makeFakeAgent(normalTurn);
    const conn = connect(factory);

    const newRes = await conn.request("session/new", { cwd: process.cwd() }).promise;
    const sessionId = (newRes["result"] as { sessionId: string }).sessionId;

    const res = await conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "image", data: "…", mimeType: "image/png" }],
    }).promise;

    expect(res["error"]).toMatchObject({ code: -32602 });
    expect((res["error"] as { message: string }).message).toContain(
      "only text and resource_link prompt content is supported",
    );

    conn.connection.dispose();
  });

  it("空 prompt 与未知会话都被拒绝（-32602）", async () => {
    const { factory } = makeFakeAgent(normalTurn);
    const conn = connect(factory);

    const newRes = await conn.request("session/new", { cwd: process.cwd() }).promise;
    const sessionId = (newRes["result"] as { sessionId: string }).sessionId;

    const empty = await conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "   " }],
    }).promise;
    expect(empty["error"]).toMatchObject({
      code: -32602,
      message: "Invalid params: empty prompt",
    });

    const unknown = await conn.request("session/prompt", {
      sessionId: "nope",
      prompt: [{ type: "text", text: "hi" }],
    }).promise;
    expect(unknown["error"]).toMatchObject({
      code: -32602,
      message: "Invalid params: unknown session: nope",
    });

    conn.connection.dispose();
  });
});

describe("ACP stdio — 会话续聊（session/resume）", () => {
  it("session/resume 命中落盘会话：返回宿主 sessionId，后续 prompt 正常跑完", async () => {
    // 第二轮对话的真实形状：新进程 initialize → session/resume{sessionId} → session/prompt
    const known = factorySessionStub("ses_from_previous_process");
    const { factory, resumeAgent, resumed } = makeFakeAgent(normalTurn, {
      knownSessions: { ses_from_previous_process: known },
    });
    const conn = connect(factory, resumeAgent);

    await conn.request("initialize", { protocolVersion: 1 }).promise;
    const res = await conn.request("session/resume", {
      sessionId: "ses_from_previous_process",
      cwd: process.cwd(),
      mcpServers: [],
    }).promise;

    expect(res["error"]).toBeUndefined();
    // 返回形状对标 ACP ResumeSessionResponse：本桥 baseline-only，只回 sessionId
    expect(res["result"]).toEqual({ sessionId: "ses_from_previous_process" });
    expect(resumed).toEqual([
      { workdir: process.cwd(), sessionId: "ses_from_previous_process", hit: true },
    ]);

    const promptRes = await conn.request("session/prompt", {
      sessionId: "ses_from_previous_process",
      prompt: [{ type: "text", text: "继续" }],
    }).promise;
    expect(promptRes["error"]).toBeUndefined();
    expect(promptRes["result"]).toEqual({ stopReason: "end_turn" });

    const updates = updatesOf(conn.output.frames(), "ses_from_previous_process");
    expect(updates.map((u) => u.sessionUpdate)).toContain("agent_message_chunk");

    conn.connection.dispose();
  });

  it("session/resume 未命中：仍以宿主 sessionId 建会话，prompt 不落 unknown session", async () => {
    const { factory, resumeAgent, resumed } = makeFakeAgent(normalTurn);
    const conn = connect(factory, resumeAgent);

    const res = await conn.request("session/resume", {
      sessionId: "ses_missing",
      cwd: process.cwd(),
    }).promise;
    expect(res["error"]).toBeUndefined();
    expect(res["result"]).toEqual({ sessionId: "ses_missing" });
    expect(resumed[0]?.hit).toBe(false);

    // 关键回归：prompt 必须命中 resume 注册的那个 id，而不是新会话的自生成 id
    const promptRes = await conn.request("session/prompt", {
      sessionId: "ses_missing",
      prompt: [{ type: "text", text: "hi" }],
    }).promise;
    expect(promptRes["error"]).toBeUndefined();
    expect(promptRes["result"]).toEqual({ stopReason: "end_turn" });

    conn.connection.dispose();
  });

  it("未注入 resumeAgent 时 session/resume 用宿主 id 保底，不再回 -32601", async () => {
    // 这是守护进程实际撞到的报错：hermes session/resume failed ... (code=-32601)
    const { factory } = makeFakeAgent(normalTurn);
    const conn = connect(factory);

    const res = await conn.request("session/resume", {
      sessionId: "ses_legacy",
      cwd: process.cwd(),
    }).promise;

    expect(res["error"]).toBeUndefined();
    expect(res["result"]).toEqual({ sessionId: "ses_legacy" });
    expect(conn.connection.sessionCount()).toBe(1);

    conn.connection.dispose();
  });

  it("session/resume 缺 sessionId 时按 -32602 拒绝", async () => {
    const { factory, resumeAgent } = makeFakeAgent(normalTurn);
    const conn = connect(factory, resumeAgent);

    const res = await conn.request("session/resume", { cwd: process.cwd() }).promise;
    expect(res["error"]).toMatchObject({
      code: -32602,
      message: "Invalid params: sessionId must be a non-empty string",
    });

    conn.connection.dispose();
  });

  it("session/load 与 resume 同语义（返回空响应，不再 -32601）", async () => {
    const { factory, resumeAgent } = makeFakeAgent(normalTurn, {
      knownSessions: { ses_loaded: factorySessionStub("ses_loaded") },
    });
    const conn = connect(factory, resumeAgent);

    const res = await conn.request("session/load", {
      sessionId: "ses_loaded",
      cwd: process.cwd(),
      mcpServers: [],
    }).promise;

    expect(res["error"]).toBeUndefined();
    expect(res["result"]).toEqual({});

    const promptRes = await conn.request("session/prompt", {
      sessionId: "ses_loaded",
      prompt: [{ type: "text", text: "hi" }],
    }).promise;
    expect(promptRes["result"]).toEqual({ stopReason: "end_turn" });

    conn.connection.dispose();
  });
});

describe("ACP stdio — 取消与错误", () => {
  it("session/cancel 把在飞 prompt 结算为 cancelled", async () => {
    // 长时间在飞的脚本：靠 cancel 收口
    const { factory } = makeFakeAgent(longTurn, { delayMs: 25 });
    const conn = connect(factory);

    const newRes = await conn.request("session/new", { cwd: process.cwd() }).promise;
    const sessionId = (newRes["result"] as { sessionId: string }).sessionId;

    const pending = conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "长任务" }],
    });
    // 等第一条文本通知到达，确认 prompt 已经在飞
    await conn.output.waitFor((frame) => frame.method === "session/update");

    conn.notify("session/cancel", { sessionId });
    const res = await pending.promise;

    expect(res["error"]).toBeUndefined();
    expect(res["result"]).toEqual({ stopReason: "cancelled" });

    conn.connection.dispose();
  });

  it("取消未知会话是 no-op（不报错、不影响连接）", async () => {
    const { factory } = makeFakeAgent(normalTurn);
    const conn = connect(factory);

    conn.notify("session/cancel", { sessionId: "unknown" });
    const res = await conn.request("initialize", { protocolVersion: 1 }).promise;
    expect(res["error"]).toBeUndefined();

    conn.connection.dispose();
  });

  it("Agent 报 error 事件时 prompt 以 -32603 拒绝（对标 dsh-acp）", async () => {
    const { factory } = makeFakeAgent(() => [
      { type: "text-delta", messageId: "m1", text: "部分输出" },
      { type: "error", error: { message: "Insufficient Balance" } },
      { type: "turn-end", reason: "error" },
    ]);
    const conn = connect(factory);

    const newRes = await conn.request("session/new", { cwd: process.cwd() }).promise;
    const sessionId = (newRes["result"] as { sessionId: string }).sessionId;

    const res = await conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    }).promise;

    expect(res["result"]).toBeUndefined();
    expect(res["error"]).toMatchObject({
      code: -32603,
      message: "Internal error: turn failed: Insufficient Balance",
    });

    conn.connection.dispose();
  });

  it("会话建立失败（凭据缺失）以 -32603 透出可执行原因，而不是让进程退出", async () => {
    const conn = connect(() => {
      throw new Error("无法解析 Provider 凭据：OPENAI_COMPATIBLE_API_KEY is required");
    });

    const res = await conn.request("session/new", { cwd: process.cwd() }).promise;
    expect(res["error"]).toMatchObject({ code: -32603 });
    expect((res["error"] as { message: string }).message).toContain(
      "OPENAI_COMPATIBLE_API_KEY is required",
    );

    conn.connection.dispose();
  });

  it("同一会话并发两个 prompt 时第二个被拒绝（-32602）", async () => {
    const { factory } = makeFakeAgent(longTurn, { delayMs: 25 });
    const conn = connect(factory);

    const newRes = await conn.request("session/new", { cwd: process.cwd() }).promise;
    const sessionId = (newRes["result"] as { sessionId: string }).sessionId;

    const first = conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "1" }],
    });
    await conn.output.waitFor((frame) => frame.method === "session/update");
    const second = await conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "2" }],
    }).promise;

    expect(second["error"]).toMatchObject({
      code: -32602,
      message: "Invalid params: a prompt is already in flight for this session",
    });

    conn.notify("session/cancel", { sessionId });
    await first.promise;
    conn.connection.dispose();
  });
});

// ──────────────────────────────────────────────
// 失败详情单行化（AGE-29：宿主侧只看到 `hermes provider error: [`）
// ──────────────────────────────────────────────

describe("ACP stdio — 失败详情单行化", () => {
  it("多行失败详情被压成单行，宿主不会只取到 `[` 碎片", async () => {
    const multiLine = `Error: [\n  {\n    "code": "invalid_type",\n    "path": ["filePath"]\n  }\n]`;
    const { factory } = makeFakeAgent(() => [
      { type: "error", error: { message: multiLine } },
      { type: "turn-end", reason: "error" },
    ]);
    const conn = connect(factory);

    const newRes = await conn.request("session/new", { cwd: process.cwd() }).promise;
    const sessionId = (newRes["result"] as { sessionId: string }).sessionId;
    const res = await conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "触发失败" }],
    }).promise;

    const message = (res["error"] as { message: string }).message;
    expect(message.startsWith("Internal error: turn failed: ")).toBe(true);
    // 详情保留（不是只剩首行 `[`），且不含裸换行
    expect(message).toContain("invalid_type");
    expect(message).toContain("filePath");
    expect(message.includes("\n")).toBe(false);
    expect(message.includes("\r")).toBe(false);

    // 原始输出按行切开后，每一行都仍是合法 JSON-RPC 帧
    const raw = conn.output.lines.join("");
    for (const line of raw.split("\n").filter((l) => l.length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    conn.connection.dispose();
  });

  it("console 改道到 stderr 时逐行加前缀（碎片可归属、不再是孤立 `[`）", () => {
    const written: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    const restore = redirectConsoleToStderr();
    try {
      console.log(`Error: [\n  { "code": 1 }\n]`);
    } finally {
      restore();
      process.stderr.write = originalWrite;
    }

    const raw = written.join("");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    for (const line of lines) {
      expect(line.startsWith("[fengagent-acp] ")).toBe(true);
    }
    // 首行不再是一个孤立的 `[`
    expect(lines[0]).toContain("Error: [");
    expect(lines[0]).not.toBe("[");
  });

  it("error 级日志同样带 `[fengagent-acp] ` 前缀（宿主误分类防线）", () => {
    const written: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    // 复刻真机形态：shared logger 的 error 级走 console.error，内容是多行 JSON 碎片
    const restore = redirectConsoleToStderr();
    try {
      console.error(`[ERROR] [agent-loop] [run] tool result: error, content=Error: [\n  {\n    "code": "boom"\n  }\n]`);
    } finally {
      restore();
      process.stderr.write = originalWrite;
    }

    const lines = written.join("").split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line.startsWith("[fengagent-acp] ")).toBe(true);
    }
    // 还原后 console.error 回到原实现（不污染其它测试）
    expect(console.error).not.toBe(console.log);
  });
});

describe("ACP stdio — 协议通道纯净性", () => {
  it("输出通道上只有合法 JSON-RPC 帧（无日志污染）", async () => {
    const { factory } = makeFakeAgent(normalTurn);
    const conn = connect(factory);

    await conn.request("initialize", { protocolVersion: 1 }).promise;
    const newRes = await conn.request("session/new", { cwd: process.cwd() }).promise;
    const sessionId = (newRes["result"] as { sessionId: string }).sessionId;
    await conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "纯净" }],
    }).promise;

    const raw = conn.output.lines.join("");
    expect(raw.endsWith("\n")).toBe(true);
    for (const line of raw.split("\n").filter((l) => l.length > 0)) {
      const frame = JSON.parse(line) as Record<string, unknown>;
      expect(frame["jsonrpc"]).toBe("2.0");
    }

    conn.connection.dispose();
  });

  it("无法解析的行被忽略，连接继续可用", async () => {
    const { factory } = makeFakeAgent([]);
    const conn = connect(factory);

    conn.input.emit("data", "这不是 JSON\n");
    const res = await conn.request("initialize", { protocolVersion: 1 }).promise;
    expect(res["error"]).toBeUndefined();

    conn.connection.dispose();
  });

  it("stdin 关闭后 closed 兑现，且不再写协议帧", async () => {
    const { factory } = makeFakeAgent([]);
    const conn = connect(factory);

    await conn.request("initialize", { protocolVersion: 1 }).promise;
    const before = conn.output.lines.length;

    conn.input.emit("end");
    await conn.connection.closed;

    expect(conn.connection.sessionCount()).toBe(0);
    expect(conn.output.lines.length).toBe(before);
  });
});

describe("ACP stdio — 纯函数", () => {
  it("acpPromptToText 拼接 text 并把 resource_link 渲染为文本引用", () => {
    const text = acpPromptToText([
      { type: "text", text: "看这个 " },
      { type: "resource_link", name: "a.ts", uri: "file:///a.ts" },
    ]);
    expect(text).toContain("看这个 ");
    expect(text).toContain("[resource_link name=\"a.ts\" uri=\"file:///a.ts\"]");
  });

  it("promptHasUnsupportedContent 只放行 text / resource_link", () => {
    expect(promptHasUnsupportedContent([{ type: "text", text: "x" }])).toBe(false);
    expect(promptHasUnsupportedContent([{ type: "audio", data: "x" }])).toBe(true);
  });

  it("turnEndToStopReason 把 token 截断折叠为 end_turn（对标 dsh-acp）", () => {
    expect(turnEndToStopReason("max_tokens")).toBe("end_turn");
    expect(turnEndToStopReason("end_turn")).toBe("end_turn");
    expect(turnEndToStopReason(undefined)).toBe("end_turn");
  });
});
