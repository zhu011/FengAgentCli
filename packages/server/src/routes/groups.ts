/**
 * @fengagent/server — 群聊路由（G1 契约冻结 v1.0）
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET | `/api/groups` | `{groups, runtimes}`（runtimes 供成员选择器） |
 * | POST | `/api/groups` | 建群 → GroupInfo（成员未注册/未启用 → 400） |
 * | GET | `/api/groups/:id` | `{group, messages}`（**全量**消息，G1 量小不分页） |
 * | PATCH | `/api/groups/:id` | 改名/描述/成员/轮数（附加：契约外用，方便前端改名） |
 * | POST | `/api/groups/:id/messages` | 人发言 → GroupMessage（关群 409） |
 * | POST | `/api/groups/:id/agent-messages` | runtime/协调者发言（非成员 403，关群 409） |
 * | POST | `/api/groups/:id/conclude` | 关群 → GroupInfo（幂等） |
 * | GET | `/api/groups/:id/messages` | 增量读取 `{messages, nextSeq}`（`after`/`limit`，附加） |
 * | GET | `/api/groups/:id/stream` | SSE：snapshot → 实时 message/group/heartbeat |
 *
 * 错误体统一 `{ error: { message, code } }`，`code ∈ bad_request | not_found | forbidden | conflict`。
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createLogger } from "@fengagent/shared";
import type { AgentGroupStatus } from "@fengagent/agent";
import {
  GroupError,
  type AgentGroupService,
  type GroupMessageDto,
  type GroupStreamEvent,
} from "../agent-group-service.ts";

const log = createLogger("group-routes");

/** 合法群状态（契约 v1.0） */
const STATUSES: readonly AgentGroupStatus[] = ["open", "concluded"];

/** 错误体（契约：`{error:{message,code}}`） */
type ErrorCode = "bad_request" | "not_found" | "forbidden" | "conflict";

/** 状态码映射 */
const STATUS_BY_CODE: Record<ErrorCode, 400 | 403 | 404 | 409> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

/** 统一错误响应 */
function fail(
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409) => Response },
  message: string,
  code: ErrorCode,
): Response {
  return c.json({ error: { message, code } }, STATUS_BY_CODE[code]);
}

/** 从异常取 (message, code) —— GroupError 带码，其余按 bad_request */
function toErrorPayload(err: unknown): { message: string; code: ErrorCode } {
  if (err instanceof GroupError) return { message: err.message, code: err.code };
  return { message: err instanceof Error ? err.message : String(err), code: "bad_request" };
}

