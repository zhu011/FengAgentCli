/**
 * @fengagent/server — createRuntime 装配的 Agent 工厂（Phase 2）
 *
 * 与 create-agent.ts 的旧式直接组装不同，本文件把 CLI `serve` 与 server 入口
 * 共用的 模型/工具/策略/存储/上下文/loop/图 全部经 createRuntime 插件化装配：
 * - ctx.model    — 模型服务（/model、/provider 经 ctx.model.switchProvider 切换）
 * - ctx.tools    — 工具服务
 * - ctx.storage  — 会话存储（SessionStore + GraphStore）
 * - ctx.context  — 上下文管理
 * - ctx.graph    — 对话可溯源 / 可回退
 * - ctx.loop     — agent loop 本身作为插件
 *
 * 行为与旧链路完全一致（薄适配既有实现），仅装配方式改为 Cordis 插件。
 */

import type { Agent } from "@fengagent/agent";
import {
  Agent as AgentClass,
  SessionStore,
  createAgentDefinitionLoader,
  createSubagentRunner,
} from "@fengagent/agent";
import type {
  Config,
  PartialConfig,
  Session,
  AgentEvent,
  ToolContext,
  SubagentRunner,
} from "@fengagent/core";
import { createSession, createUserMessage, loadConfig, ConfigSchema } from "@fengagent/core";
import type { LLMClient } from "@fengagent/llm";
import { createClientFromEnv, ReloadableLLMClient } from "@fengagent/llm";
import {
  createToolRegistry,
  registerBuiltinTools,
  createToolExecutor,
  createPermissionChecker,
  createHookRegistry,
  registerMcpTools,
} from "@fengagent/tools";
import type { HookRegistry, McpRegistrationResult, ToolRegistry } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import type { ContextManager } from "@fengagent/context";
import {
  deepMerge,
  importMainData,
  resolveDataRoot,
  writeSessionLog,
} from "@fengagent/shared";
// 注意：cordis/graph 携带 file:./vendor 依赖，bun 从其他 workspace 包按包名解析会失败，
// 因此此处用相对路径直接引用（tsconfig paths 对 tsc 同样生效）。
import { createRuntime } from "../../cordis/src/runtime.ts";
import { BUILTIN_PLUGINS } from "../../cordis/src/types.ts";
import type { FengRuntime, SessionStoreLike } from "../../cordis/src/types.ts";
import { MemoryGraphStore } from "../../graph/src/index.ts";
import type { ConversationNode } from "../../graph/src/types.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/* ------------------------------ 配置 → LLM 环境变量 ------------------------------ */

/** 将 Config 中的 Provider / API Key / BaseURL / Model 注入为 LLM 环境变量 */
export function buildEnvForLLM(
  config: Config,
  env?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const envForLLM: Record<string, string | undefined> = {
    ...env,
    ...process.env,
  };

  function injectConfigEnv(key: string, configVal: string | undefined) {
    if (configVal !== undefined && configVal !== "" && !envForLLM[key]) {
      envForLLM[key] = configVal;
    }
  }

  injectConfigEnv("FENG_PROVIDER", config.provider);
  injectConfigEnv("FENG_MODEL", config.model);
  injectConfigEnv("ANTHROPIC_API_KEY", config.anthropicApiKey);
  injectConfigEnv("ANTHROPIC_BASE_URL", config.anthropicBaseUrl);
  injectConfigEnv("OPENAI_API_KEY", config.openaiApiKey);
  injectConfigEnv("OPENAI_BASE_URL", config.openaiBaseUrl);
  injectConfigEnv("OPENAI_COMPATIBLE_API_KEY", config.openaiCompatibleApiKey);
  injectConfigEnv("OPENAI_COMPATIBLE_BASE_URL", config.openaiCompatibleBaseUrl);
  injectConfigEnv("OPENAI_COMPATIBLE_MODEL", config.openaiCompatibleModel);
  injectConfigEnv("GOOGLE_API_KEY", config.googleApiKey);
  injectConfigEnv("GOOGLE_BASE_URL", config.googleBaseUrl);

  return envForLLM;
}

