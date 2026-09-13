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
import { ensureWindowsConsoleUtf8 } from "./tui/win-console.ts";
import type { Session } from "@fengagent/core";
import { createLogger } from "@fengagent/shared";

const log = createLogger("cli");

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
  // Windows 中文控制台（代码页 936）下确保 UTF-8 输出，避免 TUI 中文/emoji 乱码
  ensureWindowsConsoleUtf8();

  log.info("main", `CLI start, args=${argv.join(" ").slice(0, 50)}`);
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

  // serve 子命令 — 启动 WebUI 服务（Phase 2/3：经 createRuntime 插件化装配）
  if (parsed.serve) {
    const { startServer, createRuntimeAgent } = await import("@fengagent/server");
    const { resolve } = await import("node:path");

    // 模型/工具/上下文/存储/图/loop 全部经 createRuntime 装配；
    // 每个会话一个 RuntimeAgent 实例，共享同一 runtime（ctx.storage / ctx.graph）
    const runtimeResult = await createRuntimeAgent();
    const config = runtimeResult.config;

    log.info("main", `serve mode (createRuntime) provider=${config.provider}, model=${config.model}, autoApproveTools=${config.autoApproveTools}`);

    // 静态文件目录（web-ui 构建产物）
    const staticDir = resolve(
      new URL(".", import.meta.url).pathname,
      "../../web-ui/dist",
    );

    log.info("main", `serve mode starting, staticDir=${staticDir}`);
    startServer({
      config,
      createAgent: () => runtimeResult.makeAgent(),
      staticDir,
      // Phase 3：跨重启恢复历史会话（与 ctx.storage 同一份 SessionStore）
      sessionStore: runtimeResult.sessionStore ?? undefined,
      // per-message LLM-judge（评测模块 judgeMessage）
      llmClient: runtimeResult.llmClient,
    });
    return;
  }

  // acp 子命令 — 启动 ACP 服务（Multica 运行时集成）
  if (parsed.acp) {
    const { loadConfig } = await import("@fengagent/core");
    const { Agent } = await import("@fengagent/agent");
    const { createClientFromEnv } = await import("@fengagent/llm");
    const {
      createToolRegistry,
      createToolExecutor,
      registerBuiltinTools,
      createPermissionChecker,
      createHookRegistry,
    } = await import("@fengagent/tools");
    const { createContextManager } = await import("@fengagent/context");
    const { startAcpServer, buildEnvForLLM } = await import("@fengagent/server");

    // 与 TUI/serve 路径一致：分层加载配置（默认值 → 全局 ~/.fengagent/config.json
    // → 项目 .fengagent/config.json → 分支 .fengagent-cordis/config.json → FENG_* 环境变量），
    // 再经 buildEnvForLLM 把配置文件中的 API Key / BaseURL / Model 注入为 LLM 环境变量。
    // 修复：此前用 loadConfigFromEnv() + createClientFromEnv() 只读环境变量，
    // 未读配置文件，导致 FENG_PROVIDER=openai-compatible 时
    // “OPENAI_COMPATIBLE_API_KEY is required” 运行时报错。
    const config = await loadConfig();
    const envForLLM = buildEnvForLLM(config);
    let llmClient: import("@fengagent/llm").LLMClient;
    try {
      llmClient = createClientFromEnv(envForLLM).client;
    } catch (err) {
      // 凭据缺失时不静默退出：Multica 只能看到 "hermes initialize failed:
      // hermes process exited"，无法定位。这里把「查了哪些位置、怎么修」写进
      // stderr 与日志，宿主日志里可以直接看到可执行的修复步骤。
      const message = err instanceof Error ? err.message : String(err);
      const lines = [
        `无法解析 Provider 凭据：${message}`,
        `  工作目录: ${process.cwd()}`,
        "  已查找的凭据来源: ./.fengagent/config.json、./.fengagent-cordis/config.json、~/.fengagent/config.json" +
          (process.env.FENG_CONFIG_FILE ? `、FENG_CONFIG_FILE=${process.env.FENG_CONFIG_FILE}` : ""),
        "  修复方式（任选其一）:",
        "    1) 在已配置好的项目目录执行 `fengagent runtime install`，" +
          "把项目凭据补齐到 ~/.fengagent/config.json（任意工作目录均可见）",
        "    2) 设置 FENG_CONFIG_FILE 指向凭据配置文件",
        "    3) 由宿主注入 Provider 环境变量（如 OPENAI_COMPATIBLE_API_KEY / OPENAI_COMPATIBLE_BASE_URL）",
      ];
      const hint = lines.join("\n");
      log.error("acp", hint);
      process.stderr.write(`Fatal: ${hint}\n`);
      process.exit(1);
    }
    const workdir = process.cwd();

    const hookRegistry = createHookRegistry();
    const permissionChecker = createPermissionChecker(workdir);

    function createAcpAgent(): InstanceType<typeof Agent> {
      const toolRegistry = createToolRegistry();
      registerBuiltinTools(toolRegistry);

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
        // ACP 路径同样禁用 AGENTS.md 注入（与对话卡死修复一致，防止运行时指令注入系统提示）
        systemContextOptions: { workdir, loadAgentsMd: false },
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

    startAcpServer({ config, createAgent: createAcpAgent });
    return;
  }

  // runtime 子命令 — 注册/卸载 Multica 本地运行时（全局安装后 `fengagent runtime install`）
  if (parsed.runtime) {
    const {
      installRuntimeRegistration,
      uninstallRuntimeRegistration,
      runtimeRegistrationPath,
    } = await import("./runtime-install.ts");

    if (parsed.runtime === "install") {
      const { file, registration, credentials } = installRuntimeRegistration({
        seedGlobalConfig: !parsed.noGlobalConfig,
      });
      process.stdout.write(`FengAgentCli 已注册为 Multica 本地运行时：\n  ${file}\n`);
      process.stdout.write(
        `Multica 应能检测到 "${registration.displayName}" 运行时（launchHeader: ${registration.launchHeader}）。\n`,
      );
      if (credentials) {
        process.stdout.write(
          `\n已把项目级 Provider 凭据补齐到全局配置（${credentials.keys.length} 项）：\n` +
            `  ${credentials.path}\n` +
            "  用途：Multica 每次对话都在全新的空工作目录里拉起运行时，只有全局配置在任何工作目录都可见。\n",
        );
      } else if (!parsed.noGlobalConfig) {
        process.stdout.write(
          "\n未补齐全局配置：当前目录未找到项目级 .fengagent/config.json 凭据，" +
            "或全局配置中对应项已存在（保持不覆盖）。\n",
        );
      }
    } else {
      const file = uninstallRuntimeRegistration();
      if (file) {
        process.stdout.write(`已移除 Multica 运行时注册：\n  ${file}\n`);
      } else {
        process.stdout.write(`未找到运行时注册文件：${runtimeRegistrationPath()}\n`);
      }
    }
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
