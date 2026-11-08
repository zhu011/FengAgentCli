/**
 * @fengagent/cli — `/skill` 与 `/mcp` 命令测试（AGE-35 第一批 ②③）
 *
 * 覆盖：
 * 1. `/skill list` 从 `workdir/.fengagent/skills/*.md` 同步加载（自定义覆盖内置）；
 * 2. `/skill <name>` 返回 inputDraft（填输入框，不直接跑一轮对话）；
 * 3. `/skill <name>` 未命中给出可用技能；
 * 4. `/mcp list` 渲染连接/失败/工具数，`/mcp reload` 返回 App 层标记；
 * 5. Input 组件接受外部草稿（`/skill` 填入后用户可编辑）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { render } from "ink-testing-library";
import { Agent as AgentClass } from "@fengagent/agent";
import type { Config } from "@fengagent/core";
import {
  createToolRegistry,
  createToolExecutor,
  McpClient,
  registerMcpTools,
  type McpRegistrationResult,
} from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import type { LLMClient, LLMRequest, LLMEvent, LLMResponse } from "@fengagent/llm";
import { Input } from "../tui/input.tsx";
import {
  handleCommand,
  formatMcpStatus,
  MCP_RELOAD_MARKER,
  type CommandContext,
} from "../commands.ts";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "feng-skill-mcp-"));
  tempDirs.push(dir);
  return dir;
}

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class MockLLMClient implements LLMClient {
  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    // no events
  }
  async generate(request: LLMRequest): Promise<LLMResponse> {
    return {
      id: "mock",
      model: request.model,
      content: [{ type: "text", text: "ok" }],
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "end_turn",
    };
  }
}

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
    autoApproveTools: false,
    allowedTools: "*",
    bashTimeout: 120_000,
    maxToolConcurrency: 10,
    maxTurns: 50,
    logLevel: "info",
    dataDir: "~/.fengagent",
  };
}

/** 建一个带 MCP 风格工具名的 Agent（工具名前缀 `mcp__<server>__`） */
function createTestAgent(workdir: string, mcpToolNames: string[] = []) {
  const mockLLM = new MockLLMClient();
  const toolRegistry = createToolRegistry();
  for (const name of mcpToolNames) {
    toolRegistry.register({
      name,
      description: "mcp tool",
      inputSchema: z.object({}),
      async execute() {
        return { content: "ok" };
      },
      isReadOnly: () => true,
    });
  }
  const contextManager = createContextManager({
    config: {
      contextWindow: 200_000,
      compactThreshold: 0.85,
      compactKeepTokens: 8000,
      disableCompact: false,
      smallModel: "test-small",
    },
    summaryGenerator: mockLLM,
    systemContextOptions: { workdir },
  });
  return new AgentClass({
    llmClient: mockLLM,
    toolRegistry,
    toolExecutor: createToolExecutor(),
    contextManager,
    config: createTestConfig(),
    workdir,
  });
}

