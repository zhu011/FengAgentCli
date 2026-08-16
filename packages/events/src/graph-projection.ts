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
        head = node;
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
