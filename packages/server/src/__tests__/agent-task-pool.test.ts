/**
 * @fengagent/server — 任务池认领（P3-1）测试
 *
 * 覆盖 claude大哥 调研 6 点里可验证的部分：
 *
 * 1. opt-in：`claimPolicy` 缺省仍是点名派发（原语义零变化），`pool` 只进池不派发；
 * 2. 状态/事件：`claimed` + `task/claimed` / `task/requeued`（可重放）；
 * 3. 原子认领：后到者 409（`already_claimed`），不是「先 SELECT 再 UPDATE」；
 * 4. 两道保险：per-agent 串行（`agent_busy`）+ 租约回收（过期回池、不判死）；
 * 5. API：`GET /api/agent-tasks?claimable=1&squad=…`、`POST /api/agent-tasks/:id/claim`；
 * 6. 池内过滤：小队成员 + roster skill 标签（不做能力评分）；
 * 7. 崩溃恢复：`claimed` → `created`（回池），池里的 `created` 不算遗留残局。
 *
 * 认领成功后会真 spawn `fake-acp-agent`，所以「认领即派发」是端到端验的。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@fengagent/agent";
import { AgentTaskService, TaskClaimError } from "../agent-task-service.ts";
import type { TaskPoolScope } from "../agent-task-service.ts";
import { AgentRuntimeRegistry } from "../agent-runtimes.ts";
import { createAgentTaskRoutes } from "../routes/agent-tasks.ts";

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

/** Windows 上子进程 cwd 会占住目录句柄：删不掉也不算失败（清理不是断言） */
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

interface TestScope extends TaskPoolScope {
  squadMembers: Map<string, Set<string>>;
  skills: Map<string, string[]>;
}

interface Harness {
  service: AgentTaskService;
  dir: string;
  app: ReturnType<typeof createAgentTaskRoutes>;
  scope: TestScope;
}

/**
 * 造一个带池过滤上下文的服务（fake runtime 真 spawn + 真智能体绑定）。
 *
 * `squadMembers` / `skills` 在用例里按需填，过滤逻辑就走真实闭包。
 */
