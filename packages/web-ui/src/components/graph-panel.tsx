/**
 * @fengagent/web-ui — 对话图面板（Phase 4：分支可视化 + 回退）
 *
 * 渲染会话的对话图：用户/助手/工具/分支点节点、活跃路径高亮、
 * 被回退作废的旧分支（灰显保留）、助手节点上的「回退」按钮。
 *
 * AGE-29 增强（图逐步可辨）：
 * - 真实提问节点标注「第 N 问」+ 问题摘要；工具结果 user 节点明确标注
 *   「工具结果」（不再与提问混淆）；助手节点标注「第 N 问回答 · 步骤 M」
 *   + 所用工具名；分支点标注「回退重答」；
 * - head 节点高亮（描边/光晕 + ← 当前），活跃路径底色强调。
 *
 * Round 2：颜色全部改用 CSS 变量（--accent / --success / --danger /
 * --text-* / --border-* 等），三套主题（深空/日光/赛博）自动适配。
 */

import { useMemo, useState } from "react";
import { GitBranch, RotateCcw } from "lucide-react";
import type { ConversationNode, GraphData, Message } from "../api/types.ts";

interface GraphPanelProps {
  graph: GraphData;
  /** 会话消息（按 messageId 反查节点内容：提问摘要 / 工具名 / 工具结果） */
  messages?: Message[];
  busy: boolean;
  onRollback: (nodeId: string) => void;
}

const NODE_ICON: Record<string, string> = {
  user: "🧑",
  assistant: "🤖",
  tool: "🔧",
  "branch-point": "🔀",
};

const NODE_LABEL: Record<string, string> = {
  user: "用户",
  assistant: "助手",
  tool: "工具",
  "branch-point": "分支点",
};

/** 节点消息是否为工具结果（tool-result user 消息） */
function isToolResultMessage(node: ConversationNode, messagesById: Map<string, Message>): boolean {
  const msg = messagesById.get(node.messageId);
  if (!msg) return false;
  return msg.content.some((b) => b.type === "tool-result");
}

/** 节点消息是否为真实提问（含文本的 user 消息） */
function isRealQuestion(node: ConversationNode, messagesById: Map<string, Message>): boolean {
  const msg = messagesById.get(node.messageId);
  if (!msg) return false;
  return msg.content.some((b) => b.type === "text");
}

