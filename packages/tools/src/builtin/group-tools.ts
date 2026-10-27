/**
 * @fengagent/tools — 群工具（G1：协调者侧）
 *
 * v1「协调者中转」里，**只有本仓库的 fengagent 成员**拿得到这四个工具 —— 外部
 * runtime（kimi/dsh/claude）要拥有群工具必须往它们的进程注入 MCP（G4/v2）。
 * 因此它们和 `dispatch_task` 一样是**由 server 装配注入**的：
 * `createGroupTools(handler)`，tools 包不反向依赖 server。
 *
 * | 工具 | 作用 |
 * |---|---|
 * | `group_create` | 建群（可指定成员 runtime 名单与主题） |
 * | `group_send` | 以协调者身份往群里发言 |
 * | `group_history` | 读群聊记录（最近 N 条，带发言人与 seq） |
 * | `group_list` | 列群（按状态过滤），用于「我们有哪些群」 |
 *
 * `group_conclude` / `group_dispatch` 属于 G2/G3（编排收敛与群内派发），这里不放。
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
  send(input: { groupId: string; content: string; from: string }): Promise<{ id: string; seq: number }>;
  /** 读群聊记录 */
  history(input: {
    groupId: string;
    limit?: number;
  }): Promise<{ groupId: string; name: string; lines: string[] }>;
  /** 列群 */
  list(input: {
    status?: "open" | "concluded";
  }): Promise<Array<{ id: string; name: string; status: string; members: string[]; messageCount: number }>>;
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
  coordinator: z.string().optional().describe("协调者名（缺省用你自己的名字）"),
});

const groupSendSchema = z.object({
  groupId: z.string().min(1).describe("群 id"),
  content: z.string().min(1).describe("发言内容"),
});

const groupHistorySchema = z.object({
  groupId: z.string().min(1).describe("群 id"),
  limit: z.number().int().positive().max(200).optional().describe("取最近多少条（默认 30）"),
});

const groupListSchema = z.object({
  status: z
    .enum(["open", "concluded"])
    .optional()
    .describe("按状态过滤（缺省全部）"),
});

/**
 * 创建群工具组。
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
        coordinator: input.coordinator ?? selfName(),
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
      return {
        content: `已发送（seq=${sent.seq}）`,
        metadata: { groupId: input.groupId },
      };
    },
    sideEffect: () => "idempotent",
    isConcurrencySafe: () => true,
    renderUse: (input) => `group_send(${input.groupId.slice(0, 8)})`,
  };

  const historyTool: ToolDefinition<z.infer<typeof groupHistorySchema>, { groupId: string }> = {
    name: "group_history",
    description: "读群聊记录（最近 N 条，含发言人与 seq）。开会讨论前先用它对齐上下文。",
    inputSchema: groupHistorySchema,
    async execute(input): Promise<ToolResult<{ groupId: string }>> {
      const history = await handler.history({
        groupId: input.groupId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      const body =
        history.lines.length === 0 ? "（暂无消息）" : history.lines.join("\n");
      return {
        content: `群「${history.name}」最近消息：\n${body}`,
        metadata: { groupId: history.groupId },
      };
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    renderUse: (input) => `group_history(${input.groupId.slice(0, 8)})`,
  };

  const listTool: ToolDefinition<z.infer<typeof groupListSchema>, { count: number }> = {
    name: "group_list",
    description: "列出已有的群（可按状态过滤），用于确认「我们有哪些群、各聊到哪了」。",
    inputSchema: groupListSchema,
    async execute(input): Promise<ToolResult<{ count: number }>> {
      const groups = await handler.list({
        ...(input.status === undefined ? {} : { status: input.status }),
      });
      const body =
        groups.length === 0
          ? "（暂无群）"
          : groups
              .map(
                (g) =>
                  `- ${g.name}（${g.id.slice(0, 8)}，${g.status}，${g.members.length} 人，${g.messageCount} 条消息）`,
              )
              .join("\n");
      return { content: `共 ${groups.length} 个群：\n${body}`, metadata: { count: groups.length } };
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    renderUse: () => "group_list()",
  };

  return [createTool, sendTool, historyTool, listTool];
}
