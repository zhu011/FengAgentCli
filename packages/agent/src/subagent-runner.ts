/**
 * @fengagent/agent — 子 Agent 派遣实现
 *
 * 实现 SubagentRunner 接口：创建子会话、过滤工具、运行 Agent Loop、返回结果。
 * 子 Agent 不能调用 task 工具（防递归）。
 * 参考 ARCHITECTURE.md 第 3.4 节（多 Agent 数据流）。
 */

import type {
  Config,
  Session,
  AgentEvent,
  AgentInfo,
  SubagentParams,
  SubagentResult,
  SubagentRunner,
  ContentBlock,
} from "@fengagent/core";
import { createSession, createUserMessage } from "@fengagent/core";
import type { LLMClient } from "@fengagent/llm";
import type {
  ToolRegistry,
  ToolExecutor,
} from "@fengagent/tools";
import { createToolRegistry } from "@fengagent/tools";
import type { ContextManager } from "@fengagent/context";
import { createContextManager } from "@fengagent/context";
import { AgentLoop } from "./loop.ts";
import type { AgentLoopOptions } from "./loop.ts";
import type { AgentDefinitionLoader } from "./agent-definition.ts";
import { SUBAGENT_MAX_DEPTH } from "@fengagent/shared";
import { generateId } from "@fengagent/shared/utils";

// ──────────────────────────────────────────────
// SubagentRunner 创建器
// ──────────────────────────────────────────────

/** SubagentRunnerFactory 构造选项 */
export interface SubagentRunnerOptions {
  /** LLM 客户端 */
  llmClient: LLMClient;
  /** 父工具注册表（子 Agent 从中继承工具） */
  toolRegistry: ToolRegistry;
  /** 工具执行器 */
  toolExecutor: ToolExecutor;
  /** 父上下文管理器（子 Agent 继承其配置） */
  contextManager: ContextManager;
  /** 配置 */
  config: Config;
  /** 工作目录 */
  workdir: string;
  /** Agent 定义加载器 */
  agentDefinitionLoader: AgentDefinitionLoader;
  /** 最大嵌套深度 */
  maxDepth?: number;
}

/**
 * 创建子 Agent 派遣函数。
 *
 * 流程：
 * 1. 查找 Agent 定义（subagentType）
 * 2. 检查深度限制
 * 3. 创建子会话（使用 Agent 定义的 model / systemPrompt）
 * 4. 创建过滤后的工具注册表（排除 task 工具）
 * 5. 创建子上下文管理器（使用 Agent 定义的 systemPrompt）
 * 6. 运行 AgentLoop（前台阻塞）
 * 7. 收集最终文本输出
 * 8. 返回 SubagentResult
 *
 * @returns SubagentRunner 函数
 */
