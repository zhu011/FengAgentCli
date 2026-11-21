/**
 * @fengagent/tools — 小队审批内置工具（P2 负责人确认）
 *
 * 队长用这三个工具做「日常确认」，人类发起人走 `/api/approvals`：
 * - `list_approvals(status?)`：看自己小队还有哪些待裁决；
 * - `resolve_approval(approval_id, decision, scope, note?)`：裁决（once / session / permanent）；
 * - `escalate_approval(approval_id, reason)`：拿不准，上抛人类发起人。
 *
 * 与 `dispatch_task` 同样只声明接口、实现由 `@fengagent/server` 注入 —— tools 包不反向
 * 依赖 server，测试可以塞假 handler。审计写在服务端（`approval_audit`），这里不落盘。
 */

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "@fengagent/core/tool";

/** 审批摘要（工具结果里给模型看的形态） */
export interface ApprovalSummary {
  id: string;
  agentId: string;
  toolName: string;
  reason: string;
  status: string;
}

/** 裁决范围 */
export type ApprovalScopeInput = "once" | "session" | "permanent";

/** 裁决结果 */
export interface ApprovalResolveOutcome {
  id: string;
  status: string;
  scope?: string;
  error?: string;
}

/** 注入的审批能力 */
export interface ApprovalToolHandlers {
  list: (status?: string) => Promise<ApprovalSummary[]> | ApprovalSummary[];
  resolve: (input: {
    approvalId: string;
    decision: "approve" | "deny";
    scope?: ApprovalScopeInput;
    note?: string;
  }) => Promise<ApprovalResolveOutcome> | ApprovalResolveOutcome;
  escalate: (input: {
    approvalId: string;
    reason?: string;
  }) => Promise<ApprovalResolveOutcome> | ApprovalResolveOutcome;
}

const listSchema = z.object({
  status: z
    .enum(["pending", "approved", "denied", "escalated"])
    .optional()
    .describe("按状态过滤；缺省只看 pending"),
});

const resolveSchema = z.object({
  approval_id: z.string().min(1).describe("审批请求 id（形如 apr_xxx）"),
  decision: z.enum(["approve", "deny"]).describe("批准 / 驳回"),
  scope: z
    .enum(["once", "session", "permanent"])
    .optional()
    .describe("授权范围：once 只批这一次（默认）；session 本子任务内有效；permanent 长期有效"),
  note: z.string().optional().describe("裁决附言（写进审计）"),
});

const escalateSchema = z.object({
  approval_id: z.string().min(1).describe("审批请求 id"),
  reason: z.string().optional().describe("为什么拿不准（写进审计，人类发起人据此判断）"),
});

/** 审批列表工具 */
export function createListApprovalsTool(
  handlers: Pick<ApprovalToolHandlers, "list">,
): ToolDefinition<z.infer<typeof listSchema>, { count: number }> {
  return {
    name: "list_approvals",
    description:
      "列出本小队待裁决的审批请求（成员遇到需要批准的操作时生成）。裁决用 resolve_approval，" +
      "拿不准用 escalate_approval 上抛人类发起人。",
    inputSchema: listSchema,
    async execute(input): Promise<ToolResult<{ count: number }>> {
      const status = input.status ?? "pending";
      const items = await handlers.list(status);
      const body =
        items.length === 0
          ? `没有 ${status} 状态的审批请求。`
          : [
              `共 ${items.length} 条 ${status}：`,
              ...items.map(
                (item) =>
                  `- ${item.id} | 成员 ${item.agentId} 请求 \`${item.toolName}\`${item.reason === "" ? "" : `（${item.reason}）`}`,
              ),
            ].join("\n");
      return { content: body, isError: false, metadata: { count: items.length } };
    },
    sideEffect: () => "none",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    renderUse: () => "list_approvals()",
    renderResult: (result) => `审批 ${result.metadata?.count ?? 0} 条`,
  };
}

/** 裁决工具 */
export function createResolveApprovalTool(
  handlers: Pick<ApprovalToolHandlers, "resolve">,
): ToolDefinition<z.infer<typeof resolveSchema>, { approvalId: string; status: string }> {
  return {
    name: "resolve_approval",
    description:
      "裁决一笔审批请求（approve / deny）。scope 决定授权范围：once 只这一次、session 本子任务内、" +
      "permanent 长期。每一笔都会记审计（谁批、批哪次、什么范围）。",
    inputSchema: resolveSchema,
    async execute(input): Promise<ToolResult<{ approvalId: string; status: string }>> {
      try {
        const outcome = await handlers.resolve({
          approvalId: input.approval_id,
          decision: input.decision,
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.note === undefined ? {} : { note: input.note }),
        });
        return {
          content: `${outcome.id} → ${outcome.status}${outcome.scope === undefined ? "" : `（scope=${outcome.scope}）`}`,
          isError: false,
          metadata: { approvalId: outcome.id, status: outcome.status },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `裁决失败：${message}`,
          isError: true,
          metadata: { approvalId: input.approval_id, status: "error" },
        };
      }
    },
    sideEffect: () => "non-idempotent",
    isConcurrencySafe: () => false,
    renderUse: (input) => `resolve_approval(${input.approval_id}, ${input.decision})`,
    renderResult: (result) => (result.isError ? "裁决失败" : "已裁决"),
  };
}

/** 上抛工具 */
export function createEscalateApprovalTool(
  handlers: Pick<ApprovalToolHandlers, "escalate">,
): ToolDefinition<z.infer<typeof escalateSchema>, { approvalId: string; status: string }> {
  return {
    name: "escalate_approval",
    description: "把一笔拿不准的审批上抛给人类发起人（会写审计；人类在审批页裁决）。",
    inputSchema: escalateSchema,
    async execute(input): Promise<ToolResult<{ approvalId: string; status: string }>> {
      try {
        const outcome = await handlers.escalate({
          approvalId: input.approval_id,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        });
        return {
          content: `${outcome.id} → ${outcome.status}（已上抛人类发起人）`,
          isError: false,
          metadata: { approvalId: outcome.id, status: outcome.status },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `上抛失败：${message}`,
          isError: true,
          metadata: { approvalId: input.approval_id, status: "error" },
        };
      }
    },
    sideEffect: () => "non-idempotent",
    isConcurrencySafe: () => false,
    renderUse: (input) => `escalate_approval(${input.approval_id})`,
    renderResult: (result) => (result.isError ? "上抛失败" : "已上抛"),
  };
}
