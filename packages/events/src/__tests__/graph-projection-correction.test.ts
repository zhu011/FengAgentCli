/**
 * @fengagent/events — 图投影 改参溯源测试（AGE-29 图三件套 ③）
 *
 * 覆盖：
 * 1. `tool/corrected` 事实 → 对应助手节点 `meta.userCorrectedInput` = true，
 *    且 `meta.inputCorrections` 保留**改参前后**（原始入参 / 新入参）——溯源指数据可追；
 * 2. 未经改参的节点不带该标记（不误标）；
 * 3. 同一节点多次改参 → 按事件序追加（历史完整）；
 * 4. 指向未知 messageId 的改参事实不炸投影（容忍遗留/越界事件）；
 * 5. 步级回退事件 → 分支点带 `stepLevel`；轮级回退事件 → 不带（图形区分）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../event-store.ts";
import { EventGraphStore } from "../event-graph-store.ts";
import { projectGraph } from "../graph-projection.ts";
import { assistantNodeId, branchPointNodeId, userNodeId } from "../node-ids.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "proj-corr-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { store: new EventStore({ dir: join(dir, "events") }) };
}

/**
 * 一轮带工具调用的对话：
 * user/q → step/start(a-1，含 tool-use 块) → user/message(工具结果) → step/start(a-2)
 */
function seedToolRound(store: EventStore, sessionId: string): void {
  store.append({
    sessionId,
    type: "session/created",
    payload: { title: "改参会话", status: "created" },
    timestamp: "2026-09-26T00:00:00.000Z",
  });
  store.append({
    sessionId,
    type: "user/message",
    payload: { messageId: "u-1", content: [{ type: "text", text: "查一下目录" }] },
    timestamp: "2026-09-26T00:00:01.000Z",
  });
  store.append({
    sessionId,
    type: "step/start",
    payload: { messageId: "a-1", model: "deepseek-chat" },
    timestamp: "2026-09-26T00:00:02.000Z",
  });
  store.append({
    sessionId,
    type: "assistant/chunk",
    payload: {
      messageId: "a-1",
      index: 0,
      delta: {
        type: "tool-use",
        id: "toolu-1",
        name: "bash",
        input: { command: "ls" },
      },
    },
    timestamp: "2026-09-26T00:00:02.100Z",
  });
  store.append({
    sessionId,
    type: "step/end",
    payload: { messageId: "a-1" },
    timestamp: "2026-09-26T00:00:02.200Z",
  });
  store.append({
    sessionId,
    type: "user/message",
    payload: {
      messageId: "u-2",
      content: [{ type: "tool-result", toolUseId: "toolu-1", content: "a.txt" }],
    },
    timestamp: "2026-09-26T00:00:03.000Z",
  });
  store.append({
    sessionId,
    type: "step/start",
    payload: { messageId: "a-2", model: "deepseek-chat" },
    timestamp: "2026-09-26T00:00:04.000Z",
  });
}

describe("图投影 — userCorrectedInput（改参可溯源）", () => {
  test("tool/corrected → 节点标已改参 + 保留改参前后", () => {
    const { store } = setup();
    const sid = "s-corr";
    seedToolRound(store, sid);

    store.append({
      sessionId: sid,
      type: "tool/corrected",
      payload: {
        messageId: "a-1",
        toolUseId: "toolu-1",
        toolName: "bash",
        originalInput: { command: "ls" },
        correctedInput: { command: "ls -la" },
        source: "graph",
      },
      timestamp: "2026-09-26T00:00:03.500Z",
    });

    const graph = projectGraph(store.replay(sid))!;
    const node = graph.nodeById.get(assistantNodeId(sid, "a-1"))!;

    expect(node.meta.userCorrectedInput).toBe(true);
    expect(node.meta.inputCorrections).toHaveLength(1);
    const correction = node.meta.inputCorrections![0]!;
    expect(correction.toolName).toBe("bash");
    expect(correction.originalInput).toEqual({ command: "ls" });
    expect(correction.correctedInput).toEqual({ command: "ls -la" });
    expect(correction.source).toBe("graph");
    expect(typeof correction.seq).toBe("number");

    // 未改参的节点不得被误标
    const other = graph.nodeById.get(assistantNodeId(sid, "a-2"))!;
    expect(other.meta.userCorrectedInput).toBeUndefined();
    expect(other.meta.inputCorrections).toBeUndefined();
  });

  test("同一节点多次改参 → 按事件序完整保留", () => {
    const { store } = setup();
    const sid = "s-corr2";
    seedToolRound(store, sid);

    for (const [i, command] of ["ls -la", "pwd"].entries()) {
      store.append({
        sessionId: sid,
        type: "tool/corrected",
        payload: {
          messageId: "a-1",
          toolUseId: `toolu-${i + 1}`,
          toolName: "bash",
          originalInput: { command: "ls" },
          correctedInput: { command },
          source: "hitl",
        },
        timestamp: `2026-09-26T00:00:0${3 + i}.500Z`,
      });
    }

    const graph = projectGraph(store.replay(sid))!;
    const node = graph.nodeById.get(assistantNodeId(sid, "a-1"))!;
    expect(node.meta.inputCorrections?.map((c) => c.correctedInput)).toEqual([
      { command: "ls -la" },
      { command: "pwd" },
    ]);
  });

  test("指向未知 messageId 的改参事实不炸投影", () => {
    const { store } = setup();
    const sid = "s-corr3";
    seedToolRound(store, sid);
    store.append({
      sessionId: sid,
      type: "tool/corrected",
      payload: {
        messageId: "a-missing",
        toolUseId: "toolu-x",
        toolName: "bash",
        originalInput: {},
        correctedInput: {},
      },
      timestamp: "2026-09-26T00:00:05.000Z",
    });

    const graph = projectGraph(store.replay(sid))!;
    expect(graph.nodes.some((n) => n.meta.userCorrectedInput === true)).toBe(false);
    expect(graph.nodes).toHaveLength(4); // u-1 / a-1 / u-2 / a-2
  });
});

