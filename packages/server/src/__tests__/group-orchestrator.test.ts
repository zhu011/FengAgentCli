/**
 * @fengagent/server — G3：编排收敛 + 人在环
 *
 * 三条独立策略共用一个幂等 `conclude()`：
 * 1. **轮次上限**：同一群内、自上次人类发言后的协调者发言数达到 `maxRounds` → 自动收口；
 * 2. **静默超时**：`idleTimeoutMs` 内没有新消息 → `sweepIdle()` 收口（生产由定时器驱动）；
 * 3. **人类拍板**：human 发 `kind="decision"` → 该消息落库后立即收口。
 *
 * 外加：`group_conclude` 工具（协调者结论 + 关群 + 取消任务）、`POST /:id/stop` 中途关停。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGroupTools } from "@fengagent/tools";
import { AgentGroupService } from "../agent-group-service.ts";
import { GroupOrchestrator } from "../group-orchestrator.ts";
import { createGroupRoutes } from "../routes/groups.ts";
import type { RuntimeInfo } from "../agent-runtimes.ts";

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

interface Fixture {
  dir: string;
  groups: AgentGroupService;
  orchestrator: GroupOrchestrator;
  cancelled: string[];
  app: ReturnType<typeof createGroupRoutes>;
  close: () => void;
}

function makeFixture(options: { cancelTasks?: string[] } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "feng-g3-"));
  const groups = new AgentGroupService({
    dataRoot: dir,
    runtimes: () => [runtimeCard("kimi"), runtimeCard("fengagent")],
  });
  const cancelled: string[] = [];
  const orchestrator = new GroupOrchestrator({
    groups,
    sweepIntervalMs: 0, // 测试手动 sweepIdle
    cancelGroupTasks: () => {
      const ids = options.cancelTasks ?? [];
      cancelled.push(...ids);
      return ids;
    },
  });
  groups.onMessage((groupId, message) => orchestrator.onMessage(groupId, message));
  const app = createGroupRoutes(groups, orchestrator);
  return {
    dir,
    groups,
    orchestrator,
    cancelled,
    app,
    close: () => {
      orchestrator.dispose();
      groups.close();
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          Bun.sleepSync(50);
        }
      }
    },
  };
}

describe("G3 — 轮次上限", () => {
  test("协调者发言达到 maxRounds → 自动收口，并留 system 说明", () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({ name: "轮次", members: ["kimi"], maxRounds: 2 });
      fx.groups.postAgentMessage(group.id, { content: "第一轮", fromName: "fengagent" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("open");

      fx.groups.postAgentMessage(group.id, { content: "第二轮", fromName: "fengagent" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("concluded");

      const messages = fx.groups.listMessages(group.id);
      expect(messages.at(-1)!.fromKind).toBe("system");
      expect(messages.at(-1)!.content).toContain("maxRounds=2");
    } finally {
      fx.close();
    }
  });

  test("人类发言重置轮次计数（拍板前不会被上限误收口）", () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({ name: "重置", members: ["kimi"], maxRounds: 2 });
      fx.groups.postAgentMessage(group.id, { content: "第一轮", fromName: "fengagent" });
      fx.groups.postHumanMessage(group.id, { content: "我说一句" });
      fx.groups.postAgentMessage(group.id, { content: "第二轮", fromName: "fengagent" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("open");
      fx.groups.postAgentMessage(group.id, { content: "第三轮", fromName: "fengagent" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("concluded");
    } finally {
      fx.close();
    }
  });
});

describe("G3 — 静默超时", () => {
  test("sweepIdle 只在超过 idleTimeoutMs 时收口，且幂等", () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({ name: "静默", members: ["kimi"] });
      // 把 idleTimeoutMs 调小，便于确定性地 sweep
      fx.groups.store.update(group.id, { idleTimeoutMs: 1000 });
      fx.groups.postHumanMessage(group.id, { content: "人在吗" });

      expect(fx.orchestrator.sweepIdle(Date.now() + 500)).toEqual([]);
      const closed = fx.orchestrator.sweepIdle(Date.now() + 5000);
      expect(closed).toEqual([group.id]);
      expect(fx.groups.getGroup(group.id)!.status).toBe("concluded");

      // 再扫一次：已 concluded，不再重复收口
      expect(fx.orchestrator.sweepIdle(Date.now() + 10_000)).toEqual([]);
    } finally {
      fx.close();
    }
  });
});

describe("G3 — 人在环", () => {
  test("human 发 decision → 立即收口（decision 消息保留）", () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({ name: "拍板", members: ["kimi"] });
      fx.groups.postHumanMessage(group.id, { content: "就按 A 方案做", kind: "decision" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("concluded");
      const messages = fx.groups.listMessages(group.id);
      const decision = messages.find((m) => m.kind === "decision")!;
      expect(decision.fromKind).toBe("human");
      expect(decision.content).toBe("就按 A 方案做");
      expect(messages.at(-1)!.content).toContain("人类拍板");
    } finally {
      fx.close();
    }
  });

  test("POST /:id/messages 带 kind=decision → 201 且立即收口（human 拍板走 HTTP 可达）", async () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({ name: "拍板接口", members: ["kimi"] });
      const res = await fx.app.request(`/${group.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "就按 B 方案", kind: "decision" }),
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { kind: string }).kind).toBe("decision");
      expect(fx.groups.getGroup(group.id)!.status).toBe("concluded");
    } finally {
      fx.close();
    }
  });

  test("非法 kind → 400；建群可指定 idleTimeoutMs 且回显", async () => {
    const fx = makeFixture();
    try {
      const created = await fx.app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "短超时",
          members: ["kimi"],
          maxRounds: 5,
          idleTimeoutMs: 60_000,
        }),
      });
      expect(created.status).toBe(201);
      const group = (await created.json()) as { id: string; idleTimeoutMs: number };
      expect(group.idleTimeoutMs).toBe(60_000);

      const bad = await fx.app.request(`/${group.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "试试", kind: "task_card" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      fx.close();
    }
  });

  test("POST /:id/stop → 收口 + 返回被取消任务；再次 stop 幂等", async () => {
    const fx = makeFixture({ cancelTasks: ["task-1", "task-2"] });
    try {
      const group = fx.groups.createGroup({ name: "关停", members: ["kimi"] });
      const res = await fx.app.request(`/${group.id}/stop`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        group: { status: string };
        cancelledTasks: string[];
      };
      expect(body.group.status).toBe("concluded");
      expect(body.cancelledTasks).toEqual(["task-1", "task-2"]);

      const again = await fx.app.request(`/${group.id}/stop`, { method: "POST" });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { group: { status: string } }).group.status).toBe(
        "concluded",
      );
      expect(fx.cancelled).toEqual(["task-1", "task-2"]); // 只取消一次
    } finally {
      fx.close();
    }
  });

  test("POST /:id/conclude 走编排器：留收口说明", async () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({ name: "接口收口", members: ["kimi"] });
      const res = await fx.app.request(`/${group.id}/conclude`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe("concluded");
      const last = fx.groups.listMessages(group.id).at(-1)!;
      expect(last.fromKind).toBe("system");
      expect(last.content).toContain("【收口】");
    } finally {
      fx.close();
    }
  });
});

describe("G3 — group_conclude 工具", () => {
  test("协调者收口：decision 落库 → 关群 → 报告取消任务数", async () => {
    const fx = makeFixture({ cancelTasks: ["task-9"] });
    try {
      const tools = createGroupTools(
        {
          create: async (input) => {
            const group = fx.groups.createGroup({
              name: input.name,
              members: input.members ?? [],
              coordinator: input.coordinator ?? "fengagent",
            });
            return { id: group.id, name: group.name, members: group.members };
          },
          send: async (input) => {
            const m = fx.groups.postAgentMessage(input.groupId, {
              content: input.content,
              fromName: input.from,
            });
            return { id: m.id, seq: m.seq };
          },
          history: async (input) => {
            const group = fx.groups.getGroup(input.groupId)!;
            return {
              groupId: group.id,
              name: group.name,
              lines: fx.groups
                .listRecentMessages(input.groupId, input.limit ?? 50)
                .map((m) => `#${m.seq} [${m.fromName}] ${m.content}`),
            };
          },
          conclude: async (input) => {
            const result = fx.orchestrator.conclude(input.groupId, {
              by: "coordinator",
              reason: "协调者收口",
              conclusion: input.conclusion,
            });
            return { status: result.group.status, cancelledTasks: result.cancelledTasks.length };
          },
        },
        { selfName: () => "fengagent" },
      );
      const byName = new Map(tools.map((t) => [t.name, t]));
      expect([...byName.keys()]).toEqual([
        "group_create",
        "group_send",
        "group_history",
        "group_conclude",
      ]);

      const ctx = { workdir: fx.dir, sessionId: "s-1", messageId: "m-1" };
      const created = await byName.get("group_create")!.execute({ name: "收口群" }, ctx);
      const groupId = (created.metadata as { groupId: string }).groupId;

      const result = await byName.get("group_conclude")!.execute(
        { groupId, conclusion: "结论：按 A 方案；kimi 负责接入，遗留 B 待下周" },
        ctx,
      );
      expect(result.content).toContain("群已收口");
      expect(result.content).toContain("取消在跑任务 1 个");

      const messages = fx.groups.listMessages(groupId);
      const decision = messages.find((m) => m.kind === "decision")!;
      expect(decision.fromKind).toBe("coordinator");
      expect(decision.content).toContain("按 A 方案");
      expect(fx.groups.getGroup(groupId)!.status).toBe("concluded");
    } finally {
      fx.close();
    }
  });
});
