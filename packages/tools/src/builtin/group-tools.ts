/**
 * @fengagent/tools — 群工具（协调者侧；G1 三个 + G3 的 `group_conclude`）
 *
 * v1「协调者中转」里，**只有本仓库的 fengagent 成员**拿得到这些工具 —— 外部
 * runtime（kimi/dsh/claude）要拥有群工具必须往它们的进程注入 MCP（G4/v2）。
 * 因此它们和 `dispatch_task` 一样是**由 server 装配注入**的：
 * `createGroupTools(handler)`，tools 包不反向依赖 server。
 *
 * | 工具 | 阶段 | 作用 |
 * |---|---|---|
 * | `group_create` | G1 | 建群（成员 runtime 名单 + 描述），返回 GroupInfo |
 * | `group_send` | G1 | 以协调者身份往群里发言（`from_kind=coordinator`） |
 * | `group_history` | G1 | 读群聊记录（最近 N 条，旧→新，带发言人与 seq） |
 * | `group_conclude` | G3 | 收口：结论作为 `decision` 消息落库 → 关群 → 取消在跑任务 |
 *
 * `group_dispatch` 属于 G2 的派发面（用 `dispatch_task({groupId})` 即可），无需单独工具。
 */

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "@fengagent/core/tool";

/** 群会话（服务层注入的实现） */
export interface GroupToolHandler {
  /** 建群 */
  create(input: {
    name: string;
    description?: string;
    members?: string[];
    coordinator?: string;
  }): Promise<{ id: string; name: string; members: string[] }>;
  /** 以协调者身份发言 */
  send(input: {
    groupId: string;
    content: string;
    from: string;
  }): Promise<{ id: string; seq: number }>;
  /** 读群聊记录（旧 → 新） */
  history(input: {
    groupId: string;
    limit?: number;
  }): Promise<{ groupId: string; name: string; lines: string[] }>;
  /**
   * 收口（G3）：把协调者的结论以 `decision` 消息落库，然后关群（幂等）。
   * 返回被取消的在跑任务数（关群后无残留任务）。
   */
  conclude(input: {
    groupId: string;
    conclusion: string;
    from: string;
  }): Promise<{ status: string; cancelledTasks: number }>;
}

/** 群工具选项 */
export interface GroupToolsOptions {
  /** 协调者署名（缺省 `fengagent`） */
  selfName?: () => string;
}

const groupCreateSchema = z.object({
  name: z.string().min(1).describe("群名"),
  description: z.string().optional().describe("群描述/目标（一两句话说清要讨论什么）"),
  members: z
    .array(z.string().min(1))
    .optional()
    .describe("成员 runtime 名（kimi / dsh / claude …）；人类成员默认已在群里"),
});

const groupSendSchema = z.object({
  groupId: z.string().min(1).describe("群 id"),
  content: z.string().min(1).describe("发言内容"),
});

const groupHistorySchema = z.object({
  groupId: z.string().min(1).describe("群 id"),
  limit: z.number().int().positive().max(200).optional().describe("取最近多少条（默认 50）"),
});

const groupConcludeSchema = z.object({
  groupId: z.string().min(1).describe("群 id"),
  conclusion: z
    .string()
    .min(1)
    .describe("收口结论（一段话：结论是什么、谁负责什么、还有什么遗留）——会作为 decision 消息留在群里"),
});

/**
 * 创建群工具组（三个）。
 *
 * @param handler - 服务层实现
 * @param options - 协调者署名
 */
export function createGroupTools(
  handler: GroupToolHandler,
  options: GroupToolsOptions = {},
): ToolDefinition[] {
  const selfName = (): string => options.selfName?.() ?? "fengagent";

  const createTool: ToolDefinition<z.infer<typeof groupCreateSchema>, { groupId: string }> = {
    name: "group_create",
    description:
      "创建一个 agent 群聊（讨论组），把本机可用的 agent 拉进来一起办一件事。" +
      "建好后用 group_send 在群里发言、用 dispatch_task 给成员派任务（G2 起任务结果会自动回到群里）。",
    inputSchema: groupCreateSchema,
    async execute(input): Promise<ToolResult<{ groupId: string }>> {
      const group = await handler.create({
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.members === undefined ? {} : { members: input.members }),
        coordinator: selfName(),
      });
      return {
        content:
          `群已创建：${group.name}（id=${group.id}）\n` +
          `成员：${group.members.join(" / ")}`,
        metadata: { groupId: group.id },
      };
    },
    sideEffect: () => "idempotent",
    isConcurrencySafe: () => true,
    renderUse: (input) => `group_create(${input.name})`,
  };

  const sendTool: ToolDefinition<z.infer<typeof groupSendSchema>, { groupId: string }> = {
    name: "group_send",
    description:
      "以协调者身份在群里发一条消息（人类成员与其它成员都能看到）。用它汇报进展、转述成员产出、或请人拍板。",
    inputSchema: groupSendSchema,
    async execute(input): Promise<ToolResult<{ groupId: string }>> {
      const sent = await handler.send({
        groupId: input.groupId,
        content: input.content,
        from: selfName(),
      });
      return { content: `已发送（seq=${sent.seq}）`, metadata: { groupId: input.groupId } };
    },
    sideEffect: () => "idempotent",
    isConcurrencySafe: () => true,
    renderUse: (input) => `group_send(${input.groupId.slice(0, 8)})`,
  };

  const historyTool: ToolDefinition<z.infer<typeof groupHistorySchema>, { groupId: string }> = {
    name: "group_history",
    description: "读群聊记录（最近 N 条，旧→新，含发言人与 seq）。开会讨论前先用它对齐上下文。",
    inputSchema: groupHistorySchema,
    async execute(input): Promise<ToolResult<{ groupId: string }>> {
      const history = await handler.history({
        groupId: input.groupId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      const body = history.lines.length === 0 ? "（暂无消息）" : history.lines.join("\n");
      return {
        content: `群「${history.name}」最近消息：\n${body}`,
        metadata: { groupId: history.groupId },
      };
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    renderUse: (input) => `group_history(${input.groupId.slice(0, 8)})`,
  };

  const concludeTool: ToolDefinition<
    z.infer<typeof groupConcludeSchema>,
    { groupId: string; status: string }
  > = {
    name: "group_conclude",
    description:
      "收口（结束讨论）：把你的结论作为 decision 消息留在群里，然后把群置为 concluded，" +
      "并取消该群所有在跑任务。结论要自包含（结论 / 分工 / 遗留），人类与成员都靠它对齐。",
    inputSchema: groupConcludeSchema,
    async execute(input): Promise<ToolResult<{ groupId: string; status: string }>> {
      const result = await handler.conclude({
        groupId: input.groupId,
        conclusion: input.conclusion,
        from: selfName(),
      });
      return {
        content:
          `群已收口（status=${result.status}）` +
          (result.cancelledTasks > 0 ? `，取消在跑任务 ${result.cancelledTasks} 个` : ""),
        metadata: { groupId: input.groupId, status: result.status },
      };
    },
    sideEffect: () => "non-idempotent",
    isConcurrencySafe: () => false,
    renderUse: (input) => `group_conclude(${input.groupId.slice(0, 8)})`,
  };

  return [createTool, sendTool, historyTool, concludeTool];
}