async function makeHarness(
  options: { leaseMs?: number; now?: () => number } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "feng-agent-pool-"));
  const registry = new AgentRuntimeRegistry({
    dataRoot: dir,
    entries: [{ name: "fake", command: process.execPath, args: [FIXTURE], enabled: true }],
    // 桩探测：用例不该等 20s 真握手
    probe: async () => ({
      agentName: "fake-acp",
      agentVersion: "1.0.0",
      capabilities: { resume: false, loadSession: false, image: false },
      probedAt: new Date().toISOString(),
    }),
  });
  await registry.probeAll();
  const agents = new AgentRegistry({ dataRoot: dir, workdir: dir });
  for (const id of ["coder", "writer"]) agents.create({ id, runtime: "fake" });
  const squadMembers = new Map<string, Set<string>>();
  const skills = new Map<string, string[]>();
  const scope: TestScope = {
    squadMembers,
    skills,
    hasSquad: (squadId: string) => squadMembers.has(squadId),
    hasAgentMember: (squadId: string, agentId: string) =>
      squadMembers.get(squadId)?.has(agentId) ?? false,
    skillsFor: (agentId: string) => skills.get(agentId) ?? [],
  };
  const service = new AgentTaskService({
    dataRoot: dir,
    registry,
    agentRegistry: agents,
    defaultCwd: mkdtempSync(join(tmpdir(), "feng-agent-pool-work-")),
    requestTimeoutMs: 8000,
    promptTimeoutMs: 15_000,
    autoProbe: false,
    recoverOnStart: false,
    pool: {
      scope,
      leaseMs: options.leaseMs ?? 10 * 60_000,
      // 用例里手动 sweep，别让后台定时器把时序搅乱
      sweepIntervalMs: 0,
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { service, dir, app: createAgentTaskRoutes(service), scope };
}

describe("任务池认领 — 服务层", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.service.close();
    safeRm(h.dir);
  });

  test("opt-in：pool 任务只进池不派发；缺省 claimPolicy 仍是点名派发", async () => {
    const pooled = await h.service.submit({
      content: "这活谁有空谁干",
      claimPolicy: "pool",
      runtime: "fake",
    });
    expect(pooled.status).toBe("created");
    expect(pooled.claimPolicy).toBe("pool");
    expect(pooled.agentId).toBeUndefined();
    expect(pooled.runtime).toBe("fake");

    // 给 dispatch 一次「跑起来」的机会：池任务没认领就不该动
    await Bun.sleep(120);
    expect(h.service.store.get(pooled.id)!.status).toBe("created");
    expect(h.service.store.get(pooled.id)!.dispatchedAt).toBeUndefined();

    // 默认（不传 claimPolicy）= 点名派发，行为与 P2 完全一致
    const assigned = await h.service.submit({ runtime: "fake", content: "点名" });
    expect(assigned.claimPolicy).toBe("assigned");
    expect(["dispatched", "running", "replied"]).toContain(assigned.status);
    await h.service.waitForTerminal(assigned.id, 15_000);
  });

  test("认领即派发：claimed → dispatched → replied，事件流带 task/claimed", async () => {
    const pooled = await h.service.submit({
      content: "池任务",
      claimPolicy: "pool",
      runtime: "fake",
    });
    const claimed = h.service.claimTask(pooled.id, "coder");
    expect(claimed.ok).toBe(true);
    expect(claimed.status).toBe("claimed");
    expect(claimed.leaseExpiresAt).toBeGreaterThan(Date.now());
    expect(claimed.task.agentId).toBe("coder");

    const done = await h.service.waitForTerminal(pooled.id, 15_000);
    expect(done.status).toBe("replied");

    const events = h.service.listEvents(pooled.id).map((event) => event.type);
    expect(events[0]).toBe("task/created");
    expect(events).toContain("task/claimed");
    expect(events).toContain("task/replied");
    expect(events.indexOf("task/claimed")).toBeLessThan(events.indexOf("task/replied"));
  });

  test("原子认领：第二个 agent 拿到 409 already_claimed，不会把任务抢走", async () => {
    const pooled = await h.service.submit({
      content: "只该有一个人干",
      claimPolicy: "pool",
      runtime: "fake",
    });
    h.service.claimTask(pooled.id, "coder");

    let error: unknown;
    try {
      h.service.claimTask(pooled.id, "writer");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(TaskClaimError);
    expect((error as TaskClaimError).code).toBe("already_claimed");
    expect((error as TaskClaimError).status).toBe(409);
    expect(h.service.store.get(pooled.id)!.agentId).toBe("coder");
    await h.service.waitForTerminal(pooled.id, 15_000);
  });

  test("per-agent 串行：同一个 agent 手上有在飞任务时不能再认领（agent_busy）", async () => {
    const first = await h.service.submit({
      content: "第一件",
      claimPolicy: "pool",
      runtime: "fake",
    });
    const second = await h.service.submit({
      content: "第二件",
      claimPolicy: "pool",
      runtime: "fake",
    });
    // 直接落库认领（不自动派发），让「手上有活」这件事在用例里稳定成立
    expect(h.service.store.claim(first.id, "coder", { leaseMs: 60_000 }).ok).toBe(true);

    let error: unknown;
    try {
      h.service.claimTask(second.id, "coder");
    } catch (err) {
      error = err;
    }
    expect((error as TaskClaimError).code).toBe("agent_busy");
    expect(h.service.store.get(second.id)!.status).toBe("created");

    // 另一个 agent 可以拿走第二件（真派发）
    expect(h.service.claimTask(second.id, "writer").ok).toBe(true);
    await h.service.waitForTerminal(second.id, 15_000);
  });

  test("租约回收：过期 claimed 回池（created + task/requeued），可以重新认领", async () => {
    let now = 1_000_000;
    const harness = await makeHarness({ leaseMs: 1_000, now: () => now });
    try {
      const pooled = harness.service.store.create({
        runtime: "fake",
        content: "认领后进程崩了",
        cwd: harness.dir,
        claimPolicy: "pool",
      }).task;
      // 模拟「认领成功、还没派发就崩了」：直接落库认领，不走 claimTask 的自动派发
      expect(
        harness.service.store.claim(pooled.id, "coder", { leaseMs: 1_000, now }).ok,
      ).toBe(true);
      expect(harness.service.listClaimableTasks()).toHaveLength(0);

      now += 1_500;
      expect(harness.service.sweepLeases()).toEqual([pooled.id]);
      const after = harness.service.store.get(pooled.id)!;
      expect(after.status).toBe("created");
      expect(after.agentId).toBeUndefined();
      expect(harness.service.listClaimableTasks().map((task) => task.id)).toEqual([pooled.id]);
      expect(harness.service.listEvents(pooled.id).map((event) => event.type)).toContain(
        "task/requeued",
      );
      // 回池后可以被别人重新认领
      expect(
        harness.service.store.claim(pooled.id, "writer", { leaseMs: 1_000, now }).ok,
      ).toBe(true);
    } finally {
      await harness.service.close();
      safeRm(harness.dir);
    }
  });

  test("崩溃恢复：claimed → created 回池（不判死），池里的 created 保持不动", async () => {
    const waiting = await h.service.submit({
      content: "还没人认领",
      claimPolicy: "pool",
      runtime: "fake",
    });
    const claimedTask = h.service.store.create({
      runtime: "fake",
      content: "认领后崩溃",
      cwd: h.dir,
      claimPolicy: "pool",
    }).task;
    h.service.store.claim(claimedTask.id, "coder", { leaseMs: 60_000 });

    const recovered = h.service.recoverInterrupted();
    expect(recovered).toEqual([claimedTask.id]);
    expect(h.service.store.get(claimedTask.id)!.status).toBe("created");
    expect(h.service.store.get(waiting.id)!.status).toBe("created");
    expect(h.service.listEvents(claimedTask.id).map((event) => event.type)).toContain(
      "task/requeued",
    );
  });

  test("池内过滤：小队成员 + roster skill 标签（claimable 列表与认领同口径）", async () => {
    h.scope.squadMembers.set("sq_web", new Set(["coder"]));
    h.scope.skills.set("coder", ["react", "review"]);
    h.scope.skills.set("writer", ["docs"]);

    const scoped = await h.service.submit({
      content: "前端池任务",
      claimPolicy: "pool",
      runtime: "fake",
      poolScope: "sq_web",
      skillTags: ["review"],
    });

    // writer 不在小队里 → 候选列表看不到、也认领不了
    expect(h.service.listClaimableTasks({ squad: "sq_web", agent: "writer" })).toHaveLength(0);
    expect(
      h.service.listClaimableTasks({ squad: "sq_web", agent: "coder" }).map((t) => t.id),
    ).toEqual([scoped.id]);

    let error: unknown;
    try {
      h.service.claimTask(scoped.id, "writer");
    } catch (err) {
      error = err;
    }
    expect((error as TaskClaimError).code).toBe("not_member");
    expect((error as TaskClaimError).status).toBe(409);

    // 成员但缺技能 → skill_mismatch
    h.scope.squadMembers.get("sq_web")!.add("writer");
    try {
      h.service.claimTask(scoped.id, "writer");
    } catch (err) {
      error = err;
    }
    expect((error as TaskClaimError).code).toBe("skill_mismatch");

    // 成员且技能齐 → 认领成功并真跑起来
    expect(h.service.claimTask(scoped.id, "coder").ok).toBe(true);
    await h.service.waitForTerminal(scoped.id, 15_000);
  });

  test("池任务不写死 runtime：认领时按认领人绑定解析", async () => {
    const pooled = await h.service.submit({ content: "没写 runtime", claimPolicy: "pool" });
    expect(pooled.runtime).toBe("");
    const claimed = h.service.claimTask(pooled.id, "coder");
    expect(claimed.task.runtime).toBe("fake");
    const done = await h.service.waitForTerminal(pooled.id, 15_000);
    expect(done.status).toBe("replied");

    // 不存在的 agent 认领这种任务 → 明确 404，不静默失败
    const another = await h.service.submit({ content: "再来一件", claimPolicy: "pool" });
    let error: unknown;
    try {
      h.service.claimTask(another.id, "ghost");
    } catch (err) {
      error = err;
    }
    expect((error as TaskClaimError).code).toBe("agent_not_found");
    expect((error as TaskClaimError).status).toBe(404);
  });
});

