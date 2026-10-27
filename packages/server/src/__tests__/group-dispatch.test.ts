/**
 * @fengagent/server — G2：群内派发 + 结果回群
 *
 * 验证三件事：
 * 1. `dispatch_task` / `POST /api/agent-tasks` 带 `groupId` → 任务落库带群；
 * 2. 任务终态（replied / failed）时，结果以 `kind="task_card"` 自动写回群，
 *    `fromKind="runtime"` + `agentTaskId` 深链（服务端代写，不靠成员自觉）；
 * 3. 群维度过滤：`GET /api/agent-tasks?groupId=` 只返回该群派出的任务。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchTaskTool } from "@fengagent/tools";
import { AgentRuntimeRegistry } from "../agent-runtimes.ts";
import { AgentGroupService } from "../agent-group-service.ts";
import { AgentTaskService } from "../agent-task-service.ts";
import { createAgentTaskRoutes } from "../routes/agent-tasks.ts";
import type { RuntimeInfo } from "../agent-runtimes.ts";

const FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "agent",
  "src",
  "__tests__",
  "fixtures",
  "fake-acp-agent.ts",
);

function runtimeCard(name: string): RuntimeInfo {
  return {
    name,
    command: process.execPath,
    agentName: name,
    agentVersion: "0.0.1",
    capabilities: { resume: true, loadSession: true, image: false },
    probeStatus: "ok",
    enabled: true,
    recentTaskCount: 0,
  };
}

function makeFixture(): {
  dir: string;
  groups: AgentGroupService;
  tasks: AgentTaskService;
  app: ReturnType<typeof createAgentTaskRoutes>;
} {
  const dir = mkdtempSync(join(tmpdir(), "feng-group-dispatch-"));
  const groups = new AgentGroupService({
    dataRoot: dir,
    runtimes: () => [runtimeCard("fake"), runtimeCard("fengagent")],
  });
  const registry = new AgentRuntimeRegistry({
    dataRoot: dir,
    entries: [{ name: "fake", command: process.execPath, args: [FIXTURE], enabled: true }],
  });
  const tasks = new AgentTaskService({
    dataRoot: dir,
    registry,
    // G2：结果回群（真实群服务当 sink，端到端验证 task_card 落库）
    groupSink: groups,
    requestTimeoutMs: 8000,
    promptTimeoutMs: 15_000,
    autoProbe: false,
    recoverOnStart: false,
  });
  return { dir, groups, tasks, app: createAgentTaskRoutes(tasks) };
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

describe("G2 — 群内派发 + 结果回群", () => {
  test("replied → 群里出现 task_card（fromKind=runtime，带 agentTaskId 深链）", async () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({ name: "评审", members: ["fake"] });
      const task = await fx.tasks.dispatchAndWait(
        { runtime: "fake", content: "打个招呼", groupId: group.id },
        15_000,
      );
      expect(task.status).toBe("replied");
      expect(task.groupId).toBe(group.id);

      const messages = fx.groups.listMessages(group.id);
      const card = messages[messages.length - 1]!;
      expect(card.kind).toBe("task_card");
      expect(card.fromKind).toBe("runtime");
      expect(card.fromName).toBe("fake");
      expect(card.agentTaskId).toBe(task.id);
      expect(card.content).toContain("已完成");
      expect(card.content).toContain("你好");
    } finally {
      await fx.tasks.close();
      fx.groups.close();
      safeRm(fx.dir);
    }
  });

  test("failed → 群里同样落 task_card（内容带失败原因）", async () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({ name: "失败面", members: ["fake"] });
      const task = await fx.tasks.dispatchAndWait(
        { runtime: "fake", content: "FAIL 这条会失败", groupId: group.id },
        15_000,
      );
      expect(task.status).toBe("failed");

      const messages = fx.groups.listMessages(group.id);
      const card = messages[messages.length - 1]!;
      expect(card.kind).toBe("task_card");
      expect(card.agentTaskId).toBe(task.id);
      expect(card.content).toContain("失败");
      expect(card.content).toContain("目标拒绝执行");
    } finally {
      await fx.tasks.close();
      fx.groups.close();
      safeRm(fx.dir);
    }
  });

  test("不带 groupId 的任务不回群", async () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({ name: "旁观", members: ["fake"] });
      const before = fx.groups.listMessages(group.id).length;
      await fx.tasks.dispatchAndWait({ runtime: "fake", content: "普通任务" }, 15_000);
      expect(fx.groups.listMessages(group.id).length).toBe(before);
    } finally {
      await fx.tasks.close();
      fx.groups.close();
      safeRm(fx.dir);
    }
  });

  test("API：POST 带 groupId → 任务带群；GET ?groupId= 只返回该群任务", async () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({ name: "接口面", members: ["fake"] });

      const created = await fx.app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runtime: "fake", content: "群内任务", groupId: group.id }),
      });
      expect(created.status).toBe(201);
      const task = (await created.json()) as { id: string; groupId?: string };
      expect(task.groupId).toBe(group.id);
      await fx.tasks.waitForTerminal(task.id, 15_000);

      await fx.tasks.dispatchAndWait({ runtime: "fake", content: "群外任务" }, 15_000);

      const scoped = (await (await fx.app.request(`/?groupId=${group.id}`)).json()) as {
        tasks: Array<{ id: string }>;
      };
      expect(scoped.tasks.map((t) => t.id)).toEqual([task.id]);

      const all = (await (await fx.app.request("/")).json()) as { tasks: Array<{ id: string }> };
      expect(all.tasks.length).toBe(2);
    } finally {
      await fx.tasks.close();
      fx.groups.close();
      safeRm(fx.dir);
    }
  });

  test("未知 groupId → POST 400（先验群存在，避免结果无处可回）", async () => {
    const fx = makeFixture();
    try {
      const res = await fx.app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runtime: "fake", content: "没有这个群", groupId: "grp_missing" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("群不存在");
      // 没有落任何任务
      expect(fx.tasks.listTasks().tasks).toHaveLength(0);

      // 服务层直调同样拒绝
      let caught: unknown = null;
      try {
        await fx.tasks.submit({ runtime: "fake", content: "x", groupId: "grp_missing" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
    } finally {
      await fx.tasks.close();
      fx.groups.close();
      safeRm(fx.dir);
    }
  });

  test("dispatch_task 工具把 groupId 透传给服务层", async () => {
    const seen: Array<{ runtime: string; content: string; groupId?: string }> = [];
    const tool = createDispatchTaskTool(async (input) => {
      seen.push(input);
      return { id: "t-1", runtime: input.runtime, status: "replied", result: "ok" };
    });
    const result = await tool.execute(
      { agent: "fake", task: "写个卡片", groupId: "grp_abc" },
      { workdir: process.cwd(), sessionId: "s-1", messageId: "m-1" },
    );
    expect(result.isError).toBe(false);
    expect(seen).toEqual([{ runtime: "fake", content: "写个卡片", groupId: "grp_abc" }]);
  });

  test("群任务的列表过滤在 store 层也成立（groupId 落库）", async () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({ name: "落库", members: ["fake"] });
      const first = await fx.tasks.dispatchAndWait(
        { runtime: "fake", content: "甲", groupId: group.id },
        15_000,
      );
      const second = await fx.tasks.dispatchAndWait({ runtime: "fake", content: "乙" }, 15_000);
      expect(fx.tasks.store.get(first.id)?.groupId).toBe(group.id);
      expect(fx.tasks.store.get(second.id)?.groupId).toBeUndefined();
      expect(fx.tasks.store.list({ groupId: group.id }).map((t) => t.id)).toEqual([first.id]);
    } finally {
      await fx.tasks.close();
      fx.groups.close();
      safeRm(fx.dir);
    }
  });
});
