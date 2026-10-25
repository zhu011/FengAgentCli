/**
 * @fengagent/tools — `dispatch_task` 内置工具（把任务派给本机其他 agent）
 *
 * LLM 在会话里调用它：`{ agent: "kimi", task: "..." }` → 服务端 spawn 目标 runtime、
 * 跑一轮 ACP、把回复文本回填成工具结果。因此「派活给别的 agent」对模型来说就是
 * 一次普通工具调用，结果自然回流到当前会话。
 *
 * 工具本身不碰进程/协议：真正的派发由 `@fengagent/server` 的 `AgentTaskService`
 * 注入（`createDispatchTaskTool(handler)`）—— 这样 tools 包不反向依赖 server，
 * 也方便测试注入假 handler。
 *
 * 副作用声明为 `non-idempotent`：派发是「对 agent 之外的可见效果」，崩溃恢复时
 * 未决的派发必须人工核对，绝不静默重放（与 AGE-29 台账语义一致）。
 */

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "@fengagent/core/tool";

/** 派发请求（工具入参 → 服务层） */
export interface DispatchTaskRequest {
  /** 目标 runtime 注册名（kimi / dsh / fengagent …） */
  runtime: string;
  /** 要交给它的任务文本 */
  content: string;
  /** 覆盖目标工作目录（缺省用服务默认的隔离目录） */
  cwd?: string;
}

/** 派发结果（服务层 → 工具结果） */
export interface DispatchTaskOutcome {
  id: string;
  runtime: string;
  status: string;
  result?: string;
  error?: string;
}

/** 服务层注入的派发实现 */
export type DispatchTaskHandler = (
  input: DispatchTaskRequest,
  context: { sessionId: string; workdir: string },
) => Promise<DispatchTaskOutcome>;

/** 工具入参 schema */
const dispatchTaskSchema = z.object({
  agent: z
    .string()
    .min(1)
    .describe("目标 agent runtime 的注册名，例如 kimi / dsh / fengagent"),
  task: z
    .string()
    .min(1)
    .describe("交给该 agent 的完整任务文本（它看不到本会话上下文，要求需自包含）"),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe("可选：目标 agent 的工作目录（缺省用隔离目录，避免污染本仓库）"),
});

/** 工具入参类型 */
export type DispatchTaskInput = z.infer<typeof dispatchTaskSchema>;

/** 工具输出元数据 */
export interface DispatchTaskMetadata {
  taskId: string;
  runtime: string;
  status: string;
}

/**
 * 创建 `dispatch_task` 工具。
 *
 * @param handler - 派发实现（生产 = `AgentTaskService.dispatchAndWait`）
 * @param options - `runtimes`：把可用 runtime 名单写进工具描述（模型据此选目标）
 */
export function createDispatchTaskTool(
  handler: DispatchTaskHandler,
  options: { runtimes?: () => string[] } = {},
): ToolDefinition<DispatchTaskInput, DispatchTaskMetadata> {
  const listRuntimes = (): string => {
    try {
      const names = options.runtimes?.() ?? [];
      return names.length > 0 ? `可用 runtime：${names.join(" / ")}。` : "";
    } catch {
      return "";
    }
  };

  return {
    name: "dispatch_task",
    description:
      "把一个自包含的任务派给本机另一个 agent（kimi / dsh / fengagent 等 ACP 运行时）执行，" +
      "等待它跑完并把最终回复返回给你。目标 agent 看不到当前会话的上下文，任务文本必须自包含" +
      "（背景、目标、交付物、边界都写清楚）。适合「换一个模型/运行时做交叉验证」「让专门的 agent " +
      "跑长任务」这类场景。" +
      listRuntimes(),

    inputSchema: dispatchTaskSchema,

    async execute(input, context): Promise<ToolResult<DispatchTaskMetadata>> {
      try {
        const outcome = await handler(
          {
            runtime: input.agent,
            content: input.task,
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          },
          { sessionId: context.sessionId, workdir: context.workdir },
        );
        const ok = outcome.status === "replied";
        const body = outcome.result ?? outcome.error ?? "";
        return {
          content:
            `派发任务 ${outcome.id} → ${outcome.runtime}：${outcome.status}` +
            (body === "" ? "" : `\n\n${body}`),
          isError: !ok,
          metadata: {
            taskId: outcome.id,
            runtime: outcome.runtime,
            status: outcome.status,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `派发失败（${input.agent}）：${message}`,
          isError: true,
          metadata: { taskId: "", runtime: input.agent, status: "failed" },
        };
      }
    },

    // 派发是「对 agent 之外的可见效果」：进副作用台账，未决时不静默重放
    sideEffect: () => "non-idempotent",
    isConcurrencySafe: () => true,
    renderUse: (input) => `dispatch_task(${input.agent}) → ${input.task.slice(0, 60)}`,
    renderResult: (result) => (result.isError ? "派发失败" : "派发完成"),
  };
}
