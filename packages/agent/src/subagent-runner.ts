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
import type { SessionStore } from "./session.ts";
import type { TaskStore } from "./task-store.ts";
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
  /**
   * 会话仓（注入后子 Agent 会话落盘，`task_id` 才真正可跨进程恢复）。
   *
   * 未注入时子 Agent 仍是纯内存会话：此时 `task_id` 只在**同一次进程内**
   * 能找回，跨进程不可恢复 —— 工具描述里对此有明确说明。
   */
  sessionStore?: SessionStore;
  /**
   * 任务状态仓（注入后每个子任务是一个可恢复单元：core_intent / 步级
   * checkpoint / 副作用台账都在 `task_id` 名下）。
   */
  taskStore?: TaskStore;
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

    // 4. 恢复 or 新建子会话
    //    `task_id` 是可恢复单元：同一 task_id 再次派遣 = 继续同一个子会话
    //    （前提是会话仓/任务仓已注入并落过盘），而不是从零开一个新会话。
    const resumable = resolveResumableSession(
      options,
      params.taskId,
      model,
      params.description,
    );
    const session = resumable.session;
    session.updatedAt = Date.now();
    session.status = "running";
    // 续跑：新的派遣提示词作为追加输入，历史（含已完成步骤的工具结果）保留；
    // 新建：历史为空，这条就是首条输入。
    session.messages.push(createUserMessage(params.prompt));
    // 落盘（会话 + 首条输入）：跨进程按 task_id 找回子会话的前提
    if (options.sessionStore) {
      options.sessionStore.saveSession(session);
      options.sessionStore.saveMessages(session.id, session.messages);
    }
    // 任务单元：首次派遣建 core_intent 锚点；续跑沿用既有锚点（只读）
    if (options.taskStore) {
      const existing = options.taskStore.getTask(taskId);
      if (!existing) {
        options.taskStore.createTask({
          taskId,
          sessionId: session.id,
          coreIntent: `${params.description}: ${params.prompt}`.slice(0, 500),
        });
      }
    }

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
      // 子任务同样是可恢复单元：task_id 名下有自己的 core_intent 与步级 checkpoint
      ...(options.taskStore
        ? { taskRuntime: { store: options.taskStore, taskId } }
        : {}),
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

    // 10. 会话落盘（跨进程按 task_id 恢复子会话的前提）
    session.status = hasError ? "error" : "idle";
    session.updatedAt = Date.now();
    if (options.sessionStore) {
      options.sessionStore.saveSession(session);
      options.sessionStore.saveMessages(session.id, session.messages);
    }

    const resumeInfo: Pick<SubagentResult, "resumed" | "resumeFallbackReason"> =
      resumable.status === "resumed"
        ? { resumed: true }
        : resumable.status === "fallback"
          ? { resumed: false, resumeFallbackReason: resumable.reason }
          : {};

    if (hasError) {
      return {
        taskId,
        sessionId: session.id,
        state: "error",
        text: errorMessage || resultText || "Subagent encountered an error",
        summary: `Subagent error: ${params.description}`,
        ...resumeInfo,
      };
    }

    return {
      taskId,
      sessionId: session.id,
      state: "completed",
      text: resultText || "(subagent produced no output)",
      summary: `Task completed: ${params.description}`,
      ...resumeInfo,
    };
  };
}

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

/** 子会话解析结果 */
interface ResumableSession {
  session: Session;
  /**
   * - `fresh`：请求的 task_id 没有落盘记录 —— 首次派遣，无「续跑」可言；
   * - `resumed`：命中既有 task_id 并读回了它的会话；
   * - `fallback`：本来该续跑但拿不到记录（未注入仓 / 记录已丢），本次新建。
   */
  status: "fresh" | "resumed" | "fallback";
  reason?: string;
}

/**
 * 解析本次派遣该用哪个子会话。
 *
 * 恢复路径要求**两级都在**：
 * 1. `taskStore` 里存在该 `task_id`（知道它归属哪个 session）；
 * 2. `sessionStore` 里那个 session 还在（历史消息可读回）。
 *
 * 两级缺一即退回新建 —— 但要如实告知调用方「本次没有恢复成功」，
 * 不能像历史实现那样静默新建却宣称「继续了同一个会话」。
 */
function resolveResumableSession(
  options: SubagentRunnerOptions,
  requestedTaskId: string | undefined,
  model: string,
  description: string,
): ResumableSession {
  const fresh = (): ResumableSession => ({
    session: createSession(model, description),
    status: "fresh",
  });
  if (!requestedTaskId) return fresh();

  if (!options.taskStore || !options.sessionStore) {
    return {
      session: createSession(model, description),
      status: "fallback",
      reason:
        "请求了 task_id，但当前运行时未配置任务仓/会话仓，无法找回上个子会话，本次已新建。",
    };
  }

  const task = options.taskStore.getTask(requestedTaskId);
  if (!task) return fresh();

  const prior = options.sessionStore.loadSession(task.sessionId);
  if (!prior) {
    return {
      session: createSession(model, description),
      status: "fallback",
      reason: `task_id=${requestedTaskId} 存在，但其会话 ${task.sessionId} 已不在会话仓中，本次已新建。`,
    };
  }
  return { session: prior, status: "resumed" };
}

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
