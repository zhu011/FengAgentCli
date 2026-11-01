/**
 * @fengagent/groups — V2-3：自治发言编排（`speechMode` / 发言预算 / @ 仲裁 / 轮数升级）
 *
 * 覆盖四类口径：
 * 1. **v1 零回归**：缺省 `coordinated`，协调者轮次上限、人类重置计数原样；
 * 2. **free 轮数升级**：轮 = 一名成员的一组连续发言，换人才 +1，到上限自动收口；
 * 3. **发言预算**：每成员每窗口 N 条，落库前拒绝（`GroupError{code:"conflict"}`），跨窗口恢复；
 * 4. **@ 仲裁**：被 @ 的成员拿到下一发言权，插话被拒；协调者/人可越过；
 * 另加 `getStatus()` 快照与老库补列（`speech_mode`）迁移。
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentGroupStore } from "@fengagent/agent";
import { AgentGroupService, GroupError, GroupOrchestrator } from "../index.ts";

const MEMBERS = ["kimi", "claude", "dsh"];

interface Fixture {
  dir: string;
  groups: AgentGroupService;
  orchestrator: GroupOrchestrator;
  /** 推进注入时钟（预算窗口用） */
  advance: (ms: number) => void;
  close: () => void;
}

function makeFixture(
  options: {
    speechBudget?: { limit?: number; windowMs?: number };
    arbitration?: "enforce" | "advisory";
    onTurn?: (groupId: string, speaker: string) => void;
  } = {},
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "feng-v23-"));
  let clock = Date.UTC(2026, 4, 1, 12, 0, 0);
  const now = () => clock;
  const groups = new AgentGroupService({
    store: new AgentGroupStore(join(dir, "groups.db"), { now }),
    runtimes: () => [...MEMBERS, "fengagent"].map((name) => ({ name, enabled: true })),
  });
  const orchestrator = new GroupOrchestrator({
    groups,
    now,
    sweepIntervalMs: 0, // 测试手动推进时钟，不起定时器
    ...(options.speechBudget === undefined ? {} : { speechBudget: options.speechBudget }),
    ...(options.arbitration === undefined ? {} : { arbitration: options.arbitration }),
    ...(options.onTurn === undefined ? {} : { onTurn: options.onTurn }),
  });
  groups.onMessage((groupId, message) => orchestrator.onMessage(groupId, message));
  return {
    dir,
    groups,
    orchestrator,
    advance: (ms) => {
      clock += ms;
    },
    close: () => {
      orchestrator.dispose();
      groups.close();
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          Bun.sleepSync(50);
        }
      }
    },
  };
}

/** 断言被拒 + 错误码（落库前拒绝，消息不会进群） */
function expectRejected(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
    throw new Error("expected rejection, but call succeeded");
  } catch (err) {
    expect(err).toBeInstanceOf(GroupError);
    expect((err as GroupError).code).toBe("conflict");
    expect((err as GroupError).message).toMatch(pattern);
  }
}

