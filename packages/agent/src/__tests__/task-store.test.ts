/**
 * 任务状态仓 + 副作用台账 + 恢复核对 — 块 1/2/3/4 的存储与核对层验收
 *
 * 验收点：
 * 1. `state_version` 是乐观锁：陈旧版本写入**被拒**（不是静默覆盖）；
 * 2. 事件重放重建的状态与实时状态逐字节零差异；
 * 3. 同一幂等键二次 `begin` 不会产生第二条台账行（去重在存储层）；
 * 4. 「有 tool-use 无 tool-result」的会话加载必须列出 orphan；
 * 5. 结果 unknown 不得自动继续 —— `canResumeAutomatically` 必须为 false。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Session } from "@fengagent/core";
import { TaskStateError } from "@fengagent/core";
import { TaskStore } from "../task-store.ts";
import { buildTaskRecoveryReport, detectOrphanToolCalls } from "../task-recovery.ts";

let dir: string;
let store: TaskStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feng-taskstore-"));
  store = new TaskStore(join(dir, "tasks.db"));
});

afterEach(() => {
  store.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 偶发占用
  }
});

function makeSession(id: string, messages: Message[] = []): Session {
  return {
    id,
    title: "t",
    messages,
    model: "m",
    createdAt: 1,
    updatedAt: 1,
    status: "idle",
    tokenCount: 0,
  };
}

describe("TaskStore 基本读写", () => {
  test("createTask 落盘并可读回，core_intent 只读", () => {
    const state = store.createTask({
      taskId: "t1",
      sessionId: "s1",
      coreIntent: "核心意图",
      at: 1000,
    });
    expect(state.stateVersion).toBe(1);
    const loaded = store.getTask("t1")!;
    expect(loaded.coreIntent).toBe("核心意图");
    expect(loaded.sessionId).toBe("s1");
    expect(loaded.createdAt).toBe(1000);
  });

  test("重复 createTask 被拒", () => {
    store.createTask({ taskId: "t1", sessionId: "s1", coreIntent: "a" });
    expect(() =>
      store.createTask({ taskId: "t1", sessionId: "s1", coreIntent: "b" }),
    ).toThrow(TaskStateError);
  });

  test("getTaskBySession 找得到本会话的任务", () => {
    store.createTask({ taskId: "t1", sessionId: "s1", coreIntent: "a" });
    expect(store.getTaskBySession("s1")!.taskId).toBe("t1");
    expect(store.getTaskBySession("nope")).toBeNull();
  });
});

describe("state_version 乐观锁", () => {
  test("陈旧版本写入被拒（不会被静默覆盖）", () => {
    store.createTask({ taskId: "t1", sessionId: "s1", coreIntent: "a" });
    // 正确版本 1 → 推进到 2
    store.applyEvent("t1", 1, {
      type: "task/subtask",
      taskId: "t1",
      subtask: "第一步",
      at: 100,
    });
    // 落后的调用方仍以为版本是 1 → 必须被拒
    expect(() =>
      store.applyEvent("t1", 1, {
        type: "task/subtask",
        taskId: "t1",
        subtask: "并发的陈旧写入",
        at: 101,
      }),
    ).toThrow(TaskStateError);
    // 现场未被污染
    expect(store.getTask("t1")!.currentSubtask).toBe("第一步");
    expect(store.getTask("t1")!.stateVersion).toBe(2);
  });

  test("版本单调递增", () => {
    store.createTask({ taskId: "t1", sessionId: "s1", coreIntent: "a" });
    let last = store.getTask("t1")!.stateVersion;
    for (let i = 0; i < 6; i++) {
      const next = store.appendEvent("t1", {
        type: "task/subtask",
        taskId: "t1",
        subtask: `s${i}`,
        at: 200 + i,
      });
      expect(next.stateVersion).toBe(last + 1);
      last = next.stateVersion;
    }
  });

  test("版本冲突错误码可被程序化判定", () => {
    store.createTask({ taskId: "t1", sessionId: "s1", coreIntent: "a" });
    try {
      store.applyEvent("t1", 99, {
        type: "task/status",
        taskId: "t1",
        status: "completed",
        at: 1,
      });
      throw new Error("应当抛出");
    } catch (err) {
      expect(err).toBeInstanceOf(TaskStateError);
      expect((err as TaskStateError).code).toBe("stale_state_version");
    }
  });
});

describe("事件重放对拍（零差异）", () => {
  test("重放状态 === 实时状态", () => {
    store.createTask({ taskId: "t1", sessionId: "s1", coreIntent: "目标", at: 1 });
    store.appendEvent("t1", {
      type: "task/pending",
      taskId: "t1",
      stepId: "step-1",
      pending: [
        {
          toolUseId: "tu-1",
          toolName: "notify_external",
          input: { channel: "ops" },
          sideEffect: "non-idempotent",
          operationKey: "notify_external::ops",
          stepId: "step-1",
          startedAt: 2,
        },
      ],
      at: 2,
    });
    store.appendEvent("t1", {
      type: "task/step-completed",
      taskId: "t1",
      step: {
        stepId: "step-1",
        intent: "通知",
        outcome: "ok",
        toolUseIds: ["tu-1"],
        startedAt: 2,
        finishedAt: 3,
      },
      at: 3,
    });
    store.appendEvent("t1", {
      type: "task/context",
      taskId: "t1",
      snapshot: { k: "v" },
      at: 4,
    });

    const live = store.getTask("t1")!;
    const replayed = store.replay("t1")!;
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(live));
    expect(replayed.completedSteps).toHaveLength(1);
    expect(replayed.contextSnapshot).toEqual({ k: "v" });
  });

  test("事件流带 seq 且可全量读回", () => {
    store.createTask({ taskId: "t1", sessionId: "s1", coreIntent: "a", at: 1 });
    store.appendEvent("t1", {
      type: "task/status",
      taskId: "t1",
      status: "blocked",
      at: 2,
    });
    const events = store.events("t1");
    expect(events.map((e) => e.type)).toEqual(["task/created", "task/status"]);
  });
});

describe("副作用台账（去重在存储层）", () => {
  test("同一幂等键二次 begin 不会新增台账行，且返回已存在的记录", () => {
    const first = store.ledger.begin({
      operationId: "op-1",
      operationKey: "notify_external::ops",
      toolName: "notify_external",
      sessionId: "s1",
      input: { channel: "ops" },
      startedAt: 1,
    });
    expect(first.operationId).toBe("op-1");

    const second = store.ledger.begin({
      operationId: "op-2",
      operationKey: "notify_external::ops",
      toolName: "notify_external",
      sessionId: "s1",
      input: { channel: "ops" },
      startedAt: 2,
    });
    // 幂等键命中既有记录 —— 第二次拿着的是**同一条**记录
    expect(second.operationId).toBe("op-1");
    expect(store.ledger.listBySession("s1")).toHaveLength(1);
  });

  test("complete 后可复用结果；listPending 不再包含它", () => {
    store.ledger.begin({
      operationId: "op-1",
      operationKey: "k",
      toolName: "t",
      sessionId: "s1",
      input: {},
      startedAt: 1,
    });
    expect(store.ledger.listPending()).toHaveLength(1);
    store.ledger.complete("op-1", {
      digest: "OK:5:hello",
      json: { content: "hello", isError: false },
      finishedAt: 2,
    });
    const rec = store.ledger.lookup("k")!;
    expect(rec.status).toBe("succeeded");
    expect(rec.resultJson).toEqual({ content: "hello", isError: false });
    expect(store.ledger.listPending()).toHaveLength(0);
  });

  test("markUnknown 只作用于 pending", () => {
    store.ledger.begin({
      operationId: "op-1",
      operationKey: "k",
      toolName: "t",
      sessionId: "s1",
      input: {},
      startedAt: 1,
    });
    store.ledger.markUnknown("op-1");
    expect(store.ledger.get("op-1")!.status).toBe("unknown");
    store.ledger.markUnknown("op-1"); // 幂等
    expect(store.ledger.get("op-1")!.status).toBe("unknown");
  });

  test("fail 记录失败原因", () => {
    store.ledger.begin({
      operationId: "op-1",
      operationKey: "k",
      toolName: "t",
      sessionId: "s1",
      input: {},
      startedAt: 1,
    });
    store.ledger.fail("op-1", "boom", 2);
    const rec = store.ledger.get("op-1")!;
    expect(rec.status).toBe("failed");
    expect(rec.error).toBe("boom");
  });

  test("跨实例可见（落盘，不是进程内内存）", () => {
    store.ledger.begin({
      operationId: "op-1",
      operationKey: "k",
      toolName: "t",
      sessionId: "s1",
      input: { a: 1 },
      startedAt: 1,
    });
    const store2 = new TaskStore(join(dir, "tasks.db"));
    expect(store2.ledger.lookup("k")!.operationId).toBe("op-1");
    store2.close();
  });
});

describe("未决调用核对（orphan 检测）", () => {
  test("有 tool-use 无 tool-result 的调用被列出", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "assistant",
        createdAt: 1,
        content: [
          { type: "text", text: "我来通知外部系统" },
          { type: "tool-use", id: "tu-1", name: "notify_external", input: { channel: "ops" } },
          { type: "tool-use", id: "tu-2", name: "file_read", input: { path: "a.ts" } },
        ],
      },
      {
        id: "m2",
        role: "user",
        createdAt: 2,
        content: [{ type: "tool-result", toolUseId: "tu-2", content: "ok" }],
      },
    ];
    const orphans = detectOrphanToolCalls(messages);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.toolUseId).toBe("tu-1");
    expect(orphans[0]!.messageId).toBe("m1");
  });

  test("全部配对时无 orphan", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "assistant",
        createdAt: 1,
        content: [{ type: "tool-use", id: "tu-1", name: "x", input: {} }],
      },
      {
        id: "m2",
        role: "user",
        createdAt: 2,
        content: [{ type: "tool-result", toolUseId: "tu-1", content: "ok" }],
      },
    ];
    expect(detectOrphanToolCalls(messages)).toEqual([]);
  });

  test("unknown 的非幂等操作 → 不得自动继续", () => {
    const session = makeSession("s1");
    store.createTask({ taskId: "t1", sessionId: "s1", coreIntent: "x", at: 1 });
    store.ledger.begin({
      operationId: "op-1",
      operationKey: "notify_external::ops",
      toolName: "notify_external",
      sessionId: "s1",
      input: {},
      startedAt: 1,
    });
    store.ledger.markUnknown("op-1");

    const report = buildTaskRecoveryReport(store, session, () => "non-idempotent");
    expect(report.canResumeAutomatically).toBe(false);
    expect(report.unresolvedOperations).toHaveLength(1);
    expect(report.requiresConfirmation.join(" ")).toContain("unknown");
    // 重放对拍同样成立（核对不该改变状态）
    expect(JSON.stringify(report.replayedState)).toBe(JSON.stringify(report.state));
  });

  test("幂等工具的未决操作 → 允许自动继续（不打扰用户）", () => {
    const session = makeSession("s1");
    store.createTask({ taskId: "t1", sessionId: "s1", coreIntent: "x", at: 1 });
    store.ledger.begin({
      operationId: "op-1",
      operationKey: "put_config::a",
      toolName: "put_config",
      sessionId: "s1",
      input: {},
      startedAt: 1,
    });
    const report = buildTaskRecoveryReport(store, session, () => "idempotent");
    expect(report.canResumeAutomatically).toBe(true);
    expect(report.requiresConfirmation).toEqual([]);
  });

  test("orphan 且副作用未声明 → 仍需显式确认", () => {
    const session = makeSession("s1", [
      {
        id: "m1",
        role: "assistant",
        createdAt: 1,
        content: [
          { type: "tool-use", id: "tu-9", name: "mystery_writer", input: {} },
        ],
      },
    ]);
    store.createTask({ taskId: "t1", sessionId: "s1", coreIntent: "x", at: 1 });
    const report = buildTaskRecoveryReport(store, session, () => "non-idempotent");
    expect(report.orphans).toHaveLength(1);
    expect(report.canResumeAutomatically).toBe(false);
    expect(report.requiresConfirmation.join(" ")).toContain("orphan");
  });

  test("干净的会话（无 orphan、无未决）→ 允许自动继续", () => {
    const session = makeSession("s1");
    store.createTask({ taskId: "t1", sessionId: "s1", coreIntent: "x", at: 1 });
    const report = buildTaskRecoveryReport(store, session, () => "non-idempotent");
    expect(report.canResumeAutomatically).toBe(true);
    expect(report.taskId).toBe("t1");
  });
});
