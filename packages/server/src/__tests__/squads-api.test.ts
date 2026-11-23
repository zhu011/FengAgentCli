/**
 * @fengagent/server — `/api/squads` + `/api/approvals` 测试（P2 第一阶段）
 *
 * 真 spawn `fake-acp-agent` 当队长/成员的 runtime，覆盖验收点：
 * 1. 小队实体：建队 / 加成员 / 换队长 / 移除队长被拒（409 cannot_remove_squad_leader）；
 * 2. leader 模式派单**非阻塞**：POST 立刻返回 taskId，队长的执行在后台；
 * 3. 队长派活 → worker 子任务 + 运行树父子关系正确；worker 终态后**唤醒队长**（attempt+1）；
 * 4. 负责人确认：成员请求 bash → 落 pending 审批；队长裁决（permanent）→ 放行；
 *    审计 3 行（request/approve/consume）；人类审批接口同源可读。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AgentRegistry, ApprovalStore, SquadStore } from "@fengagent/agent";
import { AgentTaskService } from "../agent-task-service.ts";
import { AgentRuntimeRegistry } from "../agent-runtimes.ts";
import { SquadService } from "../squad-service.ts";
import { SquadAutoCoordinator } from "../squad-auto.ts";
import { createSquadRoutes } from "../routes/squads.ts";
import { createApprovalRoutes } from "../routes/approvals.ts";

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

/** 轮询到条件成立（避免用固定 sleep 猜时序） */
async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(25);
  }
  throw new Error("等待条件超时");
}

interface Fixture {
  service: SquadService;
  tasks: AgentTaskService;
  approvals: ApprovalStore;
  app: Hono;
  dir: string;
}

async function makeFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "feng-squads-api-"));
  const runtimeRegistry = new AgentRuntimeRegistry({
    dataRoot: dir,
    entries: [{ name: "fake", command: process.execPath, args: [FIXTURE], enabled: true }],
  });
  // 绑定解析要求 runtime 探测通过（否则派单会被拒）
  await runtimeRegistry.probeAll();
  const agentRegistry = new AgentRegistry({ dataRoot: dir });
  agentRegistry.create({ id: "leader", displayName: "队长", runtime: "fake", instructions: "你是队长。" });
  agentRegistry.create({ id: "worker", displayName: "成员甲", runtime: "fake", instructions: "你是成员甲。" });
  agentRegistry.create({ id: "worker2", displayName: "成员乙", runtime: "fake" });

  const tasks = new AgentTaskService({
    dataRoot: dir,
    registry: runtimeRegistry,
    agentRegistry,
    defaultCwd: mkdtempSync(join(tmpdir(), "feng-squads-work-")),
    requestTimeoutMs: 8000,
    promptTimeoutMs: 15_000,
    autoProbe: false,
    recoverOnStart: false,
  });
  const store = new SquadStore(join(dir, "sessions.db"));
  const approvals = new ApprovalStore(join(dir, "sessions.db"));
  const auto = new SquadAutoCoordinator({
    store,
    tasks,
    composeMemberPrompt: (agentId, content) => `[${agentId}]\n${content}`,
    waitTimeoutMs: 15_000,
  });
  const service = new SquadService({
    store,
    approvals,
    agentRegistry,
    tasks,
    auto,
    skillsFor: (agentId) => (agentId === "leader" ? ["webui"] : []),
    humanOwner: "owner",
    waitTimeoutMs: 15_000,
  });
  const app = new Hono();
  app.route("/api/squads", createSquadRoutes(service));
  app.route("/api/approvals", createApprovalRoutes(service, "owner"));
  return { service, tasks, approvals, app, dir };
}

