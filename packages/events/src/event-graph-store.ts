/**
 * @fengagent/events — EventGraphStore（Phase 2 事件溯源图存储）
 *
 * GraphStore 的事件溯源实现：图状态由事件日志派生（graph 投影，#4/#6），
 * 而非内存可变状态直接整写：
 * - 读路径：每次从事件日志重放投影（graph.jsonl 只是派生视图，非事实源）；
 * - 写路径：用户/助手节点来自消息事件（user/message、step/start…，由双写先行落盘）；
 *   markQuality → node/quality 事件；rollbackTo → rollback 事件；fork → fork 事件；
 * - flush：把「派生视图 + 无事件会话的遗留节点」写到 graph.jsonl（不再整写内存态）；
 * - 确定性节点 id（node-ids.ts）：跨重启重放可重建同一张图。
 *
 * 无事件会话（如导入的 main 遗留数据）读 legacy 节点（graph.jsonl 原样），
 * 一旦该会话产生事件即切换为派生视图（事件为准）。
 */

import type { ConversationNode, ConversationNodeMeta, ConversationNodeType, GraphStore, NodeQuality, RollbackResult } from "@fengagent/graph";
import { generateId } from "@fengagent/shared";
import { readFileSync } from "node:fs";
import type { EventStore } from "./event-store.ts";
import { projectGraph, type ProjectedGraph } from "./graph-projection.ts";
import { assistantNodeId, branchPointNodeId, parseNodeId, userNodeId } from "./node-ids.ts";

export interface EventGraphStoreOptions {
  /** 事件日志（事实源） */
  events: EventStore;
  /** graph.jsonl 派生视图落盘路径 */
  persistPath?: string;
  /** 遗留 graph.jsonl 读取路径（默认 = persistPath；无事件会话的兼容读取） */
  legacyLoadPath?: string;
}

/** 无事件会话的遗留视图 */
interface LegacyView {
  nodes: ConversationNode[];
  head: ConversationNode | undefined;
  activePath: ConversationNode[];
}

export class EventGraphStore implements GraphStore {
  private readonly events: EventStore;
  private readonly persistPath?: string;
  /** 遗留节点（来自 graph.jsonl，仅供无事件会话） */
  private readonly legacy = new Map<string, ConversationNode>();
  /** 无事件词汇的节点（如 tool 等未来类型） */
  private readonly manual = new Map<string, ConversationNode>();

  constructor(options: EventGraphStoreOptions) {
    this.events = options.events;
    this.persistPath = options.persistPath;
    const legacyPath = options.legacyLoadPath ?? options.persistPath;
    if (legacyPath) this.loadLegacy(legacyPath);
  }

  /* ------------------------------ 事件 → 投影 ------------------------------ */

  /** 会话事件 → 派生图（无事件返回 null） */
  private projectConversation(sessionId: string): ProjectedGraph | null {
    const evs = this.events.replay(sessionId);
    if (evs.length === 0) return null;
    return projectGraph(evs);
  }

  /** 无事件会话的遗留视图（graph.jsonl 节点，兼容旧数据） */
  private legacyView(conversationId: string): LegacyView {
    const nodes = [...this.legacy.values()].filter(
      (n) => n.conversationId === conversationId,
    );
    const head = nodes.length > 0 ? nodes[nodes.length - 1] : undefined;
    const activePath: ConversationNode[] = [];
    let cur = head;
    while (cur) {
      activePath.unshift(cur);
      cur = cur.parentId ? this.legacy.get(cur.parentId) : undefined;
    }
    return { nodes, head, activePath: activePath.filter((n) => n.meta.active !== false) };
  }

  /* ------------------------------ GraphStore 读路径 ------------------------------ */

  getNode(id: string): ConversationNode | undefined {
    const manual = this.manual.get(id);
    if (manual) return manual;
    const legacy = this.legacy.get(id);
    if (legacy) return legacy;
    const parsed = parseNodeId(id);
    if (parsed) {
      const g = this.projectConversation(parsed.sessionId);
      if (g) return g.nodeById.get(id);
    }
    return undefined;
  }

  listNodes(conversationId: string): ConversationNode[] {
    const manual = [...this.manual.values()].filter(
      (n) => n.conversationId === conversationId,
    );
    const g = this.projectConversation(conversationId);
    if (g) return [...g.nodes, ...manual];
    return [...this.legacyView(conversationId).nodes, ...manual];
  }

  getChildren(id: string): ConversationNode[] {
    const node = this.getNode(id);
    if (!node) return [];
    return node.childrenIds
      .map((cid) => this.getNode(cid))
      .filter((n): n is ConversationNode => n !== undefined);
  }