/** SSE 帧队列（与 agent-tasks 同款：订阅回调只入队 + 唤醒） */
function createFrameQueue() {
  const pending: GroupStreamEvent[] = [];
  let waiter: (() => void) | null = null;

  const push = (frame: GroupStreamEvent): void => {
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
  const next = (): Promise<GroupStreamEvent | null> => {
    if (pending.length > 0) return Promise.resolve(pending.shift()!);
    return new Promise<GroupStreamEvent | null>((resolve) => {
      waiter = () => resolve(pending.length > 0 ? pending.shift()! : null);
    });
  };
  return { push, wake, next };
}

/**
 * 群聊路由。
 *
 * @param service - 群服务
 */
export function createGroupRoutes(service: AgentGroupService): Hono {
  const app = new Hono();

  // GET / — 群列表 + runtime 卡片
  app.get("/", (c) => {
    const rawStatus = c.req.query("status");
    const statuses =
      rawStatus === undefined || rawStatus === ""
        ? undefined
        : rawStatus
            .split(",")
            .map((s) => s.trim())
            .filter((s): s is AgentGroupStatus => (STATUSES as readonly string[]).includes(s));
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
    const groups = service.listGroups({
      ...(statuses === undefined || statuses.length === 0
        ? {}
        : { status: statuses.length === 1 ? statuses[0]! : statuses }),
      ...(limit === undefined ? {} : { limit }),
    });
    return c.json({ groups, runtimes: service.listRuntimes() });
  });

  // POST / — 建群
  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "") return fail(c, "name 必填", "bad_request");
    const members = Array.isArray(body.members)
      ? body.members.filter((m): m is string => typeof m === "string" && m.trim() !== "")
      : [];
    try {
      const group = service.createGroup({
        name,
        members,
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(typeof body.maxRounds === "number" ? { maxRounds: body.maxRounds } : {}),
        ...(typeof body.coordinator === "string" ? { coordinator: body.coordinator } : {}),
        ...(typeof body.createdBy === "string" ? { createdBy: body.createdBy } : {}),
      });
      return c.json(group, 201);
    } catch (err) {
      const payload = toErrorPayload(err);
      return fail(c, payload.message, payload.code);
    }
  });

  // GET /:id — 群详情 + 全量消息
  app.get("/:id", (c) => {
    const id = c.req.param("id");
    const group = service.getGroup(id);
    if (!group) return fail(c, `群不存在: ${id}`, "not_found");
    return c.json({ group, messages: service.listMessages(id) });
  });

  // PATCH /:id — 改名/描述/成员/轮数（契约外的附加便利接口）
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!service.getGroup(id)) return fail(c, `群不存在: ${id}`, "not_found");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      return c.json(
        service.updateGroup(id, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.status === "string" &&
          (STATUSES as readonly string[]).includes(body.status)
            ? { status: body.status as AgentGroupStatus }
            : {}),
          ...(Array.isArray(body.members)
            ? {
                members: body.members.filter(
                  (m): m is string => typeof m === "string" && m.trim() !== "",
                ),
              }
            : {}),
          ...(typeof body.maxRounds === "number" ? { maxRounds: body.maxRounds } : {}),
        }),
      );
    } catch (err) {
      const payload = toErrorPayload(err);
      return fail(c, payload.message, payload.code);
    }
  });

  // POST /:id/messages — 人发言
  app.post("/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!service.getGroup(id)) return fail(c, `群不存在: ${id}`, "not_found");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const content = typeof body.content === "string" ? body.content : "";
    if (content.trim() === "") return fail(c, "content 必填", "bad_request");
    try {
      const message = service.postHumanMessage(id, {
        content,
        ...(body.kind === "chat" ? { kind: "chat" as const } : {}),
      });
      return c.json(message, 201);
    } catch (err) {
      const payload = toErrorPayload(err);
      return fail(c, payload.message, payload.code);
    }
  });

  // POST /:id/agent-messages — runtime/协调者发言（服务端装配调用，不对外开放鉴权）
  app.post("/:id/agent-messages", async (c) => {
    const id = c.req.param("id");
    if (!service.getGroup(id)) return fail(c, `群不存在: ${id}`, "not_found");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const content = typeof body.content === "string" ? body.content : "";
    const fromName = typeof body.fromName === "string" ? body.fromName.trim() : "";
    if (content.trim() === "") return fail(c, "content 必填", "bad_request");
    if (fromName === "") return fail(c, "fromName 必填", "bad_request");
    try {
      const message = service.postAgentMessage(id, {
        content,
        fromName,
        ...(typeof body.kind === "string" ? { kind: body.kind as never } : {}),
      });
      return c.json(message, 201);
    } catch (err) {
      const payload = toErrorPayload(err);
      return fail(c, payload.message, payload.code);
    }
  });

  // POST /:id/conclude — 关群（幂等）
  app.post("/:id/conclude", (c) => {
    const id = c.req.param("id");
    try {
      return c.json(service.concludeGroup(id));
    } catch (err) {
      const payload = toErrorPayload(err);
      return fail(c, payload.message, payload.code);
    }
  });

  // GET /:id/messages — 增量读取（after / limit；SSE 重连同款语义）
  app.get("/:id/messages", (c) => {
    const id = c.req.param("id");
    if (!service.getGroup(id)) return fail(c, `群不存在: ${id}`, "not_found");
    const rawAfter = Number.parseInt(c.req.query("after") ?? "", 10);
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const messages = service.listMessagesAfter(id, {
      ...(Number.isFinite(rawAfter) && rawAfter > 0 ? { after: rawAfter } : {}),
      ...(Number.isFinite(rawLimit) && rawLimit > 0 ? { limit: rawLimit } : {}),
    });
    const nextSeq =
      messages.length > 0 ? messages[messages.length - 1]!.seq : service.store.lastSeq(id);
    return c.json({ messages, nextSeq });
  });

  // GET /:id/stream — 群 SSE
  app.get("/:id/stream", (c) => {
    const id = c.req.param("id");
    const snapshot = service.getGroup(id);
    if (!snapshot) return fail(c, `群不存在: ${id}`, "not_found");

    const rawAfter = c.req.query("after") ?? c.req.header("Last-Event-ID") ?? "0";
    const parsedAfter = Number.parseInt(rawAfter, 10);
    const after = Number.isFinite(parsedAfter) && parsedAfter > 0 ? parsedAfter : 0;

    return streamSSE(c, async (stream) => {
      const queue = createFrameQueue();
      let closed = false;
      let seq = after;

      const write = async (frame: GroupStreamEvent): Promise<void> => {
        if (frame.type === "message" && frame.message.seq > seq) seq = frame.message.seq;
        await stream.writeSSE(
          frame.type === "message"
            ? { event: frame.type, id: String(frame.message.seq), data: JSON.stringify(frame) }
            : { event: frame.type, data: JSON.stringify(frame) },
        );
      };

      // ① 快照：契约要求「含 after 之后的消息回放」+ lastSeq
      const backlog: GroupMessageDto[] = service.listMessagesAfter(id, { after });
      const lastSeq =
        backlog.length > 0 ? backlog[backlog.length - 1]!.seq : service.store.lastSeq(id);
      await write({ type: "snapshot", group: snapshot, messages: backlog, lastSeq });

      // ② 实时
      const unsubscribe = service.subscribe(id, (frame) => queue.push(frame));
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        queue.wake();
      });
      const heartbeat = setInterval(() => {
        queue.push({ type: "heartbeat" });
      }, 15_000);

      try {
        while (!closed) {
          const frame = await queue.next();
          if (frame === null) continue;
          await write(frame);
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

/** 供 server.ts 挂载（导出便于测试） */
export function mountGroupRoutes(app: Hono, service: AgentGroupService): void {
  app.route("/api/groups", createGroupRoutes(service));
}
