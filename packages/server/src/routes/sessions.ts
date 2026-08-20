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
import { createLogger } from "@fengagent/shared";

/** 创建会话路由 */
export function createSessionRoutes(sessionManager: SessionManager): Hono {
  const app = new Hono();
  const log = createLogger("server");

  // POST / — 创建会话
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title : undefined;

    const session = sessionManager.createSession(title);
    log.info("createSession", `session created id=${session.id}, title=${title ?? "(none)"}`);
    return c.json(session, 201);
  });

  // GET / — 列出会话
  app.get("/", (c) => {
    const sessions = sessionManager.listSessions();
    log.info("listSessions", `count=${sessions.length}`);
    return c.json(sessions);
  });

  // GET /:id — 获取会话详情
  app.get("/:id", (c) => {
    const id = c.req.param("id");
    log.info("getSession", `id=${id}`);
    const session = sessionManager.getSession(id);
    if (!session) {
      log.warn("getSession", `session not found id=${id}`);
      return c.json({ error: `Session "${id}" not found` }, 404);
    }
    return c.json(session);
  });

  // PATCH /:id — 重命名会话（WebUI 侧边栏双击重命名 / 顶栏标题编辑）
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return c.json({ error: "title is required" }, 400);
    }
    const session = sessionManager.renameSession(id, title);
    if (!session) {
      log.warn("renameSession", `session not found id=${id}`);
      return c.json({ error: `Session "${id}" not found` }, 404);
    }
    log.info("renameSession", `sessionId=${id}, title=${title}`);
    return c.json(session);
  });

  // POST /:id/messages — 发送消息（返回 SSE 流）
  app.post("/:id/messages", (c) => {
    const id = c.req.param("id");
    log.info("sendMessage", `entry method=POST, path=/sessions/${id}/messages, sessionId=${id}`);

    // 设置 SSE 响应头：禁用代理缓冲 + 禁用缓存
    // 这些头确保 Vite proxy / nginx 等中间代理层不缓冲流式响应
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    c.header("Connection", "keep-alive");

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

      log.info("sendMessage", `content preview=${String(content).slice(0, 50)}, model=${model ?? "(default)"}`);

      try {
        const events = sessionManager.sendMessage(id, content, model);

        for await (const event of events) {
          const frame = agentEventToSSE(event);
          log.debug("sendMessage", `SSE event type=${frame.event}`);
          await stream.writeSSE({
            event: frame.event,
            data: frame.data,
          });
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);

        log.error("sendMessage", `error: ${message}`);

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
    log.info("interrupt", `sessionId=${id}`);
    const interrupted = sessionManager.interrupt(id);
    log.info("interrupt", `sessionId=${id}, interrupted=${interrupted}`);
    return c.json({ interrupted }, interrupted ? 200 : 404);
  });

  // POST /:id/permissions/:reqId — 权限响应
  app.post("/:id/permissions/:reqId", async (c) => {
    const id = c.req.param("id");
    const reqId = c.req.param("reqId");
    const body = await c.req.json().catch(() => ({}));

    // 构造 PermissionResult
    const decision = body.decision === "deny" ? "deny" : "allow";
    log.info("respondPermission", `sessionId=${id}, reqId=${reqId}, decision=${decision}`);
    const result =
      decision === "deny"
        ? { decision: "deny" as const, reason: body.reason }
        : { decision: "allow" as const };

    const responded = sessionManager.respondPermission(id, reqId, result);
    log.info("respondPermission", `sessionId=${id}, reqId=${reqId}, responded=${responded}`);
    return c.json({ responded }, responded ? 200 : 404);
  });

  // GET /:id/permissions — 获取待处理权限请求列表
  app.get("/:id/permissions", (c) => {
    const id = c.req.param("id");
    const pending = sessionManager.getPendingPermissions(id);
    return c.json(pending);
  });

  // GET /:id/graph — 对话图（节点/分支/溯源链，Phase 3/4 分支可视化）
  app.get("/:id/graph", (c) => {
    const id = c.req.param("id");
    log.info("getGraph", `sessionId=${id}`);
    const graph = sessionManager.getGraph(id);
    if (!graph) {
      return c.json({ error: `Graph not available for session "${id}"` }, 404);
    }
    return c.json(graph);
  });

  // POST /:id/rollback — 回退到目标节点（旧分支保留可溯源，Phase 4）
  app.post("/:id/rollback", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const nodeId =
      typeof body.nodeId === "string" && body.nodeId ? body.nodeId : undefined;
    const reason =
      typeof body.reason === "string" && body.reason ? body.reason : "用户回退";
    log.info("rollback", `sessionId=${id}, nodeId=${nodeId ?? "(last assistant)"}, reason=${reason}`);
    const result = sessionManager.rollbackSession(id, nodeId, reason);
    return c.json(result, result.ok ? 200 : 400);
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
    log.info("destroySession", `sessionId=${id}`);
    sessionManager.destroySession(id);
    return c.json({ deleted: true });
  });

  return app;
}
