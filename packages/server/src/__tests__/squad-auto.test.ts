/**
 * @fengagent/server — auto 模式接线层单测（P2 第二阶段）
 *
 * 覆盖点：
 * 1. 分配：按成员顺序取空闲成员，「全员忙」时任务排队（pending），不丢；
 * 2. 优先级：排队任务补派时 urgent 先于 low（协调器的算法真的在起作用）；
 * 3. 失败转派：成员失败 → 换空闲成员重试，新 run 挂到上一轮 run 下（运行树能看出转派链）；
 * 4. 冷却：失败达阈值 → 成员冷却 + 任务排队；冷却到期 tick 后补派，成员失败计数清零；
 * 5. 持久化：重启后按 `squad_task` / `squad_member_state` 重建（成员占用与排队任务不丢）；
 * 6. 对账：库里非终态、执行侧已终态的任务在 reconcile 时结算。
 *
 * 用假 AgentTaskService 驱动：这里测的是**协调器与落盘**，不是 ACP 协议。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SquadStore } from "@fengagent/agent";
import type { AgentTaskDto, AgentTaskService } from "../agent-task-service.ts";
import { SquadAutoCoordinator } from "../squad-auto.ts";

/** 轮询到条件成立 */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("等待条件超时");
}

/** 假执行服务：记录派发、可手动结算终态 */
class FakeTasks {
  readonly submitted: Array<{ id: string; agentId: string; content: string }> = [];
  private readonly tasks = new Map<string, AgentTaskDto>();
  private readonly waiters = new Map<string, Set<(task: AgentTaskDto) => void>>();
  private seq = 0;

  async submit(request: { agent?: string; runtime?: string; content: string }): Promise<AgentTaskDto> {
    const id = `at_${++this.seq}`;
    const dto: AgentTaskDto = {
      id,
      fromSession: "",
      runtime: request.runtime ?? "fake",
      ...(request.agent === undefined ? {} : { agentId: request.agent }),
      status: "running",
      content: request.content,
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(id, dto);
    this.submitted.push({ id, agentId: request.agent ?? "", content: request.content });
    return dto;
  }

  getTask(id: string): AgentTaskDto | null {
    return this.tasks.get(id) ?? null;
  }

  waitForTerminal(id: string): Promise<AgentTaskDto> {
    const current = this.tasks.get(id);
    if (!current) return Promise.reject(new Error(`任务不存在: ${id}`));
    if (current.status === "replied" || current.status === "failed") return Promise.resolve(current);
    return new Promise<AgentTaskDto>((resolve) => {
      const set = this.waiters.get(id) ?? new Set<(task: AgentTaskDto) => void>();
      set.add(resolve);
      this.waiters.set(id, set);
    });
  }

  /** 结算一条执行任务（模拟成员跑完/跑挂） */
  finish(id: string, status: "replied" | "failed", patch: { result?: string; error?: string } = {}): void {
    const current = this.tasks.get(id);
    if (!current) throw new Error(`任务不存在: ${id}`);
    const next: AgentTaskDto = { ...current, status, ...patch };
    this.tasks.set(id, next);
    for (const waiter of this.waiters.get(id) ?? []) waiter(next);
    this.waiters.delete(id);
  }
}

interface Fixture {
  dir: string;
  store: SquadStore;
  tasks: FakeTasks;
  auto: SquadAutoCoordinator;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "feng-squad-auto-"));
  const store = new SquadStore(join(dir, "squad.db"));
  store.createSquad({
    id: "sq_auto",
    name: "算法队",
    leaderId: "leader",
    mode: "auto",
    members: [
      { memberId: "w1", role: "前端" },
      { memberId: "w2", role: "后端" },
    ],
  });
  const tasks = new FakeTasks();
  const auto = new SquadAutoCoordinator({
    store,
    tasks: tasks as unknown as AgentTaskService,
    composeMemberPrompt: (agentId, content) => `[${agentId}]\n${content}`,
    waitTimeoutMs: 5000,
  });
  return { dir, store, tasks, auto };
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 偶发占用
    }
  }
  delete process.env["FENG_SQUAD_MAX_FAILURES"];
  delete process.env["FENG_SQUAD_COOLDOWN_MS"];
});

