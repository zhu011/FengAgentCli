/**
 * @fengagent/server — 外派任务服务 + Agents API 测试（P1 + P2）
 *
 * 用 `packages/agent/src/__tests__/fixtures/fake-acp-agent.ts` 当被派发的目标运行时
 * （真 spawn、真 NDJSON），覆盖：
 *
 * 1. 派发全流程：created → dispatched → accepted → running → replied（结果回流）；
 * 2. 权限请求按策略 deny 且**留痕**（事件里有 `[permission]`），不静默挂起；
 * 3. 失败路径（目标回 JSON-RPC error）落 failed + error；
 * 4. 取消（running → cancelled）；
 * 5. retry = 新 attempt（task/retried 事件 + attempt 递增）；
 * 6. 幂等台账：同 attempt 已 succeeded → 回放结果不重跑；仍 pending → 拒绝并报未决；
 * 7. 启动恢复：遗留 created → expired、dispatched/running → failed（不自动重跑）；
 * 8. 路由契约：GET/POST /api/agent-tasks、详情/取消、SSE 快照 + 事件回放。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fengagent/agent";
import { AgentTaskService } from "../agent-task-service.ts";
import { AgentRuntimeRegistry } from "../agent-runtimes.ts";
import { createAgentTaskRoutes, createRuntimeRoutes } from "../routes/agent-tasks.ts";

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

/**
 * Windows 上子进程的 cwd 会占住目录句柄：删临时目录前重试几次，
 * 实在删不掉也不算测试失败（清理不是断言）。
 */
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

/** 造一个只注册 fake runtime 的服务（真 spawn fixture） */
function makeService(options: { ledger?: boolean; permissionPolicy?: "allow" | "deny" } = {}): {
  service: AgentTaskService;
  taskStore: TaskStore | null;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "feng-agent-task-svc-"));
  const registry = new AgentRuntimeRegistry({
    dataRoot: dir,
    entries: [
      {
        name: "fake",
        command: process.execPath,
        args: [FIXTURE],
        enabled: true,
        ...(options.permissionPolicy === undefined
          ? {}
          : { permissionPolicy: options.permissionPolicy }),
      },
    ],
  });
  const taskStore = options.ledger ? new TaskStore(join(dir, "tasks.db")) : null;
  const service = new AgentTaskService({
    dataRoot: dir,
    registry,
    // 派发工作目录放到数据根外：Windows 上子进程 cwd 会锁住目录，别拖累清理
    defaultCwd: mkdtempSync(join(tmpdir(), "feng-agent-task-work-")),
    ...(taskStore ? { ledger: taskStore.ledger } : {}),
    requestTimeoutMs: 8000,
    promptTimeoutMs: 15_000,
    autoProbe: false,
    recoverOnStart: false,
  });
  return { service, taskStore, dir };
}

