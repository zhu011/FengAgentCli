/**
 * @fengagent/agent — 群聊存储测试（G1）
 *
 * 覆盖：建群/取群/列表、成员收敛与校验、seq 单调、增量读取（after）、
 * 最近消息（尾部升序）、关群后禁言、描述/轮数等字段更新。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentGroupStore } from "../agent-group-store.ts";

function makeStore(): { store: AgentGroupStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "feng-groups-"));
  return { store: new AgentGroupStore(join(dir, "groups.db")), dir };
}

describe("AgentGroupStore — 群", () => {
  test("建群：默认 open、轮数 3、成员去重", () => {
    const { store, dir } = makeStore();
    try {
      const group = store.create({
        name: "接入评审",
        description: "讨论 claude 接入",
        members: [
          { kind: "runtime", name: "kimi", runtime: "kimi" },
          { kind: "runtime", name: "dsh", runtime: "dsh" },
          { kind: "coordinator", name: "fengagent" },
        ],
        at: 1000,
      });
      expect(group.status).toBe("open");
      expect(group.maxRounds).toBe(3);
      expect(group.description).toBe("讨论 claude 接入");
      expect(group.members.map((m) => m.name)).toEqual(["kimi", "dsh", "fengagent"]);
      expect(group.createdAt).toBe(1000);
      expect(store.get(group.id)?.name).toBe("接入评审");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("成员重名 / 空群名被拒", () => {
    const { store, dir } = makeStore();
    try {
      expect(() => store.create({ name: "  " })).toThrow(/群名不能为空/);
      expect(() =>
        store.create({
          name: "dupe",
          members: [
            { kind: "runtime", name: "kimi", runtime: "kimi" },
            { kind: "runtime", name: "kimi", runtime: "kimi" },
          ],
        }),
      ).toThrow(/成员重名/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("列表按最近更新倒序；可按状态过滤", () => {
    const { store, dir } = makeStore();
    try {
      const a = store.create({ name: "A", at: 1000 });
      const b = store.create({ name: "B", at: 2000 });
      store.appendMessage({ groupId: a.id, content: "顶一下", at: 3000 });
      expect(store.list().map((g) => g.name)).toEqual(["A", "B"]);
      store.update(b.id, { status: "concluded" });
      expect(store.list({ status: "concluded" }).map((g) => g.name)).toEqual(["B"]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AgentGroupStore — 消息", () => {
  test("seq 在群内单调递增，且消息会前移群的 updatedAt", () => {
    const { store, dir } = makeStore();
    try {
      const group = store.create({ name: "seq", at: 1000 });
      const m1 = store.appendMessage({ groupId: group.id, content: "一", at: 1100 });
      const m2 = store.appendMessage({
        groupId: group.id,
        content: "二",
        fromKind: "runtime",
        fromName: "kimi",
        agentTaskId: "task-1",
        at: 1200,
      });
      expect([m1.seq, m2.seq]).toEqual([1, 2]);
      expect(m2.kind).toBe("chat");
      expect(m2.agentTaskId).toBe("task-1");
      expect(store.lastSeq(group.id)).toBe(2);
      expect(store.get(group.id)!.updatedAt).toBe(1200);
      expect(store.messageCount(group.id)).toBe(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("增量读取（after）与最近消息（尾部升序）", () => {
    const { store, dir } = makeStore();
    try {
      const group = store.create({ name: "read" });
      for (let i = 1; i <= 5; i++) {
        store.appendMessage({ groupId: group.id, content: `m${i}`, at: 1000 + i });
      }
      expect(store.messages(group.id, { after: 3 }).map((m) => m.content)).toEqual(["m4", "m5"]);
      expect(store.messages(group.id, { limit: 2 }).map((m) => m.content)).toEqual(["m1", "m2"]);
      expect(store.recentMessages(group.id, 2).map((m) => m.content)).toEqual(["m4", "m5"]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("关群后禁止继续发言；系统消息 kind=system", () => {
    const { store, dir } = makeStore();
    try {
      const group = store.create({ name: "close" });
      const sys = store.appendMessage({
        groupId: group.id,
        content: "群已创建",
        fromKind: "system",
        fromName: "system",
      });
      expect(sys.kind).toBe("system");
      store.update(group.id, { status: "concluded" });
      expect(() => store.appendMessage({ groupId: group.id, content: "还能说吗" })).toThrow(
        /群已关闭/,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("不存在的群不能写消息", () => {
    const { store, dir } = makeStore();
    try {
      expect(() => store.appendMessage({ groupId: "nope", content: "x" })).toThrow(/群不存在/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
