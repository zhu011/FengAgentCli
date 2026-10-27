/**
 * @fengagent/server — Agents 外派面板路由（P2 契约）
 *
 * 与 WebUI `packages/web-ui/src/api/client.ts`（P3 已冻结）逐条对齐：
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET | `/api/runtimes` | runtime 卡片数组（`?probe=1` 触发一次真探测） |
 * | POST | `/api/runtimes/probe` | 显式探测全部 |
 * | GET | `/api/agent-tasks` | `{tasks, nextCursor?, runtimes}`（`status`/`runtime`/`limit`/`cursor`） |
 * | POST | `/api/agent-tasks` | 建任务并派发 → task |
 * | GET | `/api/agent-tasks/:id` | `{task, events}` |
 * | POST | `/api/agent-tasks/:id/cancel` | 取消（终态 409） |
 * | POST | `/api/agent-tasks/:id/retry` | 重试（新 attempt，事件留痕） |
 * | GET | `/api/agent-tasks/:id/stream` | SSE：snapshot → 事件回放（`?after=<seq>`）→ 实时 chunk |
 *
 * SSE 断线重连用 `?after=<seq>`（也接受 `Last-Event-ID`）：重连只补发 `seq` 之后的事件，
 * 不重复渲染历史时间线。
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentTaskStatus } from "@fengagent/agent";
import { isTerminalTaskStatus } from "@fengagent/agent";
import { createLogger } from "@fengagent/shared";
import type { AgentTaskService, AgentTaskStreamEvent } from "../agent-task-service.ts";

const log = createLogger("agent-task-routes");

/** 合法状态枚举（请求参数校验用） */
const STATUSES: readonly AgentTaskStatus[] = [
  "created",
  "dispatched",
  "running",
  "replied",
  "failed",
  "cancelled",
  "expired",
];

/** 简单事件队列（SSE writer 顺序写出；订阅回调只入队 + 唤醒） */
function createFrameQueue() {
  const pending: AgentTaskStreamEvent[] = [];
  let waiter: (() => void) | null = null;

  const push = (frame: AgentTaskStreamEvent): void => {
    pending.push(frame);
    const w = waiter;
    waiter = null;
    w?.();
  };
  const wake = (): void => {
    const w = waiter;
    waiter = null;
    w?.();
  };
  const next = (): Promise<AgentTaskStreamEvent | null> => {
    if (pending.length > 0) return Promise.resolve(pending.shift()!);
    return new Promise<AgentTaskStreamEvent | null>((resolve) => {
      waiter = () => resolve(pending.length > 0 ? pending.shift()! : null);
    });
  };
  return { push, wake, next };
}

/**
 * `/api/runtimes` 路由。
 *
 * @param service - 外派任务服务
 */
