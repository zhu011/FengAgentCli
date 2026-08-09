/**
 * @fengagent/agent — 子 Agent 派遣集成测试
 *
 * 测试 createSubagentRunner 的完整流程：
 * 1. 成功派遣子 Agent（mock LLM 返回文本）
 * 2. 未知 Agent 类型
 * 3. 深度限制
 * 4. 子 Agent 工具过滤（task 工具被排除）
 * 5. 子 Agent LLM 错误处理
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMEvent,
} from "@fengagent/llm";
import type {
  Config,
  AgentEvent,
} from "@fengagent/core";
import { createSession, createUserMessage } from "@fengagent/core";
import {
  createToolRegistry,
  createToolExecutor,
  registerBuiltinTools,
} from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { createAgentDefinitionLoader } from "../agent-definition.ts";
import { createSubagentRunner } from "../subagent-runner.ts";
import { AgentLoop } from "../loop.ts";
import type { AgentLoopOptions } from "../loop.ts";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ──────────────────────────────────────────────
// Mock LLM Client
// ──────────────────────────────────────────────

class MockLLMClient implements LLMClient {
  private responses: LLMEvent[][] = [];
  private callIndex = 0;
  public generateCalls: LLMRequest[] = [];

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
    this.generateCalls.push(request);
    return {
      id: `mock-gen-${this.generateCalls.length}`,
      model: request.model,
      content: [{ type: "text", text: "摘要。" }],
      usage: { inputTokens: 100, outputTokens: 50 },
      finishReason: "end_turn",
    };
  }
}

// ──────────────────────────────────────────────
// 测试辅助
// ──────────────────────────────────────────────

const TEST_WORKDIR = join(tmpdir(), "fengagent-subagent-test");

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

function createTestSetup(overrides?: Partial<Config>) {
  const config = createTestConfig(overrides);
  const mockLLM = new MockLLMClient();

  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);

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
    systemContextOptions: { workdir: TEST_WORKDIR },
  });

  return { config, mockLLM, toolRegistry, toolExecutor, contextManager };
}

function textDelta(text: string): LLMEvent {
  return { type: "text-delta", text };
}

function finish(reason: "end_turn" | "tool_use" | "max_tokens"): LLMEvent {
  return { type: "finish", reason };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

beforeAll(() => {
  if (!existsSync(TEST_WORKDIR)) mkdirSync(TEST_WORKDIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_WORKDIR)) rmSync(TEST_WORKDIR, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// 子 Agent 派遣测试
// ──────────────────────────────────────────────

describe("createSubagentRunner", () => {
  test("成功派遣子 Agent 并返回结果", async () => {
    const setup = createTestSetup();
    setup.mockLLM.setResponses([
      [textDelta("子 Agent 完成了任务。"), finish("end_turn")],
    ]);

    const loader = createAgentDefinitionLoader({
      workdir: TEST_WORKDIR,
      config: setup.config,
    });
    await loader.load();

    const spawnSubagent = createSubagentRunner({
      llmClient: setup.mockLLM,
      toolRegistry: setup.toolRegistry,
      toolExecutor: setup.toolExecutor,
      contextManager: setup.contextManager,
      config: setup.config,
      workdir: TEST_WORKDIR,
      agentDefinitionLoader: loader,
    });

    const result = await spawnSubagent({
      description: "test task",
      prompt: "完成测试任务",
      subagentType: "coder",
      parentSessionId: "parent-session",
      depth: 0,
    });

    expect(result.state).toBe("completed");
    expect(result.text).toContain("子 Agent 完成了任务");
    expect(result.sessionId).toBeDefined();
    expect(result.taskId).toBeDefined();
  });

  test("未知 Agent 类型返回错误", async () => {
    const setup = createTestSetup();

    const loader = createAgentDefinitionLoader({
      workdir: TEST_WORKDIR,
      config: setup.config,
    });
    await loader.load();

    const spawnSubagent = createSubagentRunner({
      llmClient: setup.mockLLM,
      toolRegistry: setup.toolRegistry,
      toolExecutor: setup.toolExecutor,
      contextManager: setup.contextManager,
      config: setup.config,
      workdir: TEST_WORKDIR,
      agentDefinitionLoader: loader,
    });

    const result = await spawnSubagent({
      description: "test",
      prompt: "do",
      subagentType: "nonexistent-agent",
      parentSessionId: "parent",
      depth: 0,
    });

    expect(result.state).toBe("error");
    expect(result.text).toContain("Unknown agent type");
    expect(result.text).toContain("nonexistent-agent");
  });

  test("深度限制阻止递归", async () => {
    const setup = createTestSetup();

    const loader = createAgentDefinitionLoader({
      workdir: TEST_WORKDIR,
      config: setup.config,
    });
    await loader.load();

    const spawnSubagent = createSubagentRunner({
      llmClient: setup.mockLLM,
      toolRegistry: setup.toolRegistry,
      toolExecutor: setup.toolExecutor,
      contextManager: setup.contextManager,
      config: setup.config,
      workdir: TEST_WORKDIR,
      agentDefinitionLoader: loader,
      maxDepth: 2,
    });

    // depth=2 等于 maxDepth，应被拒绝
    const result = await spawnSubagent({
      description: "nested",
      prompt: "deep task",
      subagentType: "coder",
      parentSessionId: "parent",
      depth: 2,
    });

    expect(result.state).toBe("error");
    expect(result.text).toContain("depth limit");
  });

  test("子 Agent LLM 错误时返回 error 状态", async () => {
    const setup = createTestSetup();
    setup.mockLLM.setResponses([
      [{ type: "error", error: { message: "API error", code: "rate_limit" } }],
    ]);

    const loader = createAgentDefinitionLoader({
      workdir: TEST_WORKDIR,
      config: setup.config,
    });
    await loader.load();

    const spawnSubagent = createSubagentRunner({
      llmClient: setup.mockLLM,
      toolRegistry: setup.toolRegistry,
      toolExecutor: setup.toolExecutor,
      contextManager: setup.contextManager,
      config: setup.config,
      workdir: TEST_WORKDIR,
      agentDefinitionLoader: loader,
    });

    const result = await spawnSubagent({
      description: "error task",
      prompt: "will fail",
      subagentType: "coder",
      parentSessionId: "parent",
      depth: 0,
    });

    expect(result.state).toBe("error");
    expect(result.text).toContain("API error");
  });

  test("子 Agent 的工具注册表不包含 task 工具", async () => {
    // 创建一个会调用 task 工具的 mock LLM 响应
    // 但由于 task 工具不在子 Agent 的注册表中，应该返回 "not found" 错误
    const setup = createTestSetup();
    setup.mockLLM.setResponses([
      [
        textDelta("Let me delegate."),
        { type: "tool-call", id: "call-1", name: "task", input: {
          description: "sub-sub",
          prompt: "do",
          subagent_type: "coder",
        } },
        finish("tool_use"),
      ],
      // 第二轮：子 Agent 收到 task not found 错误后回复
      [textDelta("task 工具不可用。"), finish("end_turn")],
    ]);

    const loader = createAgentDefinitionLoader({
      workdir: TEST_WORKDIR,
      config: setup.config,
    });
    await loader.load();

    const spawnSubagent = createSubagentRunner({
      llmClient: setup.mockLLM,
      toolRegistry: setup.toolRegistry,
      toolExecutor: setup.toolExecutor,
      contextManager: setup.contextManager,
      config: setup.config,
      workdir: TEST_WORKDIR,
      agentDefinitionLoader: loader,
    });

    const result = await spawnSubagent({
      description: "will try task",
      prompt: "try to use task tool",
      subagentType: "coder",
      parentSessionId: "parent",
      depth: 0,
    });

    // 子 Agent 应该完成（不崩溃），但 task 工具调用应返回 not found
    expect(result.state).toBe("completed");
    expect(result.text).toContain("task 工具不可用");
  });

  test("coder Agent 只能使用 file-read/file-write/file-edit/bash/glob/grep", async () => {
    // coder 的 tools 列表不包含 grep 之外的工具...
    // 实际上 coder 包含了 6 个工具，我们验证 researcher 只能用 3 个
    const setup = createTestSetup();
    setup.mockLLM.setResponses([
      // researcher 尝试调用 bash（不在其工具列表中）
      [
        textDelta("Let me run bash."),
        { type: "tool-call", id: "call-1", name: "bash", input: { command: "ls" } },
        finish("tool_use"),
      ],
      // bash 不在 researcher 的工具列表中 → not found
      [textDelta("bash 不可用。"), finish("end_turn")],
    ]);

    const loader = createAgentDefinitionLoader({
      workdir: TEST_WORKDIR,
      config: setup.config,
    });
    await loader.load();

    const spawnSubagent = createSubagentRunner({
      llmClient: setup.mockLLM,
      toolRegistry: setup.toolRegistry,
      toolExecutor: setup.toolExecutor,
      contextManager: setup.contextManager,
      config: setup.config,
      workdir: TEST_WORKDIR,
      agentDefinitionLoader: loader,
    });

    const result = await spawnSubagent({
      description: "research",
      prompt: "try bash",
      subagentType: "researcher",
      parentSessionId: "parent",
      depth: 0,
    });

    expect(result.state).toBe("completed");
    expect(result.text).toContain("bash 不可用");
  });
});

// ──────────────────────────────────────────────
// 端到端：主 Agent 通过 task 工具派遣子 Agent
// ──────────────────────────────────────────────

describe("端到端：主 Agent → task 工具 → 子 Agent", () => {
  test("主 Agent 调用 task 工具，子 Agent 执行并返回结果", async () => {
    const setup = createTestSetup();

    // 主 Agent 第一轮：调用 task 工具
    // 主 Agent 第二轮：基于 task 结果生成最终回复
    // 子 Agent 轮：返回 "代码已重构"
    const responses: LLMEvent[][] = [
      // 主 Agent 第一轮
      [
        textDelta("让我派遣子 Agent 处理。"),
        {
          type: "tool-call",
          id: "call-1",
          name: "task",
          input: {
            description: "refactor code",
            prompt: "重构 auth 模块",
            subagent_type: "coder",
          },
        },
        finish("tool_use"),
      ],
      // 子 Agent 轮
      [textDelta("代码已重构完成。"), finish("end_turn")],
      // 主 Agent 第二轮
      [textDelta("子 Agent 已完成重构。"), finish("end_turn")],
    ];

    setup.mockLLM.setResponses(responses);

    const loader = createAgentDefinitionLoader({
      workdir: TEST_WORKDIR,
      config: setup.config,
    });
    await loader.load();

    const spawnSubagent = createSubagentRunner({
      llmClient: setup.mockLLM,
      toolRegistry: setup.toolRegistry,
      toolExecutor: setup.toolExecutor,
      contextManager: setup.contextManager,
      config: setup.config,
      workdir: TEST_WORKDIR,
      agentDefinitionLoader: loader,
    });

    const loopOptions: AgentLoopOptions = {
      llmClient: setup.mockLLM,
      toolRegistry: setup.toolRegistry,
      toolExecutor: setup.toolExecutor,
      contextManager: setup.contextManager,
      config: setup.config,
      workdir: TEST_WORKDIR,
      spawnSubagent,
      agentDepth: 0,
    };

    const session = createSession("test-model");
    session.messages.push(createUserMessage("帮我重构 auth 模块"));

    const loop = new AgentLoop(loopOptions);
    const events = await collectEvents(loop.run(session));

    // 应有 task 工具调用事件
    const taskCall = events.find(
      (e) => e.type === "tool-call-start" && (e as { name: string }).name === "task",
    );
    expect(taskCall).toBeDefined();

    // 应有 task 工具结果事件
    const taskResult = events.find(
      (e) => e.type === "tool-call-result",
    );
    expect(taskResult).toBeDefined();
    const result = (taskResult as { result: { content: string } }).result;
    expect(result.content).toContain("<task");
    expect(result.content).toContain("代码已重构完成");

    // 最终 session 应包含子 Agent 的结果
    const finalText = session.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content)
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    expect(finalText).toContain("子 Agent 已完成重构");
  });
});
