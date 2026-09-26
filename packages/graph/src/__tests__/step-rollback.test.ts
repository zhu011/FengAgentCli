/**
 * @fengagent/graph — 步级续跑策略测试（AGE-29 图三件套 ②）
 *
 * 覆盖：
 * 1. 轮级语义逐字不变（DefaultRollbackStrategy 与 StepAwareRollbackStrategy 对
 *    granularity:"turn" 给出同一结果）——步级是纯加法，不动既有回退边界；
 * 2. 步级续跑：点助手步骤节点 → 回退点落在该步产出的工具结果上（resume，
 *    工具不重复执行）；
 * 3. 步级续跑：点工具结果节点 → 回退到它本身（resume）；
 * 4. 步级重放：点无工具结果的回答步 → 回退到其前一条消息（replay，重答该步）；
 * 5. 步级解析不出（点真实提问）→ 回落轮级语义，而不是报错或截错位置；
 * 6. 基础策略（未升级）显式请求步级 → 仍给轮级结果（可插拔边界清晰）。
 */

import { describe, test, expect } from "bun:test";
import type { ConversationNode } from "../types.ts";
import {
  DefaultRollbackStrategy,
  StepAwareRollbackStrategy,
} from "../rollback.ts";
import type { RollbackTargetRequest } from "../rollback.ts";

/** 一轮问答的图骨架：q → a1(工具步) → t1(工具结果) → a2(最终回答) */
function buildRound(): {
  nodes: Map<string, ConversationNode>;
  getNode: (id: string) => ConversationNode | undefined;
} {
  const make = (
    id: string,
    type: ConversationNode["type"],
    messageId: string,
    parentId: string | null,
  ): ConversationNode => ({
    id,
    conversationId: "s1",
    type,
    messageId,
    parentId,
    childrenIds: [],
    createdAt: 0,
    meta: { active: true },
  });

  const q = make("q", "user", "m-q", null);
  const a1 = make("a1", "assistant", "m-a1", "q");
  const t1 = make("t1", "user", "m-t1", "a1");
  const a2 = make("a2", "assistant", "m-a2", "t1");
  q.childrenIds = ["a1"];
  a1.childrenIds = ["t1"];
  t1.childrenIds = ["a2"];

  const nodes = new Map([q, a1, t1, a2].map((n) => [n.id, n]));
  return { nodes, getNode: (id) => nodes.get(id) };
}

function request(
  nodeId: string,
  granularity: "turn" | "step",
  mode?: "replay" | "resume",
): RollbackTargetRequest {
  const { getNode } = buildRound();
  const node = getNode(nodeId)!;
  return {
    node,
    granularity,
    ...(mode ? { mode } : {}),
    getNode,
    // 真实提问 = 带文本的 user 节点；工具结果 user 节点不含文本
    isQuestion: (n) => n.type === "user" && !n.id.startsWith("t"),
    isToolResult: (n) => n.type === "user" && n.id.startsWith("t"),
  };
}

describe("回退策略 — 轮级语义不变（无回归）", () => {
  test("DefaultRollbackStrategy 与 StepAwareRollbackStrategy 对 turn 给出同一结果", () => {
    const base = new DefaultRollbackStrategy();
    const stepAware = new StepAwareRollbackStrategy();
    for (const nodeId of ["q", "a1", "t1", "a2"]) {
      const req = request(nodeId, "turn");
      const a = base.chooseRollbackTarget!(req);
      const b = stepAware.chooseRollbackTarget!(req);
      expect(b).toEqual(a);
      // 轮级一律解析到该轮的真实提问处（既有边界）
      expect(a).toEqual({
        targetId: "q",
        truncateToMessageId: "m-q",
        mode: "replay",
        granularity: "turn",
      });
    }
  });

  test("未升级的基础策略显式请求步级 → 回落轮级（策略可插拔边界清晰）", () => {
    const base = new DefaultRollbackStrategy();
    const choice = base.chooseRollbackTarget!(request("a1", "step"));
    expect(choice?.granularity).toBe("turn");
    expect(choice?.targetId).toBe("q");
  });
});

