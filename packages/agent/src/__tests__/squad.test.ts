import { describe, it, expect } from "bun:test";
import { SquadCoordinator } from "../squad.ts";
import type { SquadEvent } from "@fengagent/core/squad";

// ──────────────────────────────────────────────
// 辅助：创建带多个成员的协调器
// ──────────────────────────────────────────────

function createCoordinator(
  memberCount: number,
  config?: { maxFailuresBeforeReassign?: number; maxReassignments?: number; cooldownMs?: number },
): SquadCoordinator {
  const coordinator = new SquadCoordinator({
    config: {
      maxFailuresBeforeReassign: config?.maxFailuresBeforeReassign ?? 3,
      maxReassignments: config?.maxReassignments ?? 3,
      cooldownMs: config?.cooldownMs ?? 60_000,
    },
  });
  for (let i = 0; i < memberCount; i++) {
    coordinator.registerMember(`member-${i}`, `Member ${i}`);
  }
  return coordinator;
}

// ──────────────────────────────────────────────
// 成员管理
// ──────────────────────────────────────────────

describe("SquadCoordinator — 成员管理", () => {
  it("注册成员并设置初始状态", () => {
    const squad = new SquadCoordinator();
    const member = squad.registerMember("agent-1", "Agent One");

    expect(member.id).toBe("agent-1");
    expect(member.name).toBe("Agent One");
    expect(member.status).toBe("idle");
    expect(member.failureCount).toBe(0);
    expect(member.successCount).toBe(0);
    expect(member.currentTaskId).toBeNull();
  });

  it("注册重复成员抛出错误", () => {
    const squad = new SquadCoordinator();
    squad.registerMember("agent-1");
    expect(() => squad.registerMember("agent-1")).toThrow("已注册");
  });

  it("注销成员时转派其当前任务", () => {
    const squad = createCoordinator(2);
    const task = squad.submitTask("task-1");
    squad.assignTask(task.id, "member-0");

    squad.unregisterMember("member-0");

    // 任务应被转派到 member-1
    expect(task.assigneeId).toBe("member-1");
    expect(task.status).toBe("assigned");
  });

  it("获取空闲成员列表", () => {
    const squad = createCoordinator(3);
    expect(squad.getIdleMembers()).toHaveLength(3);

    const task = squad.submitTask("task-1");
    squad.assignTask(task.id, "member-0");

    expect(squad.getIdleMembers()).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────
// 任务管理
// ──────────────────────────────────────────────

describe("SquadCoordinator — 任务管理", () => {
  it("提交任务后处于 pending 状态", () => {
    const squad = new SquadCoordinator();
    const task = squad.submitTask("do something", {
      prompt: "请完成某事",
      priority: "high",
    });

    expect(task.status).toBe("pending");
    expect(task.description).toBe("do something");
    expect(task.prompt).toBe("请完成某事");
    expect(task.priority).toBe("high");
    expect(task.attempts).toBe(0);
    expect(task.maxAttempts).toBe(3);
    expect(task.reassignmentCount).toBe(0);
  });

  it("待分配任务按优先级排序", () => {
    const squad = new SquadCoordinator();
    squad.submitTask("low task", { priority: "low" });
    squad.submitTask("urgent task", { priority: "urgent" });
    squad.submitTask("normal task", { priority: "normal" });

    const pending = squad.getPendingTasks();
    expect(pending[0]!.description).toBe("urgent task");
    expect(pending[1]!.description).toBe("normal task");
    expect(pending[2]!.description).toBe("low task");
  });

  it("assignNext 分配最高优先级任务给空闲成员", () => {
    const squad = createCoordinator(1);
    squad.submitTask("low task", { priority: "low" });
    squad.submitTask("urgent task", { priority: "urgent" });

    const assigned = squad.assignNext();
    expect(assigned!.description).toBe("urgent task");
    expect(assigned!.status).toBe("assigned");
    expect(assigned!.assigneeId).toBe("member-0");
    expect(assigned!.attempts).toBe(1);
  });

  it("assignNext 无空闲成员时返回 null", () => {
    const squad = createCoordinator(1);
    squad.submitTask("task-1");
    squad.assignNext(); // member-0 now busy

    squad.submitTask("task-2");
    expect(squad.assignNext()).toBeNull();
  });

  it("assignNext 无待处理任务时返回 null", () => {
    const squad = createCoordinator(2);
    expect(squad.assignNext()).toBeNull();
  });
});

// ──────────────────────────────────────────────
// 成功报告
// ──────────────────────────────────────────────

describe("SquadCoordinator — reportSuccess", () => {
  it("报告成功后任务完成、成员释放", () => {
    const squad = createCoordinator(1);
    const task = squad.submitTask("task-1");
    squad.assignNext();

    squad.reportSuccess(task.id, "done");

    expect(task.status).toBe("completed");
    expect(task.history).toHaveLength(1);
    expect(task.history[0]!.result).toBe("success");

    const member = squad.getMember("member-0")!;
    expect(member.status).toBe("idle");
    expect(member.currentTaskId).toBeNull();
    expect(member.successCount).toBe(1);
  });

  it("报告成功后触发 task-succeeded 事件", () => {
    const events: SquadEvent[] = [];
    const squad = new SquadCoordinator({ onEvent: (e) => events.push(e) });
    squad.registerMember("m1");
    const task = squad.submitTask("task-1");
    squad.assignNext();
    squad.reportSuccess(task.id);

    const successEvent = events.find((e) => e.type === "task-succeeded");
    expect(successEvent).toBeDefined();
  });
});

// ──────────────────────────────────────────────
// 失败重试（未达冷却阈值）
// ──────────────────────────────────────────────

describe("SquadCoordinator — 失败重试（未达冷却阈值）", () => {
  it("失败后优先转派到其他空闲成员", () => {
    const squad = createCoordinator(2);
    const task = squad.submitTask("task-1");
    squad.assignTask(task.id, "member-0");

    const result = squad.reportFailure(task.id, "执行出错");

    expect(result.action).toBe("reassigned");
    expect(result.newAssigneeId).toBe("member-1");
    expect(task.assigneeId).toBe("member-1");
    expect(task.reassignmentCount).toBe(1);
    expect(task.attempts).toBe(2); // 第一次 + 转派后第二次

    // member-0 释放为 idle，failureCount=1
    const m0 = squad.getMember("member-0")!;
    expect(m0.status).toBe("idle");
    expect(m0.failureCount).toBe(1);
  });

  it("无其他空闲成员时同一成员重试", () => {
    const squad = createCoordinator(1);
    const task = squad.submitTask("task-1");
    squad.assignNext();

    const result = squad.reportFailure(task.id, "执行出错");

    expect(result.action).toBe("retried");
    expect(result.newAssigneeId).toBe("member-0");
    expect(task.attempts).toBe(2);
    expect(task.reassignmentCount).toBe(0); // 同一成员不算转派

    const m0 = squad.getMember("member-0")!;
    expect(m0.failureCount).toBe(1);
  });

  it("失败后触发 task-failed 事件", () => {
    const events: SquadEvent[] = [];
    const squad = new SquadCoordinator({ onEvent: (e) => events.push(e) });
    squad.registerMember("m1");
    const task = squad.submitTask("task-1");
    squad.assignNext();
    squad.reportFailure(task.id, "error msg");

    const failEvent = events.find((e) => e.type === "task-failed");
    expect(failEvent).toBeDefined();
    if (failEvent!.type === "task-failed") {
      expect(failEvent!.error).toBe("error msg");
      expect(failEvent!.attempt).toBe(1);
    }
  });
});

// ──────────────────────────────────────────────
// 冷却 + 自动转派（核心：多次失败后转派）
// ──────────────────────────────────────────────

describe("SquadCoordinator — 多次失败后冷却 + 自动转派", () => {
  it("成员失败达到阈值后进入冷却，任务转派到其他成员", () => {
    const squad = createCoordinator(2, { maxFailuresBeforeReassign: 3 });

    // 让 member-0 失败 2 次（用两个不同任务）
    const task1 = squad.submitTask("task-1");
    squad.assignTask(task1.id, "member-0");
    squad.reportFailure(task1.id, "err-1"); // failureCount=1, retry on member-0

    // member-0 现在忙碌（retried），先报告成功释放
    squad.reportSuccess(task1.id);

    const task2 = squad.submitTask("task-2");
    squad.assignTask(task2.id, "member-0");
    squad.reportFailure(task2.id, "err-2"); // failureCount=2, retried on member-0

    squad.reportSuccess(task2.id);

    // 第三次失败：达到阈值 3
    const task3 = squad.submitTask("task-3");
    squad.assignTask(task3.id, "member-0");
    const result = squad.reportFailure(task3.id, "err-3"); // failureCount=3 → cooldown

    expect(result.action).toBe("cooldown_reassign");
    expect(result.newAssigneeId).toBe("member-1");

    const m0 = squad.getMember("member-0")!;
    expect(m0.status).toBe("cooldown");
    expect(m0.failureCount).toBe(3);
    expect(m0.cooldownUntil).not.toBeNull();

    // task3 转派到 member-1
    expect(task3.assigneeId).toBe("member-1");
  });

  it("冷却成员不参与新任务分配", () => {
    const squad = createCoordinator(2, {
      maxFailuresBeforeReassign: 1,
      cooldownMs: 60_000,
    });

    // member-0 失败 1 次即冷却
    const task1 = squad.submitTask("task-1");
    squad.assignTask(task1.id, "member-0");
    squad.reportFailure(task1.id, "err"); // cooldown + reassign to member-1

    // 新任务只应分配给 member-1（member-0 在冷却）
    const task2 = squad.submitTask("task-2");
    // member-1 正忙（执行 task1），先报告成功
    squad.reportSuccess(task1.id);

    squad.assignNext();
    expect(task2.assigneeId).toBe("member-1");
  });

  it("冷却到期后成员恢复并重置失败计数", async () => {
    const squad = createCoordinator(2, {
      maxFailuresBeforeReassign: 1,
      cooldownMs: 50, // 50ms 冷却
    });

    const task = squad.submitTask("task-1");
    squad.assignTask(task.id, "member-0");
    squad.reportFailure(task.id, "err"); // member-0 cooldown

    const m0 = squad.getMember("member-0")!;
    expect(m0.status).toBe("cooldown");

    // 等待冷却到期后 tick
    await Bun.sleep(60);
    squad.tick();
    const m0After = squad.getMember("member-0")!;
    expect(m0After.status).toBe("idle");
    expect(m0After.failureCount).toBe(0);
    expect(m0After.cooldownUntil).toBeNull();
  });

  it("冷却触发 member-cooldown 事件", () => {
    const events: SquadEvent[] = [];
    const squad = new SquadCoordinator({
      config: { maxFailuresBeforeReassign: 1, maxReassignments: 3, cooldownMs: 60_000 },
      onEvent: (e) => events.push(e),
    });
    squad.registerMember("m1");
    squad.registerMember("m2");
    const task = squad.submitTask("task-1");
    squad.assignTask(task.id, "m1");

    squad.reportFailure(task.id, "err");

    const cooldownEvent = events.find((e) => e.type === "member-cooldown");
    expect(cooldownEvent).toBeDefined();
    if (cooldownEvent!.type === "member-cooldown") {
      expect(cooldownEvent!.memberId).toBe("m1");
      expect(cooldownEvent!.failureCount).toBe(1);
    }
  });
});

// ──────────────────────────────────────────────
// 永久失败
// ──────────────────────────────────────────────

describe("SquadCoordinator — 永久失败", () => {
  it("转派次数超限后任务永久失败", () => {
    const squad = createCoordinator(2, {
      maxFailuresBeforeReassign: 1, // 1 次失败即冷却
      maxReassignments: 2, // 最多转派 2 次
    });

    // 提交任务，让它在 member-0 和 member-1 之间来回转派
    const task = squad.submitTask("task-1");
    squad.assignTask(task.id, "member-0");

    // 失败 1: member-0 冷却, 转派到 member-1 (reassignmentCount=1)
    squad.reportFailure(task.id, "err-1");
    expect(task.assigneeId).toBe("member-1");

    // member-0 冷却中，恢复它
    squad.reactivateMember("member-0");

    // 失败 2: member-1 冷却, 转派到 member-0 (reassignmentCount=2)
    squad.reportFailure(task.id, "err-2");
    expect(task.assigneeId).toBe("member-0");

    squad.reactivateMember("member-1");

    // 失败 3: member-0 冷却, 转派超限 → 永久失败
    const result = squad.reportFailure(task.id, "err-3");

    expect(result.action).toBe("permanently_failed");
    expect(task.status).toBe("failed");
    expect(task.assigneeId).toBeNull();
  });

  it("永久失败触发 task-permanently-failed 事件", () => {
    const events: SquadEvent[] = [];
    const squad = new SquadCoordinator({
      config: { maxFailuresBeforeReassign: 1, maxReassignments: 1, cooldownMs: 60_000 },
      onEvent: (e) => events.push(e),
    });
    squad.registerMember("m1");
    squad.registerMember("m2");

    const task = squad.submitTask("task-1");
    squad.assignTask(task.id, "m1");

    // 失败 1: m1 冷却, 转派到 m2 (reassignmentCount=1)
    squad.reportFailure(task.id, "err-1");

    squad.reactivateMember("m1");

    // 失败 2: m2 冷却, 转派超限 → 永久失败
    squad.reportFailure(task.id, "err-2");

    const permEvent = events.find((e) => e.type === "task-permanently-failed");
    expect(permEvent).toBeDefined();
  });
});

// ──────────────────────────────────────────────
// 无空闲成员时排队
// ──────────────────────────────────────────────

describe("SquadCoordinator — 无空闲成员排队", () => {
  it("所有成员冷却时任务排队", () => {
    const squad = createCoordinator(1, {
      maxFailuresBeforeReassign: 1,
      maxReassignments: 3,
      cooldownMs: 60_000,
    });

    const task = squad.submitTask("task-1");
    squad.assignNext(); // member-0 busy

    const result = squad.reportFailure(task.id, "err");
    // member-0 冷却，无其他成员 → queued
    expect(result.action).toBe("queued");
    expect(task.status).toBe("pending");
    expect(task.assigneeId).toBeNull();
  });

  it("排队任务在成员恢复后被分配", () => {
    const squad = createCoordinator(1, {
      maxFailuresBeforeReassign: 1,
      maxReassignments: 3,
      cooldownMs: 60_000,
    });

    const task = squad.submitTask("task-1");
    squad.assignNext();
    squad.reportFailure(task.id, "err"); // member-0 cooldown, task queued

    expect(task.status).toBe("pending");

    // 手动恢复成员
    squad.reactivateMember("member-0");
    squad.assignNext();

    expect(task.status).toBe("assigned");
    expect(task.assigneeId).toBe("member-0");
  });
});

// ──────────────────────────────────────────────
// 手动转派与禁用
// ──────────────────────────────────────────────

describe("SquadCoordinator — 手动转派与禁用", () => {
  it("reassignTask 手动转派到其他成员", () => {
    const squad = createCoordinator(2);
    const task = squad.submitTask("task-1");
    squad.assignTask(task.id, "member-0");

    const result = squad.reassignTask(task.id, "手动调度");

    expect(result.action).toBe("cooldown_reassign");
    expect(result.newAssigneeId).toBe("member-1");
    expect(task.assigneeId).toBe("member-1");

    // 原成员释放
    const m0 = squad.getMember("member-0")!;
    expect(m0.status).toBe("idle");
    expect(m0.currentTaskId).toBeNull();
  });

  it("disableMember 禁用成员并转派其任务", () => {
    const squad = createCoordinator(2);
    const task = squad.submitTask("task-1");
    squad.assignTask(task.id, "member-0");

    squad.disableMember("member-0", "维护");

    const m0 = squad.getMember("member-0")!;
    expect(m0.status).toBe("disabled");
    expect(m0.currentTaskId).toBeNull();

    // 任务转派到 member-1
    expect(task.assigneeId).toBe("member-1");
  });

  it("reactivateMember 恢复被禁用的成员", () => {
    const squad = createCoordinator(1);
    squad.disableMember("member-0");

    const m0 = squad.getMember("member-0")!;
    expect(m0.status).toBe("disabled");

    squad.reactivateMember("member-0");
    expect(squad.getMember("member-0")!.status).toBe("idle");
  });
});

// ──────────────────────────────────────────────
// 状态概览
// ──────────────────────────────────────────────

describe("SquadCoordinator — getStatus", () => {
  it("返回正确的小队状态概览", () => {
    const squad = createCoordinator(3, { maxFailuresBeforeReassign: 1 });
    squad.submitTask("task-1");
    squad.submitTask("task-2");
    squad.submitTask("task-3");

    squad.assignNext(); // 1 busy
    squad.assignNext(); // 2 busy

    const status = squad.getStatus();
    expect(status.totalMembers).toBe(3);
    expect(status.busyMembers).toBe(2);
    expect(status.idleMembers).toBe(1);
    expect(status.totalTasks).toBe(3);
    expect(status.pendingTasks).toBe(1);
  });
});

// ──────────────────────────────────────────────
// 事件日志
// ──────────────────────────────────────────────

describe("SquadCoordinator — 事件日志", () => {
  it("记录完整的事件序列", () => {
    const squad = createCoordinator(2, { maxFailuresBeforeReassign: 1 });
    const task = squad.submitTask("task-1");
    squad.assignNext();
    squad.reportSuccess(task.id);

    const events = squad.getEvents();
    const types = events.map((e) => e.type);

    expect(types).toContain("task-submitted");
    expect(types).toContain("task-assigned");
    expect(types).toContain("task-succeeded");
  });

  it("clearEvents 清空事件日志", () => {
    const squad = createCoordinator(1);
    squad.submitTask("task-1");
    expect(squad.getEvents().length).toBeGreaterThan(0);

    squad.clearEvents();
    expect(squad.getEvents()).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────
// 环境变量覆盖
// ──────────────────────────────────────────────

describe("SquadCoordinator — 环境变量覆盖", () => {
  it("FENG_SQUAD_MAX_FAILURES 覆盖失败阈值", () => {
    const original = process.env.FENG_SQUAD_MAX_FAILURES;
    process.env.FENG_SQUAD_MAX_FAILURES = "5";

    const squad = new SquadCoordinator();
    squad.registerMember("m1");
    squad.registerMember("m2");

    const task = squad.submitTask("task-1");
    squad.assignTask(task.id, "m1");

    // 失败 1 次不应触发冷却（阈值为 5）
    squad.reportFailure(task.id, "err");
    const m1 = squad.getMember("m1")!;
    expect(m1.status).not.toBe("cooldown");

    process.env.FENG_SQUAD_MAX_FAILURES = original;
  });
});
