/**
 * @fengagent/server — 群聊 API + 群工具测试（G1 契约冻结 v1.0）
 *
 * 契约口径（与 `web-ui/src/api/types.ts` 群聊段一致）：
 * `{groups, runtimes}` / `GroupInfo` / `GroupMessage` / `{group, messages}` /
 * SSE `snapshot|message|group|heartbeat` / 错误体 `{error:{message,code}}` /
 * id 前缀 `grp_` `msg_`。
 *
 * v1「协调者中转」两条硬边界：
 * 1. 关群后 API 拒绝发言（409），历史仍可读；
 * 2. 群工具（fengagent 侧）走同一份 service —— 说话人落 `coordinator`；
 *    外部 runtime 的产出只能由服务端代写（`runtime` + agentTaskId）。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentGroupService } from "../agent-group-service.ts";
import { createGroupRoutes } from "../routes/groups.ts";
import { createGroupTools } from "@fengagent/tools";
import type { RuntimeInfo } from "../agent-runtimes.ts";

/** 三个启用 runtime 的卡片（建群成员校验用） */
function runtimeCard(name: string): RuntimeInfo {
  return {
    name,
    command: `${name} acp`,
    agentName: name,
    agentVersion: "0.0.1",
    capabilities: { resume: true, loadSession: true, image: false },
    probeStatus: "ok",
    enabled: true,
    recentTaskCount: 0,
  };
}

function makeService(): {
  service: AgentGroupService;
  dir: string;
  app: ReturnType<typeof createGroupRoutes>;
} {
  const dir = mkdtempSync(join(tmpdir(), "feng-groups-api-"));
  const service = new AgentGroupService({
    dataRoot: dir,
    runtimes: () => [runtimeCard("kimi"), runtimeCard("dsh"), runtimeCard("fengagent")],
  });
  return { service, dir, app: createGroupRoutes(service) };
}

function safeRm(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
}

/** 建群辅助（默认成员 kimi，协调者 fengagent） */
async function createGroup(
  app: ReturnType<typeof createGroupRoutes>,
  body: Record<string, unknown> = {},
): Promise<{ id: string; name: string; members: string[] }> {
  const res = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "接入评审", members: ["kimi"], ...body }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; name: string; members: string[] };
}

