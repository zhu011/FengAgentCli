/**
 * @fengagent/server — 会话路由
 *
 * 会话创建、列表、消息发送（SSE）、中断、导出。
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SessionManager } from "../session-manager.ts";
import type { SessionEvent } from "../session-manager.ts";
import { agentEventToSSE } from "../sse.ts";
import type { AgentEvent } from "@fengagent/core";
import { createLogger } from "@fengagent/shared";

/**
 * 事件桥 — 把订阅回调投递的会话事件排入队列，供 SSE writer 顺序写出。
 *
 * 客户端断开（onAbort / writeSSE 抛错）只会 wake 等待中的 writer；writer 由
 * `aborted` 标志退出并解除订阅 —— 后台运行（SessionManager 泵送）不受影响。
 */
function createEventQueue() {
  const pending: SessionEvent[] = [];
  let waiter: (() => void) | null = null;

  const push = (ev: SessionEvent): void => {
    pending.push(ev);
    const w = waiter;
    waiter = null;
    w?.();
  };
  const wake = (): void => {
    const w = waiter;
    waiter = null;
    w?.();
  };
  /** 取下一个事件；被 wake 且无积压时返回 null（调用方重查中止标志） */
  const next = (): Promise<SessionEvent | null> => {
    if (pending.length > 0) return Promise.resolve(pending.shift()!);
    return new Promise<SessionEvent | null>((resolve) => {
      waiter = () => {
        resolve(pending.length > 0 ? pending.shift()! : null);
      };
    });
  };

  return { push, wake, next };
}

