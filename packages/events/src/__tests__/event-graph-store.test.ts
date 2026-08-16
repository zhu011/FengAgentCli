/**
 * @fengagent/events — EventGraphStore 测试（Phase 2 事件溯源图存储）
 *
 * 覆盖：
 * 1. 用户/助手节点由消息事件派生（确定性 id，幂等 appendNode）；
 * 2. markQuality → node/quality 事件（同 quality 幂等不重复落）；
 * 3. rollbackTo → rollback 事件落盘 + 分支点/head/active·rolledBack 由投影派生；
 * 4. fork → fork 事件落盘 + 分支点；
 * 5. flush → graph.jsonl 派生视图（重放可重建同一张图）；遗留节点兼容读取；
 * 6. 无事件会话回退 → undefined（进入事件溯源后才可回退）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../event-store.ts";
import { EventGraphStore } from "../event-graph-store.ts";
import {
  assistantNodeId,
  branchPointNodeId,
  userNodeId,
} from "../node-ids.ts";
import { verifyEventChain } from "../reconcile.ts";
import type { ConversationNode } from "@fengagent/graph";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "egs-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const events = new EventStore({ dir: join(dir, "events") });
  const graph = new EventGraphStore({
    events,
    persistPath: join(dir, "graph.jsonl"),
  });
  return { dir, events, graph };
}

/** 一轮对话事件：session/created（首轮）+ user/message + step/start + chunk + step/end */
function runTurn(
  events: EventStore,
  sessionId: string,
  userText: string,
  assistantText: string,
  turnIndex: number,
) {
  const userMsgId = `u-${turnIndex}`;
  const asstMsgId = `a-${turnIndex}`;
  if (turnIndex === 1) {
    events.append({
      sessionId,
      type: "session/created",
      payload: { title: "会话", status: "created" },
      timestamp: `2026-08-16T00:00:0${turnIndex}.000Z`,
    });
  }
  events.append({
    sessionId,
    type: "user/message",
    payload: { messageId: userMsgId, content: [{ type: "text", text: userText }] },
    timestamp: `2026-08-16T00:00:0${turnIndex}.100Z`,
  });
  events.append({
    sessionId,
    type: "step/start",
    payload: { messageId: asstMsgId, model: "deepseek-chat" },
    timestamp: `2026-08-16T00:00:0${turnIndex}.200Z`,
  });
  events.append({
    sessionId,
    type: "assistant/chunk",
    payload: { messageId: asstMsgId, index: 0, delta: { type: "text", text: assistantText } },
    timestamp: `2026-08-16T00:00:0${turnIndex}.300Z`,
  });
  events.append({
    sessionId,
    type: "step/end",
    payload: { messageId: asstMsgId },
    timestamp: `2026-08-16T00:00:0${turnIndex}.400Z`,
  });
}

