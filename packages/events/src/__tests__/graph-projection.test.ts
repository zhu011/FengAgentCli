/**
 * @fengagent/events — Phase 2 投影测试（分支感知消息投影 + graph 投影 #4/#6）
 *
 * 覆盖：
 * 1. rollback 事件 → 消息历史截断到回退点，后续事件从截断点继续追加；
 * 2. fork 事件 → 消息历史截断到分叉点（语义同回退，不动质量）；
 * 3. 回退到分支点（再次回退）→ 沿分支点 messageId 截断；
 * 4. graph 投影：#4 head 确定式推导（无可变指针）、#6 active/rolledBack 派生态重算、
 *    确定性节点 id（重放一致）、branch-point、node/quality 事实；
 * 5. 重放一致性：同一事件序列多次投影得到同一张图（graph.jsonl 派生视图可重建）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../event-store.ts";
import { projectSession } from "../projection.ts";
import { projectGraph } from "../graph-projection.ts";
import {
  assistantNodeId,
  branchPointNodeId,
  userNodeId,
} from "../node-ids.ts";
import { verifyEventChain } from "../reconcile.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "proj2-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EventStore({ dir: join(dir, "events") });
  return { store };
}

interface Turn {
  userText: string;
  assistantText: string;
  tokenCount?: number;
}

/** 一轮对话事件：session/created（首轮）+ user/message + step/start + chunk + step/end */
function runTurn(
  store: EventStore,
  sessionId: string,
  turn: Turn,
  turnIndex: number,
) {
  const userMsgId = `u-${turnIndex}`;
  const asstMsgId = `a-${turnIndex}`;
  if (turnIndex === 1) {
    store.append({
      sessionId,
      type: "session/created",
      payload: { title: "分支会话", status: "created" },
      timestamp: `2026-08-16T00:00:0${turnIndex}.000Z`,
    });
  }
  store.append({
    sessionId,
    type: "user/message",
    payload: { messageId: userMsgId, content: [{ type: "text", text: turn.userText }] },
    timestamp: `2026-08-16T00:00:0${turnIndex}.100Z`,
  });
  store.append({
    sessionId,
    type: "step/start",
    payload: { messageId: asstMsgId, model: "deepseek-chat" },
    timestamp: `2026-08-16T00:00:0${turnIndex}.200Z`,
  });
  store.append({
    sessionId,
    type: "assistant/chunk",
    payload: { messageId: asstMsgId, index: 0, delta: { type: "text", text: turn.assistantText } },
    timestamp: `2026-08-16T00:00:0${turnIndex}.300Z`,
  });
  store.append({
    sessionId,
    type: "step/end",
    payload: { messageId: asstMsgId, tokenCount: turn.tokenCount },
    timestamp: `2026-08-16T00:00:0${turnIndex}.400Z`,
  });
}

