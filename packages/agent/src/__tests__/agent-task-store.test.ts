/**
 * @fengagent/agent — 外派任务仓测试（P2 数据面）
 *
 * 覆盖：建任务/事件流、幂等键、7 态转移（含非法转移被拒）、事件重放对拍、
 * retry（新 attempt）、列表过滤与键集分页、近 24h 计数。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTaskStore, replayAgentTaskStatus } from "../agent-task-store.ts";

function makeStore(): { store: AgentTaskStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "feng-agent-tasks-"));
  return { store: new AgentTaskStore(join(dir, "tasks.db")), dir };
}

describe("AgentTaskStore — 建 / 读 / 事件流", () => {
  test("建任务：status=created、attempt=1，并落一条 task/created 事件", () => {
    const { store, dir } = makeStore();
    try {
      const { task, reused } = store.create({
        runtime: "kimi",
        content: "你好",
        cwd: dir,
        fromSession: "s-1",
        at: 1000,
      });
      expect(reused).toBe(false);
      expect(task.status).toBe("created");
      expect(task.attempt).toBe(1);
      expect(task.fromSession).toBe("s-1");
      expect(task.createdAt).toBe(1000);

      const events = store.events(task.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.seq).toBe(1);
      expect(events[0]!.type).toBe("task/created");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("幂等键命中 → 复用同一任务，不产生第二条", () => {
    const { store, dir } = makeStore();
    try {
      const first = store.create({
        runtime: "kimi",
        content: "同一条请求",
        cwd: dir,
        idempotencyKey: "req-1",
      });
      const second = store.create({
        runtime: "kimi",
        content: "同一条请求",
        cwd: dir,
        idempotencyKey: "req-1",
      });
      expect(second.reused).toBe(true);
      expect(second.task.id).toBe(first.task.id);
      expect(store.list()).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("状态推进写行 + 事件；重放事件得到同一状态", () => {
    const { store, dir } = makeStore();
    try {
      const { task } = store.create({ runtime: "kimi", content: "x", cwd: dir, at: 1000 });
      store.setStatus(task.id, "dispatched", { detail: "spawn" }, 1100);
      store.appendEvent(task.id, "task/accepted", "握手成功", 1150);
      store.setStatus(task.id, "running", { acpSessionId: "acp-1" }, 1200);
      store.setStatus(task.id, "replied", { result: "好的" }, 1500);

      const final = store.get(task.id)!;
      expect(final.status).toBe("replied");
      expect(final.result).toBe("好的");
      expect(final.acpSessionId).toBe("acp-1");
      expect(final.dispatchedAt).toBe(1100);
      expect(final.startedAt).toBe(1200);
      expect(final.finishedAt).toBe(1500);

      const events = store.events(task.id);
      // seq 单调递增，且与状态对拍一致
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(replayAgentTaskStatus(events)).toBe("replied");
      expect(store.replayStatus(task.id)).toBe(final.status);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("非法转移被拒（终态不能回到 running）", () => {
    const { store, dir } = makeStore();
    try {
      const { task } = store.create({ runtime: "kimi", content: "x", cwd: dir });
      store.setStatus(task.id, "dispatched");
      store.setStatus(task.id, "failed", { error: "boom" });
      expect(() => store.setStatus(task.id, "running")).toThrow(/非法状态转移/);
      expect(store.get(task.id)!.status).toBe("failed");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retry：终态 → created + attempt+1，并留一条 task/retried 事件", () => {
    const { store, dir } = makeStore();
    try {
      const { task } = store.create({ runtime: "kimi", content: "x", cwd: dir });
      store.setStatus(task.id, "dispatched");
      store.setStatus(task.id, "failed", { error: "超时" });

      const reset = store.resetForRetry(task.id);
      expect(reset.status).toBe("created");
      expect(reset.attempt).toBe(2);
      expect(reset.error).toBeUndefined();
      expect(reset.finishedAt).toBeUndefined();

      const events = store.events(task.id);
      expect(events.some((e) => e.type === "task/retried")).toBe(true);
      // 重试后可以再派发
      expect(() => store.setStatus(task.id, "dispatched")).not.toThrow();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("非终态任务不允许 retry", () => {
    const { store, dir } = makeStore();
    try {
      const { task } = store.create({ runtime: "kimi", content: "x", cwd: dir });
      store.setStatus(task.id, "dispatched");
      expect(() => store.resetForRetry(task.id)).toThrow(/尚未结束/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AgentTaskStore — 列表 / 分页 / 统计", () => {
  test("按状态与 runtime 过滤；坏状态值不会漏进 SQL", () => {
    const { store, dir } = makeStore();
    try {
      const a = store.create({ runtime: "kimi", content: "a", cwd: dir, at: 1000 }).task;
      const b = store.create({ runtime: "dsh", content: "b", cwd: dir, at: 2000 }).task;
      store.setStatus(a.id, "dispatched");
      store.setStatus(b.id, "dispatched");
      store.setStatus(b.id, "failed", { error: "x" });

      expect(store.list({ status: "failed" }).map((t) => t.id)).toEqual([b.id]);
      expect(store.list({ runtime: "kimi" }).map((t) => t.id)).toEqual([a.id]);
      expect(store.list()).toHaveLength(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("键集分页：limit 返回 nextCursor，用 cursor 取下一页不重不漏", () => {
    const { store, dir } = makeStore();
    try {
      for (let i = 0; i < 5; i++) {
        store.create({ runtime: "kimi", content: `t${i}`, cwd: dir, at: 1000 + i });
      }
      const page1 = store.list({ limit: 2 });
      expect(page1).toHaveLength(2);
      const page2 = store.list({ limit: 2, cursor: page1[1]!.id });
      expect(page2).toHaveLength(2);
      const page3 = store.list({ limit: 2, cursor: page2[1]!.id });
      expect(page3).toHaveLength(1);
      const ids = [...page1, ...page2, ...page3].map((t) => t.id);
      expect(new Set(ids).size).toBe(5);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("listNonTerminal + countSince（启动恢复与 24h 统计用）", () => {
    const { store, dir } = makeStore();
    try {
      const a = store.create({ runtime: "kimi", content: "a", cwd: dir, at: 1000 }).task;
      const b = store.create({ runtime: "kimi", content: "b", cwd: dir, at: 2000 }).task;
      store.setStatus(a.id, "dispatched");
      store.setStatus(b.id, "dispatched");
      store.setStatus(b.id, "replied", { result: "ok" });

      expect(store.listNonTerminal().map((t) => t.id)).toEqual([a.id]);
      expect(store.countSince("kimi", 1500)).toBe(1);
      expect(store.countSince("kimi", 0)).toBe(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** 建一条池任务（P3-1 用例共用） */