export function createRuntimeRoutes(service: AgentTaskService): Hono {
  const app = new Hono();

  // GET / — runtime 卡片（?probe=1 时先探测再回）
  app.get("/", async (c) => {
    const probe = c.req.query("probe");
    if (probe === "1" || probe === "true") {
      return c.json(await service.probeRuntimes());
    }
    return c.json(service.listRuntimes());
  });

  // POST /probe — 显式探测全部（页面「重新探测」按钮）
  app.post("/probe", async (c) => c.json(await service.probeRuntimes()));

  // POST /:name/enabled — 启停某个 runtime（不影响历史任务）
  app.post("/:name/enabled", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled 必须是布尔值" }, 400);
    }
    try {
      service.registry.setEnabled(name, body.enabled);
      return c.json(service.listRuntimes());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  return app;
}

/**
 * `/api/agent-tasks` 路由。
 *
 * @param service - 外派任务服务
 */
export function createAgentTaskRoutes(service: AgentTaskService): Hono {
  const app = new Hono();

  // GET / — 列表 + runtime 卡片（契约：一次请求拿两屏数据）
  app.get("/", (c) => {
    const rawStatus = c.req.query("status");
    const statuses =
      rawStatus === undefined || rawStatus === ""
        ? undefined
        : rawStatus
            .split(",")
            .map((s) => s.trim())
            .filter((s): s is AgentTaskStatus => (STATUSES as readonly string[]).includes(s));
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
    const runtime = c.req.query("runtime");
    const groupId = c.req.query("groupId");
    const cursor = c.req.query("cursor");

    const page = service.listTasks({
      ...(statuses === undefined || statuses.length === 0 ? {} : { status: statuses }),
      ...(runtime === undefined || runtime === "" ? {} : { runtime }),
      ...(groupId === undefined || groupId === "" ? {} : { groupId }),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined || cursor === "" ? {} : { cursor }),
    });
    return c.json({
      tasks: page.tasks,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      runtimes: service.listRuntimes(),
    });
  });

  // POST / — 建任务并派发
  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const runtime = typeof body.runtime === "string" ? body.runtime.trim() : "";
    const content = typeof body.content === "string" ? body.content : "";
    if (runtime === "") return c.json({ error: "runtime 必填" }, 400);
    if (content.trim() === "") return c.json({ error: "content 必填" }, 400);

    const fromSession =
      typeof body.fromSession === "string" && body.fromSession !== ""
        ? body.fromSession
        : undefined;
    const cwd = typeof body.cwd === "string" && body.cwd !== "" ? body.cwd : undefined;
    const groupId =
      typeof body.groupId === "string" && body.groupId !== "" ? body.groupId : undefined;
    const idempotencyKey =
      typeof body.idempotencyKey === "string" && body.idempotencyKey !== ""
        ? body.idempotencyKey
        : undefined;

    try {
      const task = await service.submit({
        runtime,
        content,
        ...(fromSession === undefined ? {} : { fromSession }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(groupId === undefined ? {} : { groupId }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
      return c.json(task, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("create", `建任务失败: ${message}`);
      return c.json({ error: message }, 400);
    }
  });

  // GET /:id — 详情 + 事件日志
  app.get("/:id", (c) => {
    const id = c.req.param("id");
    const task = service.getTask(id);
    if (!task) return c.json({ error: `任务不存在: ${id}` }, 404);
    return c.json({ task, events: service.listEvents(id) });
  });

  // POST /:id/cancel — 取消（终态 409）
  app.post("/:id/cancel", (c) => {
    const id = c.req.param("id");
    try {
      return c.json(service.cancel(id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith("任务不存在") ? 404 : 409;
      return c.json({ error: message }, status);
    }
  });

  // POST /:id/retry — 重试（终态才有意义）
  app.post("/:id/retry", (c) => {
    const id = c.req.param("id");
    try {
      return c.json(service.retry(id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith("任务不存在") ? 404 : 409;
      return c.json({ error: message }, status);
    }
  });

  // GET /:id/stream — SSE（snapshot → 历史事件 → 实时进度）
  app.get("/:id/stream", (c) => {
    const id = c.req.param("id");
    const snapshot = service.getTask(id);
    if (!snapshot) return c.json({ error: `任务不存在: ${id}` }, 404);

    const rawAfter = c.req.query("after") ?? c.req.header("Last-Event-ID") ?? "0";
    const parsedAfter = Number.parseInt(rawAfter, 10);
    const after = Number.isFinite(parsedAfter) && parsedAfter > 0 ? parsedAfter : 0;

    return streamSSE(c, async (stream) => {
      const queue = createFrameQueue();
      let closed = false;
      let seq = after;

      const write = async (frame: AgentTaskStreamEvent): Promise<void> => {
        if (frame.type === "event" && frame.event.seq > seq) seq = frame.event.seq;
        await stream.writeSSE(
          frame.type === "event"
            ? { event: frame.type, id: String(frame.event.seq), data: JSON.stringify(frame) }
            : { event: frame.type, data: JSON.stringify(frame) },
        );
      };

      // ① 快照（重连时先让 UI 对齐当前状态）
      await write({ type: "status", task: snapshot });
      // ② 事件回放（只补 after 之后的）
      for (const event of service.listEvents(id, after)) {
        await write({ type: "event", event });
      }
      if (isTerminalTaskStatus(snapshot.status)) return;

      // ③ 实时：订阅 + 心跳
      const unsubscribe = service.subscribe(id, (frame) => queue.push(frame));
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        queue.wake();
      });
      const heartbeat = setInterval(() => {
        void stream.write(": heartbeat\n\n").catch(() => undefined);
      }, 15_000);

      try {
        while (!closed) {
          const frame = await queue.next();
          if (frame === null) continue;
          await write(frame);
          if (frame.type === "status" && isTerminalTaskStatus(frame.task.status)) break;
        }
      } catch (err) {
        log.debug("stream", `SSE 写出中断: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });

  return app;
}

/** 供 server.ts 一次挂载两个前缀（导出便于测试） */
export function mountAgentTaskRoutes(app: Hono, service: AgentTaskService): void {
  app.route("/api/runtimes", createRuntimeRoutes(service));
  app.route("/api/agent-tasks", createAgentTaskRoutes(service));
}