describe("V2-3 — v1 零回归（缺省 coordinated）", () => {
  test("建群缺省 speechMode=coordinated，GroupInfo 回显", () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({ name: "缺省模式", members: MEMBERS });
      expect(group.speechMode).toBe("coordinated");
      expect(fx.groups.getGroup(group.id)!.speechMode).toBe("coordinated");
    } finally {
      fx.close();
    }
  });

  test("coordinated：成员发言不计轮、不占预算；协调者轮次到上限才收口", () => {
    const fx = makeFixture({ speechBudget: { limit: 1, windowMs: 60_000 } });
    try {
      const group = fx.groups.createGroup({ name: "v1 轮次", members: MEMBERS, maxRounds: 2 });

      // 成员直连发言（v1 的「中途求助」）：不计轮，也不吃预算（limit=1 也不该拦）
      fx.groups.postAgentMessage(group.id, { content: "我这边先查一下", fromName: "kimi" });
      fx.groups.postAgentMessage(group.id, { content: "我也看一眼", fromName: "dsh" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("open");
      expect(fx.orchestrator.getStatus(group.id)!.coordinatorTurns).toBe(0);

      fx.groups.postAgentMessage(group.id, { content: "第一轮", fromName: "fengagent" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("open");

      fx.groups.postAgentMessage(group.id, { content: "第二轮", fromName: "fengagent" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("concluded");
      expect(fx.groups.listMessages(group.id).at(-1)!.content).toContain("maxRounds=2");
    } finally {
      fx.close();
    }
  });

  test("person 发言重置 free 轮数，人可越过发言权", () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({
        name: "人类在场",
        members: MEMBERS,
        maxRounds: 2,
        speechMode: "free",
      });
      fx.groups.postAgentMessage(group.id, { content: "@claude 你先说", fromName: "dsh" });
      expect(fx.orchestrator.getStatus(group.id)!.nextSpeaker).toBe("claude");

      // 人不上发言权也能说
      fx.groups.postHumanMessage(group.id, { content: "我插一句" });
      const status = fx.orchestrator.getStatus(group.id)!;
      expect(status.rounds).toBe(0);
      expect(status.nextSpeaker).toBeUndefined();
      // 人说完后发言权开放，kimi 可以接话
      fx.groups.postAgentMessage(group.id, { content: "我来", fromName: "kimi" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("open");
    } finally {
      fx.close();
    }
  });
});

describe("V2-3 — free 模式轮数升级", () => {
  test("成员互发不经协调者；换人计轮，到 maxRounds 自动收口", () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({
        name: "自治",
        members: MEMBERS,
        maxRounds: 3,
        speechMode: "free",
      });

      fx.groups.postAgentMessage(group.id, { content: "claude，接口字段定一下", fromName: "dsh" });
      fx.groups.postAgentMessage(group.id, { content: "字段用 speechMode", fromName: "claude" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("open");
      expect(fx.orchestrator.getStatus(group.id)!.rounds).toBe(2);

      fx.groups.postAgentMessage(group.id, { content: "收到，我按这个接", fromName: "dsh" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("concluded");

      const messages = fx.groups.listMessages(group.id);
      // 没有一条协调者消息：两方直连即可推进
      expect(messages.some((m) => m.fromKind === "coordinator")).toBe(false);
      expect(messages.at(-1)!.content).toContain("free 模式共 3 轮");
      expect(fx.orchestrator.getStatus(group.id)!.status).toBe("concluded");
    } finally {
      fx.close();
    }
  });

  test("同一成员连续发言只算一轮", () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({
        name: "连发",
        members: MEMBERS,
        maxRounds: 3,
        speechMode: "free",
      });
      fx.groups.postAgentMessage(group.id, { content: "1", fromName: "dsh" });
      fx.groups.postAgentMessage(group.id, { content: "2", fromName: "dsh" });
      fx.groups.postAgentMessage(group.id, { content: "3", fromName: "dsh" });
      expect(fx.orchestrator.getStatus(group.id)!.rounds).toBe(1);
      expect(fx.groups.getGroup(group.id)!.status).toBe("open");

      fx.groups.postAgentMessage(group.id, { content: "换我说", fromName: "claude" });
      expect(fx.orchestrator.getStatus(group.id)!.rounds).toBe(2);
      expect(fx.groups.getGroup(group.id)!.status).toBe("open");

      fx.groups.postAgentMessage(group.id, { content: "轮到我", fromName: "kimi" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("concluded");
      expect(fx.groups.listMessages(group.id).at(-1)!.content).toContain("free 模式共 3 轮");
    } finally {
      fx.close();
    }
  });

  test("free 模式可通过 PATCH 语义（updateGroup）在线切换回 coordinated", () => {
    const fx = makeFixture();
    try {
      const group = fx.groups.createGroup({
        name: "切模式",
        members: MEMBERS,
        maxRounds: 2,
        speechMode: "free",
      });
      expect(fx.groups.getGroup(group.id)!.speechMode).toBe("free");
      const updated = fx.groups.updateGroup(group.id, { speechMode: "coordinated" });
      expect(updated.speechMode).toBe("coordinated");

      // 切回 v1 后：成员发言不再计轮，协调者照旧
      fx.groups.postAgentMessage(group.id, { content: "成员说", fromName: "kimi" });
      expect(fx.orchestrator.getStatus(group.id)!.coordinatorTurns).toBe(0);
      expect(fx.groups.getGroup(group.id)!.status).toBe("open");
    } finally {
      fx.close();
    }
  });
});

describe("V2-3 — 发言预算", () => {
  test("窗口内第 N+1 条被拒（conflict），跨窗口后恢复", () => {
    const fx = makeFixture({ speechBudget: { limit: 2, windowMs: 60_000 } });
    try {
      const group = fx.groups.createGroup({
        name: "预算",
        members: MEMBERS,
        maxRounds: 10,
        speechMode: "free",
      });

      fx.groups.postAgentMessage(group.id, { content: "a", fromName: "dsh" });
      fx.groups.postAgentMessage(group.id, { content: "b", fromName: "dsh" });
      expectRejected(
        () => fx.groups.postAgentMessage(group.id, { content: "c", fromName: "dsh" }),
        /发言预算已用尽/,
      );
      // 被拒的消息不落库
      expect(fx.groups.listMessages(group.id).filter((m) => m.fromName === "dsh")).toHaveLength(2);
      // 别人不受影响
      fx.groups.postAgentMessage(group.id, { content: "我来说", fromName: "claude" });

      fx.advance(61_000);
      fx.groups.postAgentMessage(group.id, { content: "窗口刷新了", fromName: "dsh" });
      const status = fx.orchestrator.getStatus(group.id)!;
      expect(status.budget.used.dsh).toBe(1);
      expect(status.budget.remaining.dsh).toBe(1);
    } finally {
      fx.close();
    }
  });

  test("预算按成员分别计数（对齐「每成员每窗口」）", () => {
    const fx = makeFixture({ speechBudget: { limit: 1, windowMs: 60_000 } });
    try {
      const group = fx.groups.createGroup({
        name: "分成员",
        members: MEMBERS,
        maxRounds: 10,
        speechMode: "free",
      });
      fx.groups.postAgentMessage(group.id, { content: "dsh 说一句", fromName: "dsh" });
      expectRejected(
        () => fx.groups.postAgentMessage(group.id, { content: "dsh 再说", fromName: "dsh" }),
        /发言预算已用尽/,
      );
      // claude 自己的额度还在
      fx.groups.postAgentMessage(group.id, { content: "claude 说一句", fromName: "claude" });
      expect(fx.orchestrator.getStatus(group.id)!.budget.used).toEqual({ kimi: 0, claude: 1, dsh: 1 });
    } finally {
      fx.close();
    }
  });
});

describe("V2-3 — @ 仲裁（发言权）", () => {
  test("被 @ 的成员拿到下一发言权，他人插话被拒；回应后按新指向转移", () => {
    const fx = makeFixture({ speechBudget: { limit: 10, windowMs: 60_000 } });
    try {
      const group = fx.groups.createGroup({
        name: "仲裁",
        members: MEMBERS,
        maxRounds: 10,
        speechMode: "free",
      });

      fx.groups.postAgentMessage(group.id, {
        content: "@claude 帮忙确认下 MCP 的 token 口径",
        fromName: "dsh",
      });
      expect(fx.orchestrator.getStatus(group.id)!.nextSpeaker).toBe("claude");

      expectRejected(
        () => fx.groups.postAgentMessage(group.id, { content: "我先插一句", fromName: "kimi" }),
        /发言权在 claude/,
      );

      // 持权者回应：@ 回 dsh → 发言权转移
      fx.groups.postAgentMessage(group.id, {
        content: "口径是 per-member token，@dsh 你按这个接",
        fromName: "claude",
      });
      expect(fx.orchestrator.getStatus(group.id)!.nextSpeaker).toBe("dsh");
      expectRejected(
        () => fx.groups.postAgentMessage(group.id, { content: "还没轮到我", fromName: "kimi" }),
        /发言权在 dsh/,
      );

      // dsh 接完不再 @ 人 → 发言权开放
      fx.groups.postAgentMessage(group.id, { content: "收到，接口按 per-member token 走", fromName: "dsh" });
      expect(fx.orchestrator.getStatus(group.id)!.nextSpeaker).toBeUndefined();
      fx.groups.postAgentMessage(group.id, { content: "那我来写前端开关", fromName: "kimi" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("open");
    } finally {
      fx.close();
    }
  });

  test("协调者不受发言权限制，可改派", () => {
    const fx = makeFixture({ speechBudget: { limit: 10, windowMs: 60_000 } });
    try {
      const group = fx.groups.createGroup({
        name: "主持人",
        members: MEMBERS,
        maxRounds: 10,
        speechMode: "free",
      });
      fx.groups.postAgentMessage(group.id, { content: "@claude 你来", fromName: "dsh" });
      expect(fx.orchestrator.getStatus(group.id)!.nextSpeaker).toBe("claude");

      // 协调者（主持人）可随时说话，并把发言权改派给 kimi
      fx.groups.postAgentMessage(group.id, { content: "@kimi 你先给结论", fromName: "fengagent" });
      expect(fx.orchestrator.getStatus(group.id)!.nextSpeaker).toBe("kimi");
      fx.groups.postAgentMessage(group.id, { content: "结论是 A", fromName: "kimi" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("open");
    } finally {
      fx.close();
    }
  });

  test("任务结果回群（task_card）不占发言权/预算，也不算一轮", () => {
    const fx = makeFixture({ speechBudget: { limit: 1, windowMs: 60_000 } });
    try {
      const group = fx.groups.createGroup({
        name: "任务回群",
        members: MEMBERS,
        maxRounds: 3,
        speechMode: "free",
      });
      fx.groups.postAgentMessage(group.id, { content: "@claude 这个任务交给你", fromName: "dsh" });
      expect(fx.orchestrator.getStatus(group.id)!.nextSpeaker).toBe("claude");

      // 服务端代写的任务结果：不抢发言权、不占轮，也不吃 dsh 的预算（limit=1 仍可写）
      fx.groups.postRuntimeMessage(group.id, {
        runtime: "dsh",
        content: "任务 t1 完成：已改完",
        kind: "task_card",
        agentTaskId: "t1",
      });
      const status = fx.orchestrator.getStatus(group.id)!;
      expect(status.nextSpeaker).toBe("claude");
      expect(status.rounds).toBe(1);
      expect(status.budget.used.dsh).toBe(1);

      // 持权者照常回应
      fx.groups.postAgentMessage(group.id, { content: "收到结果", fromName: "claude" });
      expect(fx.groups.getGroup(group.id)!.status).toBe("open");
    } finally {
      fx.close();
    }
  });

  test("advisory 模式只记录发言权、不拦截", () => {
    const fx = makeFixture({
      speechBudget: { limit: 10, windowMs: 60_000 },
      arbitration: "advisory",
    });
    try {
      const group = fx.groups.createGroup({
        name: "建议模式",
        members: MEMBERS,
        maxRounds: 10,
        speechMode: "free",
      });
      fx.groups.postAgentMessage(group.id, { content: "@claude 你看", fromName: "dsh" });
      expect(fx.orchestrator.getStatus(group.id)!.nextSpeaker).toBe("claude");
      // 不拦：kimi 可以插话
      fx.groups.postAgentMessage(group.id, { content: "我先说两句", fromName: "kimi" });
      expect(fx.groups.listMessages(group.id).some((m) => m.fromName === "kimi")).toBe(true);
    } finally {
      fx.close();
    }
  });

  test("onTurn 回调把发言权交给宿主（可据此派发）", () => {
    const turns: Array<[string, string]> = [];
    const fx = makeFixture({
      speechBudget: { limit: 10, windowMs: 60_000 },
      onTurn: (groupId, speaker) => turns.push([groupId, speaker]),
    });
    try {
      const group = fx.groups.createGroup({
        name: "派发",
        members: MEMBERS,
        maxRounds: 10,
        speechMode: "free",
      });
      fx.groups.postAgentMessage(group.id, { content: "@claude 接手", fromName: "dsh" });
      expect(turns).toEqual([[group.id, "claude"]]);
    } finally {
      fx.close();
    }
  });
});

describe("V2-3 — 状态快照与老库迁移", () => {
  test("getStatus 暴露模式 / 轮数 / 发言权 / 预算余量", () => {
    const fx = makeFixture({ speechBudget: { limit: 3, windowMs: 30_000 } });
    try {
      const group = fx.groups.createGroup({
        name: "状态",
        members: MEMBERS,
        maxRounds: 5,
        speechMode: "free",
      });
      fx.groups.postAgentMessage(group.id, { content: "@claude 帮看", fromName: "dsh" });
      const status = fx.orchestrator.getStatus(group.id)!;
      expect(status.speechMode).toBe("free");
      expect(status.rounds).toBe(1);
      expect(status.lastSpeaker).toBe("dsh");
      expect(status.nextSpeaker).toBe("claude");
      expect(status.budget.limit).toBe(3);
      expect(status.budget.windowMs).toBe(30_000);
      expect(status.budget.used.dsh).toBe(1);
      expect(status.budget.remaining.dsh).toBe(2);
      expect(status.budget.used.fengagent).toBeUndefined(); // 主持人不在预算表里
      expect(fx.orchestrator.getStatus("grp_nope")).toBeNull();
    } finally {
      fx.close();
    }
  });

  test("老库（无 speech_mode 列）打开后自动补列，老群按 coordinated 读", () => {
    const dir = mkdtempSync(join(tmpdir(), "feng-v23-mig-"));
    const dbPath = join(dir, "groups.db");
    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE agent_groups (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open',
          members_json TEXT NOT NULL DEFAULT '[]',
          coordinator TEXT NOT NULL DEFAULT '',
          max_rounds INTEGER NOT NULL DEFAULT 3,
          idle_timeout_ms INTEGER NOT NULL DEFAULT 600000,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          created_by TEXT NOT NULL DEFAULT 'dashboard'
        );
      `);
      legacy
        .query(
          `INSERT INTO agent_groups
           (id, name, description, status, members_json, coordinator, max_rounds, idle_timeout_ms,
            created_at, updated_at, created_by)
           VALUES ('grp_legacy', '老群', '', 'open', '[]', 'fengagent', 3, 600000, 1, 1, 'dashboard')`,
        )
        .run();
      legacy.close();

      const store = new AgentGroupStore(dbPath);
      const legacyGroup = store.get("grp_legacy")!;
      expect(legacyGroup.speechMode).toBe("coordinated");
      // 补列后新群可写 free
      const created = store.create({ name: "新群", speechMode: "free" });
      expect(store.get(created.id)!.speechMode).toBe("free");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