/** 提取消息文本摘要 */
function messageSnippet(node: ConversationNode, messagesById: Map<string, Message>, max = 34): string {
  const msg = messagesById.get(node.messageId);
  if (!msg) return "";
  const text = msg.content
    .filter((b): b is Extract<Message["content"][number], { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/** 提取助手消息所用工具名 */
function toolNamesOf(node: ConversationNode, messagesById: Map<string, Message>): string[] {
  const msg = messagesById.get(node.messageId);
  if (!msg) return [];
  return msg.content
    .filter((b) => b.type === "tool-use")
    .map((b) => (b.type === "tool-use" ? b.name : ""))
    .filter(Boolean);
}

/** 节点展示信息（序号 / 步骤 / 摘要 / 工具） */
interface NodeInfo {
  icon: string;
  label: string;
  /** 副文本（摘要 / 工具名等） */
  sub?: string;
  qualityLabel?: string;
}

/**
 * 派生节点展示信息：
 * - 真实提问 user → 「第 N 问」+ 问题摘要
 * - 工具结果 user → 「工具结果」+ 简短内容
 * - assistant → 「第 N 问回答 · 步骤 M」+ 所用工具；无提问时「回答」
 * - branch-point → 「回退重答（分支点）」
 * N = 该节点父链上真实提问的序号；M = 该回答在所属轮内的步骤序号。
 */
function buildNodeInfo(
  nodes: ConversationNode[],
  messagesById: Map<string, Message>,
): Map<string, NodeInfo> {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const info = new Map<string, NodeInfo>();

  const chainOf = (node: ConversationNode): ConversationNode[] => {
    const chain: ConversationNode[] = [];
    let cur: ConversationNode | undefined = node;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? nodesById.get(cur.parentId) : undefined;
    }
    return chain;
  };

  for (const node of nodes) {
    const chain = chainOf(node);
    // 真实提问在父链上的序号（含自身）
    const realQuestionIdx = chain.filter((n) => isRealQuestion(n, messagesById));
    const qIndex = realQuestionIdx.length;
    const base = NODE_ICON[node.type] ?? "•";

    if (node.type === "user") {
      if (isRealQuestion(node, messagesById)) {
        info.set(node.id, {
          icon: base,
          label: `第 ${qIndex} 问`,
          sub: messageSnippet(node, messagesById),
        });
      } else if (isToolResultMessage(node, messagesById)) {
        info.set(node.id, {
          icon: "🔧",
          label: "工具结果",
          sub: messageSnippet(node, messagesById),
        });
      } else {
        info.set(node.id, {
          icon: base,
          label: NODE_LABEL.user ?? "用户",
          sub: messageSnippet(node, messagesById),
        });
      }
      continue;
    }

    if (node.type === "assistant") {
      // 所属轮 = 父链上最近的真实提问；步骤序号 = 该提问之后助手节点数
      const question = [...realQuestionIdx].pop();
      const qNo = realQuestionIdx.length;
      let stepNo = 0;
      if (question) {
        const fromQ = chain.indexOf(question);
        stepNo = chain.slice(fromQ + 1).filter((n) => n.type === "assistant").length;
      }
      const tools = toolNamesOf(node, messagesById);
      const label = question
        ? `第 ${qNo} 问回答 · 步骤 ${stepNo}`
        : `回答 · 步骤 ${stepNo}`;
      const sub =
        tools.length > 0
          ? `🔧 ${tools.join("、")}`
          : messageSnippet(node, messagesById) || undefined;
      info.set(node.id, { icon: base, label, sub });
      continue;
    }

    if (node.type === "branch-point") {
      info.set(node.id, {
        icon: base,
        label: "回退重答",
        sub: node.meta.qualityNote
          ? String(node.meta.qualityNote).slice(0, 24)
          : "分支点",
      });
      continue;
    }

    // tool 等其它类型
    info.set(node.id, {
      icon: base,
      label: NODE_LABEL[node.type] ?? node.type,
      sub: messageSnippet(node, messagesById),
    });
  }
  return info;
}

export function GraphPanel({ graph, messages, busy, onRollback }: GraphPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const activeIds = useMemo(
    () => new Set(graph.activePath.map((n) => n.id)),
    [graph.activePath],
  );

  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages ?? []) map.set(m.id, m);
    return map;
  }, [messages]);

  const nodeInfo = useMemo(
    () => buildNodeInfo(graph.nodes, messagesById),
    [graph.nodes, messagesById],
  );

  // 按 parentId 组织成树（子节点缩进展示）
  const childrenOf = useMemo(() => {
    const map = new Map<string | null, ConversationNode[]>();
    for (const node of graph.nodes) {
      const list = map.get(node.parentId) ?? [];
      list.push(node);
      map.set(node.parentId, list);
    }
    return map;
  }, [graph.nodes]);

  const renderNode = (node: ConversationNode, depth: number): React.ReactElement => {
    const active = activeIds.has(node.id);
    const isHead = node.id === graph.activeHead?.id;
    const isQuestion =
      node.type === "user" && isRealQuestion(node, messagesById);
    const rolledBack = node.meta.rolledBack || (activeIds.has(node.id) === false && node.type !== "branch-point");
    // 可回退节点：assistant / tool / user（含工具结果，解析到所属轮提问）—
    // 点击后走「回退并重答」：回退 + 截断 + 自动重新回答（与 CLI /rollback 语义一致）
    const canRollback =
      (node.type === "assistant" ||
        node.type === "tool" ||
        node.type === "user") &&
      active &&
      !busy;
    const nfo = nodeInfo.get(node.id);

    return (
      <div key={node.id}>
        <div
          className={`graph-node ${active ? "graph-node--active" : ""} ${isHead ? "graph-node--head" : ""} ${isQuestion ? "graph-node--question" : ""}`}
          style={{
            marginLeft: depth * 18,
            opacity: rolledBack ? 0.55 : 1,
          }}
        >
          <span style={{ fontSize: 14 }}>{nfo?.icon ?? NODE_ICON[node.type] ?? "•"}</span>
          <span className="graph-node__label">
            {nfo?.label ?? NODE_LABEL[node.type] ?? node.type}
          </span>
          {nfo?.sub && (
            <span className="graph-node__note" title={nfo.sub}>
              {nfo.sub}
            </span>
          )}
          <code className="graph-node__id">{node.id.slice(0, 10)}</code>
          {node.meta.quality && node.meta.quality !== "unrated" && (
            <span
              className={`graph-node__quality ${
                node.meta.quality === "poor" ? "graph-node__quality--poor" : ""
              }`}
            >
              {node.meta.quality === "poor" ? "回答不佳" : "良好"}
            </span>
          )}
          {rolledBack && (
            <span className="graph-node__rolledback">已作废（保留可溯源）</span>
          )}
          {isHead && (
            <span className="graph-node__head">← 当前</span>
          )}
          {canRollback && (
            <button
              type="button"
              className="graph-node__rollback"
              onClick={() => onRollback(node.id)}
            >
              <RotateCcw size={11} />
              回退并重答
            </button>
          )}
        </div>
        {(childrenOf.get(node.id) ?? []).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  const roots = childrenOf.get(null) ?? [];

  return (
    <aside
      className="chat-page__graph-panel graph-panel"
      style={{
        width: 360,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div className="graph-panel__header">
        <span className="graph-panel__title">
          <GitBranch size={14} className="graph-panel__title-icon" />
          对话图 · {graph.nodes.length} 节点
        </span>
        <button
          type="button"
          className="graph-panel__collapse"
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? "展开" : "折叠"}
        </button>
      </div>
      {!collapsed && (
        <div className="graph-panel__body">
          {roots.length === 0 ? (
            <p className="graph-panel__empty">
              暂无图节点 — 发一条消息后自动生成（对话即节点）。
            </p>
          ) : (
            <>
              {roots.map((node) => renderNode(node, 0))}
              <p className="graph-panel__hint">
                💡 点「回退并重答」：回退到该节点所属那一轮的提问处并自动重答
                （含该轮工具调用会重跑），旧分支作废但保留，可随时溯源。
              </p>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
