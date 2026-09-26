/**
 * @fengagent/agent — 图上改参重放（loop 侧）测试（AGE-29 图三件套 ①）
 *
 * 覆盖：
 * 1. 运行选项携带入参改写规则 → 工具真的以新入参执行，`tool-call-result`
 *    事件同时带「实际执行入参」与「模型原始入参」（改参前后可溯源）+
 *    `userCorrectedInput` 标记 + 来源 `graph`；
 * 2. 未带改写规则 → 事件不带改参字段（普通轮次零变化）；
 * 3. 会话历史里的 tool-use 块被同步为实际执行入参（与 HITL 改参同构）。
 */

import { describe, test, expect } from "bun:test";
import type { LLMClient, LLMRequest, LLMResponse, LLMEvent } from "@fengagent/llm";
import type { AgentEvent, Config } from "@fengagent/core";
import { createSession, createUserMessage } from "@fengagent/core";
import { createToolRegistry, createToolExecutor } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { z } from "zod";
import { AgentLoop } from "../loop.ts";
import type { AgentLoopOptions } from "../loop.ts";

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
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "end_turn",
    };
  }
}

function createConfig(): Config {
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

function setup() {
  const config = createConfig();
  const mockLLM = new MockLLMClient();
  const executed: Array<{ command: string }> = [];

  const toolRegistry = createToolRegistry();
  toolRegistry.register({
    name: "bash",
    description: "run command",
    inputSchema: z.object({ command: z.string() }),
    async execute(input: { command: string }) {
      executed.push(input);
      return { content: `ran: ${input.command}` };
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  });

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

  const options: AgentLoopOptions = {
    llmClient: mockLLM,
    toolRegistry,
    toolExecutor: createToolExecutor(),
    contextManager,
    config,
    workdir: ".",
  };

  return { mockLLM, options, executed };
}

/** 两轮响应：先调 bash，再收尾 */
function scriptToolCall(command: string): LLMEvent[][] {
  return [
    [
      { type: "tool-call", id: "call-1", name: "bash", input: { command } },
      { type: "finish", reason: "tool_use" },
    ],
    [
      { type: "text-delta", text: "完成" },
      { type: "finish", reason: "end_turn" },
    ],
  ];
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("AgentLoop — 图上改参重放（入参改写规则）", () => {
  test("命中规则 → 工具以新入参执行，事件带原始/实际入参 + graph 来源", async () => {
    const { mockLLM, options, executed } = setup();
    mockLLM.setResponses(scriptToolCall("ls"));

    const session = createSession("test-model");
    session.messages.push(createUserMessage("查目录"));

    const loop = new AgentLoop(options);
    const events = await collectEvents(
      loop.run(session, {
        inputOverrides: [
          { toolName: "bash", from: { command: "ls" }, to: { command: "ls -la" } },
        ],
        correctionSource: "graph",
      }),
    );

    // 工具真的以新入参执行
    expect(executed).toEqual([{ command: "ls -la" }]);

    const result = events.find(
      (e): e is Extract<AgentEvent, { type: "tool-call-result" }> =>
        e.type === "tool-call-result",
    )!;
    expect(result.input).toEqual({ command: "ls -la" });
    expect(result.userCorrectedInput).toBe(true);
    expect(result.originalInput).toEqual({ command: "ls" });
    expect(result.correctionSource).toBe("graph");
    expect(result.result.content).toBe("ran: ls -la");

    // 会话历史里的 tool-use 块同步为实际执行入参（与 HITL 改参同构）
    const assistantMsg = session.messages.find((m) => m.role === "assistant")!;
    const toolUse = assistantMsg.content.find((b) => b.type === "tool-use");
    expect(toolUse && toolUse.type === "tool-use" ? toolUse.input : undefined).toEqual({
      command: "ls -la",
    });
  });

  test("未带改写规则 → 事件不带改参字段（普通轮次零变化）", async () => {
    const { mockLLM, options, executed } = setup();
    mockLLM.setResponses(scriptToolCall("ls"));

    const session = createSession("test-model");
    session.messages.push(createUserMessage("查目录"));

    const loop = new AgentLoop(options);
    const events = await collectEvents(loop.run(session));

    expect(executed).toEqual([{ command: "ls" }]);
    const result = events.find(
      (e): e is Extract<AgentEvent, { type: "tool-call-result" }> =>
        e.type === "tool-call-result",
    )!;
    expect(result.userCorrectedInput).toBeUndefined();
    expect(result.originalInput).toBeUndefined();
    expect(result.input).toBeUndefined();
  });

  test("改写规则未命中 → 原行为（原始入参执行、无改参痕）", async () => {
    const { mockLLM, options, executed } = setup();
    mockLLM.setResponses(scriptToolCall("pwd"));

    const session = createSession("test-model");
    session.messages.push(createUserMessage("查目录"));

    const loop = new AgentLoop(options);
    const events = await collectEvents(
      loop.run(session, {
        inputOverrides: [
          { toolName: "bash", from: { command: "ls" }, to: { command: "ls -la" } },
        ],
      }),
    );

    expect(executed).toEqual([{ command: "pwd" }]);
    const result = events.find(
      (e): e is Extract<AgentEvent, { type: "tool-call-result" }> =>
        e.type === "tool-call-result",
    )!;
    expect(result.userCorrectedInput).toBeUndefined();
  });
});