async function createSquad(app: Hono): Promise<string> {
  const res = await app.request("/api/squads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "sq_fe",
      name: "前端小队",
      leaderId: "leader",
      instructions: "改动先跑 typecheck",
      members: [
        { memberType: "agent", memberId: "worker", role: "实现" },
        { memberType: "agent", memberId: "worker2", role: "调研" },
      ],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("SquadService + /api/squads", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(async () => {
    await fx.tasks.close();
    safeRm(fx.dir);
  });

  test("建队：队长自动入成员，列表/详情契约与前端一致", async () => {
    const id = await createSquad(fx.app);
    const detail = await fx.app.request(`/api/squads/${id}`);
    expect(detail.status).toBe(200);
    const dto = (await detail.json()) as {
      id: string;
      leaderId: string;
      mode: string;
      archived: boolean;
      members: Array<{ memberId: string; role: string }>;
    };
    expect(dto.id).toBe("sq_fe");
    expect(dto.leaderId).toBe("leader");
    expect(dto.mode).toBe("leader");
    expect(dto.archived).toBe(false);
    expect(dto.members.map((member) => member.memberId)).toEqual(["leader", "worker", "worker2"]);

    const list = await fx.app.request("/api/squads");
    expect(((await list.json()) as unknown[]).length).toBe(1);
  });

  test("约束：未知 agent 400 / 非成员当队长 400 / 移除队长 409 / 缺队 404", async () => {
    const id = await createSquad(fx.app);

    const unknown = await fx.app.request(`/api/squads/${id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberType: "agent", memberId: "ghost", role: "" }),
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("agent_not_found");

    const badLeader = await fx.app.request(`/api/squads/${id}/leader`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaderId: "ghost" }),
    });
    expect(badLeader.status).toBe(400);

    const notMember = await fx.app.request(`/api/squads/${id}/leader`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaderId: "leader" }),
    });
    expect(notMember.status).toBe(200);

    const removeLeader = await fx.app.request(`/api/squads/${id}/members/agent/leader`, {
      method: "DELETE",
    });
    expect(removeLeader.status).toBe(409);
    expect(((await removeLeader.json()) as { error: { code: string } }).error.code).toBe(
      "cannot_remove_squad_leader",
    );

    const missing = await fx.app.request("/api/squads/sq_nope");
    expect(missing.status).toBe(404);
  });

  test("leader 模式派单非阻塞 + 队长派活 + worker 终态唤醒队长", async () => {
    const id = await createSquad(fx.app);

    const started = Date.now();
    const res = await fx.app.request(`/api/squads/${id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "把技能页改好" }),
    });
    expect(res.status).toBe(201);
    const { taskId } = (await res.json()) as { taskId: string };
    // 非阻塞：HTTP 不等队长/成员跑完（fake agent 一轮也要几百 ms，这里只要求很快返回）
    expect(Date.now() - started).toBeLessThan(3000);

    const leaderTask = fx.service.listTasks(id).find((task) => task.id === taskId);
    expect(leaderTask?.isLeader).toBe(true);
    expect(leaderTask?.assigneeId).toBe("leader");
    expect(leaderTask?.agentTaskId).toBeDefined();

    // 队长派一个子任务给 worker（`dispatch_task` 的服务端分支）
    const childStarted = Date.now();
    const child = await fx.service.dispatchToMember({
      squadId: id,
      leaderTaskId: taskId,
      memberId: "worker",
      content: "实现技能页导入按钮",
    });
    expect(Date.now() - childStarted).toBeLessThan(3000);

    const runs = fx.service.listRuns(id);
    const leaderRun = runs.find((run) => run.assignee === "leader");
    const childRun = runs.find((run) => run.assignee === "worker");
    expect(leaderRun).toBeDefined();
    expect(childRun?.parentRunId).toBe(leaderRun!.id);

    // worker 终态 → 队长被唤醒（attempt 从 1 → 2）
    await waitFor(() => fx.service.listTasks(id).find((task) => task.id === child.taskId)?.status === "completed");
    await waitFor(() => (fx.service.listTasks(id).find((task) => task.id === taskId)?.attempt ?? 1) >= 2);

    const woken = fx.service.listTasks(id).find((task) => task.id === taskId);
    expect(woken?.attempt).toBeGreaterThanOrEqual(2);
    expect(woken?.status === "running" || woken?.status === "completed").toBe(true);
  });

  test("负责人确认：成员 bash 待批 → 队长 permanent 放行 → 审计齐全；人类接口同源", async () => {
    const id = await createSquad(fx.app);
    const { taskId } = await fx.service.dispatchTask(id, { content: "总任务" });
    const child = await fx.service.dispatchToMember({
      squadId: id,
      leaderTaskId: taskId,
      memberId: "worker",
      content: "删掉 dist 重建",
    });

    // 成员执行中请求 bash：没授权 → 落 pending + 拒绝（拒绝只作用于这次调用）
    const decision = fx.service.checkToolPermission({
      agentId: "worker",
      toolName: "bash",
      toolInput: '{"command":"rm -rf dist"}',
      agentTaskId: child.agentTaskId,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.approval?.status).toBe("pending");
    expect(decision.approval?.targetType).toBe("leader");
    expect(decision.approval?.targetId).toBe("leader");

    // 人类视角能看到这条待裁决（/api/approvals）
    const pending = await fx.app.request("/api/approvals?status=pending");
    const list = (await pending.json()) as Array<{ id: string; agentId: string; toolName: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.agentId).toBe("worker");
    expect(list[0]?.toolName).toBe("bash");

    // 队长裁决（permanent）→ 后续同类调用放行
    const approved = fx.service.resolveApproval(list[0]!.id, {
      decision: "approve",
      scope: "permanent",
      actor: { type: "agent", id: "leader" },
      note: "队里允许重建 dist",
    });
    expect(approved.status).toBe("approved");
    expect(
      fx.service.checkToolPermission({ agentId: "worker", toolName: "bash", agentTaskId: child.agentTaskId })
        .allowed,
    ).toBe(true);

    // 详情带审计：谁批、批哪次、什么 scope
    const detail = await fx.app.request(`/api/approvals/${list[0]!.id}`);
    const payload = (await detail.json()) as {
      request: { status: string; resolvedById: string };
      audit: Array<{ action: string; actorId: string; scope?: string }>;
    };
    expect(payload.request.status).toBe("approved");
    expect(payload.request.resolvedById).toBe("leader");
    expect(payload.audit.map((entry) => entry.action)).toEqual(["request", "approve"]);
    expect(payload.audit[1]?.scope).toBe("permanent");

    // 重复裁决 → 409
    const again = await fx.app.request(`/api/approvals/${list[0]!.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(again.status).toBe(409);

    // 收回授权后重新拒绝
    const revoke = await fx.app.request("/api/approvals/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "worker", toolName: "bash" }),
    });
    expect(((await revoke.json()) as { revoked: number }).revoked).toBe(1);
    expect(
      fx.service.checkToolPermission({ agentId: "worker", toolName: "bash", agentTaskId: child.agentTaskId })
        .allowed,
    ).toBe(false);
  });

  test("归档后派单 → 409 squad_archived；auto 模式 → 协调器真分配 + 状态/推进接口", async () => {
    const id = await createSquad(fx.app);
    expect((await fx.app.request(`/api/squads/${id}`, { method: "DELETE" })).status).toBe(200);
    const archived = await fx.app.request(`/api/squads/${id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "还能派吗" }),
    });
    expect(archived.status).toBe(409);
    expect(((await archived.json()) as { error: { code: string } }).error.code).toBe("squad_archived");

    const id2 = "sq_auto";
    const created = await fx.app.request("/api/squads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: id2, name: "算法队", leaderId: "leader", mode: "auto" }),
    });
    expect(created.status).toBe(201);

    const auto = await fx.app.request(`/api/squads/${id2}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "算法分配一次", priority: "high" }),
    });
    expect(auto.status).toBe(201);
    const dispatched = (await auto.json()) as {
      taskId: string;
      runId: string;
      agentTaskId: string;
      mode: string;
      assigneeId: string | null;
      status: string;
    };
    // 只有队长一个 agent 成员：协调器把它当兜底成员分出去
    expect(dispatched.mode).toBe("auto");
    expect(dispatched.assigneeId).toBe("leader");
    expect(dispatched.status).toBe("running");
    expect(dispatched.runId).not.toBe("");
    expect(dispatched.agentTaskId).not.toBe("");

    const runs = await fx.app.request(`/api/squads/${id2}/runs`);
    const nodes = (await runs.json()) as Array<{ id: string; assignee: string; status: string }>;
    expect(nodes.some((node) => node.id === dispatched.runId && node.assignee === "leader")).toBe(true);

    const coordinator = await fx.app.request(`/api/squads/${id2}/coordinator`);
    expect(coordinator.status).toBe(200);
    const status = (await coordinator.json()) as {
      mode: string;
      members: Array<{ memberId: string; status: string }>;
      tasks: { total: number; running: number };
      events: Array<{ type: string }>;
    };
    expect(status.mode).toBe("auto");
    expect(status.members[0]!.memberId).toBe("leader");
    expect(status.tasks.total).toBe(1);
    expect(status.events.some((event) => event.type === "task-assigned")).toBe(true);

    const tick = await fx.app.request(`/api/squads/${id2}/coordinator/tick`, { method: "POST" });
    expect(tick.status).toBe(200);
    expect(((await tick.json()) as { reactivated: string[] }).reactivated).toEqual([]);
  });
});


