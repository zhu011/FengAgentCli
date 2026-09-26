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

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, Config } from "@fengagent/core";
import type { AcpFrameReader, AcpFrameWriter, AcpLogFn } from "@fengagent/server/acp-stdio";

/**
 * ACP 路径「需要审批但宿主没有回调」时的兜底策略。
 *
 * 为什么是 `allow`：Multica 守护进程把 `fengagent acp` 当运行时子进程拉起，
 * 会话由用户在界面上发起、工作目录是该任务的独立 workdir —— 等价于宿主预授权。
 * 正常路径上审批走 ACP 权限桥（`session/request_permission`，见 acp-stdio），
 * 这里只是「宿主没回/不支持」时的兜底：不把 ask 类工具（bash 等）判成不可恢复
 * 而中断整轮对话（AGE-29 现场）。
 */
const ACP_UNATTENDED_PERMISSION_POLICY = "allow" as const;

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

/** 一次会话装配的结果（Agent + 会话） */
interface AcpSessionEntry {
  agent: InstanceType<typeof import("@fengagent/agent").Agent>;
  session: import("@fengagent/core").Session;
}

/** ACP 会话服务（`session/new` 与 `session/resume` 的公共装配） */
interface AcpSessionService {
  /** 新建一个会话（消息由 Agent 在 prompt 时写进同一份会话库） */
  createSession(workdir: string): AcpSessionEntry;
  /** 按宿主持有的 id 恢复会话（未命中则同 id 空会话） */
  resumeSession(workdir: string, sessionId: string): AcpSessionEntry;
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
  const { loadConfig, createSession: createSessionFactory } = await import("@fengagent/core");
  const { Agent, SessionStore } = await import("@fengagent/agent");
  const { resolveSessionStoreRoot } = await import("@fengagent/shared");
  const { createClientFromEnv } = await import("@fengagent/llm");
  const {
    createToolRegistry,
    registerBuiltinTools,
    createToolExecutor,
    createPermissionChecker,
    createHookRegistry,
  } = await import("@fengagent/tools");
  const { createContextManager } = await import("@fengagent/context");
  const { startAcpServer } = await import("@fengagent/server");

  // 与 TUI/serve 路径一致：分层加载配置（默认值 → 全局 ~/.fengagent/config.json
  // → 项目 .fengagent/config.json → 分支 .fengagent-cordis/config.json → FENG_* 环境变量），
  // 再把配置文件中的 API Key / BaseURL / Model 注入为 LLM 环境变量（main 的 injectConfigEnv 方式）。
  const config = await loadConfig();
  const envForLLM: Record<string, string | undefined> = { ...process.env };
  function injectConfigEnv(key: string, configVal: string | undefined) {
    if (configVal !== undefined && configVal !== "" && !envForLLM[key]) {
      envForLLM[key] = configVal;
    }
  }
  injectConfigEnv("FENG_PROVIDER", config.provider);
  injectConfigEnv("FENG_MODEL", config.model);
  injectConfigEnv("ANTHROPIC_API_KEY", config.anthropicApiKey);
  injectConfigEnv("OPENAI_API_KEY", config.openaiApiKey);
  injectConfigEnv("OPENAI_COMPATIBLE_API_KEY", config.openaiCompatibleApiKey);
  injectConfigEnv("OPENAI_COMPATIBLE_BASE_URL", config.openaiCompatibleBaseUrl);
  injectConfigEnv("OPENAI_COMPATIBLE_MODEL", config.openaiCompatibleModel);

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

  // ── 会话库（跨进程续聊的落盘基座）──────────────────────────────────
  // 必须在 `createAcpAgent` 之前建好：Agent 要拿到同一个 `SessionStore` 才会把
  // 每轮消息写进库，`session/resume` 才有东西可读 —— 只建会话行、不写消息，
  // 续聊就变成「成功但失忆」。
  const stores = new Map<string, InstanceType<typeof SessionStore>>();

  /**
   * 取该 workdir 的会话库（按 workdir 缓存：进程级单写者，避免多连接互锁）。
   *
   * 数据根优先级：守护进程指定的会话仓（`MULTICA_DSH_SESSION_ROOT`）> `FENG_DATA_DIR`
   * > `<workdir>/.fengagent-cordis`（存在时）> `<workdir>/.fengagent`。前者是 Multica
   * 守护进程判定 `session_home_reachable` / `resume_reachable` 的依据：会话库不落在
   * 它指定的仓里，下一轮守护进程就会丢掉前会话，`session/resume` 永远走不到
   * （AGE-29 的 A 项欠账）。
   *
   * @param workdir - 会话工作目录（宿主在 `session/new` / `session/resume` 里给的 cwd）
   * @returns 会话库；打不开（磁盘/权限/被占用）时返回 undefined，退回「不持久化但能对话」
   */
  function storeFor(workdir: string): InstanceType<typeof SessionStore> | undefined {
    const cached = stores.get(workdir);
    if (cached) return cached;
    try {
      const dataRoot = resolveSessionStoreRoot({ workdir });
      mkdirSync(dataRoot, { recursive: true });
      const store = new SessionStore(join(dataRoot, "sessions.db"));
      stores.set(workdir, store);
      return store;
    } catch (err) {
      process.stderr.write(
        `Fatal: 会话库不可用（${workdir}）：${err instanceof Error ? err.message : String(err)}\n`,
      );
      return undefined;
    }
  }

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
    const permissionChecker = createPermissionChecker(workdir, undefined, {
      unattendedPermissionPolicy: ACP_UNATTENDED_PERMISSION_POLICY,
    });
    const toolExecutor = createToolExecutor(permissionChecker, hookRegistry, {
      unattendedPermissionPolicy: ACP_UNATTENDED_PERMISSION_POLICY,
    });
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
    const sessionStore = storeFor(workdir);
    return new Agent({
      llmClient,
      toolRegistry,
      toolExecutor,
      contextManager,
      config,
      workdir,
      // 传了才会持久化：每轮消息落盘是「下一个进程还能续聊」的唯一依据
      ...(sessionStore ? { sessionStore } : {}),
    });
  }

  /**
   * ACP 会话服务：`session/new` 与 `session/resume` 共用同一份会话库。
   *
   * - `createSession`：新建会话，Agent 在 prompt 时把消息写进同一份库；
   * - `resumeSession`：按宿主持有的 id 恢复；未命中则用**同一个 id** 建空会话，
   *   仍让这一轮 prompt 跑完（不把「历史丢了」升级成「对话失败」）并留痕 stderr。
   */
  const sessionService: AcpSessionService = {
    createSession(workdir: string): AcpSessionEntry {
      return { agent: createAcpAgent(workdir), session: createSessionFactory(config.model) };
    },
    resumeSession(workdir: string, sessionId: string): AcpSessionEntry {
      const agent = createAcpAgent(workdir);
      const restored = storeFor(workdir)?.loadSession(sessionId);
      if (restored) return { agent, session: restored };
      process.stderr.write(
        `[fengagent-acp] 会话 ${sessionId} 无落盘记录，按同 id 新建空会话续聊（cwd=${workdir}）\n`,
      );
      const session = createSessionFactory(config.model);
      session.id = sessionId;
      return { agent, session };
    },
  };

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
    createSessionEntry: (workdir) => sessionService.createSession(workdir),
    resumeAgent: (workdir, sessionId) => sessionService.resumeSession(workdir, sessionId),
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
