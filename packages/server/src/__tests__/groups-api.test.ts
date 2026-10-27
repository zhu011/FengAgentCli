/**
 * @fengagent/server — 群聊 API + 群工具测试（G1）
 *
 * 契约对齐 `web-ui/src/api/types.ts` v1.0：`{groups, runtimes}` / `GroupInfo` /
 * `GroupMessage` / `{group, messages}` / `snapshot|message|group` SSE 帧。
 *
 * 另外验证 v1「协调者中转」的两条硬边界：
 * 1. 关群后 API 拒绝发言（409），消息仍可读；
 * 2. 群工具（fengagent 侧）走同一份 service —— 说话人落 `coordinator`，
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

function makeService(): { service: AgentGroupService; dir: string; app: ReturnType<typeof createGroupRoutes> } {
  const dir = mkdtempSync(join(tmpdir(), "feng-groups-api-"));
  const runtimeCard: RuntimeInfo = {
    name: "kimi",
    command: "kimi acp",
    agentName: "Kimi Code CLI",
    agentVersion: "0.34.0",
    capabilities: { resume: true, loadSession: true, image: true },
    probeStatus: "ok",
    enabled: true,
    recentTaskCount: 0,
  };
  const service = new AgentGroupService({
    dataRoot: dir,
    runtimes: () => [runtimeCard],
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

  test("POST /api/groups → 201 GroupInfo；GET / → {groups, runtimes}", async () => {
    const created = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "接入评审",
        description: "讨论 claude 接入",
        members: ["kimi", "dsh"],
        maxRounds: 2,
      }),
    });
    expect(created.status).toBe(201);
    const group = (await created.json()) as Record<string, unknown>;
    expect(group.name).toBe("接入评审");
    expect(group.description).toBe("讨论 claude 接入");
    expect(group.members).toEqual(["kimi", "dsh"]);
    expect(group.status).toBe("open");
    expect(group.maxRounds).toBe(2);
    expect(typeof group.createdAt).toBe("string");

    const list = (await (await app.request("/")).json()) as {
      groups: Array<{ id: string }>;
      runtimes: Array<{ name: string }>;
    };
    expect(list.groups).toHaveLength(1);
    expect(list.runtimes.map((r) => r.name)).toEqual(["kimi"]);
  });

  test("发言 → seq 单调；GET 详情带最近消息；after 增量读取", async () => {
    const created = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "聊起来", members: ["kimi"] }),
    });
    const group = (await created.json()) as { id: string };

    for (const content of ["第一句", "第二句"]) {
      const res = await app.request(`/${group.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      expect(res.status).toBe(201);
      const message = (await res.json()) as { seq: number; kind: string; fromKind: string };
      expect(message.kind).toBe("chat");
      expect(message.fromKind).toBe("human");
    }

    const detail = (await (await app.request(`/${group.id}`)).json()) as {
      group: { messageCount: number };
      messages: Array<{ seq: number; content: string }>;
    };
    expect(detail.group.messageCount).toBe(2);
    expect(detail.messages.map((m) => m.content)).toEqual(["第一句", "第二句"]);

    const after = (await (await app.request(`/${group.id}/messages?after=1`)).json()) as {
      messages: Array<{ seq: number; content: string }>;
      nextSeq: number;
    };
    expect(after.messages.map((m) => m.content)).toEqual(["第二句"]);
    expect(after.nextSeq).toBe(2);
  });

  test("关群（PATCH status=concluded）后发言 409，历史可读", async () => {
    const created = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "要关的群" }),
    });
    const group = (await created.json()) as { id: string };
    await app.request(`/${group.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "开会" }),
    });

    const patched = await app.request(`/${group.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "concluded" }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { status: string }).status).toBe("concluded");

    const rejected = await app.request(`/${group.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "还能说吗" }),
    });
    expect(rejected.status).toBe(409);

    const detail = (await (await app.request(`/${group.id}`)).json()) as {
      messages: Array<{ content: string }>;
    };
    expect(detail.messages.map((m) => m.content)).toEqual(["开会"]);
  });

  test("SSE：首帧 snapshot（group + messages + lastSeq），随后可回放 message 帧", async () => {
    const created = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "SSE 群" }),
    });
    const group = (await created.json()) as { id: string };
    await app.request(`/${group.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "快照里要有我" }),
    });

    // 关群让流不会一直等实时帧：先读快照与回放，再由客户端中断
    const controller = new AbortController();
    const res = await app.request(`/${group.id}/stream?after=0`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 6 && !text.includes('"type":"message"'); i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    expect(text).toContain("event: snapshot");
    expect(text).toContain('"lastSeq":1');
    expect(text).toContain("快照里要有我");
  });

  test("参数校验：空群名 400、未知群 404、空消息 400", async () => {
    const bad = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  " }),
    });
    expect(bad.status).toBe(400);

    expect((await app.request("/nope")).status).toBe(404);
    expect((await app.request("/nope/stream")).status).toBe(404);

    const created = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "空消息" }),
    });
    const group = (await created.json()) as { id: string };
    const empty = await app.request(`/${group.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "   " }),
    });
    expect(empty.status).toBe(400);
  });
});

describe("群工具（fengagent 侧）— 与 API 共用同一 service", () => {
  test("group_create / group_send / group_history / group_list 走通，说话人落 coordinator", async () => {
    const made = makeService();
    try {
      const tools = createGroupTools(
        {
          create: async (input) => {
            const group = made.service.createGroup({
              name: input.name,
              ...(input.description === undefined ? {} : { description: input.description }),
              members: input.members ?? [],
              ...(input.coordinator === undefined ? {} : { coordinator: input.coordinator }),
            });
            return { id: group.id, name: group.name, members: group.members };
          },
          send: async (input) => {
            const message = made.service.postMessage(input.groupId, {
              content: input.content,
              fromKind: "coordinator",
              fromName: input.from,
            });
            return { id: message.id, seq: message.seq };
          },
          history: async (input) => {
            const group = made.service.getGroup(input.groupId)!;
            const messages = made.service.listRecentMessages(input.groupId, input.limit ?? 30);
            return {
              groupId: group.id,
              name: group.name,
              lines: messages.map((m) => `#${m.seq} [${m.fromName}] ${m.content}`),
            };
          },
          list: async (input) =>
            made.service
              .listGroups({ ...(input.status === undefined ? {} : { status: input.status }) })
              .map((g) => ({
                id: g.id,
                name: g.name,
                status: g.status,
                members: g.members,
                messageCount: g.messageCount,
              })),
        },
        { selfName: () => "fengagent" },
      );
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      expect([...byName.keys()]).toEqual([
        "group_create",
        "group_send",
        "group_history",
        "group_list",
      ]);

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
      expect(sent.content).toContain("seq=1");

      const messages = made.service.listMessages(groupId);
      expect(messages[0]!.fromKind).toBe("coordinator");
      expect(messages[0]!.fromName).toBe("fengagent");

      const history = await byName.get("group_history")!.execute({ groupId }, ctx);
      expect(history.content).toContain("[fengagent] 协调者：kimi 先出一版");

      const list = await byName.get("group_list")!.execute({}, ctx);
      expect(list.content).toContain("工具建的群");
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
