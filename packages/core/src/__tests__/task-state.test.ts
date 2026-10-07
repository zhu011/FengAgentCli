/**
 * 结构化任务状态（TaskState）— 块 1/2 验收
 *
 * 验收点（与协调口径一致）：
 * 1. `core_intent` 是只读锚点 —— 任何后续事件都改不动，二次 created 直接抛；
 * 2. 事件重放重建的 state 与「实时推进的 state」**逐字节**零差异；
 * 3. `state_version` 单调递增（每个事件 +1），checkpoint 上带得出来。
 */

import { describe, expect, test } from "bun:test";
import {
  TaskStateError,
  createTaskState,
  isTaskEventType,
  reduceTaskState,
  replayTaskState,
  taskStateEquals,
} from "../task-state.ts";
import type { TaskEvent } from "../task-state.ts";

const T0 = 1_700_000_000_000;

/** 构造一串有代表性的任务事件（含 pending → step-completed 的完整步） */
function sampleEvents(taskId = "task-1"): TaskEvent[] {
  return [
    {
      type: "task/created",
      taskId,
      sessionId: "sess-1",
      coreIntent: "把结算服务从单体拆出来",
      at: T0,
    },
    {
      type: "task/subtask",
      taskId,
      subtask: "先梳理现有依赖",
      at: T0 + 1,
    },
    {
      type: "task/pending",
      taskId,
      stepId: "step-1",
      pending: [
        {
          toolUseId: "tu-1",
          toolName: "external_write",
          input: { key: "k1" },
          sideEffect: "non-idempotent",
          operationKey: "external_write::k1",
          stepId: "step-1",
          startedAt: T0 + 2,
        },
      ],
      at: T0 + 2,
    },
    {
      type: "task/step-completed",
      taskId,
      step: {
        stepId: "step-1",
        intent: "先梳理现有依赖",
        outcome: "external_write: ok",
        toolUseIds: ["tu-1"],
        finishReason: "tool_use",
        startedAt: T0 + 2,
        finishedAt: T0 + 3,
      },
      at: T0 + 3,
    },
    {
      type: "task/context",
      taskId,
      snapshot: { filesRead: 3, lastError: null },
      at: T0 + 4,
    },
    {
      type: "task/checkpoint",
      taskId,
      checkpoint: { stepId: "step-1", phase: "outcome", stateVersion: 6, at: T0 + 3 },
      at: T0 + 3,
    },
    { type: "task/status", taskId, status: "completed", at: T0 + 5 },
  ];
}

describe("TaskState 事件词汇", () => {
  test("task/* 类型判定", () => {
    expect(isTaskEventType("task/created")).toBe(true);
    expect(isTaskEventType("task/step-completed")).toBe(true);
    expect(isTaskEventType("turn/end")).toBe(false);
  });
});

