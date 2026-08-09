/**
 * @fengagent/tools — Task 内置工具（多 Agent 子任务派遣）
 *
 * 主 Agent 通过 task 工具派遣子 Agent 执行独立任务。
 * 前台模式：阻塞等待子 Agent 完成，返回 <task_result>。
 *
 * 参数：description、prompt、subagent_type、task_id（恢复）
 *
 * 子 Agent 不能调用 task 工具（由 subagent-runner 在创建子工具注册表时排除）。
 *
 * 参考 opencode task 工具和 ARCHITECTURE.md 第 3.4 节。
 */

import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  SubagentResult,
} from "@fengagent/core";
import { ALLOW } from "@fengagent/core/permission";
import { z } from "zod";

// ──────────────────────────────────────────────
// 输入 Schema
// ──────────────────────────────────────────────

const inputSchema = z.object({
  description: z
    .string()
    .describe("A short (3-5 words) description of the task"),
  prompt: z
    .string()
    .describe("The task for the agent to perform"),
  subagent_type: z
    .string()
    .describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .optional()
    .describe(
      "Set this to resume a previous task — pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one.",
    ),
});

type TaskInput = z.infer<typeof inputSchema>;

// ──────────────────────────────────────────────
// 输出格式化
// ──────────────────────────────────────────────

/** 格式化子 Agent 结果为工具输出文本 */
function renderResult(
  result: SubagentResult,
): string {
  const tag = result.state === "error" ? "task_error" : "task_result";
  const summary = result.summary ? `\n<summary>${result.summary}</summary>` : "";
  return [
    `<task id="${result.sessionId || result.taskId}" state="${result.state}">${summary}`,
    `<${tag}>`,
    result.text,
    `</${tag}>`,
    "</task>",
  ].join("\n");
}

// ──────────────────────────────────────────────
// Task 工具定义
// ──────────────────────────────────────────────

export const taskTool: ToolDefinition<TaskInput> = {
  name: "task",
  description: [
    "Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file.",
    "Delegating also keeps the bulk of intermediate file contents out of your own context — you get a conclusion back instead of a pile of dumps.",
    "",
    "Foreground is the default — the tool blocks until the subagent completes and returns the result.",
    "",
    "Available subagent types: default (general-purpose), coder (code writing), researcher (read-only research).",
  ].join("\n"),

  inputSchema,

  isReadOnly(): boolean {
    // task 工具本身不修改文件，但子 Agent 可能会
    return false;
  },

  isDestructive(): boolean {
    return false;
  },

  isConcurrencySafe(): boolean {
    // 子 Agent 可能修改文件系统，不应并行
    return false;
  },

  checkPermissions() {
    // task 工具默认允许（子 Agent 内部各自做权限检查）
    return ALLOW;
  },

  async execute(input: TaskInput, context: ToolContext): Promise<ToolResult> {
    // 检查是否注入了 spawnSubagent
    if (!context.spawnSubagent) {
      return {
        content:
          'Error: Task tool requires a subagent runner but none is available. This usually means the agent runtime was not configured with agent definitions.',
        isError: true,
        metadata: { reason: "no_spawnSubagent" },
      };
    }

    // 当前深度
    const currentDepth = context.agentDepth ?? 0;

    try {
      const result = await context.spawnSubagent({
        description: input.description,
        prompt: input.prompt,
        subagentType: input.subagent_type,
        taskId: input.task_id,
        parentSessionId: context.sessionId,
        depth: currentDepth,
      });

      const output = renderResult(result);

      return {
        content: output,
        isError: result.state === "error",
        metadata: {
          taskId: result.taskId,
          sessionId: result.sessionId,
          state: result.state,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        content: `<task state="error">\n<task_error>\n${errorMsg}\n</task_error>\n</task>`,
        isError: true,
        metadata: { reason: "exception", error: errorMsg },
      };
    }
  },

  renderUse(input: TaskInput): string {
    return `task: ${input.description} (${input.subagent_type})`;
  },
};
