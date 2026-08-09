/**
 * @fengagent/cli — Agent 实例工厂
 *
 * 从配置和环境变量创建完整的 Agent 实例，
 * 包含 LLM Client、工具注册表、执行器、上下文管理器、会话存储、
 * Agent 定义加载器、子 Agent 派遣器。
 */

import type { Agent } from "@fengagent/agent";
import type { Config, PartialConfig } from "@fengagent/core";
import { loadConfig } from "@fengagent/core";
import { createClientFromEnv } from "@fengagent/llm";
import type { LLMClient } from "@fengagent/llm";
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
import { expandTilde } from "@fengagent/shared";
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
  llmClient: LLMClient;
  sessionStore: SessionStore | null;
  agentDefinitionLoader: AgentDefinitionLoader;
  subagentRunner: SubagentRunner;
  /** Hook 注册器（用于注册 pre/post-tool-use、pre/post-compact 钩子） */
  hookRegistry: HookRegistry;
  /** MCP 注册结果（null = 未连接任何 MCP Server） */
  mcpResult: McpRegistrationResult | null;
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

  // 2. 创建 LLM Client
  const { client: llmClient } = createClientFromEnv(
    options.env ?? process.env,
  );

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