describe("分支感知消息投影（rollback/fork 截断语义）", () => {
  test("rollback 后消息历史截断到回退点，事件不可变保留", () => {
    const { store } = setup();
    const sid = "s-rb";
    runTurn(store, sid, { userText: "第一问", assistantText: "第一答", tokenCount: 10 }, 1);
    runTurn(store, sid, { userText: "第二问", assistantText: "第二答", tokenCount: 30 }, 2);

    // 回退到第二问（user 节点）— 第二答被截断
    store.append({
      sessionId: sid,
      type: "rollback",
      payload: {
        targetNodeId: userNodeId(sid, "u-2"),
        reason: "回答不好",
        supersededNodeIds: [assistantNodeId(sid, "a-2")],
      },
      timestamp: "2026-08-16T00:00:03.000Z",
    });

    const proj = projectSession(store.replay(sid))!;
    expect(proj.messages.map((m) => m.id)).toEqual(["u-1", "a-1", "u-2"]);

    // 回退后继续对话（新一轮用户提问）— 从截断点追加
    store.append({
      sessionId: sid,
      type: "user/message",
      payload: { messageId: "u-3", content: [{ type: "text", text: "重答一次" }] },
      timestamp: "2026-08-16T00:00:03.500Z",
    });
    store.append({
      sessionId: sid,
      type: "step/start",
      payload: { messageId: "a-3", model: "deepseek-chat" },
      timestamp: "2026-08-16T00:00:03.600Z",
    });
    store.append({
      sessionId: sid,
      type: "assistant/chunk",
      payload: { messageId: "a-3", index: 0, delta: { type: "text", text: "重答内容" } },
      timestamp: "2026-08-16T00:00:03.700Z",
    });
    store.append({
      sessionId: sid,
      type: "step/end",
      payload: { messageId: "a-3", tokenCount: 40 },
      timestamp: "2026-08-16T00:00:03.800Z",
    });

    const proj2 = projectSession(store.replay(sid))!;
    expect(proj2.messages.map((m) => m.id)).toEqual(["u-1", "a-1", "u-2", "u-3", "a-3"]);
    expect(proj2.messages[4]!.content).toEqual([{ type: "text", text: "重答内容" }]);
    expect(proj2.tokenCount).toBe(40);

    // 事件日志不可变：全部事件仍在，hash 链完整
    expect(store.replay(sid).length).toBeGreaterThan(8);
    expect(verifyEventChain(store.replay(sid))).toEqual([]);
  });

  test("fork 后消息历史截断到分叉点（语义同回退，不动质量）", () => {
    const { store } = setup();
    const sid = "s-fork";
    runTurn(store, sid, { userText: "Q1", assistantText: "A1" }, 1);
    runTurn(store, sid, { userText: "Q2", assistantText: "A2" }, 2);

    store.append({
      sessionId: sid,
      type: "fork",
      payload: { parentNodeId: userNodeId(sid, "u-1"), branch: "explore" },
      timestamp: "2026-08-16T00:00:03.000Z",
    });

    const proj = projectSession(store.replay(sid))!;
    expect(proj.messages.map((m) => m.id)).toEqual(["u-1"]);

    // 分叉后追加
    store.append({
      sessionId: sid,
      type: "user/message",
      payload: { messageId: "u-4", content: [{ type: "text", text: "分叉提问" }] },
      timestamp: "2026-08-16T00:00:04.000Z",
    });
    store.append({
      sessionId: sid,
      type: "step/start",
      payload: { messageId: "a-4", model: "deepseek-chat" },
      timestamp: "2026-08-16T00:00:04.100Z",
    });
    store.append({
      sessionId: sid,
      type: "assistant/chunk",
      payload: { messageId: "a-4", index: 0, delta: { type: "text", text: "分叉回答" } },
      timestamp: "2026-08-16T00:00:04.200Z",
    });
    store.append({
      sessionId: sid,
      type: "step/end",
      payload: { messageId: "a-4" },
      timestamp: "2026-08-16T00:00:04.300Z",
    });

    const proj2 = projectSession(store.replay(sid))!;
    expect(proj2.messages.map((m) => m.id)).toEqual(["u-1", "u-4", "a-4"]);
  });

  test("回退到分支点（再次回退）：沿分支点 messageId 截断", () => {
    const { store } = setup();
    const sid = "s-rb-bp";
    runTurn(store, sid, { userText: "Q1", assistantText: "A1" }, 1);
    runTurn(store, sid, { userText: "Q2", assistantText: "A2" }, 2);

    // 第一次回退到 u-2 → 分支点 b(seq=rollback 事件 seq)
    const rb1 = store.append({
      sessionId: sid,
      type: "rollback",
      payload: {
        targetNodeId: userNodeId(sid, "u-2"),
        reason: "第一次回退",
        supersededNodeIds: [assistantNodeId(sid, "a-2")],
      },
      timestamp: "2026-08-16T00:00:03.000Z",
    });
    // 重答
    store.append({
      sessionId: sid,
      type: "user/message",
      payload: { messageId: "u-5", content: [{ type: "text", text: "重答问" }] },
      timestamp: "2026-08-16T00:00:04.000Z",
    });
    store.append({
      sessionId: sid,
      type: "step/start",
      payload: { messageId: "a-5", model: "deepseek-chat" },
      timestamp: "2026-08-16T00:00:04.100Z",
    });
    store.append({
      sessionId: sid,
      type: "assistant/chunk",
      payload: { messageId: "a-5", index: 0, delta: { type: "text", text: "重答" } },
      timestamp: "2026-08-16T00:00:04.200Z",
    });
    store.append({
      sessionId: sid,
      type: "step/end",
      payload: { messageId: "a-5" },
      timestamp: "2026-08-16T00:00:04.300Z",
    });

    const proj1 = projectSession(store.replay(sid))!;
    expect(proj1.messages.map((m) => m.id)).toEqual(["u-1", "a-1", "u-2", "u-5", "a-5"]);

    // 第二次回退到分支点（第一次 rollback 事件的分支点）— 截断到 u-2
    const bpId = branchPointNodeId(sid, rb1.seq);
    store.append({
      sessionId: sid,
      type: "rollback",
      payload: {
        targetNodeId: bpId,
        reason: "再次回退",
        supersededNodeIds: [userNodeId(sid, "u-5"), assistantNodeId(sid, "a-5")],
      },
      timestamp: "2026-08-16T00:00:05.000Z",
    });

    const proj2 = projectSession(store.replay(sid))!;
    expect(proj2.messages.map((m) => m.id)).toEqual(["u-1", "a-1", "u-2"]);
  });
});

