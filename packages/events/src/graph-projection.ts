/**
 * @fengagent/events — graph 投影（Phase 2，#4/#6）
 *
 * 从事件日志按 seq 重放派生「对话图」读模型（对话即节点 / 可溯源 / 可回退）：
 * - 节点派生：user/message → 用户节点；step/start → 助手节点；
 *   rollback/fork → 分支点（branch-point）节点；node/quality → 质量事实；
 * - #4 head 确定式推导：head = 最新事件所属分支的链尾（回退/分叉后 = 最新
 *   rollback/fork 事件声明的链尾），不设可变「当前分支」指针；
 * - #6 派生态重算：active/rolledBack 不字面落事件，由 head 链推导
 *   （链上节点 active，其余 rolledBack 保留历史）。
 *
 * 节点 id 使用确定性方案（见 node-ids.ts）：同一事实重放得到同一节点，
 * 保证 graph.jsonl 派生视图与运行内存图一致、跨重启可重建。
 */

import type { ConversationNode } from "@fengagent/graph";
import type { AnySessionEvent } from "./types.ts";
import {
  assistantNodeId,
  branchPointNodeId,
  userNodeId,
} from "./node-ids.ts";

/** 单会话派生图读模型 */
export interface ProjectedGraph {
  conversationId: string;
  /** 全部节点（含已作废分支，按创建顺序） */
  nodes: ConversationNode[];
  /** 节点 id → 节点 */
  nodeById: Map<string, ConversationNode>;
  /** 当前活跃 head（#4 确定式推导；无节点时 undefined） */
  head: ConversationNode | undefined;
  /** 活跃路径（根 → head，链上节点） */
  activePath: ConversationNode[];
}

/**
 * 从会话事件序列派生图（#4/#6）。
 * @returns 派生图；事件流为空或缺少会话归属时返回 null
 */
