/**
 * @fengagent/server — 等待审批（waiting_approval）端到端验收（P2 第二阶段）
 *
 * 真 spawn `fake-acp-agent` 当队长/成员，覆盖「任务等负责人裁决」这条链：
 * 1. 成员请求 bash → 落 pending 审批 + 小队任务进**非终态** `waiting_approval`
 *    （原因写 `blocked_reason`，run 同步等待态，`/runs` 契约带原因）；
 * 2. 成员这一轮结束也**不判死**整轮：任务仍是 waiting_approval，不会变 failed；
 * 3. 裁决（批准）→ 续跑：回到 running，并补一轮「已批准 + 继续」的续跑任务；
 *    授权 permanent 后续调用直接放行，任务最终 completed；
 * 4. 裁决（拒绝）→ 同样续跑（换路径继续），续跑正文带「拒绝」；
 * 5. 事件流对接：执行侧有时间线事件 `task/blocked` / `task/unblocked`。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AgentRegistry, ApprovalStore, SquadStore } from "@fengagent/agent";
import { AgentTaskService } from "../agent-task-service.ts";
import { AgentRuntimeRegistry } from "../agent-runtimes.ts";
import { SquadService } from "../squad-service.ts";
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

/** 轮询到条件成立 */
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
  store: SquadStore;
  app: Hono;
  dir: string;
}

async function makeFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "feng-squad-wait-"));
  const runtimeRegistry = new AgentRuntimeRegistry({
    dataRoot: dir,
    entries: [{ name: "fake", command: process.execPath, args: [FIXTURE], enabled: true }],
  });
  await runtimeRegistry.probeAll();
  const agentRegistry = new AgentRegistry({ dataRoot: dir });
  agentRegistry.create({
    id: "leader",
    displayName: "队长",
    runtime: "fake",
    instructions: "你是队长。",
  });
  agentRegistry.create({
    id: "worker",
    displayName: "成员甲",
    runtime: "fake",
    instructions: "你是成员甲。",
  });
  const tasks = new AgentTaskService({
    dataRoot: dir,
    registry: runtimeRegistry,
    agentRegistry,
    defaultCwd: mkdtempSync(join(tmpdir(), "feng-squad-wait-work-")),
    requestTimeoutMs: 8000,
    promptTimeoutMs: 15_000,
    autoProbe: false,
    recoverOnStart: false,
  });
  const store = new SquadStore(join(dir, "sessions.db"));
  const approvals = new ApprovalStore(join(dir, "sessions.db"));
  const service = new SquadService({
    store,
    approvals,
    agentRegistry,
    tasks,
    humanOwner: "owner",
    waitTimeoutMs: 15_000,
  });
  const app = new Hono();
  app.route("/api/squads", createSquadRoutes(service));
  app.route("/api/approvals", createApprovalRoutes(service, "owner"));
  return { service, tasks, approvals, store, app, dir };
}

/** 建一支「队长 + 成员」的小队，返回小队 id */
async function createSquad(app: Hono): Promise<string> {
  const res = await app.request("/api/squads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "sq_wait",
      name: "审批小队",
      leaderId: "leader",
      members: [{ memberType: "agent", memberId: "worker", role: "实现" }],
    }),
  });
  expect(res.status).toBe(201);
  return "sq_wait";
}

/** 派一条队长任务 + 一条成员子任务，返回子任务 */
async function dispatchChild(fx: Fixture, content: string) {
  const leader = await fx.service.dispatchTask("sq_wait", { content: "总任务" });
  return fx.service.dispatchToMember({
    squadId: "sq_wait",
    leaderTaskId: leader.taskId,
    memberId: "worker",
    content,
  });
}

