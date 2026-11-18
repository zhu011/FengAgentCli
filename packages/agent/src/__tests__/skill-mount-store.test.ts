/**
 * Skill 挂载仓（P1）单元测试：关系语义 + 版本快照追加。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillMountStore } from "../skill-mount-store.ts";

let root: string;
let store: SkillMountStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-skill-mount-"));
  store = new SkillMountStore(join(root, "sessions.db"));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("SkillMountStore — 挂载关系", () => {
  test("add 幂等：重复添加不覆盖启停与来源", () => {
    const first = store.add({ agentId: "coder", skillName: "review", source: "team" });
    expect(first.created).toBe(true);
    store.patch("coder", "review", { enabled: false });

    const again = store.add({ agentId: "coder", skillName: "review", source: "builtin" });
    expect(again.created).toBe(false);
    expect(again.mount.enabled).toBe(false);
    expect(again.mount.source).toBe("team");
  });

  test("replace 多删少增，保留已存在行状态", () => {
    store.add({ agentId: "coder", skillName: "a", source: "team" });
    store.add({ agentId: "coder", skillName: "b", source: "team" });
    store.patch("coder", "b", { enabled: false });

    const mounts = store.replace("coder", ["b", "c"]);
    expect(mounts.map((mount) => mount.skillName)).toEqual(["b", "c"]);
    expect(mounts.find((mount) => mount.skillName === "b")?.enabled).toBe(false);
  });

  test("remove 只删关系；agentsUsing 反查", () => {
    store.add({ agentId: "coder", skillName: "review", source: "team" });
    store.add({ agentId: "reviewer", skillName: "review", source: "team" });
    store.patch("reviewer", "review", { enabled: false });

    expect(store.agentsUsing("review")).toEqual([
      { agentId: "coder", enabled: true },
      { agentId: "reviewer", enabled: false },
    ]);
    expect(store.remove("coder", "review")).toBe(true);
    expect(store.remove("coder", "review")).toBe(false);
    expect(store.agentsUsing("review")).toHaveLength(1);
  });

  test("patch 未挂载的行返回 undefined", () => {
    expect(store.patch("coder", "nope", { enabled: true })).toBeUndefined();
  });
});

describe("SkillMountStore — 版本快照", () => {
  test("内容变化才递增 version；同 hash 返回上一版", () => {
    const v1 = store.recordRevision({
      skillName: "review",
      content: "v1",
      contentHash: "hash-1",
      source: "manual",
    });
    expect(v1.version).toBe(1);

    const same = store.recordRevision({
      skillName: "review",
      content: "v1",
      contentHash: "hash-1",
      source: "edit",
    });
    expect(same.version).toBe(1);

    const v2 = store.recordRevision({
      skillName: "review",
      content: "v2",
      contentHash: "hash-2",
      source: "edit",
    });
    expect(v2.version).toBe(2);
    expect(store.listRevisions("review").map((item) => item.version)).toEqual([2, 1]);
    expect(store.getRevision("review", 1)?.content).toBe("v1");
    expect(store.latestRevision("review")?.content).toBe("v2");
  });

  test("版本按 skill 隔离，互不影响", () => {
    store.recordRevision({ skillName: "a", content: "x", contentHash: "h1", source: "manual" });
    store.recordRevision({ skillName: "b", content: "y", contentHash: "h2", source: "manual" });
    expect(store.latestRevision("a")?.version).toBe(1);
    expect(store.latestRevision("b")?.version).toBe(1);
  });
});
