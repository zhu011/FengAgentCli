/**
 * 块 5 验收：session / task 分层 —— `task_id` 是**可恢复**单元
 *
 * 历史实现里 `task_id` 只是被接受后原样透传，子会话每次都新建，工具描述却写着
 * 「会继续同一个子会话」—— 说了续跑、实际新建。本用例把两件事都钉住：
 * 1. 注入会话仓 + 任务仓后，同一 `task_id` 二次派遣**真的**接着同一个子会话跑；
 * 2. 没注入（拿不到落盘记录）时如实回报 `resumed=false` + 原因，不再静默宣称续跑。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMClient, LLMEvent, LLMRequest, LLMResponse } from "@fengagent/llm";
import type { Config } from "@fengagent/core";
import { createContextManager } from "@fengagent/context";
import { createToolExecutor, createToolRegistry, registerBuiltinTools } from "@fengagent/tools";
import { createAgentDefinitionLoader } from "../agent-definition.ts";
import { createSubagentRunner } from "../subagent-runner.ts";
import { SessionStore } from "../session.ts";
import { TaskStore } from "../task-store.ts";

const TEST_WORKDIR = join(tmpdir(), "fengagent-resume-test");

class MockLLMClient implements LLMClient {
  private responses: LLMEvent[][] = [];
  private callIndex = 0;
  private calls: LLMRequest[] = [];

  setResponses(responses: LLMEvent[][]): void {
    this.responses = responses;
    this.callIndex = 0;
  }

  /** 每次 stream 请求（用于断言「历史确实带过去了」） */
  streamRequests(): LLMRequest[] {
    return this.calls;
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    this.calls.push(request);
    const events = this.responses[this.callIndex] ?? [];
    this.callIndex++;
    for (const event of events) {
      yield event;
    }
  }

  async generate(_request: LLMRequest): Promise<LLMResponse> {
    return {
      id: "mock-gen",
      model: "test-model",
      content: [{ type: "text", text: "摘要。" }],
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
    temperature: 1,
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
    logLevel: "error",
    dataDir: "~/.fengagent",
    ...overrides,
  };
}

let dir: string;
let sessionStore: SessionStore;
let taskStore: TaskStore;
let config: Config;
let mockLLM: MockLLMClient;
let toolRegistry: ReturnType<typeof createToolRegistry>;
let contextManager: ReturnType<typeof createContextManager>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "fengagent-resume-db-"));
  if (!existsSync(TEST_WORKDIR)) mkdirSync(TEST_WORKDIR, { recursive: true });
  config = createTestConfig();
  mockLLM = new MockLLMClient();
  toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  contextManager = createContextManager({
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
  sessionStore = new SessionStore(join(dir, "sessions.db"));
  taskStore = new TaskStore(join(dir, "tasks.db"));
});

afterAll(() => {
  sessionStore.close();
  taskStore.close();
  try {
    rmSync(dir, { recursive: true, force: true });
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
  } catch {
    // Windows 偶发占用
  }
});

async function makeRunner(withPersistence: boolean) {
  const loader = createAgentDefinitionLoader({
    workdir: TEST_WORKDIR,
    config,
  });
  await loader.load();
  return createSubagentRunner({
    llmClient: mockLLM,
    toolRegistry,
    toolExecutor: createToolExecutor(),
    contextManager,
    config,
    workdir: TEST_WORKDIR,
    agentDefinitionLoader: loader,
    ...(withPersistence ? { sessionStore, taskStore } : {}),
  });
}

describe("task_id 可恢复单元", () => {
  test("注入落盘仓后：同一 task_id 二次派遣接着同一个子会话跑", async () => {
    const spawn = await makeRunner(true);
    const taskId = "task-resume-1";

    mockLLM.setResponses([[{ type: "text-delta", text: "第一轮完成。" }, { type: "finish", reason: "end_turn" }]]);
    const first = await spawn({
      description: "第一段",
      prompt: "先做第一步",
      subagentType: "default",
      taskId,
      parentSessionId: "parent",
      depth: 0,
    });
    expect(first.state).toBe("completed");
    // 首次派遣一个新 task_id：没有可续跑的记录，如实不带任何 resumed 声明
    expect(first.resumed).toBeUndefined();
    expect(first.sessionId).not.toBe("");

    // 落盘检查：任务仓知道这个 task_id 归哪个会话
    const persistedTask = taskStore.getTask(taskId)!;
    expect(persistedTask.sessionId).toBe(first.sessionId);
    expect(persistedTask.coreIntent).toContain("第一段");

    // 第二轮：**同一个 task_id**
    mockLLM.setResponses([[{ type: "text-delta", text: "第二轮完成。" }, { type: "finish", reason: "end_turn" }]]);
    const second = await spawn({
      description: "第二段",
      prompt: "接着做第二步",
      subagentType: "default",
      taskId,
      parentSessionId: "parent",
      depth: 0,
    });

    // 会话是同一个（不是新建）
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.resumed).toBe(true);

    // 历史真的带过去了：第二轮请求的上下文里含第一轮的提示词
    const requests = mockLLM.streamRequests();
    const lastRequest = requests[requests.length - 1]!;
    const flat = JSON.stringify(lastRequest.messages);
    expect(flat).toContain("先做第一步");
    expect(flat).toContain("接着做第二步");

    // 落盘会话同样保留了两轮
    const persistedSession = sessionStore.loadSession(first.sessionId)!;
    const text = JSON.stringify(persistedSession.messages);
    expect(text).toContain("先做第一步");
    expect(text).toContain("接着做第二步");
  });

  test("未注入落盘仓：如实回报 resumed=false 并给出原因（不静默宣称续跑）", async () => {
    const spawn = await makeRunner(false);
    mockLLM.setResponses([[{ type: "text-delta", text: "ok" }, { type: "finish", reason: "end_turn" }]]);
    const result = await spawn({
      description: "无落盘",
      prompt: "做事",
      subagentType: "default",
      taskId: "task-resume-unknown",
      parentSessionId: "parent",
      depth: 0,
    });
    expect(result.state).toBe("completed");
    expect(result.resumed).toBe(false);
    expect(result.resumeFallbackReason).toBeTruthy();
  });

  test("不传 task_id 时不带 resumed 字段（新建就是新建，无需解释）", async () => {
    const spawn = await makeRunner(true);
    mockLLM.setResponses([[{ type: "text-delta", text: "ok" }, { type: "finish", reason: "end_turn" }]]);
    const result = await spawn({
      description: "全新任务",
      prompt: "做事",
      subagentType: "default",
      parentSessionId: "parent",
      depth: 0,
    });
    expect(result.resumed).toBeUndefined();
    expect(result.resumeFallbackReason).toBeUndefined();
  });

  test("task_id 命中但会话已被删除 → 如实回报回退原因", async () => {
    const spawn = await makeRunner(true);
    const taskId = "task-resume-orphan";
    mockLLM.setResponses([[{ type: "text-delta", text: "ok" }, { type: "finish", reason: "end_turn" }]]);
    const first = await spawn({
      description: "建会话",
      prompt: "p",
      subagentType: "default",
      taskId,
      parentSessionId: "parent",
      depth: 0,
    });
    sessionStore.deleteSession(first.sessionId);

    mockLLM.setResponses([[{ type: "text-delta", text: "ok" }, { type: "finish", reason: "end_turn" }]]);
    const second = await spawn({
      description: "会话丢了",
      prompt: "p2",
      subagentType: "default",
      taskId,
      parentSessionId: "parent",
      depth: 0,
    });
    expect(second.resumed).toBe(false);
    expect(second.resumeFallbackReason).toContain("task_id");
  });
});