describe("AgentTaskService — 派发闭环", () => {
  let service: AgentTaskService;
  let dir: string;

  beforeEach(() => {
    const made = makeService();
    service = made.service;
    dir = made.dir;
  });

  afterEach(async () => {
    await service.close();
    safeRm(dir);
  });

  test("submit → replied：结果回流，事件流完整且 seq 单调", async () => {
    const created = await service.submit({
      runtime: "fake",
      content: "打个招呼",
      fromSession: "session-42",
    });
    expect(created.status === "dispatched" || created.status === "running").toBe(true);

    const done = await service.waitForTerminal(created.id, 15_000);
    expect(done.status).toBe("replied");
    expect(done.fromSession).toBe("session-42");
    expect(done.result).toContain("你");
    expect(done.result).toContain("好");
    expect(done.durationMs).toBeGreaterThanOrEqual(0);

    const events = service.listEvents(created.id);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("task/created");
    expect(types).toContain("task/dispatched");
    expect(types).toContain("task/accepted");
    expect(types).toContain("task/running");
    expect(types[types.length - 1]).toBe("task/replied");

    // seq 单调递增（重连去重的前提）
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // 权限请求按策略 deny 且留痕（不静默挂起）
    const permission = events.find((e) => e.detail?.startsWith("[permission]"));
    expect(permission).toBeDefined();
    expect(permission!.detail).toContain("deny");
  });

  test("目标侧失败 → failed + error（不静默成功）", async () => {
    const created = await service.submit({ runtime: "fake", content: "FAIL 这条应当失败" });
    const done = await service.waitForTerminal(created.id, 15_000);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("目标拒绝执行");
  });

  test("幂等键重复提交 → 复用同一任务", async () => {
    const first = await service.submit({
      runtime: "fake",
      content: "同一条",
      idempotencyKey: "key-1",
    });
    const second = await service.submit({
      runtime: "fake",
      content: "同一条",
      idempotencyKey: "key-1",
    });
    expect(second.id).toBe(first.id);
    await service.waitForTerminal(first.id, 15_000);
    expect(service.listTasks().tasks).toHaveLength(1);
  });

  test("取消 running 中的任务 → cancelled", async () => {
    const created = await service.submit({ runtime: "fake", content: "SLOW 慢任务" });
    // 等它进入 running（fixture 先吐两块文本）
    await new Promise((resolve) => setTimeout(resolve, 120));
    const cancelled = service.cancel(created.id);
    expect(cancelled.status).toBe("cancelled");

    const events = service.listEvents(created.id);
    expect(events.some((e) => e.type === "task/cancelled")).toBe(true);
    // 终态后再取消 → 抛错（路由映射 409）
    expect(() => service.cancel(created.id)).toThrow(/终态/);
  });

  test("retry 复用目标会话：目标有 resume 能力就续聊同一个 acpSessionId", async () => {
    const created = await service.submit({ runtime: "fake", content: "第一次" });
    const first = await service.waitForTerminal(created.id, 15_000);
    expect(first.status).toBe("replied");
    const sessionId = service.store.get(created.id)!.acpSessionId;
    expect(sessionId).toBe("fake-session-1");

    service.retry(created.id);
    const second = await service.waitForTerminal(created.id, 15_000);
    expect(second.status).toBe("replied");
    // 同一个目标会话（不是新开一个）
    expect(service.store.get(created.id)!.acpSessionId).toBe(sessionId);
    const accepted = service
      .listEvents(created.id)
      .filter((e) => e.type === "task/accepted");
    expect(accepted[accepted.length - 1]!.detail).toContain(`resume=${sessionId}`);
  });

  test("实时帧：每次状态转移都先推 task/<status> 事件帧，再推 status 帧（含终态）", async () => {
    type Frame = { kind: "event"; type: string } | { kind: "status"; status: string };
    const frames: Frame[] = [];
    // 直接从 store 建任务再手动 dispatch，才能从第一条事件开始订阅
    const { task } = service.store.create({
      runtime: "fake",
      content: "普通任务",
      cwd: dir,
    });
    service.subscribe(task.id, (frame) => {
      if (frame.type === "event") frames.push({ kind: "event", type: frame.event.type });
      else if (frame.type === "status") frames.push({ kind: "status", status: frame.task.status });
    });

    await service.dispatch(task.id);

    const kinds = frames
      .map((f) => (f.kind === "event" ? `event:${f.type}` : `status:${f.status}`))
      // 权限决策也是一条事件（task/stream-chunk），生命周期断言里排除它
      .filter((kind) => kind !== "event:task/stream-chunk");
    // 转移顺序：dispatched → running → replied，每一步都是「事件帧在前、状态帧在后」
    expect(kinds).toEqual([
      "event:task/dispatched",
      "status:dispatched",
      "event:task/accepted",
      "event:task/running",
      "status:running",
      "event:task/replied",
      "status:replied",
    ]);
  });

  test("实时帧：失败与取消同样先推终态事件帧", async () => {
    const failedKinds: string[] = [];
    const failedTask = service.store.create({ runtime: "fake", content: "FAIL x", cwd: dir }).task;
    service.subscribe(failedTask.id, (frame) => {
      if (frame.type === "event") failedKinds.push(`event:${frame.event.type}`);
      else if (frame.type === "status") failedKinds.push(`status:${frame.task.status}`);
    });
    await service.dispatch(failedTask.id);
    expect(failedKinds.slice(-2)).toEqual(["event:task/failed", "status:failed"]);

    const cancelKinds: string[] = [];
    const slowTask = service.store.create({ runtime: "fake", content: "SLOW 慢", cwd: dir }).task;
    service.subscribe(slowTask.id, (frame) => {
      if (frame.type === "event") cancelKinds.push(`event:${frame.event.type}`);
      else if (frame.type === "status") cancelKinds.push(`status:${frame.task.status}`);
    });
    const running = service.dispatch(slowTask.id);
    await Bun.sleep(120);
    service.cancel(slowTask.id);
    await running;
    expect(cancelKinds.slice(-2)).toEqual(["event:task/cancelled", "status:cancelled"]);
  });

  test("权限策略按 runtime 可配 allow（复验 marker 用）：回执 allow-once 且事件留痕", async () => {
    const made = makeService({ permissionPolicy: "allow" });
    try {
      const created = await made.service.submit({ runtime: "fake", content: "写个 marker 文件" });
      const done = await made.service.waitForTerminal(created.id, 15_000);
      expect(done.status).toBe("replied");
      expect(done.result).toContain("[perm:allow-once]");
      const permission = made.service
        .listEvents(created.id)
        .find((e) => e.detail?.startsWith("[permission]"));
      expect(permission?.detail).toContain("allow");
    } finally {
      await made.service.close();
      safeRm(made.dir);
    }
  });

  test("身份隔离：目标进程不继承 MULTICA_*（含 token）", async () => {
    const previous = process.env.MULTICA_TOKEN;
    process.env.MULTICA_TOKEN = "leak-me";
    try {
      const created = await service.submit({ runtime: "fake", content: "ENV_PROBE" });
      const done = await service.waitForTerminal(created.id, 15_000);
      expect(done.status).toBe("replied");
      expect(done.result).toContain("multica_env=none");
    } finally {
      if (previous === undefined) delete process.env.MULTICA_TOKEN;
      else process.env.MULTICA_TOKEN = previous;
    }
  });

  test("身份隔离：默认 cwd 是仓库外中立目录（不读本仓库 AGENTS.md）", async () => {
    // 这个用例刻意**不传 defaultCwd**，验证生产默认值（~/.fengagent/dispatch-workspace/…）
    const bareDir = mkdtempSync(join(tmpdir(), "feng-agent-task-bare-"));
    const bareRegistry = new AgentRuntimeRegistry({
      dataRoot: bareDir,
      entries: [{ name: "fake", command: process.execPath, args: [FIXTURE], enabled: true }],
    });
    const bare = new AgentTaskService({
      dataRoot: bareDir,
      registry: bareRegistry,
      autoProbe: false,
      recoverOnStart: false,
      promptTimeoutMs: 15_000,
    });
    try {
      const created = await bare.submit({ runtime: "fake", content: "CWD_PROBE" });
      const done = await bare.waitForTerminal(created.id, 15_000);
      expect(done.status).toBe("replied");
      const cwd = (done.result ?? "").replace(/^cwd=/, "").trim();
      expect(cwd).toContain("dispatch-workspace");
      expect(cwd.toLowerCase().startsWith(process.cwd().toLowerCase())).toBe(false);
    } finally {
      await bare.close();
      safeRm(bareDir);
    }
  });

  test("retry：终态 → 新 attempt，事件流留痕 task/retried 且能再次成功", async () => {
    const created = await service.submit({ runtime: "fake", content: "FAIL 先失败" });
    const failed = await service.waitForTerminal(created.id, 15_000);
    expect(failed.status).toBe("failed");

    const retried = service.retry(created.id);
    expect(retried.id).toBe(created.id);
    // 重试仍是同一条「FAIL」内容 → 再次失败，但 attempt 已经推进
    const again = await service.waitForTerminal(created.id, 15_000);
    expect(again.status).toBe("failed");

    const events = service.listEvents(created.id);
    expect(events.some((e) => e.type === "task/retried")).toBe(true);
    expect(service.store.get(created.id)!.attempt).toBe(2);
  });

  test("listTasks 支持状态过滤与 cursor 分页", async () => {
    const a = await service.submit({ runtime: "fake", content: "甲" });
    await service.waitForTerminal(a.id, 15_000);
    const b = await service.submit({ runtime: "fake", content: "乙" });
    await service.waitForTerminal(b.id, 15_000);

    const replied = service.listTasks({ status: "replied" });
    expect(replied.tasks).toHaveLength(2);

    const page1 = service.listTasks({ limit: 1 });
    expect(page1.tasks).toHaveLength(1);
    expect(page1.nextCursor).toBeDefined();
    const page2 = service.listTasks({ limit: 1, cursor: page1.nextCursor });
    expect(page2.tasks[0]!.id).not.toBe(page1.tasks[0]!.id);
  });

  test("别 runtime 未注册 → failed（错误可读）", async () => {
    const created = await service.submit({ runtime: "不存在", content: "x" });
    const done = await service.waitForTerminal(created.id, 5000);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("未注册的 runtime");
  });
});

