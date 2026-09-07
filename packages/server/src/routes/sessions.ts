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
import type { AgentEvent } from "@fengagent/core";

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

  // POST /:id/messages — 发送消息（订阅 + 后台启动，客户端断开仅解除订阅、后台继续）
  app.post("/:id/messages", (c) => {
    const id = c.req.param("id");
    log.info("sendMessage", `entry method=POST, path=/sessions/${id}/messages, sessionId=${id}`);

    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    c.header("Connection", "keep-alive");

    return streamSSE(c, async (stream) => {
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

      // 先订阅（回放 + 实时），再后台启动 — 客户端断开仅解除订阅
      const unsub = sessionManager.subscribeSessionEvents(id, async (e) => {
        const frame = agentEventToSSE(e as AgentEvent);
        try {
          await stream.writeSSE({ event: frame.event, data: frame.data });
        } catch { /* 客户端已断开 */ }
        if (e.type === "run-end") {
          await stream.close();
        }
      });

      try {
        stream.onAbort(() => {
          unsub();
          log.info("sendMessage", `client disconnected, sessionId=${id}, background continues`);
        });

        sessionManager.startMessageRun(id, content, model);
        // 等待 run-end（后台泵送完成后订阅者收到 run-end → stream.close）
        // 如果客户端先断开，unsub 已调用，后台继续
        await new Promise<void>((resolve) => {
          const checkEnd = () => {
            if (stream.aborted) { resolve(); return; }
            setTimeout(checkEnd, 100);
          };
          checkEnd();
        });
      } catch (err) {
        unsub();
        const message = err instanceof Error ? err.message : String(err);
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

  // GET /:id/events — 纯订阅通道（回放 + 实时 + 心跳，供重连/多客户端附加）
  app.get("/:id/events", (c) => {
    const id = c.req.param("id");
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    c.header("Connection", "keep-alive");

    return streamSSE(c, async (stream) => {
      const unsub = sessionManager.subscribeSessionEvents(id, async (e) => {
        const frame = agentEventToSSE(e as AgentEvent);
        try {
          await stream.writeSSE({ event: frame.event, data: frame.data });
        } catch { /* 客户端已断开 */ }
        if (e.type === "run-end") {
          // run-end 不关闭持久订阅流（客户端可能想等下一次运行）
        }
      });

      stream.onAbort(() => {
        unsub();
        log.info("sessionEvents", `unsubscribe sessionId=${id}`);
      });

      // 心跳（每 15s）+ 等待断开
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
      }, 15_000);

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        clearInterval(heartbeat);
        unsub();
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
