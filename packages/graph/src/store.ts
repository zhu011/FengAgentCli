/**
 * @fengagent/graph — 内存图存储（可选 JSONL 持久化）
 *
 * 对话可溯源：每个节点记录 parentId / childrenIds，getChain 可还原任意节点
 * 的完整溯源链；getActivePath 返回当前活跃分支。
 * 对话即节点：appendNode 把每一轮对话沉淀为节点。
 * 节点回答不佳可回退：rollbackTo 把活跃路径回退到目标节点并长出新分支，
 * 旧分支整体作废但保留（不可变历史，可溯源）。
 */

import type {
  ConversationNode,
  ConversationNodeMeta,
  ConversationNodeType,
  GraphStore,
  NodeQuality,
  RollbackResult,
} from "./types.ts";
import { generateId } from "@fengagent/shared/utils";
import { readFileSync } from "node:fs";

export interface MemoryGraphStoreOptions {
  /** JSONL 持久化文件路径（可选） */
  persistPath?: string;
  /** 从已有 JSONL 恢复（可选） */
  loadFrom?: string;
}

/**
 * 内存图存储。线程内同步操作 + 可选 JSONL 追加持久化。
 * JSONL 每行一个节点或边事件，重启后可恢复（可溯源）。
 */
export class MemoryGraphStore implements GraphStore {
  private nodes = new Map<string, ConversationNode>();
  private conversationHeads = new Map<string, string>();

  constructor(private options: MemoryGraphStoreOptions = {}) {
    if (options.loadFrom) {
      this.load(options.loadFrom);
    }
  }

  appendNode(node: Omit<ConversationNode, "childrenIds">): ConversationNode {
    const full: ConversationNode = { ...node, childrenIds: [] };
    // 维护父节点的 children
    if (full.parentId) {
      const parent = this.nodes.get(full.parentId);
      if (parent) {
        parent.childrenIds.push(full.id);
      }
    }
    this.nodes.set(full.id, full);
    // 更新该会话的活跃 head
    this.conversationHeads.set(full.conversationId, full.id);
    return full;
  }

  getNode(id: string): ConversationNode | undefined {
    return this.nodes.get(id);
  }

  listNodes(conversationId: string): ConversationNode[] {
    return [...this.nodes.values()].filter(
      (n) => n.conversationId === conversationId,
    );
  }

  getChildren(id: string): ConversationNode[] {
    const parent = this.nodes.get(id);
    if (!parent) return [];
    return parent.childrenIds
      .map((cid) => this.nodes.get(cid))
      .filter((n): n is ConversationNode => n !== undefined);
  }

  getChain(nodeId: string): ConversationNode[] {
    const chain: ConversationNode[] = [];
    let current = this.nodes.get(nodeId);
    while (current) {
      chain.unshift(current);
      current = current.parentId ? this.nodes.get(current.parentId) : undefined;
    }
    return chain;
  }

  getActivePath(conversationId: string): ConversationNode[] {
    const head = this.getActiveHead(conversationId);
    if (!head) return [];
    // 活跃路径 = 从根到 head 的链，只保留 active 节点（跳过被作废的分支点后的旧路径）
    return this.getChain(head.id).filter((n) => n.meta.active !== false);
  }

  getActiveHead(conversationId: string): ConversationNode | undefined {
    const headId = this.conversationHeads.get(conversationId);
    if (!headId) return undefined;
    const head = this.nodes.get(headId);
    return head;
  }

  markQuality(nodeId: string, quality: NodeQuality, note?: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.meta.quality = quality;
    if (note) node.meta.qualityNote = note;
  }