describe("reduceTaskState", () => {
  test("task/created 建立只读锚点与初始版本 1", () => {
    const state = createTaskState("t", "s", "核心意图", T0);
    expect(state.coreIntent).toBe("核心意图");
    expect(state.stateVersion).toBe(1);
    expect(state.status).toBe("active");
    expect(state.pendingTools).toEqual([]);
    expect(state.completedSteps).toEqual([]);
  });

  test("core_intent 不可改写：二次 created 直接拒绝", () => {
    const state = createTaskState("t", "s", "原始意图", T0);
    expect(() =>
      reduceTaskState(state, {
        type: "task/created",
        taskId: "t",
        sessionId: "s",
        coreIntent: "偷换的意图",
        at: T0 + 1,
      }),
    ).toThrow(TaskStateError);
    expect(state.coreIntent).toBe("原始意图");
  });

  test("任何事件都不含 coreIntent 字段 —— 锚点无从被覆盖", () => {
    const events = sampleEvents();
    for (const event of events) {
      if (event.type === "task/created") continue;
      expect(Object.keys(event)).not.toContain("coreIntent");
      expect(Object.keys(event)).not.toContain("subtaskIntentRewrite");
    }
  });

  test("state_version 单调 +1，每个事件都推进", () => {
    const events = sampleEvents();
    let state = replayTaskState(events);
    expect(state).not.toBeNull();
    expect(state!.stateVersion).toBe(events.length);

    // 再补一条事件 → 恰好 +1
    state = reduceTaskState(state, {
      type: "task/subtask",
      taskId: "task-1",
      subtask: "下一步",
      at: T0 + 10,
    });
    expect(state!.stateVersion).toBe(events.length + 1);
  });

  test("pending 随所属步结算清空，completedSteps 追加", () => {
    const events = sampleEvents();
    // 步结算前：pending 里有 1 条
    const before = replayTaskState(events.slice(0, 3));
    expect(before!.pendingTools).toHaveLength(1);
    // 步结算后：pending 清空、completedSteps 有 1 条
    const after = replayTaskState(events.slice(0, 4));
    expect(after!.pendingTools).toHaveLength(0);
    expect(after!.completedSteps).toHaveLength(1);
    expect(after!.completedSteps[0]!.stepId).toBe("step-1");
  });

  test("只清掉本步的 pending，未结算的其它步保留", () => {
    let state = createTaskState("t", "s", "intent", T0);
    state = reduceTaskState(state, {
      type: "task/pending",
      taskId: "t",
      stepId: "step-a",
      pending: [
        {
          toolUseId: "a",
          toolName: "x",
          input: {},
          sideEffect: "none",
          stepId: "step-a",
          startedAt: T0,
        },
      ],
      at: T0,
    });
    state = reduceTaskState(state, {
      type: "task/pending",
      taskId: "t",
      stepId: "step-b",
      pending: [
        {
          toolUseId: "b",
          toolName: "y",
          input: {},
          sideEffect: "none",
          stepId: "step-b",
          startedAt: T0,
        },
      ],
      at: T0,
    });
    state = reduceTaskState(state, {
      type: "task/step-completed",
      taskId: "t",
      step: {
        stepId: "step-a",
        intent: "a",
        outcome: "ok",
        toolUseIds: ["a"],
        startedAt: T0,
        finishedAt: T0,
      },
      at: T0,
    });
    expect(state.pendingTools.map((p) => p.stepId)).toEqual(["step-b"]);
  });

  test("reducer 是纯函数：不改写入参状态", () => {
    const state = createTaskState("t", "s", "intent", T0);
    const snapshot = JSON.stringify(state);
    reduceTaskState(state, {
      type: "task/subtask",
      taskId: "t",
      subtask: "新的",
      at: T0 + 1,
    });
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  test("taskId 不匹配的事件被拒", () => {
    const state = createTaskState("t", "s", "intent", T0);
    expect(() =>
      reduceTaskState(state, {
        type: "task/status",
        taskId: "other",
        status: "completed",
        at: T0,
      }),
    ).toThrow(TaskStateError);
  });

  test("未 created 就应用业务事件被拒", () => {
    expect(() =>
      reduceTaskState(null, {
        type: "task/subtask",
        taskId: "t",
        subtask: "x",
        at: T0,
      }),
    ).toThrow(TaskStateError);
  });
});

describe("事件重放对拍", () => {
  test("重放结果与实时推进逐字节一致", () => {
    const events = sampleEvents();
    // 实时推进：一条一条 apply
    let live = reduceTaskState(null, events[0]!);
    for (const event of events.slice(1)) {
      live = reduceTaskState(live, event);
    }
    // 重放：一次给整条流
    const replayed = replayTaskState(events);
    expect(taskStateEquals(live, replayed)).toBe(true);
    expect(JSON.stringify(live)).toBe(JSON.stringify(replayed));
  });

  test("重放与实时推进在「同事件序列」上恒等（含多次 pending 覆盖）", () => {
    const taskId = "task-x";
    const base: TaskEvent[] = [
      { type: "task/created", taskId, sessionId: "s", coreIntent: "i", at: T0 },
    ];
    const churn: TaskEvent[] = [];
    for (let i = 0; i < 5; i++) {
      churn.push({
        type: "task/pending",
        taskId,
        stepId: `step-${i}`,
        pending: [
          {
            toolUseId: `tu-${i}`,
            toolName: "t",
            input: { i },
            sideEffect: "none",
            stepId: `step-${i}`,
            startedAt: T0 + i,
          },
        ],
        at: T0 + i,
      });
      churn.push({
        type: "task/step-completed",
        taskId,
        step: {
          stepId: `step-${i}`,
          intent: `i${i}`,
          outcome: `o${i}`,
          toolUseIds: [`tu-${i}`],
          startedAt: T0 + i,
          finishedAt: T0 + i + 1,
        },
        at: T0 + i + 1,
      });
    }
    const events = [...base, ...churn];
    const replayed = replayTaskState(events);
    let live = reduceTaskState(null, events[0]!);
    for (const event of events.slice(1)) live = reduceTaskState(live, event);
    expect(taskStateEquals(live, replayed)).toBe(true);
    expect(replayed!.completedSteps).toHaveLength(5);
  });

  test("空事件流重放得到 null", () => {
    expect(replayTaskState([])).toBeNull();
  });
});