describe("EventGraphStore — 事件溯源图存储", () => {
  test("节点由消息事件派生：确定性 id，appendNode 幂等", () => {
    const { events, graph } = setup();
    const sid = "s1";
    runTurn(events, sid, "你好", "你好！", 1);

    // 事件 → 派生节点
    const nodes = graph.listNodes(sid);
    expect(nodes.map((n) => n.type)).toEqual(["user", "assistant"]);
    expect(nodes[0]!.id).toBe(userNodeId(sid, "u-1"));
    expect(nodes[1]!.id).toBe(assistantNodeId(sid, "a-1"));

    // appendNode 幂等：重复调用返回同一派生节点（不重复落事件）
    const again = graph.appendNode({
      id: "whatever-ignored",
      conversationId: sid,
      type: "assistant",
      messageId: "a-1",
      parentId: null,
      createdAt: Date.now(),
      meta: { active: true },
    });
    expect(again.id).toBe(assistantNodeId(sid, "a-1"));
    expect(events.replay(sid).length).toBe(5); // 未新增事件

    // head / 活跃路径
    expect(graph.getActiveHead(sid)?.id).toBe(assistantNodeId(sid, "a-1"));
    expect(graph.getActivePath(sid).map((n) => n.id)).toEqual([
      userNodeId(sid, "u-1"),
      assistantNodeId(sid, "a-1"),
    ]);
    // 溯源链
    expect(graph.getChain(assistantNodeId(sid, "a-1")).map((n) => n.id)).toEqual([
      userNodeId(sid, "u-1"),
      assistantNodeId(sid, "a-1"),
    ]);
  });

  test("markQuality → node/quality 事件；同 quality 幂等", () => {
    const { events, graph } = setup();
    const sid = "s1";
    runTurn(events, sid, "Q", "A", 1);

    graph.markQuality(assistantNodeId(sid, "a-1"), "poor", "用户反馈");
    const n = graph.getNode(assistantNodeId(sid, "a-1"))!;
    expect(n.meta.quality).toBe("poor");
    expect(n.meta.qualityNote).toBe("用户反馈");
    const evCount = events.replay(sid).length;

    // 同 quality + 同 note → 不重复落事件
    graph.markQuality(assistantNodeId(sid, "a-1"), "poor", "用户反馈");
    expect(events.replay(sid).length).toBe(evCount);

    // 不同 quality → 再落一条
    graph.markQuality(assistantNodeId(sid, "a-1"), "good");
    expect(events.replay(sid).length).toBe(evCount + 1);
    expect(graph.getNode(assistantNodeId(sid, "a-1"))!.meta.quality).toBe("good");
  });

  test("rollbackTo → rollback 事件 + 派生分支点/head/active·rolledBack", () => {
    const { events, graph } = setup();
    const sid = "s1";
    runTurn(events, sid, "Q1", "A1", 1);
    runTurn(events, sid, "Q2", "A2", 2);

    const u2 = userNodeId(sid, "u-2");
    const result = graph.rollbackTo(u2, "回答不佳");
    expect(result).toBeDefined();
    expect(result!.target.id).toBe(u2);
    expect(result!.superseded).toEqual([assistantNodeId(sid, "a-2")]);
    expect(result!.branchPoint.type).toBe("branch-point");
    expect(result!.branchPoint.parentId).toBe(u2);

    // rollback 事件已落盘
    const evs = events.replay(sid);
    const rb = evs.find((e) => e.type === "rollback");
    expect(rb).toBeDefined();
    expect(rb!.payload).toMatchObject({
      targetNodeId: u2,
      reason: "回答不佳",
      supersededNodeIds: [assistantNodeId(sid, "a-2")],
    });

    // 派生状态
    expect(graph.getActiveHead(sid)?.type).toBe("branch-point");
    expect(graph.getActiveHead(sid)?.id).toBe(branchPointNodeId(sid, rb!.seq));
    expect(graph.getNode(assistantNodeId(sid, "a-2"))!.meta.rolledBack).toBe(true);
    // 事件链完整
    expect(verifyEventChain(evs)).toEqual([]);

    // 目标不在活跃路径上 → undefined（不落事件）
    const evCount = events.replay(sid).length;
    expect(graph.rollbackTo(assistantNodeId(sid, "a-2"))).toBeUndefined();
    expect(events.replay(sid).length).toBe(evCount);
  });

  test("fork → fork 事件 + 分支点；rollbackTo 无事件会话 → undefined", () => {
    const { events, graph } = setup();
    const sid = "s1";
    runTurn(events, sid, "Q1", "A1", 1);
    runTurn(events, sid, "Q2", "A2", 2);

    const result = graph.fork(userNodeId(sid, "u-1"), "explore");
    expect(result).toBeDefined();
    const evs = events.replay(sid);
    const fork = evs.find((e) => e.type === "fork");
    expect(fork).toBeDefined();
    expect(fork!.payload).toMatchObject({
      parentNodeId: userNodeId(sid, "u-1"),
      branch: "explore",
    });
    expect(graph.getActiveHead(sid)?.id).toBe(branchPointNodeId(sid, fork!.seq));
    expect(graph.getActivePath(sid).map((n) => n.id)).toEqual([
      userNodeId(sid, "u-1"),
      branchPointNodeId(sid, fork!.seq),
    ]);
    expect(graph.getNode(assistantNodeId(sid, "a-1"))!.meta.rolledBack).toBe(true);

    // 无事件会话 → 回退/分叉返回 undefined
    const ghost = new EventGraphStore({ events });
    expect(ghost.rollbackTo("nope")).toBeUndefined();
    expect(ghost.fork("nope")).toBeUndefined();
  });

  test("flush → graph.jsonl 派生视图；新实例重放事件重建同一张图", async () => {
    const { dir, events, graph } = setup();
    const sid = "s1";
    runTurn(events, sid, "Q1", "A1", 1);
    runTurn(events, sid, "Q2", "A2", 2);
    graph.rollbackTo(userNodeId(sid, "u-2"), "不佳");

    const path = join(dir, "graph.jsonl");
    await graph.flush();
    expect(existsSync(path)).toBe(true);

    // 派生视图：包含确定性 id 节点 + 分支点 + rolledBack 标记
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ConversationNode);
    const ids = lines.map((n) => n.id);
    expect(ids).toContain(userNodeId(sid, "u-2"));
    expect(ids).toContain(assistantNodeId(sid, "a-2"));
    const bp = lines.find((n) => n.type === "branch-point")!;
    expect(bp).toBeDefined();
    const a2 = lines.find((n) => n.id === assistantNodeId(sid, "a-2"))!;
    expect(a2.meta.rolledBack).toBe(true);

    // 新实例（同一事件日志）重建同一张图 — 派生视图可再生成
    const restored = new EventGraphStore({ events, persistPath: path });
    expect(restored.listNodes(sid).map((n) => n.id)).toEqual(
      graph.listNodes(sid).map((n) => n.id),
    );
    expect(restored.getActiveHead(sid)?.id).toBe(graph.getActiveHead(sid)?.id);
  });

  test("遗留 graph.jsonl（无事件会话）：读 legacy 节点；有事件后派生视图接管", async () => {
    const { dir, events } = setup();
    const path = join(dir, "graph.jsonl");
    // 遗留数据：两个 gnode- 节点（模拟 main 导入）
    const legacyNodes: ConversationNode[] = [
      {
        id: "gnode-legacy-1",
        conversationId: "legacy-conv",
        type: "user",
        messageId: "lm-1",
        parentId: null,
        childrenIds: ["gnode-legacy-2"],
        createdAt: 1,
        meta: { active: true },
      },
      {
        id: "gnode-legacy-2",
        conversationId: "legacy-conv",
        type: "assistant",
        messageId: "lm-2",
        parentId: "gnode-legacy-1",
        childrenIds: [],
        createdAt: 2,
        meta: { active: true },
      },
    ];
    writeFileSync(path, legacyNodes.map((n) => JSON.stringify(n)).join("\n") + "\n");

    const graph = new EventGraphStore({ events, persistPath: path });
    // 无事件会话 → legacy 节点可用
    expect(graph.listNodes("legacy-conv")).toHaveLength(2);
    expect(graph.getNode("gnode-legacy-2")?.type).toBe("assistant");
    expect(graph.getActiveHead("legacy-conv")?.id).toBe("gnode-legacy-2");

    // 该会话产生事件后 → 派生视图接管（legacy 节点不再返回）
    runTurn(events, "legacy-conv", "新问", "新答", 1);
    expect(graph.listNodes("legacy-conv").some((n) => n.id.startsWith("gnode-"))).toBe(false);
    expect(graph.getActiveHead("legacy-conv")?.id).toBe(assistantNodeId("legacy-conv", "a-1"));

    // flush 后派生视图整写：legacy 节点被派生节点替换
    await graph.flush();
    const content = readFileSync(path, "utf8");
    expect(content).toContain(assistantNodeId("legacy-conv", "a-1"));
    expect(content).not.toContain("gnode-legacy-1");
  });
});
