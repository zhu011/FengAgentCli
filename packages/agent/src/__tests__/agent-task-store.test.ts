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
