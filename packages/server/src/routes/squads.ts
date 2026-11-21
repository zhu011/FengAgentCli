/**
 * @fengagent/server — `/api/squads` 路由（P2 小队与队长）
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/api/squads` | 小队列表（不含归档） |
 * | POST | `/api/squads` | 建队（name + leaderId 必填；队长自动入成员） |
 * | GET | `/api/squads/:id` | 小队详情（含成员） |
 * | PATCH | `/api/squads/:id` | 改名/描述/指令/模式 |
 * | DELETE | `/api/squads/:id` | 归档（软删，历史保留） |
 * | POST | `/api/squads/:id/members` | 加成员（agent id + 自由 role） |
 * | DELETE | `/api/squads/:id/members/:memberType/:memberId` | 移除成员（现任队长 → 409） |
 * | POST | `/api/squads/:id/leader` | 换队长（必须是成员） |
 * | POST | `/api/squads/:id/tasks` | 派单（leader 模式；建完即返回） |
 * | GET | `/api/squads/:id/runs` | 运行树（leader 父 + worker 子） |
 *
 * 错误统一 `{ error: { message, code } }`，code 与 KG 前端契约一致：
 * bad_request / not_found / conflict / cannot_remove_squad_leader / leader_not_member /
 * squad_archived / agent_not_found / mode_not_supported / internal。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { SquadService, SquadServiceError, type SquadServiceErrorCode } from "../squad-service.ts";

/** 错误码 → HTTP 状态 */
const STATUS_BY_CODE: Record<SquadServiceErrorCode | "internal", 400 | 404 | 409 | 500> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  cannot_remove_squad_leader: 409,
  leader_not_member: 400,
  squad_archived: 409,
  agent_not_found: 400,
  mode_not_supported: 400,
  internal: 500,
};

/** 统一错误响应 */
function fail(c: Context, err: unknown): Response {
  if (err instanceof SquadServiceError) {
    return c.json({ error: { message: err.message, code: err.code } }, STATUS_BY_CODE[err.code]);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: { message, code: "internal" } }, 500);
}

/** 读 JSON 体（不是合法 JSON → 400） */
async function readJson(c: Context): Promise<Record<string, unknown> | Response> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: { message: "请求体不是合法 JSON", code: "bad_request" } }, 400);
  }
}

/** 取字符串字段（非字符串 → undefined） */
function pickString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

/** 小队路由 */
export function createSquadRoutes(service: SquadService): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    c.header("Cache-Control", "no-cache");
    return c.json(service.listSquads());
  });

  app.post("/", async (c) => {
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const membersRaw = body["members"];
    const members = Array.isArray(membersRaw)
      ? membersRaw
          .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
          .map((item) => ({
            memberType: pickString(item, "memberType") === "member" ? ("member" as const) : ("agent" as const),
            memberId: pickString(item, "memberId") ?? "",
            role: pickString(item, "role") ?? "",
          }))
      : undefined;
    try {
      return c.json(
        service.createSquad({
          ...(pickString(body, "id") === undefined ? {} : { id: pickString(body, "id") }),
          name: pickString(body, "name") ?? "",
          ...(pickString(body, "description") === undefined
            ? {}
            : { description: pickString(body, "description") }),
          leaderId: pickString(body, "leaderId") ?? "",
          ...(pickString(body, "mode") === "auto" ? { mode: "auto" as const } : {}),
          ...(pickString(body, "instructions") === undefined
            ? {}
            : { instructions: pickString(body, "instructions") }),
          ...(members === undefined ? {} : { members }),
        }),
        201,
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/:id", (c) => {
    c.header("Cache-Control", "no-cache");
    try {
      return c.json(service.getSquad(c.req.param("id")));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.patch("/:id", async (c) => {
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const mode = pickString(body, "mode");
    try {
      return c.json(
        service.updateSquad(c.req.param("id"), {
          ...(pickString(body, "name") === undefined ? {} : { name: pickString(body, "name") }),
          ...(pickString(body, "description") === undefined
            ? {}
            : { description: pickString(body, "description") }),
          ...(pickString(body, "instructions") === undefined
            ? {}
            : { instructions: pickString(body, "instructions") }),
          ...(mode === "leader" || mode === "auto" ? { mode } : {}),
        }),
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete("/:id", (c) => {
    try {
      service.archiveSquad(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/:id/members", async (c) => {
    const body = await readJson(c);
    if (body instanceof Response) return body;
    try {
      return c.json(
        service.addMember(c.req.param("id"), {
          memberType: pickString(body, "memberType") === "member" ? "member" : "agent",
          memberId: pickString(body, "memberId") ?? "",
          role: pickString(body, "role") ?? "",
        }),
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete("/:id/members/:memberType/:memberId", (c) => {
    const memberType = c.req.param("memberType") === "member" ? "member" : "agent";
    try {
      return c.json(service.removeMember(c.req.param("id"), memberType, c.req.param("memberId")));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/:id/leader", async (c) => {
    const body = await readJson(c);
    if (body instanceof Response) return body;
    try {
      return c.json(service.setLeader(c.req.param("id"), pickString(body, "leaderId") ?? ""));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/:id/tasks", async (c) => {
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const mode = pickString(body, "mode");
    try {
      const result = await service.dispatchTask(c.req.param("id"), {
        content: pickString(body, "content") ?? "",
        ...(mode === "leader" || mode === "auto" ? { mode } : {}),
      });
      return c.json({ taskId: result.taskId, runId: result.runId, agentTaskId: result.agentTaskId }, 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/:id/runs", (c) => {
    c.header("Cache-Control", "no-cache");
    try {
      return c.json(service.listRuns(c.req.param("id")));
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}