describe("waiting_approval：任务等审批不判死，裁决后续跑", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(async () => {
    await fx.tasks.close();
    safeRm(fx.dir);
  });

  test("进入等待态 + 执行侧终态后仍等待 + 裁决续跑（批准）", async () => {
    await createSquad(fx.app);
    const child = await dispatchChild(fx, "删掉 dist 重建");

    // ① 成员请求 bash：没授权 → 落 pending 审批，任务进 waiting_approval
    const decision = fx.service.checkToolPermission({
      agentId: "worker",
      toolName: "bash",
      toolInput: '{"command":"rm -rf dist"}',
      reason: "重建产物",
      agentTaskId: child.agentTaskId,
    });
    expect(decision.allowed).toBe(false);
    const approvalId = decision.approval!.id;

    const waiting = fx.store.getTask(child.taskId)!;
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.blockedReason).toContain("等待裁决：bash");
    expect(waiting.blockedReason).toContain("重建产物");

    // ② 运行树同步等待态：状态 + 原因 + 执行任务深链都在契约里
    const runs = await fx.app.request("/api/squads/sq_wait/runs");
    expect(runs.status).toBe(200);
    const nodes = (await runs.json()) as Array<{
      id: string;
      assignee: string;
      status: string;
      blockedReason: string | null;
      agentTaskId: string | null;
    }>;
    const childNode = nodes.find((node) => node.assignee === "worker")!;
    expect(childNode.status).toBe("waiting_approval");
    expect(childNode.blockedReason).toContain("bash");
    expect(childNode.agentTaskId).toBe(child.agentTaskId);

    // ③ 执行侧这一轮结束（权限被拒后照常收口）→ 任务**仍然**等待，不判死
    await waitFor(() => {
      const task = fx.tasks.getTask(child.agentTaskId);
      return task !== null && (task.status === "replied" || task.status === "failed");
    });
    await Bun.sleep(150);
    const stillWaiting = fx.store.getTask(child.taskId)!;
    expect(stillWaiting.status).toBe("waiting_approval");
    expect(stillWaiting.error).toBeUndefined();

    // ④ 事件流对接：执行侧有 task/blocked（带审批引用）
    const blockedEvents = fx.tasks.listEvents(child.agentTaskId);
    expect(blockedEvents.some((event) => event.type === "task/blocked")).toBe(true);
    expect(blockedEvents.find((event) => event.type === "task/blocked")!.detail).toContain(
      approvalId,
    );

    // ⑤ 批准（permanent）→ 续跑：回到 running，补一轮「已批准 + 继续」的任务
    const oldAgentTaskId = fx.store.getTask(child.taskId)!.agentTaskId!;
    const resolved = fx.service.resolveApproval(approvalId, {
      decision: "approve",
      scope: "permanent",
      actor: { type: "agent", id: "leader" },
      note: "队里允许重建 dist",
    });
    expect(resolved.status).toBe("approved");

    await waitFor(() => {
      const task = fx.store.getTask(child.taskId)!;
      return task.status === "running" && task.agentTaskId !== oldAgentTaskId;
    });
    const resumed = fx.store.getTask(child.taskId)!;
    expect(resumed.blockedReason).toBeUndefined();
    const resumedTask = fx.tasks.getTask(resumed.agentTaskId!)!;
    expect(resumedTask.content).toContain("已批准");
    expect(resumedTask.content).toContain("继续");
    // 续跑任务有自己的 unblocked 事件，时间线对得上
    expect(
      fx.tasks.listEvents(resumed.agentTaskId!).some((event) => event.type === "task/unblocked"),
    ).toBe(true);

    // ⑥ permanent 授权生效：这一轮再请求 bash 直接放行 → 任务跑完变 completed
    await waitFor(() => fx.store.getTask(child.taskId)!.status === "completed", 30_000);
    const done = fx.store.getTask(child.taskId)!;
    expect(done.status).toBe("completed");
    expect(done.blockedReason).toBeUndefined();
  }, 60_000);

  test("裁决（拒绝）同样续跑：换路径继续，不把整轮判死", async () => {
    await createSquad(fx.app);
    const child = await dispatchChild(fx, "清理缓存目录");

    const decision = fx.service.checkToolPermission({
      agentId: "worker",
      toolName: "bash",
      agentTaskId: child.agentTaskId,
    });
    const approvalId = decision.approval!.id;
    expect(fx.store.getTask(child.taskId)!.status).toBe("waiting_approval");

    // 等这一轮收口，再拒绝
    await waitFor(() => {
      const task = fx.tasks.getTask(child.agentTaskId);
      return task !== null && (task.status === "replied" || task.status === "failed");
    });
    const oldAgentTaskId = fx.store.getTask(child.taskId)!.agentTaskId!;
    fx.service.resolveApproval(approvalId, {
      decision: "deny",
      actor: { type: "member", id: "owner" },
      note: "不允许删缓存",
    });

    await waitFor(() => {
      const task = fx.store.getTask(child.taskId)!;
      return task.status === "running" && task.agentTaskId !== oldAgentTaskId;
    });
    const resumed = fx.store.getTask(child.taskId)!;
    expect(resumed.status).toBe("running");
    const resumedTask = fx.tasks.getTask(resumed.agentTaskId!)!;
    expect(resumedTask.content).toContain("负责人拒绝");
    expect(resumedTask.content).toContain("换一条");
    // 拒绝不是判死：续跑这一轮照常收口，任务以 completed 结束（不是 failed）
    await waitFor(() => fx.store.getTask(child.taskId)!.status === "completed", 30_000);
    const done = fx.store.getTask(child.taskId)!;
    expect(done.status).toBe("completed");
    expect(done.error).toBeUndefined();
    expect(done.blockedReason).toBeUndefined();
  }, 60_000);

  test("审批详情带审计流：request / approve 两笔，scope 落库", async () => {
    await createSquad(fx.app);
    const child = await dispatchChild(fx, "重建产物");
    const decision = fx.service.checkToolPermission({
      agentId: "worker",
      toolName: "bash",
      agentTaskId: child.agentTaskId,
    });
    await waitFor(() => {
      const task = fx.tasks.getTask(child.agentTaskId);
      return task !== null && (task.status === "replied" || task.status === "failed");
    });
    fx.service.resolveApproval(decision.approval!.id, {
      decision: "approve",
      scope: "session",
      actor: { type: "agent", id: "leader" },
    });

    const detail = await fx.app.request(`/api/approvals/${decision.approval!.id}`);
    expect(detail.status).toBe(200);
    const payload = (await detail.json()) as {
      request: { status: string; squadTaskId?: string };
      audit: Array<{ action: string; scope?: string }>;
    };
    expect(payload.request.status).toBe("approved");
    expect(payload.request.squadTaskId).toBe(child.taskId);
    expect(payload.audit.map((entry) => entry.action)).toEqual(["request", "approve"]);
    expect(payload.audit[1]!.scope).toBe("session");
  }, 60_000);
});