/* ------------------------------ 热切换状态（/model、/provider 底座） ------------------------------ */

interface ReloadState {
  client: ReloadableLLMClient;
  config: Config;
  env?: Record<string, string | undefined>;
  runtime: FengRuntime | null;
}

let reloadState: ReloadState | null = null;

/**
 * 运行时替换 Provider / 模型（/provider set、/model 调用）。
 *
 * 有 runtime 时经 ctx.model.switchProvider 插件化切换（onSwitch 同步重建 client），
 * 无 runtime（单元测试直构 Agent）时回退到旧链路直接替换 ReloadableLLMClient。
 */
export function reloadProvider(patch: PartialConfig): Config | null {
  if (!reloadState) return null;
  const merged = deepMerge(
    { ...reloadState.config },
    patch as Record<string, unknown>,
  );
  const newConfig = ConfigSchema.parse(merged);
  // 先原地更新 config（onSwitch 读取最新值重建 client）
  Object.assign(reloadState.config, newConfig);

  const runtime = reloadState.runtime;
  if (runtime) {
    const model = runtime.ctx.model;
    if (model?.switchProvider) {
      // switchProvider 的 onSwitch 为同步实现，状态在返回前已落地
      void model.switchProvider(newConfig.provider, {
        model: newConfig.model,
      });
      return reloadState.config;
    }
  }

  // 旧链路：无 runtime（如直接构造 Agent 的测试）— 直接重建 client 并热替换
  const envForLLM = buildEnvForLLM(newConfig, reloadState.env);
  const { client } = createClientFromEnv(envForLLM);
  reloadState.client.setClient(client);
  return reloadState.config;
}

/* ------------------------------ Agent 创建选项 / 结果 ------------------------------ */

export interface CreateRuntimeAgentOptions {
  /** 命令行参数覆盖（最高优先级配置） */
  cliArgs?: PartialConfig;
  /** 自定义环境变量（默认 process.env） */
  env?: Record<string, string | undefined>;
  /** 工作目录（默认 process.cwd()） */
  workdir?: string;
  /** 是否启用会话持久化（默认 true） */
  enableSessionStore?: boolean;
}

export interface CreateRuntimeAgentResult {
  /** 运行时 Agent（与旧链路同接口：prompt/resume/compactSession/...） */
  agent: Agent;
  /** 构造新 Agent 实例的工厂（共享同一 runtime 的服务；server 每会话一个实例） */
  makeAgent: () => Agent;
  config: Config;
  llmClient: ReloadableLLMClient;
  sessionStore: SessionStore | null;
  agentDefinitionLoader: ReturnType<typeof createAgentDefinitionLoader>;
  subagentRunner: SubagentRunner;
  hookRegistry: HookRegistry;
  mcpResult: McpRegistrationResult | null;
  /** Cordis 运行时（Phase 3/4：server/WebUI 经 ctx.storage / ctx.graph 取数） */
  runtime: FengRuntime;
}

/** 简易内存会话存储（enableSessionStore=false 时兜底，避免插件落到磁盘） */
function createMemorySessionStore(): SessionStoreLike {
  const sessions = new Map<string, Session>();
  return {
    saveSession(s: Session) {
      sessions.set(s.id, s);
    },
    loadSession(id: string) {
      return sessions.get(id);
    },
    listSessions() {
      return [...sessions.values()];
    },
    deleteSession(id: string) {
      sessions.delete(id);
    },
  };
}

/**
 * 经 createRuntime 装配完整 Agent（模型/工具/上下文/存储/图/loop 全部走插件）。
 */