export function projectGraph(events: AnySessionEvent[]): ProjectedGraph | null {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  if (sorted.length === 0) return null;
  const sessionId = sorted[0]!.sessionId;
  const nodeById = new Map<string, ConversationNode>();
  let head: ConversationNode | undefined;

  /**
   * 改参事实（`tool/corrected`）的负载。
   *
   * 生产写入序是「改参事实 → 助手消息的 step/start」：工具结果 yield 时助手消息
   * 还没双写落事件（消息在回合收尾才 saveMessages）。因此按 seq 重放到改参事实
   * 时，归属节点往往尚未派生 —— 就地丢弃会让节点永远标不上「已改参」（真实
   * 断链现场）。这里先挂起，节点派生出来时再应用，重放结果与事件顺序无关。
   */
  const pendingCorrections = new Map<
    string,
    Array<Extract<AnySessionEvent, { type: "tool/corrected" }>>
  >();

  /** 把一条改参事实应用到助手节点（`seq`/`timestamp` 保留事件序，可溯源） */
  const applyCorrection = (
    node: ConversationNode,
    e: Extract<AnySessionEvent, { type: "tool/corrected" }>,
  ) => {
    node.meta.userCorrectedInput = true;
    const corrections = (node.meta.inputCorrections ??= []);
    corrections.push({
      toolUseId: e.payload.toolUseId,
      toolName: e.payload.toolName,
      originalInput: e.payload.originalInput,
      correctedInput: e.payload.correctedInput,
      source: e.payload.source,
      seq: e.seq,
      timestamp: e.timestamp,
    });
  };

  const addNode = (node: ConversationNode) => {
    nodeById.set(node.id, node);
    if (node.parentId) {
      const parent = nodeById.get(node.parentId);
      if (parent) parent.childrenIds.push(node.id);
    }
  };

  /** 当前活跃路径（head → 根，用于 rollback/fork 的作废段判定） */
  const activePathFrom = (h: ConversationNode | undefined): ConversationNode[] => {
    const path: ConversationNode[] = [];
    let cur = h;
    while (cur) {
      path.push(cur);
      cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
    }
    return path;
  };

  for (const e of sorted) {
    const ts = Date.parse(e.timestamp);
    switch (e.type) {
      case "user/message": {
        const id = userNodeId(sessionId, e.payload.messageId);
        let node = nodeById.get(id);
        if (!node) {
          node = {
            id,
            conversationId: sessionId,
            type: "user",
            messageId: e.payload.messageId,
            parentId: head?.id ?? null,
            childrenIds: [],
            createdAt: ts,
            meta: { active: true },
          };
          addNode(node);
        }
        head = node;
        break;
      }
      case "step/start": {
        const id = assistantNodeId(sessionId, e.payload.messageId);
        let node = nodeById.get(id);
        if (!node) {
          node = {
            id,
            conversationId: sessionId,
            type: "assistant",
            messageId: e.payload.messageId,
            parentId: head?.id ?? null,
            childrenIds: [],
            createdAt: ts,
            meta: { active: true },
          };
          addNode(node);
        }
        if (e.payload.model) node.meta.model = e.payload.model;
        // 节点刚派生：应用早于本事件到达的改参事实（生产写入序即如此）
        const pending = pendingCorrections.get(e.payload.messageId);
        if (pending) {
          for (const fact of pending) applyCorrection(node, fact);
          pendingCorrections.delete(e.payload.messageId);
        }
        head = node;
        break;
      }
      case "tool/corrected": {
        // 改参事实：挂到产生该工具调用的助手节点上（改参前后可溯源）。
        // 节点尚未派生（生产序：消息回合收尾才落 step/start）时先挂起，
        // 待 step/start 派生节点后再应用；始终无节点（遗留流）则自然丢弃。
        const node = nodeById.get(assistantNodeId(sessionId, e.payload.messageId));
        if (node) {
          applyCorrection(node, e);
        } else {
          const pending = pendingCorrections.get(e.payload.messageId) ?? [];
          pending.push(e);
          pendingCorrections.set(e.payload.messageId, pending);
        }
        break;
      }
      case "node/quality": {
        const node = nodeById.get(e.payload.nodeId);
        if (node) {
          node.meta.quality = e.payload.quality;
          if (e.payload.note !== undefined) node.meta.qualityNote = e.payload.note;
        }
        break;
      }
      case "rollback": {
        const target = nodeById.get(e.payload.targetNodeId);
        if (!target) break; // 无法解析（遗留 id）— 保守跳过
        const path = activePathFrom(head);
        const idx = path.findIndex((n) => n.id === target.id);
        if (idx === -1) break; // 目标不在活跃路径上 — 跳过
        // 作废旧分支（target 之后的活跃节点），保留历史
        for (const n of path.slice(idx + 1)) {
          n.meta.active = false;
          n.meta.rolledBack = true;
        }
        // 分支点：挂到 target 下，成为新 head
        const bp: ConversationNode = {
          id: branchPointNodeId(sessionId, e.seq),
          conversationId: sessionId,
          type: "branch-point",
          messageId: target.messageId,
          parentId: target.id,
          childrenIds: [],
          createdAt: ts,
          meta: {
            branch: `rollback-${e.seq}`,
            active: true,
            qualityNote: e.payload.reason,
            // 步级续跑（回退点在一轮之内）——图上据此标「步级续跑」而非「回退重答」
            ...(e.payload.granularity === "step" ? { stepLevel: true } : {}),
          },
        };
        addNode(bp);
        head = bp;
        break;
      }
      case "fork": {
        const parent = nodeById.get(e.payload.parentNodeId);
        if (!parent) break;
        const path = activePathFrom(head);
        const idx = path.findIndex((n) => n.id === parent.id);
        if (idx !== -1) {
          for (const n of path.slice(idx + 1)) {
            n.meta.active = false;
            n.meta.rolledBack = true;
          }
        }
        const bp: ConversationNode = {
          id: branchPointNodeId(sessionId, e.seq),
          conversationId: sessionId,
          type: "branch-point",
          messageId: parent.messageId,
          parentId: parent.id,
          childrenIds: [],
          createdAt: ts,
          meta: {
            branch: e.payload.branch,
            active: true,
          },
        };
        addNode(bp);
        head = bp;
        break;
      }
      default:
        // session/*、assistant/chunk、step/end、turn/end — 无节点影响
        break;
    }
  }

  // #6 派生态重算：active/rolledBack 由 head 链推导，不字面信任 meta
  const activeIds = new Set<string>();
  let cur = head;
  while (cur) {
    activeIds.add(cur.id);
    cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
  }
  for (const n of nodeById.values()) {
    if (activeIds.has(n.id)) {
      n.meta.active = true;
      delete n.meta.rolledBack;
    } else {
      n.meta.active = false;
      n.meta.rolledBack = true;
    }
  }

  const activePath: ConversationNode[] = [];
  {
    let c = head;
    while (c) {
      activePath.unshift(c);
      c = c.parentId ? nodeById.get(c.parentId) : undefined;
    }
  }

  return {
    conversationId: sessionId,
    nodes: [...nodeById.values()],
    nodeById,
    head,
    activePath,
  };
}