function writeSkill(workdir: string, file: string, content: string): void {
  const dir = join(workdir, ".fengagent", "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content, "utf-8");
}

describe("/skill — 技能列表与载入", () => {
  test("/skill list 列出内置 + 自定义技能（自定义同名覆盖内置）", () => {
    const workdir = makeTempDir();
    writeSkill(
      workdir,
      "my-review.md",
      ["---", "name: my-review", "description: 项目自有审查技能", "---", "请按团队规范审查。"].join("\n"),
    );
    // 覆盖内置 code-review
    writeSkill(
      workdir,
      "code-review.md",
      ["---", "name: code-review", "description: 覆盖后的审查技能", "---", "覆盖版 prompt"].join("\n"),
    );
    const agent = createTestAgent(workdir);

    const result = handleCommand("/skill list", {
      agent,
      currentModel: "test-model",
    } as CommandContext);

    expect(result.handled).toBe(true);
    expect(result.message).toContain("my-review");
    expect(result.message).toContain("覆盖后的审查技能");
    expect(result.message).not.toContain("系统性地审查代码质量");
    // 内置的其余技能仍在
    expect(result.message).toContain("debug");
    expect(result.message).toContain("/skill <name>");
  });

  test("/skill <name> 返回 inputDraft（填入输入框，不直接跑对话）", () => {
    const workdir = makeTempDir();
    writeSkill(
      workdir,
      "deploy.md",
      ["---", "name: deploy", "description: 发布检查", "---", "逐步检查发布清单：版本号、变更日志、回滚方案。"].join("\n"),
    );
    const agent = createTestAgent(workdir);

    const result = handleCommand("/skill deploy", {
      agent,
      currentModel: "test-model",
    } as CommandContext);

    expect(result.handled).toBe(true);
    expect(result.inputDraft).toContain("逐步检查发布清单");
    expect(result.message).toContain("已把技能 deploy");
    // 不是「直接跑一轮」的标记
    expect(result.message).not.toBe("__COMPACT__");
  });

  test("/skill <name> 未命中：报错并列出可用技能", () => {
    const workdir = makeTempDir();
    const agent = createTestAgent(workdir);

    const result = handleCommand("/skill 不存在的技能", {
      agent,
      currentModel: "test-model",
    } as CommandContext);

    expect(result.handled).toBe(true);
    expect(result.inputDraft).toBeUndefined();
    expect(result.message).toContain("未找到技能");
    expect(result.message).toContain("code-review");
  });

  test("skills 目录不存在时退化为内置技能（不报错）", () => {
    const workdir = makeTempDir();
    const agent = createTestAgent(workdir);

    const result = handleCommand("/skill", {
      agent,
      currentModel: "test-model",
    } as CommandContext);

    expect(result.message).toContain("技能列表");
    expect(result.message).toContain("code-review");
    expect(result.message).toContain("debug");
  });
});

describe("/mcp — 状态与重连", () => {
  function makeMcpResult(): McpRegistrationResult {
    return {
      client: new McpClient(),
      toolCount: 2,
      connectedServers: ["fs"],
      failedServers: [{ name: "remote", error: "spawn npx ENOENT" }],
    };
  }

  test("/mcp list 显示已连接/失败/工具数（按 server 归类 mcp__ 前缀）", () => {
    const workdir = makeTempDir();
    const agent = createTestAgent(workdir, [
      "mcp__fs__read_file",
      "mcp__fs__list_dir",
      "file-read",
    ]);

    const result = handleCommand("/mcp", {
      agent,
      currentModel: "test-model",
      mcpResult: makeMcpResult(),
    } as CommandContext);

    expect(result.handled).toBe(true);
    expect(result.message).toContain("1 已连接");
    expect(result.message).toContain("1 失败");
    expect(result.message).toContain("2 个工具");
    expect(result.message).toContain("fs — 已连接，2 个工具");
    expect(result.message).toContain("remote — 连接失败: spawn npx ENOENT");
    expect(result.message).toContain("mcp-servers.json");
  });

  test("/mcp reload 返回 App 层标记（真重连需要 await）", () => {
    const workdir = makeTempDir();
    const agent = createTestAgent(workdir);

    const result = handleCommand("/mcp reload", {
      agent,
      currentModel: "test-model",
      mcpResult: makeMcpResult(),
    } as CommandContext);

    expect(result.message).toBe(MCP_RELOAD_MARKER);
  });

  test("未配置 MCP 时给出配置路径与下一步", () => {
    const agent = createTestAgent(makeTempDir());
    const result = handleCommand("/mcp list", {
      agent,
      currentModel: "test-model",
      mcpResult: {
        client: new McpClient(),
        toolCount: 0,
        connectedServers: [],
        failedServers: [],
      },
    } as CommandContext);

    expect(result.message).toContain("未配置任何 Server");
    expect(result.message).toContain("/mcp reload");
  });

  test("formatMcpStatus：宿主未接 MCP（null）时说明原因", () => {
    const text = formatMcpStatus(null, [], "/tmp/work");
    expect(text).toContain("未初始化");
    expect(text).toContain("/tmp/work/.fengagent/mcp-servers.json");
  });

  test("/mcp reload 的底层序列：registerMcpTools 二次注册不重复、旧 client 可断开", async () => {
    // App 层 /mcp reload 做的事：registerMcpTools(registry) → 收新快照 → 旧 client disconnectAll
    const workdir = makeTempDir();
    const agent = createTestAgent(workdir, []);
    const registry = agent.getToolRegistry();
    const before = registry.list().length;

    const first = await registerMcpTools(registry, workdir);
    expect(first.connectedServers).toEqual([]);

    const second = await registerMcpTools(registry, workdir);
    await first.client.disconnectAll();

    expect(second.toolCount).toBe(0);
    // 无配置文件时不动内置工具，也不会因重复注册撑大注册表
    expect(registry.list().length).toBe(before);
  });
});

describe("Input — 外部草稿注入（/skill <name> 填输入框）", () => {
  test("draft 变化时渲染出草稿文本，用户可继续编辑", async () => {
    const { lastFrame, rerender } = render(<Input onSubmit={() => {}} />);
    expect(lastFrame()).not.toContain("检查发布清单");

    rerender(
      <Input onSubmit={() => {}} draft={{ text: "检查发布清单", id: 1 }} />,
    );
    await sleep(20);
    expect(lastFrame()).toContain("检查发布清单");

    // 同 id 重渲染不重复覆盖（模拟用户继续输入后父组件重渲染）
    rerender(
      <Input onSubmit={() => {}} draft={{ text: "检查发布清单", id: 1 }} />,
    );
    await sleep(20);
    expect(lastFrame()).toContain("检查发布清单");
  });

  test("技能 prompt 多行草稿折叠显示（不把对话区挤出屏幕）", async () => {
    const prompt = Array.from(
      { length: 20 },
      (_, i) => `第${i + 1}行：技能 prompt`,
    ).join("\n");
    const { lastFrame } = render(
      <Input onSubmit={() => {}} draft={{ text: prompt, id: 7 }} />,
    );
    await sleep(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("第1行：技能 prompt");
    expect(frame).toContain("已折叠");
    // 第 6 行以后折叠掉，不占屏幕
    expect(frame).not.toContain("第6行：技能 prompt");
  });
});