describe("步级续跑 — 回退点精确到一轮之内的一步", () => {
  const strategy = new StepAwareRollbackStrategy();

  test("点助手工具步 → 续跑到该步的工具结果（resume：工具不重复执行）", () => {
    const choice = strategy.chooseRollbackTarget!(request("a1", "step"));
    expect(choice).toEqual({
      targetId: "t1",
      truncateToMessageId: "m-t1",
      mode: "resume",
      granularity: "step",
    });
  });

  test("点工具结果节点 → 回退到它本身（resume）", () => {
    const choice = strategy.chooseRollbackTarget!(request("t1", "step"));
    expect(choice).toEqual({
      targetId: "t1",
      truncateToMessageId: "m-t1",
      mode: "resume",
      granularity: "step",
    });
  });

  test("点无工具结果的回答步 → 重放该步（截断到前一条消息）", () => {
    const choice = strategy.chooseRollbackTarget!(request("a2", "step"));
    expect(choice).toEqual({
      targetId: "t1",
      truncateToMessageId: "m-t1",
      mode: "replay",
      granularity: "step",
    });
  });

  test("点真实提问（步级无法解析）→ 回落轮级语义而非报错", () => {
    const choice = strategy.chooseRollbackTarget!(request("q", "step"));
    expect(choice?.granularity).toBe("turn");
    expect(choice?.targetId).toBe("q");
  });

  test("步级与轮级的截断点确实不同（步级不会整轮重跑）", () => {
    const stepChoice = strategy.chooseRollbackTarget!(request("a1", "step"));
    const turnChoice = strategy.chooseRollbackTarget!(request("a1", "turn"));
    expect(stepChoice!.truncateToMessageId).toBe("m-t1");
    expect(turnChoice!.truncateToMessageId).toBe("m-q");
    expect(stepChoice!.truncateToMessageId).not.toBe(turnChoice!.truncateToMessageId);
  });
});

describe("步级重放 — 图上改参重放（mode=replay）", () => {
  const strategy = new StepAwareRollbackStrategy();

  test("点工具步 + mode=replay → 截断到该步之前（工具才会以新入参重新执行）", () => {
    const choice = strategy.chooseRollbackTarget!(request("a1", "step", "replay"));
    expect(choice).toEqual({
      targetId: "q",
      truncateToMessageId: "m-q",
      mode: "replay",
      granularity: "step",
    });
  });

  test("多步轮次：改第二步的参 → 只回退到第一步的工具结果（第一步工具不重跑）", () => {
    // q → a1（工具步1）→ t1（结果1）→ a2（工具步2）→ t2（结果2）→ a3
    const { getNode } = buildRound();
    const a2: ConversationNode = {
      id: "a2b",
      conversationId: "s1",
      type: "assistant",
      messageId: "m-a2b",
      parentId: "t1",
      childrenIds: ["t2"],
      createdAt: 0,
      meta: { active: true },
    };
    const t2: ConversationNode = {
      id: "t2",
      conversationId: "s1",
      type: "user",
      messageId: "m-t2",
      parentId: "a2b",
      childrenIds: [],
      createdAt: 0,
      meta: { active: true },
    };
    const nodes = new Map([a2, t2].map((n) => [n.id, n]));
    const lookup = (id: string) => getNode(id) ?? nodes.get(id);

    const choice = strategy.chooseRollbackTarget!({
      node: a2,
      granularity: "step",
      mode: "replay",
      getNode: lookup,
      isQuestion: (n) => n.type === "user" && !n.id.startsWith("t"),
      isToolResult: (n) => n.type === "user" && n.id.startsWith("t"),
    });

    // 回退到第一步的工具结果（保留其上下文），第二步整体重放
    expect(choice).toEqual({
      targetId: "t1",
      truncateToMessageId: "m-t1",
      mode: "replay",
      granularity: "step",
    });
  });

  test("mode=replay 落在工具结果/提问节点上 → 无重放语义，回落轮级", () => {
    expect(
      strategy.chooseRollbackTarget!(request("t1", "step", "replay"))?.granularity,
    ).toBe("turn");
  });
});
