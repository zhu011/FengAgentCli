/**
 * @fengagent/server — ACP 权限桥（`session/request_permission`）测试（AGE-29）
 *
 * 回归目标（现场：Multica 守护进程日志
 * `unrecoverable tool result guard: ... Tool "bash" requires user approval but no
 * permission callback is available`）：
 *
 * 1. `session/prompt` 里 ask 类工具必须能向宿主发 `session/request_permission`，
 *    并把宿主的 `optionId` 翻译成权限决策（对标 @deepseek-ai/dsh-acp 的同名路径）；
 * 2. 宿主不可用时不能把整轮对话判死：超时/无响应按「宿主未表态」放行，
 *    由 executor 侧的预授权策略兜底执行（不能让 bash 在 Multica 里永远不可用）。
 */

import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  startAcpStdioServer,
  mapPermissionResponse,
  type AcpFrameWriter,
} from "../acp-stdio.ts";
import { createToolExecutor, createToolRegistry, createPermissionChecker } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { Agent } from "@fengagent/agent";
import type { LLMClient, LLMRequest, LLMEvent } from "@fengagent/llm";
import type { AgentEvent, Config, PermissionResult, Session } from "@fengagent/core";
import { z } from "zod";

/** 内存输出端：按行收集协议帧（遵循 AcpFrameWriter 契约，写完即回调） */
class FrameCollector {
  lines: string[] = [];

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.lines.push(chunk);
    callback?.();
    return true;
  }

  frames(): Array<Record<string, unknown>> {
    return this.lines
      .join("")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  async waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs = 3000,
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

/** 被询问过的权限请求（断言「宿主确实收到了审批请求」） */
interface SeenPermission {
  sessionId: string;
  toolName: string;
  reason?: string;
  optionIds: string[];
  requestId: unknown;
}

/**
 * 建一个「先征求宿主审批、再产出事件」的假 Agent。
 *
 * `prompt()` 的 options.requestPermission 就是本桥注入的回调；这里把它记下来并
 * 按脚本产出 `tool-call-result`，让断言能同时看到「审批往返」与「轮次结算」。
 */
function makePermissionAwareAgent(options: {
  seen: SeenPermission[];
  /** 工具执行前的审批（decision 决定假 Agent 如何继续） */
  toolName?: string;
  /** 审批被拒绝时产出错误结果并提前结束轮次 */
  events?: AgentEvent[];
}) {
  const toolName = options.toolName ?? "bash";

  const factory = (): Agent => {
    const session = {
      id: `ses_${Math.random().toString(36).slice(2, 8)}`,
      title: "perm-fake",
      messages: [],
      model: "fake",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "idle",
      tokenCount: 0,
    } as unknown as Session;

    const agent = {
      createSession: () => session,
      async *prompt(
        _text: string,
        _session: Session,
        promptOptions?: {
          requestPermission?: (permission: {
            toolName: string;
            input: unknown;
            reason?: string;
          }) => Promise<PermissionResult>;
        },
      ): AsyncGenerator<AgentEvent> {
        let decision: PermissionResult = { decision: "allow" };
        if (promptOptions?.requestPermission) {
          decision = await promptOptions.requestPermission({
            toolName,
            input: { command: "pwd" },
            reason: "bash command will execute on the system. Confirm to proceed.",
          });
        }
        for (const event of options.events ?? []) yield event;
        yield {
          type: "tool-call-result",
          toolUseId: "t1",
          result:
            decision.decision === "allow"
              ? { content: "C:\\work", isError: false }
              : { content: "Permission denied by user", isError: true },
        };
        yield { type: "turn-end", reason: "end_turn" };
      },
    } as unknown as Agent;

    return agent;
  };

  return factory;
}

/** 建一个受控连接（可注入权限桥开关 / 超时） */
function connect(
  factory: (workdir: string) => Agent,
  bridgeOptions: { permissionBridge?: boolean; permissionTimeoutMs?: number } = {},
) {
  const input = new EventEmitter();
  const output = new FrameCollector();
  const connection = startAcpStdioServer({
    createAgent: factory,
    config: { contextWindow: 100_000 },
    input,
    output: output as unknown as AcpFrameWriter,
    exitOnClose: false,
    ...bridgeOptions,
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
    send,
    request(method: string, params?: unknown): { id: number; promise: Promise<Record<string, unknown>> } {
      const id = ++nextId;
      send({ jsonrpc: "2.0", id, method, params });
      return { id, promise: output.waitFor((frame) => frame.id === id) };
    },
  };
}

/** 建会话并返回 sessionId */
async function newSession(conn: ReturnType<typeof connect>): Promise<string> {
  const res = await conn.request("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  }).promise;
  return (res["result"] as { sessionId: string }).sessionId;
}

describe("ACP 权限桥 — mapPermissionResponse 语义", () => {
  it("outcome=cancelled → 拒绝（宿主明确取消）", () => {
    expect(mapPermissionResponse({ outcome: { outcome: "cancelled" } })).toMatchObject({
      decision: "deny",
    });
  });

  it("optionId 命中拒绝集合 → 拒绝", () => {
    for (const optionId of ["reject-once", "reject_once", "reject-always"]) {
      expect(
        mapPermissionResponse({ outcome: { outcome: "selected", optionId } }),
      ).toMatchObject({ decision: "deny" });
    }
  });

  it("optionId 命中放行集合（allow-once / approve_once）→ 放行", () => {
    for (const optionId of ["allow-once", "approve_once"]) {
      expect(
        mapPermissionResponse({ outcome: { outcome: "selected", optionId } }),
      ).toMatchObject({ decision: "allow" });
    }
  });

  it("宿主回了没见过的 optionId / 空响应 → 放行并留痕（不把工具调用判死）", () => {
    expect(
      mapPermissionResponse({ outcome: { outcome: "selected", optionId: "whatever" } }),
    ).toMatchObject({ decision: "allow" });
    expect(mapPermissionResponse(undefined)).toMatchObject({ decision: "allow" });
    expect(mapPermissionResponse({})).toMatchObject({ decision: "allow" });
  });
});

describe("ACP 权限桥 — 与宿主的请求往返", () => {
  it("ask 类工具 → 本桥发 session/request_permission，宿主选放行后工具结果放行", async () => {
    const seen: SeenPermission[] = [];
    const conn = connect(
      makePermissionAwareAgent({
        seen,
        events: [
          { type: "text-delta", messageId: "m1", text: "running bash" },
          { type: "tool-call-start", toolUseId: "t1", name: "bash", input: { command: "pwd" } },
        ],
      }),
    );

    const sessionId = await newSession(conn);
    const prompt = conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "跑一下 pwd" }],
    });

    // 本桥必须主动向宿主发审批请求（agent → client 方向）
    const permissionFrame = await conn.output.waitFor(
      (frame) => frame.method === "session/request_permission",
    );
    const params = permissionFrame["params"] as {
      sessionId: string;
      toolCall: { toolCallId: string; title: string };
      options: Array<{ optionId: string; kind: string }>;
    };
    expect(permissionFrame["jsonrpc"]).toBe("2.0");
    expect(typeof permissionFrame["id"]).toBe("number");
    expect(params.sessionId).toBe(sessionId);
    expect(params.toolCall.title).toBe("bash");
    expect(params.options.map((option) => option.optionId)).toEqual([
      "allow-once",
      "approve_once",
      "reject-once",
    ]);
    expect(params.options.filter((option) => option.kind === "allow_once")).toHaveLength(2);

    // 宿主回「放行」（守护进程自动批准时回的正是 approve_once）
    conn.send({
      jsonrpc: "2.0",
      id: permissionFrame["id"],
      result: { outcome: { outcome: "selected", optionId: "approve_once" } },
    });

    const res = await prompt.promise;
    expect(res["error"]).toBeUndefined();
    expect((res["result"] as { stopReason: string }).stopReason).toBe("end_turn");

    const toolResult = conn.output
      .frames()
      .filter((frame) => frame.method === "session/update")
      .map((frame) => (frame.params as { update: Record<string, unknown> }).update)
      .find((update) => update["sessionUpdate"] === "tool_call_update");
    expect(toolResult?.["status"]).toBe("completed");
  });

  it("宿主选拒绝 → 工具结果为失败（审批链路真的生效，不是无条件放行）", async () => {
    const seen: SeenPermission[] = [];
    const conn = connect(
      makePermissionAwareAgent({
        seen,
        events: [
          { type: "tool-call-start", toolUseId: "t1", name: "bash", input: { command: "rm -rf /" } },
        ],
      }),
    );

    const sessionId = await newSession(conn);
    const prompt = conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "删库" }],
    });

    const permissionFrame = await conn.output.waitFor(
      (frame) => frame.method === "session/request_permission",
    );
    conn.send({
      jsonrpc: "2.0",
      id: permissionFrame["id"],
      result: { outcome: { outcome: "selected", optionId: "reject-once" } },
    });

    const res = await prompt.promise;
    expect(res["error"]).toBeUndefined();

    const toolResult = conn.output
      .frames()
      .filter((frame) => frame.method === "session/update")
      .map((frame) => (frame.params as { update: Record<string, unknown> }).update)
      .find((update) => update["sessionUpdate"] === "tool_call_update");
    expect(toolResult?.["status"]).toBe("failed");
  });

  it("宿主不支持该方法（-32601）→ 放行兜底，轮次照常结算（bash 不再不可用）", async () => {
    const seen: SeenPermission[] = [];
    const conn = connect(
      makePermissionAwareAgent({
        seen,
        events: [
          { type: "tool-call-start", toolUseId: "t1", name: "bash", input: { command: "pwd" } },
        ],
      }),
    );

    const sessionId = await newSession(conn);
    const prompt = conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "跑一下 pwd" }],
    });

    const permissionFrame = await conn.output.waitFor(
      (frame) => frame.method === "session/request_permission",
    );
    conn.send({
      jsonrpc: "2.0",
      id: permissionFrame["id"],
      error: { code: -32601, message: '"Method not found": session/request_permission' },
    });

    const res = await prompt.promise;
    expect(res["error"]).toBeUndefined();
    const toolResult = conn.output
      .frames()
      .filter((frame) => frame.method === "session/update")
      .map((frame) => (frame.params as { update: Record<string, unknown> }).update)
      .find((update) => update["sessionUpdate"] === "tool_call_update");
    expect(toolResult?.["status"]).toBe("completed");
  });

  it("宿主不回（超时）→ 不吊死：按未表态放行并结算轮次", async () => {
    const seen: SeenPermission[] = [];
    const conn = connect(
      makePermissionAwareAgent({
        seen,
        events: [
          { type: "tool-call-start", toolUseId: "t1", name: "bash", input: { command: "pwd" } },
        ],
      }),
      { permissionTimeoutMs: 40 },
    );

    const sessionId = await newSession(conn);
    const prompt = conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "跑一下 pwd" }],
    });

    await conn.output.waitFor((frame) => frame.method === "session/request_permission");

    const res = await prompt.promise;
    expect(res["error"]).toBeUndefined();
    expect((res["result"] as { stopReason: string }).stopReason).toBe("end_turn");
  });

  it("permissionBridge: false → 不发审批请求，agent 回落为无回调（由预授权策略兜底）", async () => {
    const seen: SeenPermission[] = [];
    const conn = connect(
      makePermissionAwareAgent({
        seen,
        events: [
          { type: "tool-call-start", toolUseId: "t1", name: "bash", input: { command: "pwd" } },
        ],
      }),
      { permissionBridge: false },
    );

    const sessionId = await newSession(conn);
    const res = await conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "跑一下 pwd" }],
    }).promise;

    expect(res["error"]).toBeUndefined();
    expect(
      conn.output.frames().some((frame) => frame.method === "session/request_permission"),
    ).toBe(false);
  });

  it("连接关闭时结算在飞审批请求（不留悬挂 Promise）", async () => {
    const seen: SeenPermission[] = [];
    const conn = connect(
      makePermissionAwareAgent({
        seen,
        events: [
          { type: "tool-call-start", toolUseId: "t1", name: "bash", input: { command: "pwd" } },
        ],
      }),
      { permissionTimeoutMs: 60_000 },
    );

    const sessionId = await newSession(conn);
    const prompt = conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "跑一下 pwd" }],
    });

    await conn.output.waitFor((frame) => frame.method === "session/request_permission");
    // 模拟 stdin EOF（守护进程回收运行时）
    conn.input.emit("end");

    const res = await prompt.promise;
    // 宿主未表态 → 放行兜底，兜底路径本身不抛错
    expect(res["error"]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// 真实 Agent + 真实工具执行器 + 真实权限层的端到端
// ─────────────────────────────────────────────────────────────

/** 脚本化 LLM：第 1 轮要求调用工具，第 2 轮给出终答 */
class ScriptedLLM implements LLMClient {
  private index = 0;

  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    const turn = this.index++;
    if (turn === 0) {
      yield { type: "tool-call", id: "t1", name: "echo", input: { text: "hello-acp" } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }
    yield { type: "text-delta", text: "done" };
    yield { type: "finish", reason: "end_turn" };
  }

  async generate(): Promise<never> {
    throw new Error("not used");
  }
}

function testConfig(): Config {
  return {
    model: "test-model",
    smallModel: "test-small-model",
    provider: "anthropic",
    maxTokens: 4096,
    temperature: 1,
    contextWindow: 100_000,
    compactThreshold: 0.85,
    compactKeepTokens: 8000,
    compactBuffer: 20_000,
    disableCompact: true,
    toolOutputMaxChars: 4000,
    serverPort: 3000,
    serverHost: "127.0.0.1",
    corsOrigin: "*",
    autoApproveTools: false,
    allowedTools: "*",
    bashTimeout: 120_000,
    maxToolConcurrency: 10,
    maxTurns: 5,
    logLevel: "error",
    dataDir: "~/.fengagent",
  } as Config;
}

/** 装一个和 bash 同样「自带 ask + 破坏性」的工具，绕开真实 shell 的沙箱限制 */
function createRealAgentFactory(): (workdir: string) => Agent {
  const config = testConfig();
  const ran: string[] = [];

  return (workdir: string): Agent => {
    const toolRegistry = createToolRegistry();
    toolRegistry.register({
      name: "echo",
      description: "echo tool that requires approval",
      inputSchema: z.object({ text: z.string() }),
      execute: async (input: { text: string }) => {
        ran.push(input.text);
        return { content: `ran:${input.text}` };
      },
      isReadOnly: () => false,
      isDestructive: () => true,
      isConcurrencySafe: () => false,
      checkPermissions: () => ({ decision: "ask" as const, message: "confirm?" }),
    });

    // 与 acp-mode.ts 同款装配：预授权策略 + 真实权限检查器 + 真实执行器
    const permissionChecker = createPermissionChecker(workdir, undefined, {
      unattendedPermissionPolicy: "allow",
    });
    const toolExecutor = createToolExecutor(permissionChecker, undefined, {
      unattendedPermissionPolicy: "allow",
    });
    const contextManager = createContextManager({
      config: {
        contextWindow: config.contextWindow,
        compactThreshold: config.compactThreshold,
        compactKeepTokens: config.compactKeepTokens,
        disableCompact: config.disableCompact,
        smallModel: config.smallModel,
      },
      summaryGenerator: new ScriptedLLM(),
      systemContextOptions: { workdir, loadAgentsMd: false },
    });

    const agent = new Agent({
      llmClient: new ScriptedLLM(),
      toolRegistry,
      toolExecutor,
      contextManager,
      config,
      workdir,
    });
    (agent as unknown as { __ran: string[] }).__ran = ran;
    return agent;
  };
}

describe("ACP 权限桥 — 端到端（真实 Agent + ask 类工具 + 预授权宿主）", () => {
  it("宿主放行后工具真的被执行（不再是 requires approval 错误）", async () => {
    const factory = createRealAgentFactory();
    const conn = connect(factory);

    const sessionId = await newSession(conn);
    const prompt = conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "调用 echo 工具" }],
    });

    const permissionFrame = await conn.output.waitFor(
      (frame) => frame.method === "session/request_permission",
    );
    const params = permissionFrame["params"] as { toolCall: { title: string } };
    expect(params.toolCall.title).toBe("echo");

    conn.send({
      jsonrpc: "2.0",
      id: permissionFrame["id"],
      result: { outcome: { outcome: "selected", optionId: "approve_once" } },
    });

    const res = await prompt.promise;
    expect(res["error"]).toBeUndefined();
    expect((res["result"] as { stopReason: string }).stopReason).toBe("end_turn");

    const toolUpdate = conn.output
      .frames()
      .filter((frame) => frame.method === "session/update")
      .map((frame) => (frame.params as { update: Record<string, unknown> }).update)
      .find((update) => update["sessionUpdate"] === "tool_call_update");
    expect(toolUpdate?.["status"]).toBe("completed");
    expect(String(toolUpdate?.["rawOutput"])).toContain("ran:hello-acp");
  });

  it("宿主完全不回时也跑得通（预授权兜底），对话不再因审批中断", async () => {
    const factory = createRealAgentFactory();
    const conn = connect(factory, { permissionTimeoutMs: 30 });

    const sessionId = await newSession(conn);
    const res = await conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "调用 echo 工具" }],
    }).promise;

    expect(res["error"]).toBeUndefined();
    const toolUpdate = conn.output
      .frames()
      .filter((frame) => frame.method === "session/update")
      .map((frame) => (frame.params as { update: Record<string, unknown> }).update)
      .find((update) => update["sessionUpdate"] === "tool_call_update");
    expect(toolUpdate?.["status"]).toBe("completed");
  });
});