export async function createRuntimeAgent(
  options: CreateRuntimeAgentOptions = {},
): Promise<CreateRuntimeAgentResult> {
  const workdir = options.workdir ?? process.cwd();

  // 1. 加载配置
  const config = await loadConfig(options.cliArgs, { env: options.env });

  // 2. LLM Client（可热替换 — /model、/provider 底座）
  const envForLLM = buildEnvForLLM(config, options.env);
  const { client: baseClient } = createClientFromEnv(envForLLM);
  const llmClient = new ReloadableLLMClient(baseClient);

  // 3. 工具注册表 + 内置工具 + Hook + 权限 + 执行器
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  const hookRegistry = createHookRegistry();
  const permissionChecker = createPermissionChecker(workdir);
  const toolExecutor = createToolExecutor(permissionChecker, hookRegistry);

  // 4. MCP 集成（MCP 工具注册进同一 registry，走 ctx.tools）
  let mcpResult: McpRegistrationResult | null = null;
  try {
    mcpResult = await registerMcpTools(toolRegistry, workdir);
    if (mcpResult.connectedServers.length > 0) {
      process.stderr.write(
        `MCP: connected ${mcpResult.connectedServers.length} server(s), ` +
        `registered ${mcpResult.toolCount} tool(s)\n`,
      );
    }
    if (mcpResult.failedServers.length > 0) {
      for (const fail of mcpResult.failedServers) {
        process.stderr.write(`MCP: failed to connect "${fail.name}": ${fail.error}\n`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`MCP: initialization error: ${message}\n`);
  }

  // 5. 上下文管理器（走 ctx.context 插件）
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

  // 6. 会话存储 + 图存储（走 ctx.storage / ctx.graph 插件）
  //    数据根隔离：resolveDataRoot（FENG_DATA_DIR > 配置 dataDir > workdir/.fengagent-cordis）
  let sessionStore: SessionStore | null = null;
  const enableStore = options.enableSessionStore ?? true;
  const dataDir = resolveDataRoot({
    workdir,
    env: options.env,
    configDataDir: config.dataDir,
  });
  if (enableStore) {
    // 首次运行单向幂等导入 main 遗留数据（只读 main、import.marker 去重、自环防护）
    importMainData({ workdir, env: options.env, configDataDir: config.dataDir });
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch {
      // 目录可能已存在或无法创建 — 忽略
    }
    sessionStore = new SessionStore(`${dataDir}/sessions.db`);
  }
  const storageBackend: SessionStoreLike = sessionStore ?? createMemorySessionStore();
  const graphStore = new MemoryGraphStore({
    persistPath: join(dataDir, "graph.jsonl"),
  });

  // 7. Agent 定义加载器 + 子 Agent 派遣器
  const agentDefinitionLoader = createAgentDefinitionLoader({
    workdir,
    config: {
      model: config.model,
      smallModel: config.smallModel,
      maxTurns: config.maxTurns,
    },
  });
  await agentDefinitionLoader.load();

  const subagentRunner = createSubagentRunner({
    llmClient,
    toolRegistry,
    toolExecutor,
    contextManager,
    config,
    workdir,
    agentDefinitionLoader,
  });

  // 8. createRuntime 插件化装配（依赖注入顺序无关，fiber 自动等待）
  const runtime = createRuntime({
    workdir,
    plugins: [
      {
        id: BUILTIN_PLUGINS.MODEL,
        config: {
          provider: config.provider,
          model: config.model,
          client: llmClient,
          onSwitch: () => {
            // /model、/provider 经 ctx.model.switchProvider → 此回调重建 client
            const st = reloadState;
            if (!st) {
              throw new Error("reloadState not ready");
            }
            const env = buildEnvForLLM(st.config, st.env);
            const { client } = createClientFromEnv(env);
            return client;
          },
        },
      },
      { id: BUILTIN_PLUGINS.TOOLS, config: { registry: toolRegistry } },
      {
        id: BUILTIN_PLUGINS.STRATEGY,
        config: {
          contextWindow: config.contextWindow,
          compactThreshold: config.compactThreshold,
        },
      },
      { id: BUILTIN_PLUGINS.CONTEXT, config: { manager: contextManager } },
      {
        id: BUILTIN_PLUGINS.STORAGE,
        config: { sessionStore: storageBackend, graph: graphStore },
      },
      { id: BUILTIN_PLUGINS.GRAPH, config: { store: graphStore } },
      // Phase 1：事件日志服务（写路径/重放/自愈，事件落 <dataDir>/events）
      { id: BUILTIN_PLUGINS.EVENTS, config: { dir: join(dataDir, "events") } },
      {
        id: BUILTIN_PLUGINS.LOOP,
        config: {
          config: {
            maxTurns: config.maxTurns,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
          },
          workdir,
          spawnSubagent: subagentRunner,
          agentDepth: 0,
        },
      },
    ],
  });

  await runtime.start();

  // 记录 reload 状态（供 reloadProvider / onSwitch 使用）
  reloadState = { client: llmClient, config, env: options.env, runtime };

  function makeAgent(): Agent {
    return new RuntimeAgent(runtime, config, {
      llmClient,
      toolRegistry,
      toolExecutor,
      contextManager,
      workdir,
      sessionStore: sessionStore ?? undefined,
      subagentRunner,
    });
  }

  const agent = makeAgent();
  return {
    agent,
    makeAgent,
    config,
    llmClient,
    sessionStore,
    agentDefinitionLoader,
    subagentRunner,
    hookRegistry,
    mcpResult,
    runtime,
  };
}

/* ------------------------------ 运行时 Agent（CLI/Server 共用） ------------------------------ */

interface RuntimeAgentServices {
  llmClient: LLMClient;
  toolRegistry: ToolRegistry;
  toolExecutor: ReturnType<typeof createToolExecutor>;
  contextManager: ContextManager;
  workdir: string;
  sessionStore?: SessionStore;
  subagentRunner?: SubagentRunner;
}

/**
 * 运行时 Agent — 继承既有 Agent 的全部接口（结构性兼容），
 * 但 prompt 走 ctx.loop（对话即节点，可溯源），持久化走 ctx.storage。
 */
export class RuntimeAgent extends AgentClass {
  private readonly runtime: FengRuntime;
  private readonly cfg: Config;

  constructor(runtime: FengRuntime, config: Config, services: RuntimeAgentServices) {
    super({
      llmClient: services.llmClient,
      toolRegistry: services.toolRegistry,
      toolExecutor: services.toolExecutor,
      contextManager: services.contextManager,
      config,
      workdir: services.workdir,
      sessionStore: services.sessionStore,
      spawnSubagent: services.subagentRunner,
      agentDepth: 0,
    });
    this.runtime = runtime;
    this.cfg = config;
  }

  /** 访问 Cordis 根上下文（ctx.model / ctx.tools / ctx.storage / ctx.graph / ctx.loop） */
  getRuntime(): FengRuntime {
    return this.runtime;
  }

  /** 加载会话 — 经 ctx.storage（存储插件） */
  override loadSession(sessionId: string): Session | null {
    const loaded = this.runtime.ctx.storage.loadSession(sessionId);
    return loaded ?? null;
  }

  /** 列出会话 — 经 ctx.storage（存储插件） */
  override listSessions() {
    return this.runtime.ctx.storage.listSessions();
  }

  /** 发送用户消息并运行 Agent Loop（经 ctx.loop，对话沉淀为图节点） */
  override async *prompt(
    text: string,
    session?: Session,
    options?: { requestPermission?: ToolContext["requestPermission"] },
  ): AsyncGenerator<AgentEvent> {
    const ctx = this.runtime.ctx;
    const sess = session ?? createSession(this.cfg.model);
    sess.status = "running";

    const userMsg = createUserMessage(text);
    sess.messages.push(userMsg);
    sess.updatedAt = Date.now();

    writeSessionLog({
      timestamp: new Date().toISOString(),
      sessionId: sess.id,
      messageId: userMsg.id,
      role: "user",
      content: userMsg.content,
      model: sess.model,
      hasToolCalls: false,
    });

    // 持久化走 ctx.storage（存储插件）
    ctx.storage.saveSession(sess);
    ctx.storage.saveMessage?.(sess.id, userMsg);

    yield { type: "session-start", session: sess };

    // Agent Loop 本身是插件：经 ctx.loop.run（内部薄适配既有 AgentLoop + 对话即节点）
    for await (const event of ctx.loop.run(sess, options)) {
      if (event.type === "message-end") {
        const assistantMsg = sess.messages.find((m) => m.id === event.messageId);
        if (assistantMsg) {
          const toolCalls = assistantMsg.content
            .filter((b) => b.type === "tool-use")
            .map((b): { name: string; input: unknown } => {
              if (b.type === "tool-use") return { name: b.name, input: b.input };
              return { name: "", input: null };
            });
          writeSessionLog({
            timestamp: new Date().toISOString(),
            sessionId: sess.id,
            messageId: assistantMsg.id,
            role: "assistant",
            content: assistantMsg.content.map((b) => {
              if (b.type === "text") return { type: "text", text: b.text.slice(0, 500) };
              if (b.type === "tool-use") return { type: "tool-use", name: b.name };
              if (b.type === "tool-result") return { type: "tool-result", toolUseId: b.toolUseId };
              return { type: b.type };
            }),
            model: sess.model,
            hasToolCalls: toolCalls.length > 0,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            tokenCount: sess.tokenCount,
          });
        }
      }
      yield event as unknown as AgentEvent;
    }

    // 会话收尾：置 idle + 持久化（经 ctx.storage）
    sess.status = "idle";
    sess.updatedAt = Date.now();
    ctx.storage.saveSession(sess);
    ctx.storage.saveMessages?.(sess.id, sess.messages);

    yield { type: "session-end" };
  }

  /* ------------------------------ 图 / 回退（Phase 4 底座） ------------------------------ */

  /** 会话图数据（节点 + 活跃路径 + 溯源链），供 /graph 与 WebUI 可视化 */
  getGraphData(sessionId: string): {
    nodes: ConversationNode[];
    activePath: ConversationNode[];
    activeHead: ConversationNode | undefined;
    chain: ConversationNode[];
  } {
    const ctx = this.runtime.ctx;
    const nodes = ctx.graph.listNodes(sessionId);
    const activePath = ctx.graph.getActivePath(sessionId);
    const activeHead = ctx.graph.getActiveHead(sessionId);
    const chain = activeHead ? ctx.graph.getChain(activeHead.id) : [];
    return { nodes, activePath, activeHead, chain };
  }

  /** /graph 文本摘要（CLI 展示用） */
  formatGraph(sessionId: string): string {
    const { nodes, activePath, activeHead } = this.getGraphData(sessionId);
    if (nodes.length === 0) {
      return "当前会话还没有图节点（发一条消息后生成）。";
    }
    const typeIcon: Record<string, string> = {
      user: "🧑",
      assistant: "🤖",
      tool: "🔧",
      "branch-point": "🔀",
    };
    const lines: string[] = [
      `对话图节点 (${nodes.length}) — 活跃路径 ${activePath.length} 个节点:`,
    ];
    const activeIds = new Set(activePath.map((n) => n.id));
    for (const node of nodes) {
      const icon = typeIcon[node.type] ?? "•";
      const activeMark = activeIds.has(node.id)
        ? node.id === activeHead?.id
          ? " ← head"
          : " (active)"
        : " (rolled-back)";
      const quality =
        node.meta.quality && node.meta.quality !== "unrated"
          ? ` quality=${node.meta.quality}`
          : "";
      lines.push(
        `  ${icon} ${node.id.slice(0, 12)}  type=${node.type}  msg=${node.messageId.slice(0, 8)}${quality}${activeMark}`,
      );
    }
    if (activeHead) {
      const chain = this.getGraphData(sessionId).chain;
      lines.push("");
      lines.push(
        `溯源链 (${chain.length}): ${chain.map((n) => n.id.slice(0, 8)).join(" → ")}`,
      );
    }
    lines.push("");
    lines.push(
      "提示: /rollback <节点id> 回退到该节点的父节点并重答（旧分支保留可溯源）。",
    );
    return lines.join("\n");
  }

  /**
   * 回退到目标节点（/rollback 底座，同步完成）。
   *
   * 语义：assistant 节点 → 回退到其父节点（用户提问处）；user/branch-point → 回退到该节点。
   * 旧分支作废但保留（不可变历史）；会话消息截断到回退点。
   *
   * @returns 回退结果；失败时 ok=false
   */
  rollback(
    session: Session,
    nodeId?: string,
    reason = "用户回退",
  ): {
    ok: boolean;
    message: string;
    target?: ConversationNode;
    rollbackToNode?: ConversationNode;
    truncatedToMessageId?: string;
  } {
    const ctx = this.runtime.ctx;
    let target: ConversationNode | undefined;
    if (nodeId) {
      target = ctx.graph.getNode(nodeId);
      if (!target || target.conversationId !== session.id) {
        return { ok: false, message: `节点 ${nodeId} 不存在或不属于当前会话。` };
      }
    } else {
      // 未指定 → 取活跃路径上最后一个 assistant 节点
      const active = ctx.graph.getActivePath(session.id);
      target = [...active].reverse().find((n) => n.type === "assistant");
      if (!target) {
        return { ok: false, message: "没有可回退的助手回答节点（先对话一轮）。" };
      }
    }

    // 决定回退点：assistant/tool → 父节点（用户提问处）；user/branch-point → 自身
    const rollbackTargetId =
      target.type === "assistant" || target.type === "tool"
        ? target.parentId
        : target.id;
    if (!rollbackTargetId) {
      return { ok: false, message: "该节点没有父节点可回退。" };
    }

    ctx.graph.store.markQuality(target.id, "poor", reason);
    const result = ctx.graph.store.rollbackTo(rollbackTargetId, reason);
    if (!result) {
      return { ok: false, message: "回退失败：目标节点不在活跃路径上。" };
    }

    // 会话消息截断到回退点（保留回退点消息，其后的消息移除）
    let truncatedToMessageId: string | undefined;
    const keepUntil = result.target.messageId;
    const idx = session.messages.findIndex((m) => m.id === keepUntil);
    if (idx !== -1) {
      session.messages = session.messages.slice(0, idx + 1);
      session.tokenCount = ctx.context.estimateTokens(session.messages);
      session.updatedAt = Date.now();
      truncatedToMessageId = keepUntil;
      ctx.storage.saveSession(session);
      ctx.storage.saveMessages?.(session.id, session.messages);
    }

    return {
      ok: true,
      message:
        `已回退到节点 ${result.target.id.slice(0, 12)}（${result.target.type}）` +
        `，作废旧分支 ${result.superseded.length} 个节点（保留可溯源），` +
        (truncatedToMessageId
          ? "会话已截断，正在重答。"
          : "会话未找到对应消息，请手动重发。"),
      target,
      rollbackToNode: result.target,
      truncatedToMessageId,
    };
  }

  /**
   * 回退到父节点并自动重答（CLI /rollback 完整链路，Phase 4）。
   *
   * 1) 回退（旧分支作废保留）→ 2) 会话截断 → 3) 经 ctx.loop 重新回答。
   * 新的回答以 branch-point 为父节点长出分支（可溯源）。
   */
  async *rollbackAndRetry(
    session: Session,
    nodeId?: string,
    reason = "用户回退",
    options?: { requestPermission?: ToolContext["requestPermission"] },
  ): AsyncGenerator<AgentEvent> {
    const ctx = this.runtime.ctx;
    const rb = this.rollback(session, nodeId, reason);
    if (!rb.ok) {
      yield { type: "error", error: { message: rb.message } };
      return;
    }

    yield { type: "session-start", session };

    for await (const event of ctx.loop.run(session, options)) {
      yield event as unknown as AgentEvent;
    }

    session.status = "idle";
    session.updatedAt = Date.now();
    ctx.storage.saveSession(session);
    ctx.storage.saveMessages?.(session.id, session.messages);
    yield { type: "session-end" };
  }
}
