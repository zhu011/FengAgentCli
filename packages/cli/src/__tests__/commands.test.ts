/**
 * @fengagent/cli — Slash 命令处理测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand, buildModelListMessage, type CommandContext } from "../commands.ts";
import type { Agent } from "@fengagent/agent";
import type { Config } from "@fengagent/core";
import { createSession } from "@fengagent/core";
import { SessionStore } from "@fengagent/agent";
import { z } from "zod";
import type { LLMClient, LLMRequest, LLMResponse, LLMEvent } from "@fengagent/llm";
import {
  createToolRegistry,
  createToolExecutor,
} from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { Agent as AgentClass } from "@fengagent/agent";

// ──────────────────────────────────────────────
// Mock LLM Client
// ──────────────────────────────────────────────

class MockLLMClient implements LLMClient {
  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    // no events
  }
  async generate(request: LLMRequest): Promise<LLMResponse> {
    return {
      id: "mock",
      model: request.model,
      content: [{ type: "text", text: "摘要" }],
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: "end_turn",
    };
  }
}

// ──────────────────────────────────────────────
// 测试辅助
// ──────────────────────────────────────────────

function createTestConfig(): Config {
  return {
    model: "test-model",
    smallModel: "test-small",
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

function createTestAgent(): Agent {
  return createAgentWithConfig(createTestConfig());
}

/** 用指定配置创建测试 Agent */
function createAgentWithConfig(config: Config): Agent {
  const mockLLM = new MockLLMClient();
  const toolRegistry = createToolRegistry();
  toolRegistry.register({
    name: "echo",
    description: "Echo",
    inputSchema: z.object({ text: z.string() }),
    async execute(input: { text: string }) {
      return { content: `Echo: ${input.text}` };
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
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
  return new AgentClass({
    llmClient: mockLLM,
    toolRegistry,
    toolExecutor,
    contextManager,
    config,
    workdir: ".",
  });
}

let dbPath: string;

beforeEach(() => {
  dbPath = `test-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
});

afterEach(() => {
  try {
    require("fs").unlinkSync(dbPath);
  } catch {
    // ignore
  }
});

// ──────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────

describe("handleCommand — 基本命令", () => {
  test("非命令文本返回 handled=false", () => {
    const agent = createTestAgent();
    const session = createSession("test-model");
    const ctx: CommandContext = {
      agent,
      currentSession: session,
      currentModel: "test-model",
    };
    const result = handleCommand("Hello world", ctx);
    expect(result.handled).toBe(false);
  });

  test("/help 返回帮助文本", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = {
      agent,
      currentModel: "test-model",
    };
    const result = handleCommand("/help", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toBeDefined();
    expect(result.message!).toContain("可用命令");
    expect(result.message!).toContain("/help");
    expect(result.message!).toContain("/exit");
    expect(result.message!).toContain("/session");
    expect(result.message!).toContain("/model");
    expect(result.message!).toContain("/export");
  });

  test("/exit 请求退出", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/exit", ctx);
    expect(result.handled).toBe(true);
    expect(result.shouldExit).toBe(true);
  });

  test("/quit 请求退出", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/quit", ctx);
    expect(result.handled).toBe(true);
    expect(result.shouldExit).toBe(true);
  });

  test("/clear 请求清屏", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/clear", ctx);
    expect(result.handled).toBe(true);
    expect(result.shouldClear).toBe(true);
  });

  test("未知命令返回提示", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/foobar", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("未知命令");
    expect(result.message).toContain("/help");
  });
});

describe("handleCommand — /session", () => {
  test("/session 无子命令显示帮助", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/session", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("/session new");
    expect(result.message).toContain("/session list");
    expect(result.message).toContain("/session switch");
  });

  test("/session new 创建新会话", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/session new My Test", ctx);
    expect(result.handled).toBe(true);
    expect(result.newSession).toBeDefined();
    expect(result.newSession!.title).toBe("My Test");
    expect(result.newSession!.id).toBeDefined();
  });

  test("/session new 无标题时使用默认标题", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/session new", ctx);
    expect(result.handled).toBe(true);
    expect(result.newSession).toBeDefined();
    expect(result.newSession!.title.length).toBeGreaterThan(0);
  });

  test("/session list 无会话时返回空提示", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/session list", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("暂无");
  });

  test("/session list 有会话时列出", () => {
    const store = new SessionStore(dbPath);
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
    const agent = new AgentClass({
      llmClient: mockLLM,
      toolRegistry,
      toolExecutor,
      contextManager,
      config,
      workdir: ".",
      sessionStore: store,
    });

    // 创建一个会话并保存
    const session = createSession("test-model", "Test Session");
    store.saveSession(session);

    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/session list", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("Test Session");
    expect(result.message).toContain("会话列表");

    store.close();
  });

  test("/session switch 无 ID 时提示用法", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/session switch", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("用法");
  });

  test("/session switch 无效 ID 时返回未找到", () => {
    const store = new SessionStore(dbPath);
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
    const agent = new AgentClass({
      llmClient: mockLLM,
      toolRegistry,
      toolExecutor,
      contextManager,
      config,
      workdir: ".",
      sessionStore: store,
    });

    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/session switch nonexistent", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("未找到");

    store.close();
  });
});

describe("handleCommand — /model", () => {
  test("/model 无参数显示当前模型和帮助", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/model", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("当前模型");
    expect(result.message).toContain("test-model");
  });

  test("/model list 返回异步标记（由 App 层构建列表）", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/model list", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toBe("__MODEL_LIST__");
  });

  test("/model list 构建当前 provider 真实模型列表（anthropic）", async () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const text = await buildModelListMessage(ctx);
    expect(text).toContain("anthropic");
    expect(text).toContain("claude");
    expect(text).toContain("test-model"); // 当前模型被标记
    expect(text).toContain("/model <id>");
  });

  test("/model list 未配置 baseUrl 时 openai-compatible 回退到目录", async () => {
    const config = { ...createTestConfig(), provider: "openai-compatible" };
    const agent = createAgentWithConfig(config);
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const text = await buildModelListMessage(ctx);
    expect(text).toContain("openai-compatible");
    expect(text).toContain("deepseek-chat");
  });

  test("/model <id> 切换模型并持久化", () => {
    const cwd = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "feng-model-cmd-"));
    try {
      process.chdir(tmp);
      const agent = createTestAgent();
      const ctx: CommandContext = { agent, currentModel: "old-model" };
      const result = handleCommand("/model new-model-id", ctx);
      expect(result.handled).toBe(true);
      expect(result.newModel).toBe("new-model-id");
      expect(result.message).toContain("old-model");
      expect(result.message).toContain("new-model-id");
      expect(result.message).toContain("config.json");

      // 已持久化到项目配置
      const raw = JSON.parse(
        readFileSync(join(tmp, ".fengagent", "config.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(raw["model"]).toBe("new-model-id");
    } finally {
      process.chdir(cwd);
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("/model <id> openai-compatible 同时写入 openaiCompatibleModel", () => {
    const cwd = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "feng-model-cmd-"));
    try {
      process.chdir(tmp);
      const config = {
        ...createTestConfig(),
        provider: "openai-compatible",
        openaiCompatibleModel: "deepseek-chat",
      };
      const agent = createAgentWithConfig(config);
      const ctx: CommandContext = { agent, currentModel: "deepseek-chat" };
      const result = handleCommand("/model deepseek-reasoner", ctx);
      expect(result.handled).toBe(true);
      expect(result.newModel).toBe("deepseek-reasoner");

      const raw = JSON.parse(
        readFileSync(join(tmp, ".fengagent", "config.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(raw["model"]).toBe("deepseek-reasoner");
      expect(raw["openaiCompatibleModel"]).toBe("deepseek-reasoner");
    } finally {
      process.chdir(cwd);
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

describe("handleCommand — /provider", () => {
  test("/provider 无子命令显示用法", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/provider", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("/provider show");
    expect(result.message).toContain("/provider set");
  });

  test("/provider 未知子命令提示", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/provider foo", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("未知的 provider 子命令");
  });

  test("/provider show 显示当前 provider（apiKey 未配置）", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/provider show", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("provider: anthropic");
    expect(result.message).toContain("apiKey:");
    expect(result.message).toContain("未配置");
  });

  test("/provider show 对 apiKey 打码显示且不泄露明文", () => {
    const config = { ...createTestConfig(), anthropicApiKey: "sk-ant-super-secret-1234567890" };
    const agent = createAgentWithConfig(config);
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/provider show", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("sk-a****");
    expect(result.message).not.toContain("super-secret-1234567890");
    expect(result.message).not.toContain("sk-ant-super-secret-1234567890");
  });

  test("/provider set 无效类型报错", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/provider set unknown-type", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("无效的 Provider 类型");
    expect(result.message).toContain("openai-compatible");
  });

  test("/provider set openai-compatible 持久化配置并打码", () => {
    // 用临时目录作为 CWD，避免污染项目真实 .fengagent/config.json
    const cwd = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "feng-provider-cmd-"));
    try {
      process.chdir(tmp);
      const agent = createTestAgent();
      const ctx: CommandContext = { agent, currentModel: "test-model" };
      const result = handleCommand(
        "/provider set openai-compatible --api-key sk-1349d75cc2a14d53af7880718d694200 --base-url https://api.deepseek.com --model deepseek-v4-pro",
        ctx,
      );
      expect(result.handled).toBe(true);
      // 消息不含明文 apiKey
      expect(result.message).not.toContain("sk-1349d75cc2a14d53af7880718d694200");
      expect(result.message).toContain("sk-1****");
      expect(result.message).toContain("https://api.deepseek.com");
      expect(result.message).toContain("deepseek-v4-pro");
      expect(result.message).toContain("config.json");
      // newModel 返回新模型（供 App 更新会话模型）
      expect(result.newModel).toBe("deepseek-v4-pro");

      // 文件已持久化且包含正确字段
      const raw = JSON.parse(
        readFileSync(join(tmp, ".fengagent", "config.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(raw["provider"]).toBe("openai-compatible");
      expect(raw["openaiCompatibleApiKey"]).toBe("sk-1349d75cc2a14d53af7880718d694200");
      expect(raw["openaiCompatibleBaseUrl"]).toBe("https://api.deepseek.com");
      expect(raw["openaiCompatibleModel"]).toBe("deepseek-v4-pro");
      expect(raw["model"]).toBe("deepseek-v4-pro");
    } finally {
      process.chdir(cwd);
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("/provider set anthropic 使用 --api-key 参数", () => {
    const cwd = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "feng-provider-cmd-"));
    try {
      process.chdir(tmp);
      const agent = createTestAgent();
      const ctx: CommandContext = { agent, currentModel: "test-model" };
      const result = handleCommand(
        "/provider set anthropic --api-key sk-ant-abcdef123456 --base-url https://api.anthropic.com --model claude-sonnet-4-20250514",
        ctx,
      );
      expect(result.handled).toBe(true);
      expect(result.message).toContain("anthropic");
      expect(result.message).toContain("sk-a****");
      expect(result.message).not.toContain("abcdef123456");
      const raw = JSON.parse(
        readFileSync(join(tmp, ".fengagent", "config.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(raw["anthropicApiKey"]).toBe("sk-ant-abcdef123456");
    } finally {
      process.chdir(cwd);
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

describe("handleCommand — /export", () => {
  test("无活动会话时返回提示", () => {
    const agent = createTestAgent();
    const ctx: CommandContext = { agent, currentModel: "test-model" };
    const result = handleCommand("/export", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("没有活动会话");
  });

  test("导出会话到文件", () => {
    const agent = createTestAgent();
    const session = createSession("test-model", "Export Test");
    // 添加一条消息
    session.messages.push({
      id: "msg-1",
      role: "user",
      content: [{ type: "text", text: "Hello" }],
      createdAt: Date.now(),
    });
    session.messages.push({
      id: "msg-2",
      role: "assistant",
      content: [{ type: "text", text: "Hi there!" }],
      createdAt: Date.now(),
    });

    const ctx: CommandContext = {
      agent,
      currentSession: session,
      currentModel: "test-model",
    };

    const exportFile = `test-export-${Date.now()}.md`;
    const result = handleCommand(`/export ${exportFile}`, ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("已导出");
    expect(result.message).toContain(exportFile);

    // 验证文件内容
    const content = require("fs").readFileSync(exportFile, "utf-8");
    expect(content).toContain("Export Test");
    expect(content).toContain("Hello");
    expect(content).toContain("Hi there!");

    // 清理
    require("fs").unlinkSync(exportFile);
  });

  test("导出使用默认文件名", () => {
    const agent = createTestAgent();
    const session = createSession("test-model", "Test");
    const ctx: CommandContext = {
      agent,
      currentSession: session,
      currentModel: "test-model",
    };
    const result = handleCommand("/export", ctx);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("已导出");
    expect(result.message).toContain(".md");

    // 清理生成的文件
    const match = result.message!.match(/已导出.*?到:\s*(\S+\.md)/);
    if (match) {
      try {
        require("fs").unlinkSync(match[1]);
      } catch {
        // ignore
      }
    }
  });
});