export function createSubagentRunner(
  options: SubagentRunnerOptions,
): SubagentRunner {
  const maxDepth = options.maxDepth ?? SUBAGENT_MAX_DEPTH;

  return async function spawnSubagent(
    params: SubagentParams,
  ): Promise<SubagentResult> {
    const taskId = params.taskId ?? generateId();

    // 1. 检查深度限制
    if (params.depth >= maxDepth) {
      return {
        taskId,
        sessionId: "",
        state: "error",
        text: `Subagent depth limit reached (${maxDepth}). Cannot spawn nested subagent.`,
        summary: `Depth limit exceeded`,
      };
    }

    // 2. 查找 Agent 定义
    const agentDef = options.agentDefinitionLoader.get(params.subagentType);
    if (!agentDef) {
      return {
        taskId,
        sessionId: "",
        state: "error",
        text: `Unknown agent type: "${params.subagentType}" is not a valid agent type. Available: ${options.agentDefinitionLoader.names().join(", ")}`,
        summary: `Unknown agent type`,
      };
    }

    // 3. 确定模型（Agent 定义为空则继承父配置）
    const model = agentDef.model || options.config.model;

    // 4. 创建子会话
    const session = createSession(model, params.description);
    session.messages.push(createUserMessage(params.prompt));

    // 5. 创建过滤后的工具注册表（排除 task 工具）
    const subToolRegistry = createFilteredToolRegistry(
      options.toolRegistry,
      agentDef,
    );

    // 6. 创建子上下文管理器
    const subContextManager = createContextManager({
      config: {
        contextWindow: options.config.contextWindow,
        compactThreshold: options.config.compactThreshold,
        compactKeepTokens: options.config.compactKeepTokens,
        disableCompact: options.config.disableCompact,
        smallModel: agentDef.smallModel ?? options.config.smallModel,
      },
      summaryGenerator: options.llmClient,
      systemContextOptions: {
        workdir: options.workdir,
        extraInstructions: agentDef.systemPrompt || undefined,
      },
    });

    // 7. 创建子 AgentLoop（注入 spawnSubagent 和递增的 depth）
    const childDepth = params.depth + 1;
    const loopOptions: AgentLoopOptions = {
      llmClient: options.llmClient,
      toolRegistry: subToolRegistry,
      toolExecutor: options.toolExecutor,
      contextManager: subContextManager,
      config: { ...options.config, maxTurns: agentDef.maxTurns },
      workdir: options.workdir,
      spawnSubagent, // 自引用 — 子 Agent 可以继续派遣（受深度限制）
      agentDepth: childDepth,
    };

    const loop = new AgentLoop(loopOptions);

    // 8. 运行 Agent Loop，收集事件
    let resultText = "";
    let hasError = false;
    let errorMessage = "";

    try {
      for await (const event of loop.run(session, {
        requestPermission: undefined, // 子 Agent 不支持交互式权限
      })) {
        const extracted = extractTextFromEvent(event);
        if (extracted.text) {
          resultText += extracted.text;
        }
        if (extracted.isError) {
          hasError = true;
          errorMessage = extracted.error;
        }
      }
    } catch (err) {
      hasError = true;
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    // 9. 从最终会话消息中提取文本（兜底：如果流式事件没有收集到）
    if (!resultText) {
      resultText = extractFinalText(session);
    }

    if (hasError) {
      return {
        taskId,
        sessionId: session.id,
        state: "error",
        text: errorMessage || resultText || "Subagent encountered an error",
        summary: `Subagent error: ${params.description}`,
      };
    }

    return {
      taskId,
      sessionId: session.id,
      state: "completed",
      text: resultText || "(subagent produced no output)",
      summary: `Task completed: ${params.description}`,
    };
  };
}

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

/**
 * 创建过滤后的工具注册表。
 * - 排除 task 工具（防递归）
 * - 如果 Agent 定义了 tools 列表，只包含列表中的工具
 */
function createFilteredToolRegistry(
  parentRegistry: ToolRegistry,
  agentDef: AgentInfo,
): ToolRegistry {
  const subRegistry = createToolRegistry();

  // 获取父注册表中的所有工具
  const allTools = parentRegistry.list();

  // 如果 Agent 定义了 tools 列表且非空，只包含列表中的工具
  const allowedSet =
    agentDef.tools.length > 0 ? new Set(agentDef.tools) : null;

  for (const tool of allTools) {
    // 始终排除 task 工具（防递归）
    if (tool.name === "task") continue;

    // 如果有白名单，只包含白名单中的工具
    if (allowedSet && !allowedSet.has(tool.name)) continue;

    subRegistry.register(tool);
  }

  return subRegistry;
}

/** 从 AgentEvent 中提取文本 */
function extractTextFromEvent(
  event: AgentEvent,
): { text: string; isError: boolean; error: string } {
  switch (event.type) {
    case "text-delta":
      return { text: event.text, isError: false, error: "" };
    case "error":
      return {
        text: "",
        isError: true,
        error: event.error.message,
      };
    default:
      return { text: "", isError: false, error: "" };
  }
}

/** 从会话消息中提取最后一条助手文本消息 */
function extractFinalText(session: Session): string {
  // 从后往前找最后一条 assistant 消息中的 text 块
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i]!;
    if (msg.role === "assistant") {
      const textBlocks = msg.content.filter(
        (c): c is ContentBlock & { type: "text"; text: string } =>
          c.type === "text",
      );
      if (textBlocks.length > 0) {
        return textBlocks.map((b) => b.text).join("");
      }
    }
  }
  return "";
}
