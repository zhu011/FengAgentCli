/**
 * @fengagent/web-ui — 对话图面板（Phase 4：分支可视化 + 回退）
 *
 * 渲染会话的对话图：用户/助手/工具/分支点节点、活跃路径高亮、
 * 被回退作废的旧分支（灰显保留）、助手节点上的「回退」按钮。
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
          style={{
            marginLeft: depth * 18,
            padding: "6px 10px",
            marginBottom: 4,
            borderRadius: 8,
            border: `1px solid ${active ? (isHead ? "#22c55e" : "#3b82f6") : "#334155"}`,
            background: active ? (isHead ? "rgba(34,197,94,0.08)" : "rgba(59,130,246,0.06)") : "rgba(51,65,85,0.25)",
            opacity: rolledBack ? 0.55 : 1,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 14 }}>{NODE_ICON[node.type] ?? "•"}</span>
          <span style={{ fontWeight: 600, fontSize: 12 }}>
            {NODE_LABEL[node.type] ?? node.type}
          </span>
          <code style={{ fontSize: 11, color: "#94a3b8" }}>{node.id.slice(0, 12)}</code>
          {node.meta.quality && node.meta.quality !== "unrated" && (
            <span
              style={{
                fontSize: 11,
                padding: "1px 6px",
                borderRadius: 999,
                background: node.meta.quality === "poor" ? "rgba(239,68,68,0.15)" : "rgba(34,197,94,0.15)",
                color: node.meta.quality === "poor" ? "#f87171" : "#4ade80",
              }}
            >
              {node.meta.quality === "poor" ? "回答不佳" : "良好"}
            </span>
          )}
          {node.meta.qualityNote && (
            <span style={{ fontSize: 11, color: "#cbd5e1" }} title={node.meta.qualityNote}>
              {node.meta.qualityNote.slice(0, 20)}
            </span>
          )}
          {rolledBack && (
            <span style={{ fontSize: 11, color: "#64748b" }}>已作废（保留可溯源）</span>
          )}
          {isHead && (
            <span style={{ fontSize: 11, color: "#4ade80", fontWeight: 700 }}>← 当前</span>
          )}
          {canRollback && (
            <button
              type="button"
              onClick={() => onRollback(node.id)}
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 6,
                border: "1px solid #f59e0b",
                background: "rgba(245,158,11,0.12)",
                color: "#fbbf24",
                cursor: "pointer",
              }}
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
      className="chat-page__graph-panel"
      style={{
        width: 340,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          borderBottom: "1px solid #1e293b",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <GitBranch size={14} color="#38bdf8" />
          对话图 · {graph.nodes.length} 节点
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          style={{
            fontSize: 12,
            background: "transparent",
            border: "none",
            color: "#94a3b8",
            cursor: "pointer",
          }}
        >
          {collapsed ? "展开" : "折叠"}
        </button>
      </div>
      {!collapsed && (
        <div style={{ padding: 12, overflowY: "auto", flexGrow: 1 }}>
          {roots.length === 0 ? (
            <p style={{ fontSize: 12, color: "#64748b" }}>
              暂无图节点 — 发一条消息后自动生成（对话即节点）。
            </p>
          ) : (
            <>
              {roots.map((node) => renderNode(node, 0))}
              <p style={{ fontSize: 11, color: "#64748b", marginTop: 10, lineHeight: 1.5 }}>
                💡 点击助手节点「回退到父节点」：回到该提问处重答，旧分支作废但保留，可随时溯源。
              </p>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
