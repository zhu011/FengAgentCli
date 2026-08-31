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

/**
 * 子 Agent 类型参数别名 — 兼容 LLM 工具调用时的常见参数名误拼。
 *
 * 规范参数名是 `subagent_type`（snake_case），但实测部分模型（如 deepseek-v4-pro）
 * 会反复输出 camelCase 的 `subagentType`，甚至 `agentType` / `type` / `agent` /
 * `subagent` / `kind` / `name` 等变体。zod 默认会静默剥离未知键，导致
 * `subagent_type` 为 undefined → 「Unknown agent type: undefined」→ 模型反复重试，
 * 形成死循环（AGE-29 现场：单会话 25 轮、48 次 task 调用全部因此失败）。
 *
 * 解法：schema 使用 passthrough + transform 把别名归一化到 `subagent_type`；
 * 值本身仍会在运行时与可用 Agent 类型（default / coder / researcher）校验。
 */
const SUBAGENT_TYPE_ALIASES = [
  "subagentType",
  "agentType",
  "agent_type",
  "agent",
  "subagent",
  "type",
  "kind",
  "name",
] as const;

/** 从输入中按别名顺序提取子 Agent 类型字符串（找不到返回 undefined） */
function pickSubagentType(raw: Record<string, unknown>): string | undefined {
  if (typeof raw["subagent_type"] === "string" && raw["subagent_type"].trim() !== "") {
    return raw["subagent_type"].trim();
  }
  for (const alias of SUBAGENT_TYPE_ALIASES) {
    const v = raw[alias];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

const inputSchema: z.ZodType<TaskInput> = z
  .object({
    description: z
      .string()
      .describe("A short (3-5 words) description of the task"),
    prompt: z
      .string()
      .describe("The task for the agent to perform"),
    subagent_type: z
      .string()
      .optional()
      .describe(
        "The type of specialized agent to use for this task. Required. Valid values: default (general-purpose), coder (code writing), researcher (read-only research). Use exactly this key name: subagent_type.",
      ),
    task_id: z
      .string()
      .optional()
      .describe(
        "Set this to resume a previous task — pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one.",
      ),
  })
  .passthrough() // 保留 LLM 误拼的别名键（subagentType 等），transform 阶段归一化
  .transform((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      // zod 已在 object 层校验 description/prompt 为 string，此处仅收窄类型
      description: r["description"] as string,
      prompt: r["prompt"] as string,
      subagent_type: pickSubagentType(r),
      task_id: typeof r["task_id"] === "string" ? r["task_id"] : undefined,
    };
  });

/** 归一化后的 Task 工具输入（subagent_type 为规范键，可能因别名缺失而为 undefined） */
export interface TaskInput {
  description: string;
  prompt: string;
  subagent_type?: string;
  task_id?: string;
}

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
    "Parameters: description, prompt, subagent_type (REQUIRED — the type of specialized agent; the exact key name is subagent_type with an underscore, NOT subagentType), task_id (optional, to resume).",
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

    // 子 Agent 类型缺失（模型漏传或未命中任一别名键）— 给出明确、可自纠正的错误
    if (!input.subagent_type) {
      return {
        content:
          'Error: task tool requires the "subagent_type" parameter (a string naming which specialized agent to use). Available subagent types: default, coder, researcher. Pass it under the key subagent_type (snake_case, e.g. {"subagent_type": "researcher"}).',
        isError: true,
        metadata: { reason: "missing_subagent_type" },
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
