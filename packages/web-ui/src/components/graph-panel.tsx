/**
 * @fengagent/web-ui — 对话图面板（Phase 4：分支可视化 + 回退）
 *
 * 渲染会话的对话图：用户/助手/工具/分支点节点、活跃路径高亮、
 * 被回退作废的旧分支（灰显保留）、助手节点上的「回退」按钮。
 *
 * Round 2：颜色全部改用 CSS 变量（--accent / --success / --danger /
 * --text-* / --border-* 等），三套主题（深空/日光/赛博）自动适配。
 */

import { useMemo, useState } from "react";
import { GitBranch, RotateCcw } from "lucide-react";
import type { ConversationNode, GraphData } from "../api/types.ts";

interface GraphPanelProps {
  graph: GraphData;
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

export function GraphPanel({ graph, busy, onRollback }: GraphPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const activeIds = useMemo(
    () => new Set(graph.activePath.map((n) => n.id)),
    [graph.activePath],
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
    const rolledBack = node.meta.rolledBack || activeIds.has(node.id) === false && node.type !== "branch-point";
    const canRollback =
      (node.type === "assistant" || node.type === "user") && active && !busy;

    return (
      <div key={node.id}>
        <div
          className={`graph-node ${active ? "graph-node--active" : ""} ${isHead ? "graph-node--head" : ""}`}
          style={{
            marginLeft: depth * 18,
            opacity: rolledBack ? 0.55 : 1,
          }}
        >
          <span style={{ fontSize: 14 }}>{NODE_ICON[node.type] ?? "•"}</span>
          <span className="graph-node__label">
            {NODE_LABEL[node.type] ?? node.type}
          </span>
          <code className="graph-node__id">{node.id.slice(0, 12)}</code>
          {node.meta.quality && node.meta.quality !== "unrated" && (
            <span
              className={`graph-node__quality ${
                node.meta.quality === "poor" ? "graph-node__quality--poor" : ""
              }`}
            >
              {node.meta.quality === "poor" ? "回答不佳" : "良好"}
            </span>
          )}
          {node.meta.qualityNote && (
            <span className="graph-node__note" title={node.meta.qualityNote}>
              {node.meta.qualityNote.slice(0, 20)}
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
              回退到父节点
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
        width: 340,
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
                💡 点击助手节点「回退到父节点」：回到该提问处重答，旧分支作废但保留，可随时溯源。
              </p>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