  getChain(nodeId: string): ConversationNode[] {
    const chain: ConversationNode[] = [];
    let cur = this.getNode(nodeId);
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? this.getNode(cur.parentId) : undefined;
    }
    return chain;
  }

  getActivePath(conversationId: string): ConversationNode[] {
    const g = this.projectConversation(conversationId);
    if (g) return g.activePath;
    return this.legacyView(conversationId).activePath;
  }

  getActiveHead(conversationId: string): ConversationNode | undefined {
    const g = this.projectConversation(conversationId);
    if (g) return g.head;
    return this.legacyView(conversationId).head;
  }

  /* ------------------------------ GraphStore 写路径（事件溯源） ------------------------------ */

  /**
   * 追加节点。
   * - 用户/助手节点：走事件派生 — 已有派生节点幂等返回；无事件时补消息事件
   *   （运行时正常路径由双写先落消息事件，不会走到补事件分支）；
   * - 其他类型（tool 等无事件词汇）：进 manual 集合（不落事件）。
   */
  appendNode(node: Omit<ConversationNode, "childrenIds">): ConversationNode {
    const full: ConversationNode = { ...node, childrenIds: [] };
    if (node.type === "user" || node.type === "assistant") {
      const existing = this.findDerivedNode(
        node.conversationId,
        node.type,
        node.messageId,
      );
      if (existing) return existing;
      // 无消息事件 → 补事件（内容未知；正常路径不会走到）
      const ts = new Date(node.createdAt).toISOString();
      if (node.type === "user") {
        this.events.append({
          sessionId: node.conversationId,
          type: "user/message",
          payload: { messageId: node.messageId, content: [] },
          timestamp: ts,
        });
      } else {
        this.events.append({
          sessionId: node.conversationId,
          type: "step/start",
          payload: {
            messageId: node.messageId,
            model: typeof node.meta.model === "string" ? node.meta.model : undefined,
          },
          timestamp: ts,
        });
        this.events.append({
          sessionId: node.conversationId,
          type: "step/end",
          payload: { messageId: node.messageId },
          timestamp: ts,
        });
      }
      const after = this.findDerivedNode(
        node.conversationId,
        node.type,
        node.messageId,
      );
      if (after) return after;
    }
    this.manual.set(full.id, full);
    return full;
  }

  /** 记录质量（#6：事实事件；同 quality 幂等不重复落） */
  markQuality(nodeId: string, quality: NodeQuality, note?: string): void {
    const node = this.getNode(nodeId);
    if (!node) return;
    const g = this.projectConversation(node.conversationId);
    if (g && g.nodeById.has(nodeId)) {
      if (node.meta.quality === quality) {
        if (note === undefined || node.meta.qualityNote === note) return;
      }
      this.events.append({
        sessionId: node.conversationId,
        type: "node/quality",
        payload: { nodeId, quality, note },
      });
      return;
    }
    // legacy/manual 节点 — 直接改 meta
    node.meta.quality = quality;
    if (note !== undefined) node.meta.qualityNote = note;
  }

  /**
   * 回退（#4/#6）：把活跃路径回退到目标节点，作废旧分支（保留历史），
   * 以 rollback 事件落盘（事实），分支点/head/active·rolledBack 由投影派生。
   * @returns 回退结果；目标不在活跃路径 / 会话无事件时返回 undefined
   */
  rollbackTo(nodeId: string, reason?: string): RollbackResult | undefined {
    const target = this.getNode(nodeId);
    if (!target) return undefined;
    const g = this.projectConversation(target.conversationId);
    if (!g) return undefined; // 无事件会话 — 不支持（进入事件溯源后才可回退）
    const idx = g.activePath.findIndex((n) => n.id === nodeId);
    if (idx === -1) return undefined; // 目标不在活跃路径上
    const superseded = g.activePath.slice(idx + 1).map((n) => n.id);

    const ev = this.events.append({
      sessionId: target.conversationId,
      type: "rollback",
      payload: {
        targetNodeId: nodeId,
        reason,
        supersededNodeIds: superseded,
      },
    });

    const g2 = this.projectConversation(target.conversationId);
    if (!g2) return undefined;
    const branchPoint = g2.nodeById.get(
      branchPointNodeId(target.conversationId, ev.seq),
    );
    if (!branchPoint) return undefined;
    return {
      target: g2.nodeById.get(nodeId) ?? target,
      branchPoint,
      superseded,
      activePath: g2.activePath,
    };
  }

  /**
   * 分叉（Phase 2）：从某节点长出新分支（fork 事件落盘），旧分支作废保留。
   * @returns 分叉结果（branchPoint 为新 head）；节点不存在/会话无事件时 undefined
   */
  fork(nodeId: string, branch?: string): RollbackResult | undefined {
    const target = this.getNode(nodeId);
    if (!target) return undefined;
    const g = this.projectConversation(target.conversationId);
    if (!g) return undefined;
    const idx = g.activePath.findIndex((n) => n.id === nodeId);
    if (idx === -1) return undefined;
    const superseded = g.activePath.slice(idx + 1).map((n) => n.id);

    const ev = this.events.append({
      sessionId: target.conversationId,
      type: "fork",
      payload: {
        parentNodeId: nodeId,
        branch: branch ?? `fork-${Date.now()}`,
      },
    });

    const g2 = this.projectConversation(target.conversationId);
    if (!g2) return undefined;
    const branchPoint = g2.nodeById.get(
      branchPointNodeId(target.conversationId, ev.seq),
    );
    if (!branchPoint) return undefined;
    return {
      target: g2.nodeById.get(nodeId) ?? target,
      branchPoint,
      superseded,
      activePath: g2.activePath,
    };
  }

  /** active/rolledBack 为派生态（#6）— 不接受直接设置 */
  setActive(_nodeId: string, _active: boolean): void {
    // no-op：派生视图，active 由 head 链推导
  }

  /* ------------------------------ 便捷创建（对齐 MemoryGraphStore） ------------------------------ */

  createRootNode(
    conversationId: string,
    messageId: string,
    type: ConversationNodeType = "user",
    meta: ConversationNodeMeta = {},
  ): ConversationNode {
    return this.appendNode({
      id: this.nodeIdFor(conversationId, type, messageId),
      conversationId,
      type,
      messageId,
      parentId: null,
      createdAt: Date.now(),
      meta: { active: true, ...meta },
    });
  }

  createNode(
    conversationId: string,
    messageId: string,
    type: ConversationNodeType,
    meta: ConversationNodeMeta = {},
  ): ConversationNode {
    const head = this.getActiveHead(conversationId);
    return this.appendNode({
      id: this.nodeIdFor(conversationId, type, messageId),
      conversationId,
      type,
      messageId,
      parentId: head ? head.id : null,
      createdAt: Date.now(),
      meta: { active: true, ...meta },
    });
  }

  /* ------------------------------ 持久化（派生视图） ------------------------------ */

  /**
   * 把「派生视图（事件会话）+ 遗留节点（无事件会话）+ manual 节点」整写到
   * graph.jsonl。graph.jsonl 因此只是可再生成的读模型快照，不再作为事实源
   * 被增量修改（Phase 2「转为派生视图不再整写内存态」）。
   */
  async flush(): Promise<void> {
    if (!this.persistPath) return;
    const lines: string[] = [];
    const eventSessions = new Set(this.events.listSessionIds());
    for (const n of this.manual.values()) lines.push(JSON.stringify(n));
    for (const n of this.legacy.values()) {
      if (!eventSessions.has(n.conversationId)) lines.push(JSON.stringify(n));
    }
    for (const sessionId of eventSessions) {
      const g = this.projectConversation(sessionId);
      if (g) for (const n of g.nodes) lines.push(JSON.stringify(n));
    }
    const text = lines.join("\n") + (lines.length ? "\n" : "");
    const file = Bun.file(this.persistPath);
    await Bun.write(file, text);
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 派生节点查找（幂等） */
  private findDerivedNode(
    conversationId: string,
    type: "user" | "assistant",
    messageId: string,
  ): ConversationNode | undefined {
    const g = this.projectConversation(conversationId);
    if (!g) return undefined;
    return g.nodes.find((n) => n.type === type && n.messageId === messageId);
  }

  /** 确定性节点 id（user/assistant 走消息事件派生；其他类型回落随机 id） */
  private nodeIdFor(
    conversationId: string,
    type: ConversationNodeType,
    messageId: string,
  ): string {
    if (type === "user") return userNodeId(conversationId, messageId);
    if (type === "assistant") return assistantNodeId(conversationId, messageId);
    return `gnode-${generateId()}`;
  }

  /** 读取遗留 graph.jsonl（无事件会话的兼容数据源） */
  private loadLegacy(path: string): void {
    try {
      const text = readFileSync(path, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const node = JSON.parse(line) as ConversationNode;
          this.legacy.set(node.id, node);
        } catch {
          // 坏行跳过（派生视图容忍损坏）
        }
      }
    } catch {
      // 无遗留文件 — 忽略
    }
  }
}
