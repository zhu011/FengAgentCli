/**
 * @fengagent/cli — 最终交付功能验证测试
 *
 * 覆盖 CLI 模式的完整功能验证：
 * - 参数解析边界情况
 * - Slash 命令完整覆盖
 * - Print 模式流式输出
 * - 会话管理命令
 * - 模型切换命令
 * - 导出命令
 * - 帮助和版本输出
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parseArgs, getHelpText, VERSION } from "../args.ts";
import { handleCommand, buildModelListMessage, type CommandContext } from "../commands.ts";
import type { Agent } from "@fengagent/agent";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMEvent,
} from "@fengagent/llm";
import type { Config } from "@fengagent/core";
import { createToolRegistry, createToolExecutor } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { Agent as AgentClass, SessionStore } from "@fengagent/agent";
import { runPrintMode } from "../print-mode.ts";
import { mkdtempSync, rmSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ──────────────────────────────────────────────
// Mock LLM Client
// ──────────────────────────────────────────────

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
    for (const event of events) {
      yield event;
    }
  }

  async generate(_request: LLMRequest): Promise<LLMResponse> {
    return {
      id: `mock-gen-${Date.now()}`,
      model: _request.model,
      content: [{ type: "text", text: "摘要。" }],
      usage: { inputTokens: 100, outputTokens: 50 },
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
let tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), `feng-cli-verify-${dbCounter++}-`));
  tempDirs.push(dir);
  return join(dir, "test.db");
}

function createTestAgent(mockLLM: MockLLMClient): Agent {
  const config = createTestConfig();
  const dbPath = createTempDbPath();

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

  const sessionStore = new SessionStore(dbPath);

  return new AgentClass({
    llmClient: mockLLM,
    toolRegistry,
    toolExecutor,
    contextManager,
    config,
    workdir: ".",
    sessionStore,
  });
}

function textDelta(text: string): LLMEvent {
  return { type: "text-delta", text };
}
function usageEvent(inp: number, out: number): LLMEvent {
  return { type: "usage", inputTokens: inp, outputTokens: out };
}
function finish(reason: "end_turn" | "tool_use" | "max_tokens"): LLMEvent {
  return { type: "finish", reason };
}

// ──────────────────────────────────────────────
// 参数解析边界情况
// ──────────────────────────────────────────────

describe("CLI 交付验证：参数解析边界情况", () => {
  test("端口 0 抛出错误", () => {
    expect(() => parseArgs(["--port", "0"])).toThrow();
  });

  test("端口负数抛出错误", () => {
    expect(() => parseArgs(["--port", "-1"])).toThrow();
  });

  test("端口 65536 超出范围抛出错误", () => {
    expect(() => parseArgs(["--port", "65536"])).toThrow();
  });

  test("端口 1 是有效值", () => {
    expect(parseArgs(["--port", "1"]).port).toBe(1);
  });

  test("端口 65535 是有效值", () => {
    expect(parseArgs(["--port", "65535"]).port).toBe(65535);
  });

  test("--port=abc 抛出错误", () => {
    expect(() => parseArgs(["--port=abc"])).toThrow();
  });

  test("多个 --model 参数取最后一个", () => {
    const result = parseArgs(["--model", "gpt-4o", "--model", "claude-sonnet-4"]);
    expect(result.model).toBe("claude-sonnet-4");
  });

  test("serve + port 组合", () => {
    const result = parseArgs(["serve", "--port", "8080"]);
    expect(result.serve).toBe(true);
    expect(result.port).toBe(8080);
  });

  test("serve + model + session + positional 全组合", () => {
    const result = parseArgs([
      "serve", "--model", "gpt-4o", "--session", "sess-1", "prompt", "text",
    ]);
    expect(result.serve).toBe(true);
    expect(result.model).toBe("gpt-4o");
    expect(result.session).toBe("sess-1");
    expect(result.positional).toEqual(["prompt", "text"]);
  });

  test("--print 标志解析", () => {
    const result = parseArgs(["--print", "hello"]);
    expect(result.print).toBe(true);
    expect(result.positional).toEqual(["hello"]);
  });

  test("纯位置参数", () => {
    const result = parseArgs(["帮我读取文件"]);
    expect(result.positional).toEqual(["帮我读取文件"]);
    expect(result.serve).toBe(false);
  });

  test("空字符串位置参数被收集", () => {
    const result = parseArgs([""]);
    expect(result.positional).toEqual([""]);
  });

  test("-- 后跟 --model 不解析为选项", () => {
    const result = parseArgs(["--", "--model"]);
    expect(result.model).toBeUndefined();
    expect(result.positional).toEqual(["--model"]);
  });

  test("-m= 不被支持（短参数不支持 = 语法）", () => {
    // -m= 不匹配任何 case，会走到 default 分支以 - 开头而抛出
    expect(() => parseArgs(["-m=gpt-4o"])).toThrow();
  });
});

// ──────────────────────────────────────────────
// 帮助和版本输出
// ──────────────────────────────────────────────

describe("CLI 交付验证：帮助和版本", () => {
  test("帮助文本包含所有主要选项", () => {
    const text = getHelpText();
    expect(text).toContain("--model");
    expect(text).toContain("--port");
    expect(text).toContain("--session");
    expect(text).toContain("--print");
    expect(text).toContain("--help");
    expect(text).toContain("--version");
    expect(text).toContain("serve");
  });

  test("帮助文本包含交互命令", () => {
    const text = getHelpText();
    expect(text).toContain("/help");
    expect(text).toContain("/session");
    expect(text).toContain("/model");
    expect(text).toContain("/export");
    expect(text).toContain("/clear");
    expect(text).toContain("/exit");
  });

  test("帮助文本包含用法示例", () => {
    const text = getHelpText();
    expect(text).toContain("用法:");
    expect(text).toContain("示例:");
  });

  test("VERSION 为 0.1.0", () => {
    expect(VERSION).toBe("0.1.0");
  });
});

// ──────────────────────────────────────────────
// Slash 命令验证
// ──────────────────────────────────────────────

describe("CLI 交付验证：Slash 命令全覆盖", () => {
  let mockLLM: MockLLMClient;
  let agent: Agent;
  let ctx: CommandContext;

  beforeEach(() => {
    mockLLM = new MockLLMClient();
    agent = createTestAgent(mockLLM);
    ctx = {
      agent,
      currentModel: "test-model",
    };
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
    tempDirs = [];
  });

  test("/help 返回帮助消息", () => {
    const result = handleCommand("/help", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toBeTruthy();
    expect(result.message).toContain("可用命令");
    expect(result.message).toContain("/session");
    expect(result.message).toContain("/model");
    expect(result.message).toContain("/export");
  });

  test("/exit 请求退出", () => {
    const result = handleCommand("/exit", ctx);
    expect(result.handled).toBe(true);
    expect(result.shouldExit).toBe(true);
  });

  test("/quit 请求退出", () => {
    const result = handleCommand("/quit", ctx);
    expect(result.handled).toBe(true);
    expect(result.shouldExit).toBe(true);
  });

  test("/clear 请求清屏", () => {
    const result = handleCommand("/clear", ctx);
    expect(result.handled).toBe(true);
    expect(result.shouldClear).toBe(true);
  });

  test("/session 无子命令返回用法", () => {
    const result = handleCommand("/session", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("用法");
    expect(result.message).toContain("/session new");
    expect(result.message).toContain("/session list");
    expect(result.message).toContain("/session switch");
  });

  test("/session new 创建新会话", () => {
    const result = handleCommand("/session new 测试会话", ctx);
    expect(result.handled).toBe(true);
    expect(result.newSession).toBeDefined();
    expect(result.newSession!.title).toBe("测试会话");
    expect(result.message).toContain("已新建会话");
  });

  test("/session new 无标题使用默认标题", () => {
    const result = handleCommand("/session new", ctx);
    expect(result.handled).toBe(true);
    expect(result.newSession).toBeDefined();
    expect(result.newSession!.title).toBeTruthy();
  });

  test("/session list 列出会话", async () => {
    // 先通过 prompt 创建一个持久化会话
    mockLLM.setResponses([
      [textDelta("回复"), finish("end_turn")],
    ]);
    for await (const event of agent.prompt("测试消息")) {
      // 消费事件使会话持久化
      void event;
    }
    const result = handleCommand("/session list", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("会话列表");
    expect(result.message).toContain("Session");
  });

  test("/session list 无会话时提示", () => {
    const result = handleCommand("/session list", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("暂无保存的会话");
  });

  test("/session switch 无 ID 返回用法", () => {
    const result = handleCommand("/session switch", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("用法");
    expect(result.message).toContain("/session switch");
  });

  test("/session switch 不存在的 ID 返回错误", () => {
    const result = handleCommand("/session switch nonexistent-id", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("未找到");
  });

  test("/session switch 有效 ID 切换成功", async () => {
    // 先通过 prompt 创建一个持久化会话
    mockLLM.setResponses([
      [textDelta("回复"), finish("end_turn")],
    ]);
    let sessionId = "";
    for await (const event of agent.prompt("创建会话")) {
      if (event.type === "session-start") {
        sessionId = event.session.id;
      }
    }

    const result = handleCommand(`/session switch ${sessionId}`, ctx);
    expect(result.handled).toBe(true);
    expect(result.newSession).toBeDefined();
    expect(result.newSession!.id).toBe(sessionId);
    expect(result.message).toContain("已切换");
  });

  test("/model 无参数返回当前模型", () => {
    const result = handleCommand("/model", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("当前模型");
    expect(result.message).toContain("test-model");
  });

  test("/model list 列出当前 provider 真实模型", async () => {
    const text = await buildModelListMessage(ctx);
    expect(text).toContain("anthropic");
    expect(text).toContain("claude");
    expect(text).toContain("test-model");
  });

  test("/model <id> 切换模型并持久化", () => {
    const cwd = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), `feng-model-${Date.now()}-`));
    try {
      process.chdir(tmp);
      const result = handleCommand("/model gpt-4o", ctx);
      expect(result.handled).toBe(true);
      expect(result.newModel).toBe("gpt-4o");
      expect(result.message).toContain("已切换");
      expect(result.message).toContain("gpt-4o");
      expect(result.message).toContain("config.json");

      const raw = JSON.parse(
        readFileSync(join(tmp, ".fengagent", "config.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(raw["model"]).toBe("gpt-4o");
    } finally {
      process.chdir(cwd);
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("/export 无活动会话返回提示", () => {
    const result = handleCommand("/export", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("没有活动会话");
  });

  test("/export 有活动会话导出成功", () => {
    // 创建会话并设为当前
    const createResult = handleCommand("/session new 导出测试", ctx);
    ctx.currentSession = createResult.newSession;

    const exportFile = join(tmpdir(), `feng-export-test-${Date.now()}.md`);
    const result = handleCommand(`/export ${exportFile}`, ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("已导出");

    // 验证文件存在
    expect(existsSync(exportFile)).toBe(true);
    const content = readFileSync(exportFile, "utf-8");
    expect(content).toContain("导出测试");
    expect(content).toContain("Session ID");

    // 清理
    try { unlinkSync(exportFile); } catch { }
  });

  test("未知命令返回提示", () => {
    const result = handleCommand("/unknown-command", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("未知命令");
    expect(result.message).toContain("/help");
  });

  test("非 slash 命令返回 handled=false", () => {
    const result = handleCommand("普通消息", ctx);
    expect(result.handled).toBe(false);
  });

  test("命令大小写不敏感", () => {
    const result = handleCommand("/HELP", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("可用命令");
  });

  test("/SESSION NEW 大写也能工作", () => {
    const result = handleCommand("/SESSION NEW 大写测试", ctx);
    expect(result.handled).toBe(true);
    expect(result.newSession).toBeDefined();
    expect(result.newSession!.title).toBe("大写测试");
  });
});

// ──────────────────────────────────────────────
// Print 模式验证
// ──────────────────────────────────────────────

describe("CLI 交付验证：Print 模式", () => {
  let mockLLM: MockLLMClient;
  let agent: Agent;

  beforeEach(() => {
    mockLLM = new MockLLMClient();
    agent = createTestAgent(mockLLM);
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
    tempDirs = [];
  });

  test("Print 模式输出流式文本到 stdout", async () => {
    mockLLM.setResponses([
      [textDelta("Hello"), textDelta(" "), textDelta("World"), usageEvent(10, 5), finish("end_turn")],
    ]);

    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let stdoutOutput = "";
    let stderrOutput = "";

    process.stdout.write = (chunk: string | Uint8Array) => {
      stdoutOutput += chunk.toString();
      return true;
    };
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrOutput += chunk.toString();
      return true;
    };

    try {
      await runPrintMode({
        agent,
        input: "测试输入",
      });

      expect(stdoutOutput).toContain("Hello World");
      expect(stderrOutput).toContain("Tokens");
    } finally {
      process.stdout.write = originalWrite;
      process.stderr.write = originalStderrWrite;
    }
  });

  test("Print 模式无输入时输出错误并退出", async () => {
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalExit = process.exit;
    let stderrOutput = "";
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrOutput += chunk.toString();
      return true;
    };
    // mock process.exit 防止真正退出进程
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      await runPrintMode({
        agent,
        input: "",
      });
    } catch {
      // process.exit mock 抛出 — 预期行为
    } finally {
      process.stderr.write = originalStderrWrite;
      process.exit = originalExit;
    }

    expect(stderrOutput).toContain("Error");
    expect(stderrOutput).toContain("No input");
  });
});
