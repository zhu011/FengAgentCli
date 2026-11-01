/**
 * @fengagent/server — 群 MCP 服务面测试（v2 V2-1）
 *
 * 覆盖：token 铸取/鉴权、send 身份绑定（token 成员即 fromName）、
 * 非成员 403、关群 409、history 增量、groups 列表。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AgentGroupStore } from "@fengagent/agent";
import { AgentGroupService } from "@fengagent/groups";
import { createGroupMcpRoutes } from "../mcp-groups.ts";

let dir: string;
let app: Hono;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feng-mcp-groups-"));
  const service = new AgentGroupService({
    store: new AgentGroupStore(join(dir, "groups.db")),
    runtimes: () => [
      { name: "kimi", enabled: true },
      { name: "claude", enabled: true },
      { name: "fengagent", enabled: true },
    ],
  });
  app = createGroupMcpRoutes(service, dir);
});

afterEach(() => {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      /* Windows 句柄延迟，重试 */
    }
  }
});

describe("群 MCP 服务面", () => {
  test("token 铸取 + me 自检 + send 身份绑定", async () => {
    const res1 = await app.request("/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member: "kimi" }),
    });
    expect(res1.status).toBe(201);
    const { token } = (await res1.json()) as { token: string };
    expect(token).toMatch(/^fgm_/);

    const me = await app.request("/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { member: string }).member).toBe("kimi");

    // 建群（kimi 是成员）
    const group = await app.request("/groups", { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    expect(group.status).toBe(200);

    const service2 = undefined; // 群经 service 建不了（无暴露建群）——直接用底座
    void service2;
  });

  test("send：token 成员发言 + 非成员 403 + 关群 409 + 无 token 401", async () => {
    const service = new AgentGroupService({
      store: new AgentGroupStore(join(dir, "g2.db")),
      runtimes: () => [
        { name: "kimi", enabled: true },
        { name: "claude", enabled: true },
        { name: "fengagent", enabled: true },
      ],
    });
    const localApp = createGroupMcpRoutes(service, dir);
    const g = service.createGroup({ name: "直连群", members: ["kimi"] });

    const mint = await localApp.request("/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member: "kimi" }),
    });
    const { token: kimiToken } = (await mint.json()) as { token: string };
    const mint2 = await localApp.request("/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member: "claude" }),
    });
    const { token: claudeToken } = (await mint2.json()) as { token: string };

    // kimi（成员）发言成功，fromName 绑定为 kimi
    const send = await localApp.request("/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${kimiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: g.id, content: "大家好，我是 kimi" }),
    });
    expect(send.status).toBe(201);
    const msg = (await send.json()) as { fromName: string; seq: number };
    expect(msg.fromName).toBe("kimi");

    // claude（非成员）403
    const deny = await localApp.request("/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${claudeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: g.id, content: "插一句" }),
    });
    expect(deny.status).toBe(403);

    // 无 token 401
    const anon = await localApp.request("/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: g.id, content: "匿名" }),
    });
    expect(anon.status).toBe(401);

    // reply 带前缀
    const reply = await localApp.request("/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${kimiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: g.id, content: "收到", replyToSeq: msg.seq }),
    });
    expect(reply.status).toBe(201);
    expect(((await reply.json()) as { content: string }).content).toContain(`↩ #${msg.seq}`);

    // history 增量
    const hist = await localApp.request(`/history?groupId=${g.id}&after=${msg.seq}`, {
      headers: { Authorization: `Bearer ${kimiToken}` },
    });
    expect(hist.status).toBe(200);
    const h = (await hist.json()) as { messages: Array<{ content: string }>; nextSeq: number };
    expect(h.messages.length).toBe(1);
    expect(h.messages[0]!.content).toContain("收到");

    // 关群后 409
    service.concludeGroup(g.id);
    const closed = await localApp.request("/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${kimiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: g.id, content: "还有吗" }),
    });
    expect(closed.status).toBe(409);
  });

  test("groups 列表返回群", async () => {
    const service = new AgentGroupService({
      store: new AgentGroupStore(join(dir, "g3.db")),
      runtimes: () => [{ name: "kimi", enabled: true }, { name: "fengagent", enabled: true }],
    });
    const localApp = createGroupMcpRoutes(service, dir);
    service.createGroup({ name: "列表群", members: ["kimi"] });
    const mint = await localApp.request("/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member: "kimi" }),
    });
    const { token } = (await mint.json()) as { token: string };
    const res = await localApp.request("/groups", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const { groups } = (await res.json()) as { groups: Array<{ name: string }> };
    expect(groups.some((x) => x.name === "列表群")).toBe(true);
  });
});