function makePoolTask(
  store: AgentTaskStore,
  dir: string,
  options: { at?: number; poolScope?: string; skillTags?: string[]; runtime?: string } = {},
) {
  return store.create({
    runtime: options.runtime ?? "",
    content: "池里的活",
    cwd: dir,
    claimPolicy: "pool",
    ...(options.poolScope === undefined ? {} : { poolScope: options.poolScope }),
    ...(options.skillTags === undefined ? {} : { skillTags: options.skillTags }),
    ...(options.at === undefined ? {} : { at: options.at }),
  }).task;
}

describe("AgentTaskStore — 任务池认领（P3-1）", () => {
  test("原子认领：changes=1 的那个赢，后到的 already_claimed，事件可重放", () => {
    const { store, dir } = makeStore();
    try {
      const task = makePoolTask(store, dir, { at: 1000 });
      expect(task.claimPolicy).toBe("pool");
      expect(task.agentId).toBeUndefined();

      const winner = store.claim(task.id, "coder", { leaseMs: 5_000, now: 2_000 });
      expect(winner.ok).toBe(true);
      if (!winner.ok) return;
      expect(winner.task.status).toBe("claimed");
      expect(winner.task.agentId).toBe("coder");
      expect(winner.task.claimedAt).toBe(2_000);
      expect(winner.task.leaseExpiresAt).toBe(7_000);

      const loser = store.claim(task.id, "writer", { leaseMs: 5_000, now: 2_100 });
      expect(loser.ok).toBe(false);
      if (loser.ok) return;
      expect(loser.code).toBe("already_claimed");

      // 事件流：created → claimed，重放与落盘一致
      const events = store.events(task.id);
      expect(events.map((e) => e.type)).toEqual(["task/created", "task/claimed"]);
      expect(store.replayStatus(task.id)).toBe("claimed");
      // 输家不会留下任何事件
      expect(events).toHaveLength(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("per-agent 串行：同一 agent 已有在飞任务时认领失败（agent_busy）", () => {
    const { store, dir } = makeStore();
    try {
      const busy = store.create({ runtime: "kimi", agentId: "coder", content: "在飞", cwd: dir })
        .task;
      store.setStatus(busy.id, "dispatched");
      store.setStatus(busy.id, "running");
      const pool = makePoolTask(store, dir);

      const rejected = store.claim(pool.id, "coder", { leaseMs: 5_000 });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) return;
      expect(rejected.code).toBe("agent_busy");
      expect(store.get(pool.id)!.status).toBe("created");

      // 换个手上没活的 agent 就能拿
      const ok = store.claim(pool.id, "writer", { leaseMs: 5_000 });
      expect(ok.ok).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("assigned 任务不可认领（not_pool）；不存在的任务 not_found", () => {
    const { store, dir } = makeStore();
    try {
      const assigned = store.create({ runtime: "kimi", content: "点名", cwd: dir }).task;
      const rejected = store.claim(assigned.id, "coder", { leaseMs: 1_000 });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.code).toBe("not_pool");

      const missing = store.claim("nope", "coder", { leaseMs: 1_000 });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.code).toBe("not_found");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("租约回收：过期退回 created + agent_id 清空 + task/requeued，未过期不动", () => {
    const { store, dir } = makeStore();
    try {
      const task = makePoolTask(store, dir);
      store.claim(task.id, "coder", { leaseMs: 1_000, now: 10_000 });

      expect(store.requeueExpired(10_500)).toEqual([]);
      expect(store.get(task.id)!.status).toBe("claimed");

      const requeued = store.requeueExpired(11_000);
      expect(requeued.map((item) => item.task.id)).toEqual([task.id]);
      const after = store.get(task.id)!;
      expect(after.status).toBe("created");
      expect(after.agentId).toBeUndefined();
      expect(after.claimedAt).toBeUndefined();
      expect(after.leaseExpiresAt).toBeUndefined();
      expect(store.events(task.id).map((e) => e.type)).toEqual([
        "task/created",
        "task/claimed",
        "task/requeued",
      ]);
      expect(store.replayStatus(task.id)).toBe("created");
      // 回池后可以被别人重新认领
      expect(store.claim(task.id, "writer", { leaseMs: 1_000, now: 12_000 }).ok).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("池列表：claimable 只给 created 的池任务，pool 视图含认领态与范围过滤", () => {
    const { store, dir } = makeStore();
    try {
      const frontend = makePoolTask(store, dir, { at: 1000, poolScope: "sq_frontend" });
      const global = makePoolTask(store, dir, { at: 2000 });
      const backend = makePoolTask(store, dir, { at: 3000, poolScope: "sq_backend" });
      store.setStatus(backend.id, "cancelled", { detail: "不做了" });

      expect(store.listClaimable().map((t) => t.id)).toEqual([frontend.id, global.id]);
      expect(store.listClaimable({ squad: "sq_frontend" }).map((t) => t.id)).toEqual([
        frontend.id,
      ]);

      store.claim(frontend.id, "coder", { leaseMs: 5_000, now: 4_000 });
      // 认领后不再出现在 claimable，但仍在 pool 视图里（前端要显示「已被认领」）
      expect(store.listClaimable().map((t) => t.id)).not.toContain(frontend.id);
      const poolView = store.listPool();
      expect(poolView.map((t) => t.id)).toContain(frontend.id);
      expect(poolView.find((t) => t.id === frontend.id)!.agentId).toBe("coder");
      expect(store.listPool({ squad: "sq_backend" }).map((t) => t.id)).toEqual([backend.id]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("池任务 retry：回到 created 且清掉认领人（否则别人永远认领不到）", () => {
    const { store, dir } = makeStore();
    try {
      const task = makePoolTask(store, dir);
      store.claim(task.id, "coder", { leaseMs: 5_000 });
      store.setStatus(task.id, "dispatched");
      store.setStatus(task.id, "failed", { error: "boom" });

      const reset = store.resetForRetry(task.id);
      expect(reset.status).toBe("created");
      expect(reset.attempt).toBe(2);
      expect(reset.agentId).toBeUndefined();
      expect(store.listClaimable().map((t) => t.id)).toEqual([task.id]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("老库迁移：缺 P3-1 五列的历史库能自动补列并认领", async () => {
    const { Database } = await import("bun:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "feng-agent-tasks-old-"));
    const dbPath = join(dir, "tasks.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE agent_tasks (
        id TEXT PRIMARY KEY, runtime TEXT NOT NULL, agent_id TEXT, content TEXT NOT NULL,
        cwd TEXT NOT NULL, from_session TEXT NOT NULL, status TEXT NOT NULL,
        attempt INTEGER NOT NULL, created_at INTEGER NOT NULL, dispatched_at INTEGER,
        started_at INTEGER, finished_at INTEGER, result TEXT, error TEXT,
        acp_session_id TEXT, group_id TEXT, idempotency_key TEXT
      );
      CREATE TABLE agent_task_events (
        task_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
        detail TEXT, at INTEGER NOT NULL, PRIMARY KEY (task_id, seq)
      );
      INSERT INTO agent_tasks (id, runtime, content, cwd, from_session, status, attempt, created_at)
      VALUES ('legacy-1', 'kimi', '历史任务', '${dir.replace(/\\/g, "/")}', 'dashboard', 'replied', 1, 1000);
    `);
    legacy.close();

    const store = new AgentTaskStore(dbPath);
    try {
      // 历史任务读出 assigned（不是 NULL），不会被 pool 的条件 UPDATE 误判
      expect(store.get("legacy-1")!.claimPolicy).toBe("assigned");
      const pool = makePoolTask(store, dir);
      expect(store.get(pool.id)!.claimPolicy).toBe("pool");
      expect(store.claim(pool.id, "coder", { leaseMs: 1_000 }).ok).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
