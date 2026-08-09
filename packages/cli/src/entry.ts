/**
 * @fengagent/cli — CLI 入口
 *
 * 命令行参数解析、模式路由：
 * - 默认 CLI 模式：Ink TUI 交互界面
 * - `serve` 子命令：WebUI 服务模式（Stage 3）
 * - `--print` 或 stdin 非 TTY（管道输入） → 非交互 print 模式
 *
 * 参考 PRD 第 4.2.6 节。
 */

import React from "react";
import { render } from "ink";
import { App } from "./tui/app.tsx";
import { parseArgs, getHelpText, VERSION, type ArgParseError } from "./args.ts";
import { createAgent } from "./create-agent.ts";
import { runPrintMode } from "./print-mode.ts";
import type { Session } from "@fengagent/core";

/**
 * CLI 入口函数。
 *
 * 从 process.argv 解析参数，根据模式路由：
 * 1. --help / --version → 输出帮助/版本后退出
 * 2. `serve` 子命令 → WebUI 服务模式（暂未实现）
 * 3. `--print` 或 stdin 非 TTY（管道输入） → 非交互 print 模式
 * 4. 默认 → Ink TUI 交互模式
 */
export async function main(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    const e = err as ArgParseError;
    process.stderr.write(`Error: ${e.message}\n\n`);
    process.stderr.write(getHelpText() + "\n");
    process.exit(1);
  }

  // --help
  if (parsed.help) {
    process.stdout.write(getHelpText() + "\n");
    return;
  }

  // --version
  if (parsed.version) {
    process.stdout.write(`FengAgentCli v${VERSION}\n`);
    return;
  }

  // serve 子命令 — 启动 WebUI 服务
  if (parsed.serve) {
    const { loadConfigFromEnv } = await import("@fengagent/core");
    const { Agent } = await import("@fengagent/agent");
    const { createClientFromEnv } = await import("@fengagent/llm");
    const {
      createToolRegistry,
      createToolExecutor,
      registerBuiltinTools,
      createPermissionChecker,
      createHookRegistry,
      McpClient,
      loadMcpConfig,
      adaptMcpTools,
    } = await import("@fengagent/tools");
    const { createContextManager } = await import("@fengagent/context");
    const { startServer } = await import("@fengagent/server");
    const { resolve } = await import("node:path");

    const config = loadConfigFromEnv();
    const { client: llmClient } = createClientFromEnv();
    const workdir = process.cwd();

    // 共享 Hook 注册器和权限检查器
    const hookRegistry = createHookRegistry();
    const permissionChecker = createPermissionChecker(workdir);

    // MCP 集成 — 连接一次，共享给所有 Agent 实例
    const mcpClient = new McpClient();
    const mcpConfigs = loadMcpConfig(workdir);
    if (Object.keys(mcpConfigs).length > 0) {
      try {
        const connections = await mcpClient.connectAll(mcpConfigs);
        const connected = connections.filter((c) => c.status === "connected");
        const failed = connections.filter((c) => c.status === "error");
        if (connected.length > 0) {
          console.error(
            `MCP: connected ${connected.length} server(s), ` +
            `registered ${mcpClient.getTools() ? Object.keys(mcpClient.getTools()).length : 0} tool(s)`,
          );
        }
        for (const f of failed) {
          console.error(`MCP: failed to connect "${f.name}": ${f.error}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`MCP: initialization error: ${message}`);
      }
    }

    function createServerAgent(): InstanceType<typeof Agent> {
      const toolRegistry = createToolRegistry();
      registerBuiltinTools(toolRegistry);

      // 注册 MCP 工具（复用已连接的 MCP 客户端）
      const mcpToolsMap = mcpClient.getTools();
      if (Object.keys(mcpToolsMap).length > 0) {
        for (const tool of adaptMcpTools(mcpToolsMap)) {
          if (toolRegistry.get(tool.name)) {
            toolRegistry.unregister(tool.name);
          }
          toolRegistry.register(tool);
        }
      }

      const toolExecutor = createToolExecutor(permissionChecker, hookRegistry);
      const contextManager = createContextManager({
        config: {
          contextWindow: config.contextWindow,
          compactThreshold: config.compactThreshold,
          compactKeepTokens: config.compactKeepTokens,
          disableCompact: config.disableCompact,
          smallModel: config.smallModel,
        },
        summaryGenerator: llmClient,
        systemContextOptions: { workdir },
      });
      return new Agent({
        llmClient,
        toolRegistry,
        toolExecutor,
        contextManager,
        config,
        workdir,
      });
    }

    // 静态文件目录（web-ui 构建产物）
    const staticDir = resolve(
      new URL(".", import.meta.url).pathname,
      "../../web-ui/dist",
    );

    startServer({ config, createAgent: createServerAgent, staticDir });
    return;
  }

  // 构建 CLI 参数覆盖
  const cliOverrides: Record<string, unknown> = {};
  if (parsed.model) {
    cliOverrides.model = parsed.model;
  }
  if (parsed.port) {
    cliOverrides.serverPort = parsed.port;
  }

  // 创建 Agent
  let agentResult;
  try {
    agentResult = await createAgent({
      cliArgs: cliOverrides,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to initialize agent: ${message}\n`);

    // 提供更友好的错误提示
    if (message.includes("API_KEY")) {
      process.stderr.write(
        "\nPlease set the appropriate API key environment variable.\n" +
          "  Anthropic: export ANTHROPIC_API_KEY=sk-...\n" +
          "  OpenAI:    export OPENAI_API_KEY=sk-...\n" +
          "  OpenAI-Compatible: export OPENAI_COMPATIBLE_API_KEY=... OPENAI_COMPATIBLE_BASE_URL=...\n",
      );
    }
    process.exit(1);
  }

  const { agent, sessionStore } = agentResult;

  // 恢复已有会话（如果指定了 --session）
  let initialSession: Session | undefined;
  if (parsed.session) {
    if (!sessionStore) {
      process.stderr.write(
        "Error: Session store is not available. Cannot resume session.\n",
      );
      process.exit(1);
    }
    const loaded = sessionStore.loadSession(parsed.session);
    if (!loaded) {
      process.stderr.write(
        `Error: Session "${parsed.session}" not found.\n`,
      );
      process.exit(1);
    }
    initialSession = loaded;
  }

  // 判断模式：--print 或 stdin 非 TTY → print 模式，否则 → TUI 模式
  const isPiped = !process.stdin.isTTY;

  if (isPiped || parsed.print) {
    // 非交互模式：stdin → stdout
    const input = parsed.positional.join(" ");
    await runPrintMode({
      agent,
      input: input || undefined,
      session: initialSession,
    });

    // 关闭会话存储
    sessionStore?.close();
    return;
  }

  // TUI 交互模式
  const instance = render(
    React.createElement(App, {
      agent,
      initialSession,
      onExit: () => {
        sessionStore?.close();
        instance.unmount();
      },
    }),
  );

  // 保持进程运行（Ink render 已经接管了终端）
  // Ink 会在退出时清理
}

// 直接运行入口
if (import.meta.main) {
  const argv = process.argv.slice(2);
  main(argv).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal: ${message}\n`);
    process.exit(1);
  });
}
