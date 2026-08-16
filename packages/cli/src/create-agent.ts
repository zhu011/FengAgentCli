/**
 * @fengagent/cli — Agent 实例工厂
 *
 * 从配置和环境变量创建完整的 Agent 实例，
 * 包含 LLM Client、工具注册表、执行器、上下文管理器、会话存储、
 * Agent 定义加载器、子 Agent 派遣器。
 */

import type { Agent } from "@fengagent/agent";
import type { Config, PartialConfig } from "@fengagent/core";
import { loadConfig, ConfigSchema } from "@fengagent/core";
import {
  createClientFromEnv,
  ReloadableLLMClient,
} from "@fengagent/llm";
import {
  createToolRegistry,
  registerBuiltinTools,
  createToolExecutor,
  createPermissionChecker,
  createHookRegistry,
  registerMcpTools,
} from "@fengagent/tools";
import type { HookRegistry, McpRegistrationResult } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { deepMerge, expandTilde } from "@fengagent/shared";
import {
  Agent as AgentClass,
  SessionStore,
  createAgentDefinitionLoader,
  createSubagentRunner,
} from "@fengagent/agent";
import type {
  AgentDefinitionLoader,
} from "@fengagent/agent";
import type { SubagentRunner } from "@fengagent/core";
import { mkdirSync } from "node:fs";

/** Agent 创建选项 */
export interface CreateAgentOptions {
  /** 命令行参数覆盖（最高优先级配置） */
  cliArgs?: PartialConfig;
  /** 自定义环境变量（默认 process.env） */
  env?: Record<string, string | undefined>;
  /** 工作目录（默认 process.cwd()） */
  workdir?: string;
  /** 是否启用会话持久化（默认 true） */
  enableSessionStore?: boolean;
}

/** Agent 创建结果 */
export interface CreateAgentResult {
  agent: Agent;
  config: Config;
  /** 可热替换的 LLM Client（/provider set 时通过 setClient 切换底层客户端） */
  llmClient: ReloadableLLMClient;
  sessionStore: SessionStore | null;
  agentDefinitionLoader: AgentDefinitionLoader;
  subagentRunner: SubagentRunner;
  /** Hook 注册器（用于注册 pre/post-tool-use、pre/post-compact 钩子） */
  hookRegistry: HookRegistry;
  /** MCP 注册结果（null = 未连接任何 MCP Server） */
  mcpResult: McpRegistrationResult | null;
}

/**
 * 将 Config 中的 Provider / API Key / BaseURL / Model 注入为 LLM 环境变量，
 * 供 createClientFromEnv 使用（环境变量优先，config 值仅作兜底）。
 */
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

// ──────────────────────────────────────────────
// 运行时 Provider 热替换（/provider 命令）
// ──────────────────────────────────────────────

/** 当前生效的可热替换 LLM Client（由 createAgent 建立，供 reloadProvider 使用） */
interface ReloadState {
  client: ReloadableLLMClient;
  config: Config;
  env?: Record<string, string | undefined>;
}

let reloadState: ReloadState | null = null;

/**
 * 运行时替换 Provider（/provider set 调用）。
 *
 * 机制：
 * 1. 将配置补丁合并进当前生效 Config（保留未改动键）并经 ConfigSchema 重新校验
 * 2. 用新配置重建 LLM Client（createClientFromEnv）
 * 3. 通过 ReloadableLLMClient.setClient 原子替换 — Agent 持有的 client 引用不变，
 *    后续请求自动走新 Provider / Key / BaseURL / Model，无需重建 Agent
 * 4. 原地更新 Config 对象（Agent 持有同一引用，getConfig()/createSession 立即反映新值）
 *
 * @param patch - Provider 配置补丁（provider / *ApiKey / *BaseUrl / model 等）
 * @returns 更新后的 Config；若 createAgent 尚未建立 reload 状态（如单元测试直接构造 Agent）则返回 null
 */
export function reloadProvider(patch: PartialConfig): Config | null {
  if (!reloadState) {
    return null;
  }
  const merged = deepMerge(
    { ...reloadState.config },
    patch as Record<string, unknown>,
  );
  const newConfig = ConfigSchema.parse(merged);
  const envForLLM = buildEnvForLLM(newConfig, reloadState.env);
  const { client } = createClientFromEnv(envForLLM);
  reloadState.client.setClient(client);
  Object.assign(reloadState.config, newConfig);
  return reloadState.config;
}

/**
 * 创建完整的 Agent 实例。
 *
 * 组装流程：
 * 1. 加载配置（分层合并：默认值 → 全局 → 项目 → 环境变量 → CLI 参数）
 * 2. 从环境变量创建 LLM Client
 * 3. 创建工具注册表并注册内置工具
 * 4. 创建工具执行器
 * 5. 创建上下文管理器（使用 LLM Client 作为摘要生成器）
 * 6. 创建会话存储（SQLite）
 * 7. 组装 Agent
 */
export async function createAgent(
  options: CreateAgentOptions = {},
): Promise<CreateAgentResult> {
  const workdir = options.workdir ?? process.cwd();

  // 1. 加载配置
  const config = await loadConfig(options.cliArgs, {
    env: options.env,
  });

  // 2. 创建 LLM Client（将 config 中的 provider/model/API key 注入到 env）
  const envForLLM = buildEnvForLLM(config, options.env);

  const { client: baseClient } = createClientFromEnv(envForLLM);

  // 用可热替换包装器持有客户端 — /provider set 时无需重建 Agent 即可切换 Provider
  const llmClient = new ReloadableLLMClient(baseClient);

  // 记录 reload 状态（供 reloadProvider 在运行时替换 client / 更新 config）
  reloadState = { client: llmClient, config, env: options.env };

  // 3. 工具注册表 + 内置工具
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);

  // 4. Hook 注册器 + 权限检查器 + 工具执行器
  const hookRegistry = createHookRegistry();
  const permissionChecker = createPermissionChecker(workdir);
  const toolExecutor = createToolExecutor(permissionChecker, hookRegistry);

  // 5. MCP 集成 — 连接配置的 MCP Server，发现并注册工具
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

  // 6. 上下文管理器
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

  // 7. 会话存储
  let sessionStore: SessionStore | null = null;
  const enableStore = options.enableSessionStore ?? true;
  if (enableStore) {
    const dataDir = expandTilde(config.dataDir);
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch {
      // 目录可能已存在或无法创建 — 忽略，SessionStore 构造会抛出
    }
    sessionStore = new SessionStore(`${dataDir}/sessions.db`);
  }

  // 8. Agent 定义加载器
  const agentDefinitionLoader = createAgentDefinitionLoader({
    workdir,
    config: {
      model: config.model,
      smallModel: config.smallModel,
      maxTurns: config.maxTurns,
    },
  });
  await agentDefinitionLoader.load();

  // 9. 子 Agent 派遣器
  const subagentRunner = createSubagentRunner({
    llmClient,
    toolRegistry,
    toolExecutor,
    contextManager,
    config,
    workdir,
    agentDefinitionLoader,
  });

  // 10. 组装 Agent（注入 subagentRunner，agentDepth 默认 0 = 顶层）
  const agent = new AgentClass({
    llmClient,
    toolRegistry,
    toolExecutor,
    contextManager,
    config,
    workdir,
    sessionStore: sessionStore ?? undefined,
    spawnSubagent: subagentRunner,
    agentDepth: 0,
  });

  return { agent, config, llmClient, sessionStore, agentDefinitionLoader, subagentRunner, hookRegistry, mcpResult };
}
