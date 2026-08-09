/**
 * @fengagent/core — Tool 接口定义
 *
 * ToolDefinition、ToolResult、ToolContext。
 * 参考 PRD 第 5 节和 ARCHITECTURE 第 4.2.3 节。
 */

import type { z } from "zod";
import type { PermissionResult } from "./permission.ts";
import type { SubagentRunner } from "./agent.ts";

/**
 * 工具执行上下文 — 传递给 tool.execute() 的运行时信息。
 */
export interface ToolContext {
  /** 工作目录 */
  workdir: string;
  /** 当前会话 ID */
  sessionId: string;
  /** 当前消息 ID */
  messageId: string;
  /** 请求权限的回调（当工具需要用户审批时调用） */
  requestPermission?: (
    permission: {
      toolName: string;
      input: unknown;
      reason?: string;
    },
  ) => Promise<PermissionResult>;
  /** 子 Agent 派遣函数（由 agent 层注入，task 工具使用） */
  spawnSubagent?: SubagentRunner;
  /** 当前 Agent 深度（0 = 顶层 Agent，子 Agent 为 1+） */
  agentDepth?: number;
  /** 额外的元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 工具执行结果。
 */
export interface ToolResult<O = unknown> {
  /** 结果内容（文本） */
  content: string;
  /** 是否为错误结果 */
  isError?: boolean;
  /** 结构化元数据（可选） */
  metadata?: O;
}

/**
 * 工具调用（从 LLM 响应中解析出的调用请求）。
 */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * 工具定义接口。
 *
 * 每个工具实现此接口，注册到 ToolRegistry。
 * 泛型 I 为输入类型，O 为输出元数据类型。
 */
export interface ToolDefinition<I = unknown, O = unknown> {
  /** 工具名（字母+数字+下划线+连字符，字母开头） */
  name: string;
  /** 给 LLM 的描述 */
  description: string;
  /** Zod 输入校验 schema */
  inputSchema: z.ZodType<I>;
  /** Zod 输出校验 schema（可选） */
  outputSchema?: z.ZodType<O>;

  /** 执行工具 */
  execute(input: I, context: ToolContext): Promise<ToolResult<O>>;

  /** 是否只读（不修改文件系统状态） */
  isReadOnly?(input: I): boolean;
  /** 是否破坏性操作 */
  isDestructive?(input: I): boolean;
  /** 是否可安全并行执行 */
  isConcurrencySafe?(input: I): boolean;

  /** 权限检查 */
  checkPermissions?(input: I, context: ToolContext): PermissionResult;

  /** TUI/WebUI 中渲染调用（返回文本描述） */
  renderUse?(input: I): string;
  /** TUI/WebUI 中渲染结果（返回文本描述） */
  renderResult?(result: ToolResult<O>): string;
}