/** 写一条 AgentEvent 形状的 SSE 帧 */
async function writeAgentEventSSE(
  stream: import("hono/streaming").SSEStreamingApi,
  event: AgentEvent,
): Promise<void> {
  const frame = agentEventToSSE(event);
  await stream.writeSSE({ event: frame.event, data: frame.data });
}

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
  //
  // 真后台并发语义（AGE-29）：本请求只负责「发起运行 + 订阅该会话的事件流」。
  // Loop 由 SessionManager 后台泵送（与连接解耦）：
  // - 客户端断开 / 切换会话不再中止后台运行 —— 运行继续，其它订阅者可接管；
  // - 事件按会话路由，只推送给订阅该会话的客户端；
  // - 运行结束（run-end 标记）后本流关闭，后台任务已在 SessionManager 侧清理。
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

      // 订阅该会话的事件流（先订阅再启动，避免漏掉首帧）
      const queue = createEventQueue();
      let aborted = false;
      const unsub = sessionManager.subscribeSessionEvents(id, (ev) =>
        queue.push(ev),
      );
      stream.onAbort(() => {
        aborted = true;
        queue.wake();
      });

      try {
        // 后台启动运行（同一会话并发防护在 SessionManager 内）
        const started = sessionManager.startMessageRun(id, content, model);
        if (!started.ok) {
          log.info("sendMessage", `rejected ${started.code} sessionId=${id}`);
          await writeAgentEventSSE(stream, {
            type: "error",
            error: { message: started.message },
          });
          return;
        }

        // writer：顺序写出订阅到的会话事件，直至 run-end / 客户端断开
        while (!aborted && !stream.aborted && !stream.closed) {
          const ev = await queue.next();
          if (ev === null) continue; // 被 wake（客户端断开）→ 重查中止标志
          if (ev.type === "run-end") break; // 运行结束 → 关闭本流
          await writeAgentEventSSE(stream, ev);
        }
      } catch (err) {
        // 客户端断开或写入失败：仅解除订阅；后台运行继续（真后台语义，不遗留任务）
        log.debug(
          "sendMessage",
          `stream closed (client disconnect?) sessionId=${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
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
        : body.input !== undefined
          ? // allow 携带用户修改后的工具入参（human-in-the-loop 改参重试）
            { decision: "allow" as const, input: body.input }
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

  // POST /:id/rollback — 回退到目标节点（旧分支保留可溯源，Phase 4；仅截断不重答）
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

  // POST /:id/rollback-retry — 回退到目标节点并自动重答（SSE 流；WebUI 图面板「回退并重答」闭环）
  // 与 CLI /rollback <节点id> 同一语义：回退（旧分支作废保留）→ 截断 → 重答（新回答挂在分支点下）
  // 并发语义与 POST /:id/messages 一致：后台泵送 + 按会话订阅（见该路由注释）。
  app.post("/:id/rollback-retry", (c) => {
    const id = c.req.param("id");
    log.info("rollbackRetry", `sessionId=${id}`);

    // 设置 SSE 响应头（与 sendMessage 一致：禁用代理缓冲 / 缓存）
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    c.header("Connection", "keep-alive");

    return streamSSE(c, async (stream) => {
      const body = await c.req.json().catch(() => ({}));
      const nodeId =
        typeof body.nodeId === "string" && body.nodeId ? body.nodeId : undefined;
      const reason =
        typeof body.reason === "string" && body.reason
          ? body.reason
          : "用户回退并重答";

      // 订阅该会话的事件流（先订阅再启动）
      const queue = createEventQueue();
      let aborted = false;
      const unsub = sessionManager.subscribeSessionEvents(id, (ev) =>
        queue.push(ev),
      );
      stream.onAbort(() => {
        aborted = true;
        queue.wake();
      });

      try {
        const started = sessionManager.startRollbackRetryRun(id, nodeId, reason);
        if (!started.ok) {
          log.info("rollbackRetry", `rejected ${started.code} sessionId=${id}`);
          await writeAgentEventSSE(stream, {
            type: "error",
            error: { message: started.message },
          });
          return;
        }

        while (!aborted && !stream.aborted && !stream.closed) {
          const ev = await queue.next();
          if (ev === null) continue;
          if (ev.type === "run-end") break;
          await writeAgentEventSSE(stream, ev);
        }
      } catch (err) {
        // 客户端断开：仅解除订阅；后台回退重答继续运行
        log.debug(
          "rollbackRetry",
          `stream closed (client disconnect?) sessionId=${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        unsub();
      }
    });
  });

  // GET /:id/events — 订阅会话事件流（按会话路由，SSE）
  //
  // 与 POST /:id/messages 的区别：纯订阅通道，可随时连接 / 断开，不影响运行。
  // - 订阅时若该会话正在运行，会先回放本次运行已产生的事件（补看进度），
  //   随后实时接收；
  // - 会话空闲时保持连接（心跳注释行），下一次运行的事件自动送达；
  // - 客户端断开只解除订阅，后台运行不受影响。
  app.get("/:id/events", (c) => {
    const id = c.req.param("id");
    log.info("sessionEvents", `subscribe sessionId=${id}`);

    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    c.header("Connection", "keep-alive");

    return streamSSE(c, async (stream) => {
      const session = sessionManager.getSession(id);
      if (!session) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            type: "error",
            error: { message: `Session "${id}" not found` },
            code: "session_not_found",
          }),
        });
        return;
      }

      const queue = createEventQueue();
      let aborted = false;
      const unsub = sessionManager.subscribeSessionEvents(id, (ev) =>
        queue.push(ev),
      );
      stream.onAbort(() => {
        aborted = true;
        queue.wake();
      });

      // 心跳：注释行保持连接（代理不超时断开），并借机探测客户端是否存活
      const heartbeat = setInterval(() => {
        void stream
          .write(": heartbeat\n\n")
          .catch(() => {
            aborted = true;
            queue.wake();
          });
      }, 15_000);

      try {
        while (!aborted && !stream.aborted && !stream.closed) {
          const ev = await queue.next();
          if (ev === null) continue;
          if (ev.type === "run-end") {
            // 运行结束标记照常下发（客户端据此结束本轮「附加」），但连接保持
            // 打开 —— 下一次运行的事件仍会送达本订阅。
            await stream.writeSSE({
              event: "run-end",
              data: JSON.stringify(ev),
            });
            continue;
          }
          await writeAgentEventSSE(stream, ev);
        }
      } catch (err) {
        log.debug(
          "sessionEvents",
          `stream closed (client disconnect?) sessionId=${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearInterval(heartbeat);
        unsub();
      }
    });
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