describe("任务池认领 — API 契约（P3-1）", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.service.close();
    safeRm(h.dir);
  });

  test("POST / 建池任务（无需 agent/runtime）→ 201 created；缺省仍是点名派发", async () => {
    const res = await h.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "池任务 A", claimPolicy: "pool" }),
    });
    expect(res.status).toBe(201);
    const task = (await res.json()) as { id: string; status: string; claimPolicy: string };
    expect(task.status).toBe("created");
    expect(task.claimPolicy).toBe("pool");

    const bad = await h.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", claimPolicy: "whatever" }),
    });
    expect(bad.status).toBe(400);

    const missing = await h.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(missing.status).toBe(400);
  });

  test("GET ?claimable=1&squad=… → 平铺数组（字段与前端 ClaimableTask 对齐）", async () => {
    h.scope.squadMembers.set("sq_web", new Set(["coder"]));
    await h.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "前端池任务",
        claimPolicy: "pool",
        poolScope: "sq_web",
        skillTags: ["react"],
      }),
    });
    const res = await h.app.request("/?claimable=1&squad=sq_web");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      content: "前端池任务",
      claimPolicy: "pool",
      poolScope: "sq_web",
      skillTags: ["react"],
      status: "created",
    });
    expect(typeof list[0]!.createdAt).toBe("string");

    // 别的池看不到
    const other = (await (
      await h.app.request("/?claimable=1&squad=sq_backend")
    ).json()) as unknown[];
    expect(other).toHaveLength(0);
  });

  test("GET ?pool=1 → 含已被认领任务的 claimedBy / leaseExpiresAt / leaseExpired", async () => {
    const created = (await (
      await h.app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "池任务", claimPolicy: "pool", runtime: "fake" }),
      })
    ).json()) as { id: string };

    const claimRes = await h.app.request(`/${created.id}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "coder" }),
    });
    expect(claimRes.status).toBe(200);
    const claim = (await claimRes.json()) as {
      ok: boolean;
      status: string;
      leaseExpiresAt: number;
      task: { status: string; agentId: string };
    };
    expect(claim.ok).toBe(true);
    expect(claim.status).toBe("claimed");
    expect(typeof claim.leaseExpiresAt).toBe("number");
    expect(claim.task.agentId).toBe("coder");

    const pool = (await (await h.app.request("/?pool=1")).json()) as Array<
      Record<string, unknown>
    >;
    const item = pool.find((row) => row.id === created.id)!;
    expect(item.claimedBy).toBe("coder");
    expect(typeof item.leaseExpiresAt).toBe("string");
    expect(item.leaseExpired).toBe(false);
    await h.service.waitForTerminal(created.id, 15_000);
  });

  test("POST /:id/claim 的失败面：409 已被认领 / 409 非池任务 / 404 不存在 / 400 缺 agent", async () => {
    const pooled = (await (
      await h.app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "池任务", claimPolicy: "pool", runtime: "fake" }),
      })
    ).json()) as { id: string };
    const assigned = (await (
      await h.app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "点名任务", runtime: "fake" }),
      })
    ).json()) as { id: string };
    await h.service.waitForTerminal(assigned.id, 15_000);

    // 直接落库认领（不自动派发），保证第二次认领稳定命中 already_claimed
    expect(h.service.store.claim(pooled.id, "coder", { leaseMs: 60_000 }).ok).toBe(true);

    const claim = (id: string, agent: string | undefined) =>
      h.app.request(`/${id}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(agent === undefined ? {} : { agent }),
      });

    const conflict = await claim(pooled.id, "writer");
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
      "already_claimed",
    );

    const notPool = await claim(assigned.id, "coder");
    expect(notPool.status).toBe(409);
    expect(((await notPool.json()) as { error: { code: string } }).error.code).toBe("not_pool");

    expect((await claim("nope", "coder")).status).toBe(404);
    expect((await claim(pooled.id, undefined)).status).toBe(400);
  });

  test("既有契约不破：GET / 仍返回 {tasks, runtimes}", async () => {
    const res = await h.app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[]; runtimes: unknown[] };
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(Array.isArray(body.runtimes)).toBe(true);
  });
});