describe("graph 投影（#4 head 确定式推导 / #6 派生态重算 / 确定性 id）", () => {
  test("线性会话：节点链 + head = 最后助手节点 + 全部 active", () => {
    const { store } = setup();
    const sid = "g-linear";
    runTurn(store, sid, { userText: "Q1", assistantText: "A1" }, 1);
    runTurn(store, sid, { userText: "Q2", assistantText: "A2" }, 2);

    const g = projectGraph(store.replay(sid))!;
    expect(g.conversationId).toBe(sid);
    const types = g.nodes.map((n) => n.type);
    expect(types).toEqual(["user", "assistant", "user", "assistant"]);

    // 确定性 id
    expect(g.nodes[0]!.id).toBe(userNodeId(sid, "u-1"));
    expect(g.nodes[1]!.id).toBe(assistantNodeId(sid, "a-1"));
    expect(g.nodes[3]!.id).toBe(assistantNodeId(sid, "a-2"));

    // #4：head = 最后助手节点；#6：全部 active
    expect(g.head?.id).toBe(assistantNodeId(sid, "a-2"));
    expect(g.activePath.map((n) => n.id)).toEqual([
      userNodeId(sid, "u-1"),
      assistantNodeId(sid, "a-1"),
      userNodeId(sid, "u-2"),
      assistantNodeId(sid, "a-2"),
    ]);
    for (const n of g.nodes) {
      expect(n.meta.active).toBe(true);
      expect(n.meta.rolledBack).toBeUndefined();
    }
  });

  test("rollback：旧分支 rolledBack 保留，branch-point 成新 head，活跃路径重算", () => {
    const { store } = setup();
    const sid = "g-rb";
    runTurn(store, sid, { userText: "Q1", assistantText: "A1" }, 1);
    runTurn(store, sid, { userText: "Q2", assistantText: "A2" }, 2);
    const rbEv = store.append({
      sessionId: sid,
      type: "rollback",
      payload: {
        targetNodeId: userNodeId(sid, "u-2"),
        reason: "回答不佳",
        supersededNodeIds: [assistantNodeId(sid, "a-2")],
      },
      timestamp: "2026-08-16T00:00:03.000Z",
    });

    const g = projectGraph(store.replay(sid))!;
    // 分支点（rollback 事件派生）
    const bp = g.nodeById.get(branchPointNodeId(sid, rbEv.seq))!;
    expect(bp.type).toBe("branch-point");
    expect(bp.parentId).toBe(userNodeId(sid, "u-2"));
    expect(bp.messageId).toBe("u-2");
    expect(bp.meta.branch).toBe(`rollback-${rbEv.seq}`);

    // #4：head = 分支点（最新 rollback 声明分支的链尾）
    expect(g.head?.id).toBe(bp.id);

    // #6：作废节点派生 rolledBack/active=false，链上节点 active
    const a2 = g.nodeById.get(assistantNodeId(sid, "a-2"))!;
    expect(a2.meta.rolledBack).toBe(true);
    expect(a2.meta.active).toBe(false);
    const u1 = g.nodeById.get(userNodeId(sid, "u-1"))!;
    expect(u1.meta.active).toBe(true);
    expect(u1.meta.rolledBack).toBeUndefined();

    // 活跃路径 = u1 → a1 → u2 → bp
    expect(g.activePath.map((n) => n.id)).toEqual([
      userNodeId(sid, "u-1"),
      assistantNodeId(sid, "a-1"),
      userNodeId(sid, "u-2"),
      bp.id,
    ]);
  });

  test("rollback 后新回答挂在分支点下（可溯源分支）", () => {
    const { store } = setup();
    const sid = "g-rb-new";
    runTurn(store, sid, { userText: "Q1", assistantText: "A1" }, 1);
    runTurn(store, sid, { userText: "Q2", assistantText: "A2" }, 2);
    const rbEv = store.append({
      sessionId: sid,
      type: "rollback",
      payload: {
        targetNodeId: userNodeId(sid, "u-2"),
        reason: "不佳",
        supersededNodeIds: [assistantNodeId(sid, "a-2")],
      },
      timestamp: "2026-08-16T00:00:03.000Z",
    });
    // 重答：u-5 / a-5
    store.append({
      sessionId: sid,
      type: "user/message",
      payload: { messageId: "u-5", content: [{ type: "text", text: "重问" }] },
      timestamp: "2026-08-16T00:00:04.000Z",
    });
    store.append({
      sessionId: sid,
      type: "step/start",
      payload: { messageId: "a-5", model: "deepseek-chat" },
      timestamp: "2026-08-16T00:00:04.100Z",
    });
    store.append({
      sessionId: sid,
      type: "assistant/chunk",
      payload: { messageId: "a-5", index: 0, delta: { type: "text", text: "重答" } },
      timestamp: "2026-08-16T00:00:04.200Z",
    });
    store.append({
      sessionId: sid,
      type: "step/end",
      payload: { messageId: "a-5" },
      timestamp: "2026-08-16T00:00:04.300Z",
    });

    const g = projectGraph(store.replay(sid))!;
    const bp = g.nodeById.get(branchPointNodeId(sid, rbEv.seq))!;
    const u5 = g.nodeById.get(userNodeId(sid, "u-5"))!;
    const a5 = g.nodeById.get(assistantNodeId(sid, "a-5"))!;
    // 回退后新用户消息挂在分支点下；新回答挂在用户消息下（可溯源分支）
    expect(u5.parentId).toBe(bp.id);
    expect(a5.parentId).toBe(u5.id);
    expect(bp.childrenIds).toContain(u5.id);
    // 旧 a2 仍保留且 rolledBack
    expect(g.nodeById.get(assistantNodeId(sid, "a-2"))!.meta.rolledBack).toBe(true);
    // 活跃路径：u1 → a1 → u2 → bp → u5 → a5
    expect(g.activePath.map((n) => n.id)).toEqual([
      userNodeId(sid, "u-1"),
      assistantNodeId(sid, "a-1"),
      userNodeId(sid, "u-2"),
      bp.id,
      userNodeId(sid, "u-5"),
      assistantNodeId(sid, "a-5"),
    ]);
  });

  test("fork：branch-point 带分支标签，旧分支作废（不动质量）", () => {
    const { store } = setup();
    const sid = "g-fork";
    runTurn(store, sid, { userText: "Q1", assistantText: "A1" }, 1);
    runTurn(store, sid, { userText: "Q2", assistantText: "A2" }, 2);
    const forkEv = store.append({
      sessionId: sid,
      type: "fork",
      payload: { parentNodeId: userNodeId(sid, "u-1"), branch: "explore-x" },
      timestamp: "2026-08-16T00:00:03.000Z",
    });

    const g = projectGraph(store.replay(sid))!;
    const bp = g.nodeById.get(branchPointNodeId(sid, forkEv.seq))!;
    expect(bp.type).toBe("branch-point");
    expect(bp.parentId).toBe(userNodeId(sid, "u-1"));
    expect(bp.meta.branch).toBe("explore-x");
    expect(g.head?.id).toBe(bp.id);
    // 旧分支 a1/u2/a2 全部作废
    expect(g.nodeById.get(assistantNodeId(sid, "a-1"))!.meta.rolledBack).toBe(true);
    expect(g.nodeById.get(assistantNodeId(sid, "a-2"))!.meta.rolledBack).toBe(true);
    expect(g.activePath.map((n) => n.id)).toEqual([userNodeId(sid, "u-1"), bp.id]);
  });

  test("node/quality 为事实事件：质量落在节点上，不受派生态重算影响", () => {
    const { store } = setup();
    const sid = "g-quality";
    runTurn(store, sid, { userText: "Q1", assistantText: "A1" }, 1);
    store.append({
      sessionId: sid,
      type: "node/quality",
      payload: { nodeId: assistantNodeId(sid, "a-1"), quality: "poor", note: "用户反馈" },
      timestamp: "2026-08-16T00:00:02.000Z",
    });

    const g = projectGraph(store.replay(sid))!;
    const a1 = g.nodeById.get(assistantNodeId(sid, "a-1"))!;
    expect(a1.meta.quality).toBe("poor");
    expect(a1.meta.qualityNote).toBe("用户反馈");
    // active 仍由链推导（#6）
    expect(a1.meta.active).toBe(true);
  });

  test("重放一致性：同一事件序列多次投影得到同一张图（派生视图可重建）", () => {
    const { store } = setup();
    const sid = "g-replay";
    runTurn(store, sid, { userText: "Q1", assistantText: "A1" }, 1);
    runTurn(store, sid, { userText: "Q2", assistantText: "A2" }, 2);
    store.append({
      sessionId: sid,
      type: "rollback",
      payload: {
        targetNodeId: userNodeId(sid, "u-2"),
        reason: "不佳",
        supersededNodeIds: [assistantNodeId(sid, "a-2")],
      },
      timestamp: "2026-08-16T00:00:03.000Z",
    });

    const evs = store.replay(sid);
    const g1 = projectGraph(evs)!;
    const g2 = projectGraph(evs)!;
    expect(g1.nodes.map((n) => n.id)).toEqual(g2.nodes.map((n) => n.id));
    expect(g1.head?.id).toBe(g2.head?.id);
    const norm = (g: typeof g1) =>
      g.nodes.map((n) => ({
        id: n.id,
        parentId: n.parentId,
        active: n.meta.active,
        rolledBack: n.meta.rolledBack === true,
      }));
    expect(norm(g1)).toEqual(norm(g2));
  });
});