describe("EventGraphStore — recordInputCorrection（图写入侧的改参事实）", () => {
  test("落 tool/corrected 事件后，图上节点标已改参且改参前后可追", () => {
    const { store } = setup();
    const sid = "s-corr-store";
    seedToolRound(store, sid);
    const graphStore = new EventGraphStore({ events: store });

    graphStore.recordInputCorrection(sid, {
      messageId: "a-1",
      toolUseId: "toolu-1",
      toolName: "bash",
      originalInput: { command: "ls" },
      correctedInput: { command: "ls -la" },
      source: "graph",
    });

    expect(store.replay(sid).some((e) => e.type === "tool/corrected")).toBe(true);
    const node = graphStore.getNode(assistantNodeId(sid, "a-1"))!;
    expect(node.meta.userCorrectedInput).toBe(true);
    expect(node.meta.inputCorrections?.[0]?.originalInput).toEqual({ command: "ls" });
    expect(node.meta.inputCorrections?.[0]?.correctedInput).toEqual({ command: "ls -la" });
  });

  test("无事件流的会话 → 不补事件（避免把遗留会话切成派生视图）", () => {
    const { store } = setup();
    const graphStore = new EventGraphStore({ events: store });

    graphStore.recordInputCorrection("s-legacy", {
      messageId: "a-1",
      toolUseId: "toolu-1",
      toolName: "bash",
      originalInput: {},
      correctedInput: {},
    });

    expect(store.replay("s-legacy")).toHaveLength(0);
  });
});

describe("图投影 — 回退粒度（步级续跑可辨识）", () => {
  test("步级回退事件 → 分支点 stepLevel=true", () => {
    const { store } = setup();
    const sid = "s-step";
    seedToolRound(store, sid);
    const target = userNodeId(sid, "u-2");
    const seq = store.append({
      sessionId: sid,
      type: "rollback",
      payload: {
        targetNodeId: target,
        reason: "步级续跑",
        supersededNodeIds: [assistantNodeId(sid, "a-2")],
        granularity: "step",
        mode: "resume",
      },
      timestamp: "2026-09-26T00:00:05.000Z",
    }).seq;

    const graph = projectGraph(store.replay(sid))!;
    const bp = graph.nodeById.get(branchPointNodeId(sid, seq))!;
    expect(bp.type).toBe("branch-point");
    expect(bp.meta.stepLevel).toBe(true);
    expect(graph.head?.id).toBe(bp.id);
  });

  test("轮级回退事件（不带 granularity）→ 分支点无 stepLevel（既有行为不变）", () => {
    const { store } = setup();
    const sid = "s-turn";
    seedToolRound(store, sid);
    const seq = store.append({
      sessionId: sid,
      type: "rollback",
      payload: {
        targetNodeId: userNodeId(sid, "u-1"),
        reason: "用户回退",
        supersededNodeIds: [],
      },
      timestamp: "2026-09-26T00:00:05.000Z",
    }).seq;

    const graph = projectGraph(store.replay(sid))!;
    const bp = graph.nodeById.get(branchPointNodeId(sid, seq))!;
    expect(bp.meta.stepLevel).toBeUndefined();
  });
});
