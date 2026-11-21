/**
 * @fengagent/server — `/api/approvals` 路由（P2 负责人确认）
 *
 * 「成员遇需批准的操作 → 队长裁决 → 拿不准上抛人类发起人 → 每笔审计」的**人类入口**。
 * 队长侧的裁决走工具（`resolve_approval` / `escalate_approval`），人类走这里，
 * 两边写同一张 `approval_audit`（谁、批哪次、once/session/permanent）。
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/api/approvals?status=&squadId=&agentId=` | 审批列表（新 → 旧） |
 * | GET | `/api/approvals/:id` | 详情 + 审计时间线 |
 * | POST | `/api/approvals/:id/resolve` | 人类裁决（approve / deny + scope） |
 * | POST | `/api/approvals/:id/escalate` | 上抛（人工转交更高一层时用） |
 * | GET | `/api/approvals/audit/recent?limit=` | 最近审计（治理页） |
 * | POST | `/api/approvals/revoke` | 收回某成员的授权（permanent 收回） |
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { ApprovalScope, ApprovalStatus } from "@fengagent/agent";
import { SquadService, SquadServiceError } from "../squad-service.ts";

/** 错误统一响应 */
function fail(c: Context, err: unknown): Response {
  if (err instanceof SquadServiceError) {
    const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400;
    return c.json({ error: { message: err.message, code: err.code } }, status);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: { message, code: "internal" } }, 500);
}

/** 读 JSON 体 */
async function readJson(c: Context): Promise<Record<string, unknown> | Response> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: { message: "请求体不是合法 JSON", code: "bad_request" } }, 400);
  }
}

/** 状态归一（非枚举值忽略） */
function toStatus(value: string | undefined): ApprovalStatus | undefined {
  return value === "pending" || value === "approved" || value === "denied" || value === "escalated" || value === "expired"
    ? value
    : undefined;
}

/** 授权范围归一 */
function toScope(value: unknown): ApprovalScope | undefined {
  return value === "once" || value === "session" || value === "permanent" ? value : undefined;
}

/**
 * 审批路由。
 *
 * @param service - 小队编排服务（审批仓由它持有）
 * @param humanOwner - 人类发起人标识（写进审计的 actor id；缺省 `owner`）
 */
export function createApprovalRoutes(service: SquadService, humanOwner = "owner"): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    c.header("Cache-Control", "no-cache");
    const status = toStatus(c.req.query("status"));
    const squadId = c.req.query("squadId");
    const agentId = c.req.query("agentId");
    return c.json(
      service.listApprovals({
        ...(status === undefined ? {} : { status }),
        ...(squadId === undefined || squadId === "" ? {} : { squadId }),
        ...(agentId === undefined || agentId === "" ? {} : { agentId }),
      }),
    );
  });

  // 注意：静态段必须在 `/:id` 之前注册，否则会被当成审批 id
  app.get("/audit/recent", (c) => {
    c.header("Cache-Control", "no-cache");
    const limit = Number(c.req.query("limit") ?? "100");
    return c.json(service.listRecentAudit(Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 100));
  });

  app.post("/revoke", async (c) => {
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const agentId = typeof body["agentId"] === "string" ? body["agentId"] : "";
    const toolName = typeof body["toolName"] === "string" ? body["toolName"] : undefined;
    try {
      return c.json(service.revokeApprovals(agentId, toolName));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/:id", (c) => {
    c.header("Cache-Control", "no-cache");
    try {
      return c.json(service.approvalDetail(c.req.param("id")));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/:id/resolve", async (c) => {
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const decision = body["decision"] === "deny" ? "deny" : body["decision"] === "approve" ? "approve" : undefined;
    if (decision === undefined) {
      return c.json({ error: { message: "decision 必须是 approve 或 deny", code: "bad_request" } }, 400);
    }
    const scope = toScope(body["scope"]);
    try {
      return c.json(
        service.resolveApproval(c.req.param("id"), {
          decision,
          ...(scope === undefined ? {} : { scope }),
          actor: { type: "member", id: humanOwner },
          ...(typeof body["note"] === "string" ? { note: body["note"] } : {}),
        }),
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/:id/escalate", async (c) => {
    const body = await readJson(c);
    if (body instanceof Response) return body;
    try {
      return c.json(
        service.escalateApproval(c.req.param("id"), {
          actor: { type: "member", id: humanOwner },
          ...(typeof body["note"] === "string" ? { note: body["note"] } : {}),
        }),
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}