  setActive(nodeId: string, active: boolean): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.meta.active = active;
    if (active) {
      this.conversationHeads.set(node.conversationId, nodeId);
    }
  }

  rollbackTo(nodeId: string, reason?: string): RollbackResult | undefined {
    const target = this.nodes.get(nodeId);
    if (!target) return undefined;

    const conversationId = target.conversationId;
    const superseded: string[] = [];

    // 1. 收集旧活跃路径上 target 之后的所有节点，标记作废（但保留历史）
    const oldPath = this.getActivePath(conversationId);
    const targetIdx = oldPath.findIndex((n) => n.id === nodeId);
    if (targetIdx === -1) {
      // 目标不在活跃路径上 — 无法回退
      return undefined;
    }
    for (const node of oldPath.slice(targetIdx + 1)) {
      node.meta.active = false;
      node.meta.rolledBack = true;
      superseded.push(node.id);
    }

    // 2. 在 target 下创建分支点（branch-point 节点）
    const branchPoint: ConversationNode = {
      id: `gnode-${generateId()}`,
      conversationId,
      type: "branch-point",
      messageId: target.messageId,
      parentId: target.id,
      childrenIds: [],
      createdAt: Date.now(),
      meta: {
        branch: `rollback-${Date.now()}`,
        active: true,
        qualityNote: reason,
      },
    };
    this.appendNode(branchPoint);

    // 3. 分支点自身也是 head
    this.conversationHeads.set(conversationId, branchPoint.id);

    return {
      target,
      branchPoint,
      superseded,
      activePath: this.getActivePath(conversationId),
    };
  }

  /**
   * 分叉（Phase 2）：从某节点长出新分支（不动质量评分），旧分支作废但保留。
   * 语义与 rollbackTo 一致（作废 target 之后的活跃节点 + 新建分支点），
   * 区别：不写质量、分支标签默认 `fork-<ts>`。
   */
  fork(nodeId: string, branch?: string): RollbackResult | undefined {
    const target = this.nodes.get(nodeId);
    if (!target) return undefined;

    const conversationId = target.conversationId;
    const superseded: string[] = [];

    const oldPath = this.getActivePath(conversationId);
    const targetIdx = oldPath.findIndex((n) => n.id === nodeId);
    if (targetIdx === -1) return undefined;
    for (const node of oldPath.slice(targetIdx + 1)) {
      node.meta.active = false;
      node.meta.rolledBack = true;
      superseded.push(node.id);
    }

    const branchPoint: ConversationNode = {
      id: `gnode-${generateId()}`,
      conversationId,
      type: "branch-point",
      messageId: target.messageId,
      parentId: target.id,
      childrenIds: [],
      createdAt: Date.now(),
      meta: {
        branch: branch ?? `fork-${Date.now()}`,
        active: true,
      },
    };
    this.appendNode(branchPoint);
    this.conversationHeads.set(conversationId, branchPoint.id);

    return {
      target,
      branchPoint,
      superseded,
      activePath: this.getActivePath(conversationId),
    };
  }

  /** 创建根节点（会话起始） */
  createRootNode(
    conversationId: string,
    messageId: string,
    type: ConversationNodeType = "user",
    meta: ConversationNodeMeta = {},
  ): ConversationNode {
    return this.appendNode({
      id: `gnode-${generateId()}`,
      conversationId,
      type,
      messageId,
      parentId: null,
      createdAt: Date.now(),
      meta: { active: true, ...meta },
    });
  }

  /** 创建常规节点（用户/助手/工具）并自动挂在活跃 head 下 */
  createNode(
    conversationId: string,
    messageId: string,
    type: ConversationNodeType,
    meta: ConversationNodeMeta = {},
  ): ConversationNode {
    const head = this.getActiveHead(conversationId);
    return this.appendNode({
      id: `gnode-${generateId()}`,
      conversationId,
      type,
      messageId,
      parentId: head ? head.id : null,
      createdAt: Date.now(),
      meta: { active: true, ...meta },
    });
  }

  async flush(): Promise<void> {
    if (!this.options.persistPath) return;
    const lines = [...this.nodes.values()].map((n) => JSON.stringify(n));
    const text = lines.join("\n") + (lines.length ? "\n" : "");
    const file = Bun.file(this.options.persistPath);
    await Bun.write(file, text);
  }

  private load(path: string): void {
    try {
      const text = readFileSync(path, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const node = JSON.parse(line) as ConversationNode;
        this.nodes.set(node.id, node);
        this.conversationHeads.set(node.conversationId, node.id);
      }
    } catch {
      // 恢复失败时静默降级为内存模式
    }
  }
}