describe("Groups API — G1 契约", () => {
  let service: AgentGroupService;
  let dir: string;
  let app: ReturnType<typeof createGroupRoutes>;

  beforeEach(() => {
    const made = makeService();
    service = made.service;
    dir = made.dir;
    app = made.app;
  });

  afterEach(() => {
    service.close();
    safeRm(dir);
  });

  test("POST /api/groups → 201 GroupInfo（成员含协调者、id 前缀 grp_、落一条 system 消息）", async () => {
    const group = await createGroup(app, { description: "讨论 claude 接入", maxRounds: 2 });
    expect(group.id.startsWith("grp_")).toBe(true);
    expect(group.name).toBe("接入评审");
    expect(group.members).toEqual(["kimi", "fengagent"]);
    expect((group as unknown as { description: string }).description).toBe("讨论 claude 接入");
    expect((group as unknown as { status: string }).status).toBe("open");
    expect((group as unknown as { maxRounds: number }).maxRounds).toBe(2);

    const detail = (await (await app.request(`/${group.id}`)).json()) as {
      messages: Array<{ content: string; kind: string; fromName: string; id: string }>;
    };
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]!.content).toBe("群已创建");
    expect(detail.messages[0]!.kind).toBe("system");
    expect(detail.messages[0]!.fromName).toBe("system");
    expect(detail.messages[0]!.id.startsWith("msg_")).toBe(true);
  });

  test("GET /api/groups → {groups, runtimes}（未注册成员建群 → 400）", async () => {
    await createGroup(app);
    const list = (await (await app.request("/")).json()) as {
      groups: Array<{ id: string }>;
      runtimes: Array<{ name: string }>;
    };
    expect(list.groups).toHaveLength(1);
    expect(list.runtimes.map((r) => r.name)).toEqual(["kimi", "dsh", "fengagent"]);

    const bad = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "野群", members: ["nope"] }),
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: { message: string; code: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("未注册");
  });

  test("人发言：seq 单调、fromName=human；详情全量返回；after 增量读取", async () => {
    const group = await createGroup(app);
    for (const content of ["第一句", "第二句"]) {
      const res = await app.request(`/${group.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      expect(res.status).toBe(201);
      const message = (await res.json()) as { seq: number; kind: string; fromKind: string; fromName: string };
      expect(message.kind).toBe("chat");
      expect(message.fromKind).toBe("human");
      expect(message.fromName).toBe("human");
    }

    const detail = (await (await app.request(`/${group.id}`)).json()) as {
      messages: Array<{ seq: number; content: string }>;
    };
    // system「群已创建」+ 两句人话 = 全量 3 条
    expect(detail.messages.map((m) => m.content)).toEqual(["群已创建", "第一句", "第二句"]);

    const after = (await (await app.request(`/${group.id}/messages?after=2`)).json()) as {
      messages: Array<{ seq: number; content: string }>;
      nextSeq: number;
    };
    expect(after.messages.map((m) => m.content)).toEqual(["第二句"]);
    expect(after.nextSeq).toBe(3);
  });

  test("agent-messages：协调者/成员可发言，非成员 403；关群后 409", async () => {
    const group = await createGroup(app);

    const asCoordinator = await app.request(`/${group.id}/agent-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "协调者：先对齐目标", fromName: "fengagent" }),
    });
    expect(asCoordinator.status).toBe(201);
    expect(((await asCoordinator.json()) as { fromKind: string }).fromKind).toBe("coordinator");

    const asMember = await app.request(`/${group.id}/agent-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "kimi 报到", fromName: "kimi" }),
    });
    expect(asMember.status).toBe(201);
    expect(((await asMember.json()) as { fromKind: string }).fromKind).toBe("runtime");

    const stranger = await app.request(`/${group.id}/agent-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "我是谁", fromName: "claude" }),
    });
    expect(stranger.status).toBe(403);
    expect(((await stranger.json()) as { error: { code: string } }).error.code).toBe("forbidden");
  });

  test("conclude：open → concluded 且幂等；关群后发言 409、历史可读", async () => {
    const group = await createGroup(app);
    const first = await app.request(`/${group.id}/conclude`, { method: "POST" });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { status: string }).status).toBe("concluded");

    const again = await app.request(`/${group.id}/conclude`, { method: "POST" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe("concluded");

    const rejected = await app.request(`/${group.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "还能说吗" }),
    });
    expect(rejected.status).toBe(409);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe("conflict");

    const detail = (await (await app.request(`/${group.id}`)).json()) as {
      messages: Array<{ content: string }>;
    };
    expect(detail.messages.map((m) => m.content)).toEqual(["群已创建"]);
  });

  test("SSE：首帧 snapshot（group + after 之后的消息 + lastSeq），message 帧带 seq", async () => {
    const group = await createGroup(app);
    await app.request(`/${group.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "快照里要有我" }),
    });

    const controller = new AbortController();
    const res = await app.request(`/${group.id}/stream?after=0`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 6; i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.includes("快照里要有我")) break;
    }
    controller.abort();
    expect(text).toContain("event: snapshot");
    expect(text).toContain('"lastSeq":2');
    expect(text).toContain('"type":"snapshot"');
    expect(text).toContain("快照里要有我");
  });

  test("参数/路径校验：空群名 400、未知群 404、空消息 400（错误体带 code）", async () => {
    const bad = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  " }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("bad_request");

    const missing = await app.request("/nope");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect((await app.request("/nope/stream")).status).toBe(404);
    expect((await app.request("/nope/conclude", { method: "POST" })).status).toBe(404);

    const group = await createGroup(app);
    const empty = await app.request(`/${group.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "   " }),
    });
    expect(empty.status).toBe(400);
  });
});

describe("群工具（fengagent 侧，G1 三个）— 与 API 共用同一 service", () => {
  test("group_create / group_send / group_history 走通，说话人落 coordinator", async () => {
    const made = makeService();
    try {
      const tools = createGroupTools(
        {
          create: async (input) => {
            const group = made.service.createGroup({
              name: input.name,
              ...(input.description === undefined ? {} : { description: input.description }),
              members: input.members ?? [],
              coordinator: input.coordinator ?? "fengagent",
            });
            return { id: group.id, name: group.name, members: group.members };
          },
          send: async (input) => {
            const message = made.service.postAgentMessage(input.groupId, {
              content: input.content,
              fromName: input.from,
            });
            return { id: message.id, seq: message.seq };
          },
          history: async (input) => {
            const group = made.service.getGroup(input.groupId)!;
            const messages = made.service.listRecentMessages(input.groupId, input.limit ?? 50);
            return {
              groupId: group.id,
              name: group.name,
              lines: messages.map((m) => `#${m.seq} [${m.fromName}] ${m.content}`),
            };
          },
        },
        { selfName: () => "fengagent" },
      );
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      expect([...byName.keys()]).toEqual(["group_create", "group_send", "group_history"]);

      const ctx = { workdir: made.dir, sessionId: "s-1", messageId: "m-1" };
      const created = await byName.get("group_create")!.execute(
        { name: "工具建的群", members: ["kimi"], description: "讲清楚" },
        ctx,
      );
      const groupId = (created.metadata as { groupId: string }).groupId;
      expect(created.content).toContain("工具建的群");

      const sent = await byName.get("group_send")!.execute(
        { groupId, content: "协调者：kimi 先出一版" },
        ctx,
      );
      expect(sent.content).toContain("seq=2"); // seq=1 是「群已创建」system

      const messages = made.service.listMessages(groupId);
      expect(messages[1]!.fromKind).toBe("coordinator");
      expect(messages[1]!.fromName).toBe("fengagent");

      const history = await byName.get("group_history")!.execute({ groupId }, ctx);
      expect(history.content).toContain("[fengagent] 协调者：kimi 先出一版");
    } finally {
      made.service.close();
      safeRm(made.dir);
    }
  });

  test("外部 runtime 的产出由服务端代写（fromKind=runtime + 任务深链）", () => {
    const made = makeService();
    try {
      const group = made.service.createGroup({ name: "回流", members: ["kimi"] });
      const message = made.service.postRuntimeMessage(group.id, {
        runtime: "kimi",
        content: "探针结果：ok",
        agentTaskId: "task-42",
      });
      expect(message.fromKind).toBe("runtime");
      expect(message.fromName).toBe("kimi");
      expect(message.agentTaskId).toBe("task-42");
      expect(message.kind).toBe("chat");
    } finally {
      made.service.close();
      safeRm(made.dir);
    }
  });
});
