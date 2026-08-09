/**
 * @fengagent/server — 会话路由
 *
 * 会话创建、列表、消息发送（SSE）、中断、导出。
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SessionManager } from "../session-manager.ts";
import { SessionNotFoundError } from "../session-manager.ts";
import { agentEventToSSE } from "../sse.ts";

/** 创建会话路由 */
export function createSessionRoutes(sessionManager: SessionManager): Hono {
  const app = new Hono();

  // POST / — 创建会话
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title : undefined;

    const session = sessionManager.createSession(title);
    return c.json(session, 201);
  });

  // GET / — 列出会话
  app.get("/", (c) => {
    const sessions = sessionManager.listSessions();
    return c.json(sessions);
  });

  // GET /:id — 获取会话详情
  app.get("/:id", (c) => {
    const id = c.req.param("id");
    const session = sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: `Session "${id}" not found` }, 404);
    }
    return c.json(session);
  });

  // POST /:id/messages — 发送消息（返回 SSE 流）
  app.post("/:id/messages", (c) => {
    const id = c.req.param("id");

    return streamSSE(c, async (stream) => {
      // 解析请求体
      const body = await c.req.json().catch(() => ({}));
      const content =
        typeof body.content === "string"
          ? body.content
          : Array.isArray(body.content)
            ? body.content
                .map((block: { text?: string }) => block.text ?? "")
                .join("")
            : "";

      if (!content) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: { message: "content is required" } }),
        });
        return;
      }

      const model =
        typeof body.model === "string" ? body.model : undefined;

      try {
        const events = sessionManager.sendMessage(id, content, model);

        for await (const event of events) {
          const frame = agentEventToSSE(event);
          await stream.writeSSE({
            event: frame.event,
            data: frame.data,
          });
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);

        if (err instanceof SessionNotFoundError) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: { message }, code: "session_not_found" }),
          });
          return;
        }

        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: { message } }),
        });
      }
    });
  });

  // POST /:id/interrupt — 中断当前运行
  app.post("/:id/interrupt", (c) => {
    const id = c.req.param("id");
    const interrupted = sessionManager.interrupt(id);
    return c.json({ interrupted }, interrupted ? 200 : 404);
  });

  // POST /:id/permissions/:reqId — 权限响应
  app.post("/:id/permissions/:reqId", async (c) => {
    const id = c.req.param("id");
    const reqId = c.req.param("reqId");
    const body = await c.req.json().catch(() => ({}));

    // 构造 PermissionResult
    const decision = body.decision === "deny" ? "deny" : "allow";
    const result =
      decision === "deny"
        ? { decision: "deny" as const, reason: body.reason }
        : { decision: "allow" as const };

    const responded = sessionManager.respondPermission(id, reqId, result);
    return c.json({ responded }, responded ? 200 : 404);
  });

  // GET /:id/permissions — 获取待处理权限请求列表
  app.get("/:id/permissions", (c) => {
    const id = c.req.param("id");
    const pending = sessionManager.getPendingPermissions(id);
    return c.json(pending);
  });

  // GET /:id/export — 导出会话
  app.get("/:id/export", (c) => {
    const id = c.req.param("id");
    const exported = sessionManager.exportSession(id);
    if (!exported) {
      return c.json({ error: `Session "${id}" not found` }, 404);
    }
    return c.text(exported, 200, {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="session-${id}.json"`,
    });
  });

  // DELETE /:id — 销毁会话
  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    sessionManager.destroySession(id);
    return c.json({ deleted: true });
  });

  return app;
}
