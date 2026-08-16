/**
 * @fengagent/cli — Agent 实例工厂（Phase 2：经 createRuntime 插件化装配）
 *
 * 本文件保留旧接口（createAgent / reloadProvider / buildEnvForLLM），
 * 实现已迁移到 @fengagent/server 的 create-runtime-agent.ts（CLI 与 server 共用同一装配）：
 * 模型/工具/策略/存储/上下文/loop/图 全部经 createRuntime 插件化装配，
 * 行为与旧链路一致（薄适配既有实现），/model、/provider 经 ctx.model.switchProvider 切换。
 */

import type { Agent } from "@fengagent/agent";
import type { Config, PartialConfig } from "@fengagent/core";
import { createRuntimeAgent } from "@fengagent/server";
import type { CreateRuntimeAgentResult } from "@fengagent/server";

export { reloadProvider, buildEnvForLLM } from "@fengagent/server";
export type {
  CreateRuntimeAgentOptions,
  CreateRuntimeAgentResult,
} from "@fengagent/server";
export { RuntimeAgent } from "@fengagent/server";

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

/** Agent 创建结果（与旧链路字段一致） */
export interface CreateAgentResult {
  agent: Agent;
  config: Config;
  /** 可热替换的 LLM Client（/provider set 时通过 setClient 切换底层客户端） */
  llmClient: import("@fengagent/llm").ReloadableLLMClient;
  sessionStore: import("@fengagent/agent").SessionStore | null;
  agentDefinitionLoader: CreateRuntimeAgentResult["agentDefinitionLoader"];
  subagentRunner: import("@fengagent/core").SubagentRunner;
  /** Hook 注册器（用于注册 pre/post-tool-use、pre/post-compact 钩子） */
  hookRegistry: import("@fengagent/tools").HookRegistry;
  /** MCP 注册结果（null = 未连接任何 MCP Server） */
  mcpResult: import("@fengagent/tools").McpRegistrationResult | null;
}

/**
 * 创建完整的 Agent 实例。
 *
 * 经 createRuntime 插件化装配：
 * 1. 加载配置（分层合并：默认值 → 全局 → 项目 → 环境变量 → CLI 参数）
 * 2. ctx.model — LLM 模型服务（ReloadableLLMClient 热替换）
 * 3. ctx.tools — 工具注册表 + 内置工具 + MCP
 * 4. ctx.context — 上下文管理器
 * 5. ctx.storage — 会话存储（SQLite）+ 图存储（JSONL）
 * 6. ctx.graph / ctx.loop — 对话即节点 + agent loop 插件
 */
export async function createAgent(
  options: CreateAgentOptions = {},
): Promise<CreateAgentResult> {
  const result = await createRuntimeAgent(options);
  return {
    agent: result.agent,
    config: result.config,
    llmClient: result.llmClient,
    sessionStore: result.sessionStore,
    agentDefinitionLoader: result.agentDefinitionLoader,
    subagentRunner: result.subagentRunner,
    hookRegistry: result.hookRegistry,
    mcpResult: result.mcpResult,
  };
}