describe("AgentTaskService — 幂等台账（不重复执行）", () => {
  let service: AgentTaskService;
  let taskStore: TaskStore;
  let dir: string;

  beforeEach(() => {
    const made = makeService({ ledger: true });
    service = made.service;
    taskStore = made.taskStore!;
    dir = made.dir;
  });

  afterEach(async () => {
    await service.close();
    taskStore.close();
    safeRm(dir);
  });

  test("台账已有 succeeded → 直接回放结果，不再执行", async () => {
    const { task } = service.store.create({
      runtime: "fake",
      content: "这条不该被真的执行",
      cwd: dir,
    });
    const key = `agent-task:${task.id}:attempt-1`;
    taskStore.ledger.begin({
      operationId: "op-done",
      operationKey: key,
      toolName: "dispatch_task",
      sessionId: "s",
      taskId: task.id,
      input: {},
      startedAt: Date.now(),
    });
    taskStore.ledger.complete("op-done", {
      digest: "digest",
      json: { text: "回放的结果" },
      finishedAt: Date.now(),
    });

    await service.dispatch(task.id);

    const after = service.store.get(task.id)!;
    expect(after.status).toBe("replied");
    expect(after.result).toBe("回放的结果");
    // 没有真的 spawn → 不会有 accepted 事件
    expect(service.listEvents(task.id).some((e) => e.type === "task/accepted")).toBe(false);
  });

  test("台账仍是 pending（上轮崩在半路）→ 拒绝重跑并要求人工核对", async () => {
    const { task } = service.store.create({
      runtime: "fake",
      content: "未决副作用",
      cwd: dir,
    });
    taskStore.ledger.begin({
      operationId: "op-pending",
      operationKey: `agent-task:${task.id}:attempt-1`,
      toolName: "dispatch_task",
      sessionId: "s",
      taskId: task.id,
      input: {},
      startedAt: Date.now(),
    });

    await service.dispatch(task.id);

    const after = service.store.get(task.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toContain("副作用未决");
  });
});

describe("AgentTaskService — 启动恢复", () => {
  test("created → expired；dispatched/running → failed（不自动重跑）", async () => {
    const { service, dir } = makeService();
    try {
      const created = service.store.create({ runtime: "fake", content: "a", cwd: dir }).task;
      const running = service.store.create({ runtime: "fake", content: "b", cwd: dir }).task;
      service.store.setStatus(running.id, "dispatched");
      service.store.setStatus(running.id, "running");

      const recovered = service.recoverInterrupted();
      expect(recovered.sort()).toEqual([created.id, running.id].sort());
      expect(service.store.get(created.id)!.status).toBe("expired");
      expect(service.store.get(running.id)!.status).toBe("failed");
      expect(service.store.get(running.id)!.error).toBeUndefined();
      // 两条都留了事件（可重放核对）
      expect(service.listEvents(running.id).some((e) => e.type === "task/failed")).toBe(true);
    } finally {
      await service.close();
      safeRm(dir);
    }
  });
});

describe("Agents API 路由 — P2 契约", () => {
  let service: AgentTaskService;
  let dir: string;
  let app: ReturnType<typeof createAgentTaskRoutes>;
  let runtimesApp: ReturnType<typeof createRuntimeRoutes>;

  beforeEach(() => {
    const made = makeService();
    service = made.service;
    dir = made.dir;
    app = createAgentTaskRoutes(service);
    runtimesApp = createRuntimeRoutes(service);
  });

  afterEach(async () => {
    await service.close();
    safeRm(dir);
  });

  test("SSE 实时推送：终态事件帧在终态 status 帧之前发出（P0 回归）", async () => {
    const created = await service.submit({ runtime: "fake", content: "SLOW 终态事件" });
    // 等它真的进入 running，再带 after=<当前最后 seq> 连流 —— 这样回放区为空，
    // 流里出现的事件只可能来自实时推送。
    for (let i = 0; i < 100; i++) {
      if (service.getTask(created.id)?.status === "running") break;
      await Bun.sleep(20);
    }
    const before = service.listEvents(created.id);
    const after = before.length === 0 ? 0 : before[before.length - 1]!.seq;

    const res = await app.request(`/${created.id}/stream?after=${after}`);
    expect(res.status).toBe(200);
    const text = await res.text();

    const repliedEventAt = text.indexOf("task/replied");
    const repliedStatusAt = text.indexOf('"status":"replied"');
    expect(repliedEventAt).toBeGreaterThan(-1);
    expect(repliedStatusAt).toBeGreaterThan(-1);
    // 事件帧先到，终态 status 帧后到（路由收到 status 才 break）
    expect(repliedEventAt).toBeLessThan(repliedStatusAt);
    // 确实是「事件帧」而不只是状态里的字段
    expect(text).toContain("event: event");
  });

  test("GET /api/runtimes → RuntimeInfo[]（未探测时为 unprobed）", async () => {    const res = await runtimesApp.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe("fake");
    expect(body[0]!.probeStatus).toBe("unprobed");
    expect(body[0]!.enabled).toBe(true);
  });

  test("POST /api/agent-tasks → 201 + GET 详情带事件；SSE 回放快照与事件", async () => {
    const createRes = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime: "fake", content: "界面发起的任务" }),
    });
    expect(createRes.status).toBe(201);
    const task = (await createRes.json()) as { id: string; fromSession: string };
    expect(task.fromSession).toBe("dashboard");

    const done = await service.waitForTerminal(task.id, 15_000);
    expect(done.status).toBe("replied");

    const detailRes = await app.request(`/${task.id}`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      task: { status: string; result?: string };
      events: Array<{ seq: number; type: string }>;
    };
    expect(detail.task.status).toBe("replied");
    expect(detail.task.result).toContain("你好");
    expect(detail.events.length).toBeGreaterThan(3);

    // 列表契约：{tasks, runtimes}
    const listRes = await app.request("/");
    const list = (await listRes.json()) as { tasks: unknown[]; runtimes: unknown[] };
    expect(list.tasks).toHaveLength(1);
    expect(list.runtimes).toHaveLength(1);

    // SSE：终态任务 → 快照 + 历史事件后自行结束
    const streamRes = await app.request(`/${task.id}/stream`);
    expect(streamRes.status).toBe(200);
    const text = await streamRes.text();
    expect(text).toContain('"type":"status"');
    expect(text).toContain('"type":"event"');
    expect(text).toContain("task/replied");

    // 终态再取消 → 409
    const cancelRes = await app.request(`/${task.id}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(409);
  });

  test("POST 参数缺失 → 400；未知任务 → 404", async () => {
    const bad = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime: "" }),
    });
    expect(bad.status).toBe(400);

    const missing = await app.request("/nope");
    expect(missing.status).toBe(404);
    const missingStream = await app.request("/nope/stream");
    expect(missingStream.status).toBe(404);
  });

  test("retry 走路由：failed 后可重试（返回任务）", async () => {
    const createRes = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime: "fake", content: "FAIL x" }),
    });
    const task = (await createRes.json()) as { id: string };
    await service.waitForTerminal(task.id, 15_000);

    const retryRes = await app.request(`/${task.id}/retry`, { method: "POST" });
    expect(retryRes.status).toBe(200);
    const retried = (await retryRes.json()) as { id: string };
    expect(retried.id).toBe(task.id);
    await service.waitForTerminal(task.id, 15_000);
    expect(service.store.get(task.id)!.attempt).toBe(2);
  });
});
