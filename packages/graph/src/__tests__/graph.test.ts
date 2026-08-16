/**
 * @fengagent/graph — Graph 机制测试
 *
 * 验证：
 * 1. 对话可溯源：getChain / getActivePath 能还原完整链路；
 * 2. 对话即节点：appendNode 自动维护父子关系；
 * 3. 节点回答不佳可回退：rollbackTo 长出分支、旧分支作废但保留；
 * 4. 回退策略：DefaultRollbackStrategy 判定。
 */

import { describe, expect, test } from "bun:test";
import {
  DefaultRollbackStrategy,
  MemoryGraphStore,
  qualityToSignal,
} from "../index.ts";

function buildConversation(store: MemoryGraphStore, conversationId: string) {
  const user1 = store.createRootNode(conversationId, "msg-1", "user", {
    branch: "main",
  });
  const asst1 = store.createNode(conversationId, "msg-2", "assistant", {
    model: "test-model",
  });
  const user2 = store.createNode(conversationId, "msg-3", "user");
  const asst2 = store.createNode(conversationId, "msg-4", "assistant", {
    model: "test-model",
    quality: "unrated",
  });
  return { user1, asst1, user2, asst2 };
}

describe("MemoryGraphStore", () => {
  test("对话即节点：appendNode 自动维护父子关系", () => {
    const store = new MemoryGraphStore();
    const convId = "conv-1";
    const { user1, asst1, user2, asst2 } = buildConversation(store, convId);

    expect(store.listNodes(convId)).toHaveLength(4);
    expect(store.getNode(user1.id)?.parentId).toBeNull();
    expect(store.getNode(asst1.id)?.parentId).toBe(user1.id);
    expect(store.getNode(asst2.id)?.parentId).toBe(user2.id);

    // 子节点关系
    expect(store.getChildren(user1.id).map((n) => n.id)).toEqual([asst1.id]);
    expect(store.getChildren(user2.id).map((n) => n.id)).toEqual([asst2.id]);
  });

  test("对话可溯源：getChain 返回根到节点的完整链路", () => {
    const store = new MemoryGraphStore();
    const { user1, asst1, user2, asst2 } = buildConversation(store, "conv-2");

    const chain = store.getChain(asst2.id);
    expect(chain.map((n) => n.id)).toEqual([user1.id, asst1.id, user2.id, asst2.id]);
    expect(store.getActivePath("conv-2").map((n) => n.id)).toEqual([
      user1.id,
      asst1.id,
      user2.id,
      asst2.id,
    ]);
  });

  test("节点回答不佳可回退：回退后长出分支，旧分支作废但保留", () => {
    const store = new MemoryGraphStore();
    const { user1, asst1, user2, asst2 } = buildConversation(store, "conv-3");

    // 标记 asst2 回答不佳并回退到 user2（重新提问/重新回答）
    store.markQuality(asst2.id, "poor", "回答不完整");
    const result = store.rollbackTo(user2.id, "回答不佳，回退重试");

    expect(result).toBeDefined();
    expect(result!.superseded).toContain(asst2.id);
    // 旧分支保留（不可变历史）
    expect(store.getNode(asst2.id)).toBeDefined();
    expect(store.getNode(asst2.id)!.meta.rolledBack).toBe(true);
    expect(store.getNode(asst2.id)!.meta.active).toBe(false);

    // 新分支点挂在 user2 下
    expect(result!.branchPoint.parentId).toBe(user2.id);
    expect(result!.branchPoint.type).toBe("branch-point");

    // 新回答挂在分支点下 → 活跃路径切换
    const asst2b = store.createNode("conv-3", "msg-5", "assistant", {
      model: "test-model",
      quality: "good",
    });
    expect(asst2b.parentId).toBe(result!.branchPoint.id);
    expect(store.getActiveHead("conv-3")?.id).toBe(asst2b.id);
    expect(store.getActivePath("conv-3").map((n) => n.id)).toEqual([
      user1.id,
      asst1.id,
      user2.id,
      result!.branchPoint.id,
      asst2b.id,
    ]);

    // 溯源依然完整：asst2b 的链包含分支点
    expect(store.getChain(asst2b.id)).toHaveLength(5);
  });

  test("回退目标不在活跃路径上时返回 undefined", () => {
    const store = new MemoryGraphStore();
    const { user2, asst2 } = buildConversation(store, "conv-4");
    // 先回退使 asst2 离开活跃路径，再对已作废节点回退应失败
    store.rollbackTo(user2.id, "先回退一次");
    expect(store.rollbackTo(asst2.id)).toBeUndefined();
    expect(store.rollbackTo("nonexistent")).toBeUndefined();
  });
});

describe("DefaultRollbackStrategy", () => {
  const store = new MemoryGraphStore();
  const { asst2 } = buildConversation(store, "conv-5");

  test("用户拒绝 → 应该回退", () => {
    const strategy = new DefaultRollbackStrategy();
    expect(strategy.shouldRollback({ node: asst2, userRejected: true })).toBe(true);
    expect(strategy.shouldRollback({ node: asst2 })).toBe(false);
  });

  test("工具错误过多 → 应该回退", () => {
    const strategy = new DefaultRollbackStrategy({ toolErrorThreshold: 2 });
    expect(strategy.shouldRollback({ node: asst2, toolErrorCount: 3 })).toBe(true);
    expect(strategy.shouldRollback({ node: asst2, toolErrorCount: 1 })).toBe(false);
  });

  test("质量归一化信号", () => {
    const goodNode = store.createNode("conv-5", "msg-good", "assistant", {
      quality: "good",
    });
    const poorNode = store.createNode("conv-5", "msg-poor", "assistant", {
      quality: "poor",
    });
    const strategy = new DefaultRollbackStrategy();
    expect(strategy.shouldRollback(qualityToSignal(goodNode))).toBe(false);
    expect(strategy.shouldRollback(qualityToSignal(poorNode))).toBe(true);
  });

  test("chooseTarget 默认回退到父节点", () => {
    const strategy = new DefaultRollbackStrategy();
    expect(strategy.chooseTarget(asst2)).toBe(asst2.parentId);
  });
});
