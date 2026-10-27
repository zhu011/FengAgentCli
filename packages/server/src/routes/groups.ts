/**
 * @fengagent/server — 群聊路由（G1 契约 v1.0）
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET | `/api/groups` | `{groups, runtimes}`（`status` / `limit`；runtimes 供成员选择器） |
 * | POST | `/api/groups` | 建群 → 201 GroupInfo |
 * | GET | `/api/groups/:id` | `{group, messages}`（最近 50 条，seq 升序） |
 * | PATCH | `/api/groups/:id` | 改群名/描述/成员/轮数/状态（`concluded` = 关群） |
 * | GET | `/api/groups/:id/messages` | `{messages, nextSeq}`（`after` / `limit`） |
 * | POST | `/api/groups/:id/messages` | 人发言 → 201 GroupMessage（关群后 409） |
 * | GET | `/api/groups/:id/stream` | 群 SSE：`snapshot` → `after` 之后的消息回放 → 实时 `message` / `group` |
 *
 * 404/400/409 口径与 `/api/agent-tasks` 一致：不存在 404、参数不合法 400、
 * 状态不允许（群已关闭）409。
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createLogger } from "@fengagent/shared";
import type { AgentGroupStatus } from "@fengagent/agent";
import type {
  AgentGroupService,
  GroupInfoDto,
  GroupStreamEvent,
} from "../agent-group-service.ts";

const log = createLogger("group-routes");

/** 合法群状态（契约 v1.0） */
const STATUSES: readonly AgentGroupStatus[] = ["open", "concluded"];

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

  // GET / — 群列表 + runtime 卡片（成员选择器）
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
    if (name === "") return c.json({ error: "name 必填" }, 400);
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
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  // GET /:id — 群详情 + 最近消息
  app.get("/:id", (c) => {
    const id = c.req.param("id");
    const group = service.getGroup(id);
    if (!group) return c.json({ error: `群不存在: ${id}` }, 404);
    return c.json({ group, messages: service.listRecentMessages(id, 50) });
  });

  // PATCH /:id — 改群（含关群 status=concluded）
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!service.getGroup(id)) return c.json({ error: `群不存在: ${id}` }, 404);
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
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  // GET /:id/messages — 增量读取（after / limit）
  app.get("/:id/messages", (c) => {
    const id = c.req.param("id");
    if (!service.getGroup(id)) return c.json({ error: `群不存在: ${id}` }, 404);
    const rawAfter = Number.parseInt(c.req.query("after") ?? "", 10);
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const messages = service.listMessages(id, {
      ...(Number.isFinite(rawAfter) && rawAfter > 0 ? { after: rawAfter } : {}),
      ...(Number.isFinite(rawLimit) && rawLimit > 0 ? { limit: rawLimit } : {}),
    });
    const nextSeq =
      messages.length > 0 ? messages[messages.length - 1]!.seq : service.store.lastSeq(id);
    return c.json({ messages, nextSeq });
  });

  // POST /:id/messages — 人发言
  app.post("/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!service.getGroup(id)) return c.json({ error: `群不存在: ${id}` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const content = typeof body.content === "string" ? body.content : "";
    if (content.trim() === "") return c.json({ error: "content 必填" }, 400);
    try {
      const message = service.postMessage(id, {
        content,
        ...(typeof body.fromName === "string" ? { fromName: body.fromName } : {}),
        ...(typeof body.kind === "string" ? { kind: body.kind as never } : {}),
        ...(typeof body.agentTaskId === "string" ? { agentTaskId: body.agentTaskId } : {}),
      });
      return c.json(message, 201);
    } catch (err) {
      const message = errorMessage(err);
      const status = message.includes("已关闭") ? 409 : 400;
      return c.json({ error: message }, status);
    }
  });

  // GET /:id/stream — 群 SSE（snapshot → 回放 → 实时）
  app.get("/:id/stream", (c) => {
    const id = c.req.param("id");
    const snapshot = service.getGroup(id);
    if (!snapshot) return c.json({ error: `群不存在: ${id}` }, 404);

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

      // ① 快照（契约：group + 最近消息 + lastSeq，一次给全）
      const recent = service.listRecentMessages(id, 50);
      await write({
        type: "snapshot",
        group: snapshot,
        messages: recent,
        lastSeq: recent.length > 0 ? recent[recent.length - 1]!.seq : 0,
      });
      // ② 回放 `after` 之后、且不在快照里的消息（重连补齐）
      const snapshotFloor = recent.length > 0 ? recent[0]!.seq : 0;
      const replayAfter = Math.max(after, snapshotFloor - 1);
      for (const message of service.listMessages(id, { after: replayAfter })) {
        await write({ type: "message", message });
      }

      // ③ 实时
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
        }
      } catch (err) {
        log.debug("stream", `SSE 写出中断: ${errorMessage(err)}`);
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });

  return app;
}

/** 错误信息提取 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 供 server.ts 挂载（导出便于测试） */
export function mountGroupRoutes(app: Hono, service: AgentGroupService): void {
  app.route("/api/groups", createGroupRoutes(service));
}

/** 群 DTO 的唯一形状（测试断言用） */
export type { GroupInfoDto };
