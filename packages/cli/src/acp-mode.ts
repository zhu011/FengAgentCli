/**
 * @fengagent/cli — `fengagent acp` 模式装配
 *
 * 把 ACP 模式的全部装配（配置分层加载 → 凭据解析 → 工具/权限/上下文 → Agent 工厂
 * → 传输层）集中在这里，`entry.ts` 只负责路由，便于：
 *
 * - 宿主（Multica 守护进程）以子进程 + stdin/stdout 驱动（默认 stdio 传输）；
 * - 端到端测试注入内存流，用真实 Agent + 真实 LLM 跑通整条链路而不必 spawn 子进程
 *   （受限环境里子进程命名管道会被拒绝）。
 *
 * 传输层：
 * - `stdio`（默认）：换行分隔 JSON-RPC，stdout 专用于协议帧，日志走 stderr；
 * - `http`：监听 HTTP + SSE，供 WebUI / 人工调试（`--acp-http`）。
 */

import type { AgentEvent, Config } from "@fengagent/core";
import type { AcpFrameReader, AcpFrameWriter, AcpLogFn } from "@fengagent/server/acp-stdio";

/** ACP 模式选项 */
export interface AcpModeOptions {
  /** `true` = HTTP + SSE；默认 stdio JSON-RPC */
  http?: boolean;
  /** 注入的输入流（默认进程 stdin，即守护进程管道） */
  input?: AcpFrameReader;
  /** 注入的协议帧输出端（默认绕过 console 改道的原始 stdout） */
  output?: AcpFrameWriter;
  /** stdin EOF 后是否退出进程（默认：输入流就是进程 stdin 时退出） */
  exitOnClose?: boolean;
  /** 日志回调（默认写 stderr） */
  log?: AcpLogFn;
  /** 会话工作目录覆盖（HTTP 模式使用；stdio 模式用宿主给的 cwd） */
  workdir?: string;
}

/** ACP 模式启动结果 */
export interface AcpModeHandle {
  /** stdio 模式的连接句柄（HTTP 模式为 undefined） */
  connection?: { closed: Promise<void>; dispose(): void; sessionCount(): number };
  /** HTTP 模式的监听端口（stdio 模式为 undefined） */
  httpPort?: number;
  /** 已装配的运行时配置（诊断/测试用） */
  config: Config;
  /**
   * 建一个与 ACP 会话等价的 Agent（诊断/测试用）。
   *
   * 凭据缺失时抛错，错误文本含可执行修复步骤。
   */
  createAgent: (workdir: string) => unknown;
}

/**
 * 凭据缺失时的可执行修复指引。
 *
 * 宿主（Multica）只能看到「hermes initialize failed: hermes process exited」，
 * 无法定位，因此把「查了哪些位置、怎么修」写成人类可读文本。
 *
 * @param err - 原始错误
 * @param cwd - 当前工作目录（写进提示便于对照）
 * @returns 多行提示文本
 */
export function credentialHint(err: unknown, cwd: string = process.cwd()): string {
  const message = err instanceof Error ? err.message : String(err);
  return [
    `无法解析 Provider 凭据：${message}`,
    `  工作目录: ${cwd}`,
    "  已查找的凭据来源: ./.fengagent/config.json、./.fengagent-cordis/config.json、~/.fengagent/config.json" +
      (process.env.FENG_CONFIG_FILE ? `、FENG_CONFIG_FILE=${process.env.FENG_CONFIG_FILE}` : ""),
    "  修复方式（任选其一）:",
    "    1) 在已配置好的项目目录执行 `fengagent runtime install`，" +
      "把项目凭据补齐到 ~/.fengagent/config.json（任意工作目录均可见）",
    "    2) 设置 FENG_CONFIG_FILE 指向凭据配置文件",
    "    3) 由宿主注入 Provider 环境变量（如 OPENAI_COMPATIBLE_API_KEY / OPENAI_COMPATIBLE_BASE_URL）",
  ].join("\n");
}

/**
 * 装配并启动 ACP 模式。
 *
 * @param options - 模式选项
 * @returns 启动句柄（HTTP 模式端口 / stdio 模式连接）
 */
export async function startAcpMode(options: AcpModeOptions = {}): Promise<AcpModeHandle> {
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

  let llmClient: import("@fengagent/llm").LLMClient | undefined;
  let credentialError: string | undefined;
  try {
    llmClient = createClientFromEnv(envForLLM).client;
  } catch (err) {
    credentialError = credentialHint(err);
    process.stderr.write(`Fatal: ${credentialError}\n`);
    // HTTP 模式没有协议握手可承载错误，直接退出；stdio 模式改为让
    // session/new 返回带该文本的 JSON-RPC error —— 宿主会把原因原样透出，
    // 比「进程退出」可定位得多。
    if (options.http) {
      process.exit(1);
    }
  }

  const hookRegistry = createHookRegistry();

  /**
   * 每个 ACP 会话一份 Agent（与 HTTP ACP 的 per-session Agent 语义一致）。
   *
   * @param workdir - 宿主在 `session/new` 里给的会话工作目录
   * @returns Agent 实例
   */
  function createAcpAgent(workdir: string): InstanceType<typeof Agent> {
    if (!llmClient) {
      throw new Error(credentialError ?? "Provider 凭据不可用");
    }

    const toolRegistry = createToolRegistry();
    registerBuiltinTools(toolRegistry);

    // 权限配置按会话工作目录解析（.fengagent/permissions.json 是项目级配置）
    const permissionChecker = createPermissionChecker(workdir);
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

  if (options.http) {
    // 旧 HTTP + SSE 传输：监听端口并把真实端口打到 stdout 供人工/宿主发现
    const server = startAcpServer({
      config,
      createAgent: () => createAcpAgent(options.workdir ?? process.cwd()),
    });
    return { httpPort: server.port, config, createAgent: createAcpAgent };
  }

  const { startAcpStdioServer } = await import("@fengagent/server/acp-stdio");
  const { VERSION } = await import("./args.ts");
  const connection = startAcpStdioServer({
    createAgent: createAcpAgent,
    config,
    agentInfo: { name: "fengagent-acp", version: VERSION },
    ...(options.input ? { input: options.input } : {}),
    ...(options.output ? { output: options.output } : {}),
    ...(options.exitOnClose === undefined ? {} : { exitOnClose: options.exitOnClose }),
    ...(options.log ? { log: options.log } : {}),
  });

  return { connection, config, createAgent: createAcpAgent };
}

/** 仅供类型引用：把 AgentEvent 暴露给调用方做事件断言 */
export type { AgentEvent };