describe("auto 模式：接线的 SquadCoordinator", () => {
  test("按成员顺序分配（队长最后兜底）；全员忙时任务排队（pending，不丢）", async () => {
    const fx = makeFixture();
    dirs.push(fx.dir);

    const a = await fx.auto.dispatch("sq_auto", { content: "任务 A" });
    const b = await fx.auto.dispatch("sq_auto", { content: "任务 B" });
    const c = await fx.auto.dispatch("sq_auto", { content: "任务 C" });
    expect(a.assigneeId).toBe("w1");
    expect(b.assigneeId).toBe("w2");
    // 队长排在候选最后：队员都在忙时才兜底接活
    expect(c.assigneeId).toBe("leader");
    expect(a.status).toBe("running");
    expect(fx.tasks.submitted.map((item) => item.agentId)).toEqual(["w1", "w2", "leader"]);

    const d = await fx.auto.dispatch("sq_auto", { content: "任务 D" });
    expect(d.status).toBe("pending");
    expect(d.runId).toBe("");
    expect(d.agentTaskId).toBe("");
    const queued = fx.store.getTask(d.taskId)!;
    expect(queued.status).toBe("pending");
    expect(queued.priority).toBe("normal");
    expect(fx.store.listRuns("sq_auto")).toHaveLength(3);

    // 成员释放 → 排队任务自动补派（不需要手动 tick）
    fx.tasks.finish(a.agentTaskId, "replied", { result: "done" });
    await waitFor(() => fx.store.getTask(d.taskId)!.status === "running");
    expect(fx.store.getTask(d.taskId)!.assigneeId).toBe("w1");
  });

  test("排队任务按优先级补派：urgent 先于 low", async () => {
    const fx = makeFixture();
    dirs.push(fx.dir);

    const a = await fx.auto.dispatch("sq_auto", { content: "任务 A" });
    await fx.auto.dispatch("sq_auto", { content: "任务 B" });
    const c = await fx.auto.dispatch("sq_auto", { content: "任务 C" });
    expect(c.assigneeId).toBe("leader");
    const low = await fx.auto.dispatch("sq_auto", { content: "低优先", priority: "low" });
    const urgent = await fx.auto.dispatch("sq_auto", { content: "紧急", priority: "urgent" });
    expect(low.status).toBe("pending");
    expect(urgent.status).toBe("pending");

    fx.tasks.finish(a.agentTaskId, "replied", { result: "done" });
    await waitFor(() => fx.store.getTask(urgent.taskId)!.status === "running");
    expect(fx.store.getTask(urgent.taskId)!.assigneeId).toBe("w1");
    expect(fx.store.getTask(urgent.taskId)!.priority).toBe("urgent");
    expect(fx.store.getTask(low.taskId)!.status).toBe("pending");
    expect(fx.store.getTask(a.taskId)!.status).toBe("completed");
  });

  test("成员失败 → 换空闲成员重试，新 run 挂在上一轮下", async () => {
    const fx = makeFixture();
    dirs.push(fx.dir);

    const a = await fx.auto.dispatch("sq_auto", { content: "会失败的活" });
    const firstRunId = a.runId;
    fx.tasks.finish(a.agentTaskId, "failed", { error: "runtime 挂了" });

    await waitFor(() => fx.store.getTask(a.taskId)!.assigneeId === "w2");
    const task = fx.store.getTask(a.taskId)!;
    expect(task.status).toBe("running");
    expect(task.reassignmentCount).toBe(1);
    expect(task.error).toContain("runtime 挂了");

    const runs = fx.store.listRuns("sq_auto");
    expect(runs).toHaveLength(2);
    expect(runs[1]!.agentId).toBe("w2");
    expect(runs[1]!.parentRunId).toBe(firstRunId);
    expect(fx.tasks.submitted.map((item) => item.agentId)).toEqual(["w1", "w2"]);
    expect(fx.tasks.submitted[1]!.content).toContain("会失败的活");
  });

  test("失败达阈值 → 成员冷却 + 任务排队；冷却到期 tick 后补派并清零失败计数", async () => {
    process.env["FENG_SQUAD_MAX_FAILURES"] = "1";
    process.env["FENG_SQUAD_COOLDOWN_MS"] = "60";
    const dir = mkdtempSync(join(tmpdir(), "feng-squad-auto-solo-"));
    dirs.push(dir);
    const store = new SquadStore(join(dir, "squad.db"));
    store.createSquad({ id: "sq_solo", name: "单人队", leaderId: "w1", mode: "auto" });
    const tasks = new FakeTasks();
    const auto = new SquadAutoCoordinator({
      store,
      tasks: tasks as unknown as AgentTaskService,
      composeMemberPrompt: (_agentId, content) => content,
      waitTimeoutMs: 5000,
    });

    const a = await auto.dispatch("sq_solo", { content: "会失败的活" });
    const b = await auto.dispatch("sq_solo", { content: "排队的活" });
    expect(b.status).toBe("pending");

    tasks.finish(a.agentTaskId, "failed", { error: "boom" });
    await waitFor(() => store.getMemberState("sq_solo", "w1")?.status === "cooldown");
    // 冷却中的成员不接活：任务排队而不是判死
    expect(store.getTask(a.taskId)!.status).toBe("pending");
    expect(store.getMemberState("sq_solo", "w1")!.failureCount).toBe(1);

    await Bun.sleep(80);
    const ticked = await auto.tick("sq_solo");
    expect(ticked.reactivated).toEqual(["w1"]);
    await waitFor(() => store.getTask(a.taskId)!.status === "running");
    expect(store.getMemberState("sq_solo", "w1")!.failureCount).toBe(0);
    expect(store.getMemberState("sq_solo", "w1")!.status).toBe("busy");
    // 只有一个成员：第二条继续排队等待
    expect(store.getTask(b.taskId)!.status).toBe("pending");
  });

  test("重启后按盘重建：成员占用与排队任务不丢", async () => {
    const fx = makeFixture();
    dirs.push(fx.dir);

    await fx.auto.dispatch("sq_auto", { content: "任务 A" });
    await fx.auto.dispatch("sq_auto", { content: "任务 B" });
    await fx.auto.dispatch("sq_auto", { content: "任务 C" });
    const d = await fx.auto.dispatch("sq_auto", { content: "任务 D" });
    expect(d.status).toBe("pending");

    // 新实例 = 模拟进程重启（同一个库 + 同一个执行服务）
    const restarted = new SquadAutoCoordinator({
      store: fx.store,
      tasks: fx.tasks as unknown as AgentTaskService,
      composeMemberPrompt: (agentId, content) => `[${agentId}]\n${content}`,
      waitTimeoutMs: 5000,
    });
    const status = restarted.status("sq_auto");
    expect(status.members.find((member) => member.memberId === "w1")!.status).toBe("busy");
    expect(status.members.find((member) => member.memberId === "w2")!.status).toBe("busy");
    expect(status.members.find((member) => member.memberId === "leader")!.status).toBe("busy");
    expect(status.tasks.running).toBe(3);
    expect(status.tasks.pending).toBe(1);

    // 排队任务在重启后照样能被补派（协调器从库里恢复成 pending）
    const first = fx.store.listTasks("sq_auto").find((task) => task.status === "running")!;
    fx.tasks.finish(first.agentTaskId!, "replied", { result: "done" });
    await waitFor(() => fx.store.getTask(d.taskId)!.status === "running");
  });

  test("对账：库里 running、执行侧已终态的任务在 reconcile 时结算", async () => {
    const fx = makeFixture();
    dirs.push(fx.dir);

    // 手工造一条「上进程留下」的任务：库里 running，执行侧其实已经 replied
    const agentTask = await fx.tasks.submit({ agent: "w1", content: "重启前就结束的活" });
    const row = fx.store.createTask({
      squadId: "sq_auto",
      isLeader: false,
      assigneeId: "w1",
      title: "重启前就结束的活",
      content: "重启前就结束的活",
      status: "assigned",
    });
    const run = fx.store.createRun({
      squadId: "sq_auto",
      squadTaskId: row.id,
      agentId: "w1",
      title: "重启前就结束的活",
    });
    fx.store.updateTask(row.id, { runId: run.id, agentTaskId: agentTask.id, status: "running" });
    fx.tasks.finish(agentTask.id, "replied", { result: "重启前的结果" });

    const settled = await fx.auto.reconcile("sq_auto");
    expect(settled).toEqual([row.id]);
    const done = fx.store.getTask(row.id)!;
    expect(done.status).toBe("completed");
    expect(done.result).toBe("重启前的结果");
    expect(fx.store.listRuns("sq_auto").find((item) => item.id === run.id)!.status).toBe("completed");
  });
});
