/**
 * @fengagent/agent — 小队实体仓测试（P2）
 *
 * 重点不是 CRUD，而是三条**约束**：
 * 1. `leader_id` 必须是成员 —— 应用层拒绝 + **SQLite 外键兜底**（直接改库也过不去）；
 * 2. 现任队长不能移除（`cannot_remove_squad_leader`），换队长必须换给成员；
 * 3. 归档后不能改队/加人（派单侧另测），历史保留。
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SquadStore, SquadStoreError } from "../squad-store.ts";

function makeStore(): { store: SquadStore; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "feng-squad-store-"));
  const path = join(dir, "sessions.db");
  let seq = 0;
  const store = new SquadStore(path, { idFactory: () => `sq_test_${++seq}` });
  return { store, path, dir };
}

describe("SquadStore — 小队实体与队长约束", () => {
  test("建队：队长自动入成员并标 leader，默认 mode=leader", () => {
    const { store, dir } = makeStore();
    const squad = store.createSquad({
      name: "前端小队",
      leaderId: "coder",
      description: "负责 WebUI",
      members: [{ memberId: "researcher", role: "调研" }],
    });
    expect(squad.leaderId).toBe("coder");
    expect(squad.mode).toBe("leader");
    expect(squad.members.map((member) => member.memberId)).toEqual(["coder", "researcher"]);
    expect(squad.members[0]?.role).toBe("leader");
    expect(store.listSquads()).toHaveLength(1);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("leader_id 必须是成员：DB 级外键兜底（绕过应用层直接删队长成员行会被拒）", () => {
    const { store, path, dir } = makeStore();
    const squad = store.createSquad({ name: "队", leaderId: "coder" });
    store.close();

    // 用第二条连接直接改库：删掉队长成员行 → 提交时触发外键（deferred）校验
    const raw = new Database(path);
    raw.exec("PRAGMA foreign_keys = ON");
    expect(() => raw.exec(`DELETE FROM squad_member WHERE squad_id = '${squad.id}'`)).toThrow();
    // 库仍是原样
    expect(
      (raw.query("SELECT COUNT(*) AS n FROM squad_member WHERE squad_id = ?").get(squad.id) as { n: number }).n,
    ).toBe(1);
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("换队长：必须是 agent 成员；非成员 / 人占位都被拒", () => {
    const { store, dir } = makeStore();
    const squad = store.createSquad({
      name: "队",
      leaderId: "coder",
      members: [{ memberId: "researcher" }, { memberType: "member", memberId: "human-1" }],
    });
    expect(store.setLeader(squad.id, "researcher").leaderId).toBe("researcher");
    expect(() => store.setLeader(squad.id, "nobody")).toThrow(SquadStoreError);
    try {
      store.setLeader(squad.id, "human-1");
      throw new Error("应当拒绝人占位当队长");
    } catch (err) {
      expect(err).toBeInstanceOf(SquadStoreError);
      expect((err as SquadStoreError).code).toBe("leader_not_member");
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("移除现任队长 → cannot_remove_squad_leader；先换队长再移除可过", () => {
    const { store, dir } = makeStore();
    const squad = store.createSquad({
      name: "队",
      leaderId: "coder",
      members: [{ memberId: "researcher" }],
    });
    try {
      store.removeMember(squad.id, "agent", "coder");
      throw new Error("应当拒绝移除队长");
    } catch (err) {
      expect(err).toBeInstanceOf(SquadStoreError);
      expect((err as SquadStoreError).code).toBe("cannot_remove_squad_leader");
    }
    store.setLeader(squad.id, "researcher");
    const after = store.removeMember(squad.id, "agent", "coder");
    expect(after.members.map((member) => member.memberId)).toEqual(["researcher"]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("成员冲突 / 归档后不可改 / 归档不进默认列表", () => {
    const { store, dir } = makeStore();
    const squad = store.createSquad({ name: "队", leaderId: "coder" });
    expect(() => store.addMember(squad.id, { memberType: "agent", memberId: "coder", role: "" })).toThrow(
      SquadStoreError,
    );
    const archived = store.archiveSquad(squad.id);
    expect(archived.archivedAt).toBeGreaterThan(0);
    expect(store.listSquads()).toHaveLength(0);
    expect(store.listSquads({ includeArchived: true })).toHaveLength(1);
    try {
      store.addMember(squad.id, { memberType: "agent", memberId: "new", role: "" });
      throw new Error("归档后不应允许加成员");
    } catch (err) {
      expect((err as SquadStoreError).code).toBe("squad_archived");
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("任务与运行树：worker 的 parent_run_id 指向 leader run", () => {
    const { store, dir } = makeStore();
    const squad = store.createSquad({ name: "队", leaderId: "coder", members: [{ memberId: "worker" }] });
    const leaderTask = store.createTask({
      squadId: squad.id,
      isLeader: true,
      assigneeId: "coder",
      title: "总任务",
      status: "assigned",
    });
    const leaderRun = store.createRun({
      squadId: squad.id,
      squadTaskId: leaderTask.id,
      agentId: "coder",
      title: "总任务",
    });
    const child = store.createTask({
      squadId: squad.id,
      parentId: leaderTask.id,
      isLeader: false,
      assigneeId: "worker",
      title: "子任务",
    });
    const childRun = store.createRun({
      squadId: squad.id,
      squadTaskId: child.id,
      agentId: "worker",
      parentRunId: leaderRun.id,
      title: "子任务",
    });
    expect(store.listChildren(leaderTask.id).map((task) => task.id)).toEqual([child.id]);
    expect(store.listRuns(squad.id).map((run) => run.id)).toEqual([leaderRun.id, childRun.id]);
    expect(store.getRun(childRun.id)?.parentRunId).toBe(leaderRun.id);
    store.updateTask(child.id, { status: "completed", result: "done", finishedAt: 1 });
    expect(store.getTask(child.id)?.status).toBe("completed");
    expect(store.getTask(child.id)?.result).toBe("done");
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
