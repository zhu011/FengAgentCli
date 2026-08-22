/**
 * @fengagent/web-ui — 会话列表侧边栏
 *
 * 设计：日期分组（今天 / 昨天 / 近 7 天 / 更早）+ 底部信息栏，
 * 参考主流对话产品（DeepSeek / ChatGPT）的会话管理体验。
 * Round 2：会话标题「双击重命名」（行内输入框，Enter 保存 / Esc 取消）。
 * Round 3：顶部会话搜索框（按标题过滤，支持清空）+ 会话行 hover 操作
 * 重命名 / 删除（键盘 focus 时同样可见）。
 * Round 5：每个会话行新增「查看观测 / 查看评测」入口（deep-link 到
 * 观测/评测页，展示该会话全部消息列表供用户选择）。
 */

import { useState } from "react";
import { Activity, FlaskConical, MessageSquare, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import type { SessionMeta } from "../api/types.ts";

interface SessionSidebarProps {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  creatingSession: boolean;
  onCreateSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  /** 打开该会话的观测页（消息选择器） */
  onOpenObservability?: (sessionId: string) => void;
  /** 打开该会话的评测页（消息选择器） */
  onOpenEval?: (sessionId: string) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 会话按日期分组 */
function groupLabel(ts: number): string {
  const now = new Date();
  const date = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfDay) / DAY_MS);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return "近 7 天";
  return "更早";
}

interface Group {
  label: string;
  items: SessionMeta[];
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  creatingSession,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onOpenObservability,
  onOpenEval,
}: SessionSidebarProps) {
  // 双击重命名状态：editingId 正在编辑的会话 + 草稿
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Round 3：会话搜索框
  const [query, setQuery] = useState("");

  const startRename = (session: SessionMeta) => {
    setEditingId(session.id);
    setDraft(session.title);
  };

  const commitRename = () => {
    if (editingId) {
      onRenameSession(editingId, draft);
    }
    setEditingId(null);
  };

  const normalizedQuery = query.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;
  // 搜索态：按标题过滤；非搜索态：全部
  const visibleSessions = searching
    ? sessions.filter((s) => s.title.toLowerCase().includes(normalizedQuery))
    : sessions;

  // 按日期分组（保持时间倒序；搜索态不分组，扁平展示）
  const groups: Group[] = [];
  const sorted = [...visibleSessions].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!searching) {
    for (const s of sorted) {
      const label = groupLabel(s.updatedAt);
      const last = groups[groups.length - 1];
      if (last && last.label === label) {
        last.items.push(s);
      } else {
        groups.push({ label, items: [s] });
      }
    }
  }

  return (
    <aside className="session-sidebar">
      <div className="session-sidebar__header">
        <div className="session-sidebar__brand">
          <span className="session-sidebar__logo">⚡</span>
          <div className="session-sidebar__brand-text">
            <h1 className="session-sidebar__title">FengAgentCli</h1>
            <span className="session-sidebar__sub">本地 AI Agent 对话平台</span>
          </div>
        </div>
        <button
          type="button"
          className="session-sidebar__new-btn"
          onClick={onCreateSession}
          disabled={creatingSession}
        >
          <Plus size={16} />
          <span>{creatingSession ? "Creating..." : "新对话"}</span>
        </button>
      </div>

      {/* Round 3：会话搜索框 */}
      <div className="session-sidebar__search">
        <Search size={14} className="session-sidebar__search-icon" aria-hidden="true" />
        <input
          type="text"
          className="session-sidebar__search-input"
          placeholder="搜索会话…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索会话"
        />
        {query && (
          <button
            type="button"
            className="session-sidebar__search-clear"
            onClick={() => setQuery("")}
            aria-label="清空搜索"
            title="清空搜索"
          >
            <X size={13} />
          </button>
        )}
      </div>

      <div className="session-sidebar__list">
        {sessions.length === 0 ? (
          <p className="session-sidebar__empty">
            还没有会话
            <br />
            点击「新对话」开始
          </p>
        ) : searching && visibleSessions.length === 0 ? (
          <p className="session-sidebar__empty">
            无匹配会话
            <br />
            试试其他关键词
          </p>
        ) : searching ? (
          sorted.map((session) => (
            <div
              key={session.id}
              className={`session-card ${
                session.id === activeSessionId ? "session-card--active" : ""
              }`}
              onClick={() => onSelectSession(session.id)}
              onDoubleClick={(e) => {
                // 双击卡片进入重命名（点删除/重命名按钮不触发）
                if ((e.target as HTMLElement).closest(".session-card__delete, .session-card__rename")) return;
                startRename(session);
              }}
              title="双击重命名会话"
            >
              <MessageSquare
                size={15}
                className="session-card__icon"
                aria-hidden="true"
              />
              <div className="session-card__body">
                {editingId === session.id ? (
                  <input
                    autoFocus
                    type="text"
                    className="session-card__rename-input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    onBlur={commitRename}
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="session-card__title">{session.title}</span>
                    <span className="session-card__meta">
                      {session.tokenCount > 0
                        ? `${session.tokenCount.toLocaleString()} tokens`
                        : formatDate(session.updatedAt)}
                    </span>
                  </>
                )}
              </div>
              <button
                type="button"
                className="session-card__delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteSession(session.id);
                }}
                aria-label="Delete session"
              >
                <Trash2 size={14} />
              </button>
              <button
                type="button"
                className="session-card__rename"
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(session);
                }}
                aria-label="Rename session"
                title="重命名"
              >
                <Pencil size={13} />
              </button>
              {onOpenObservability && (
                <button
                  type="button"
                  className="session-card__obs session-card__obs--activity"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenObservability(session.id);
                  }}
                  aria-label="查看观测"
                  title="查看该会话的观测（调用链）"
                >
                  <Activity size={13} />
                </button>
              )}
              {onOpenEval && (
                <button
                  type="button"
                  className="session-card__obs session-card__obs--eval"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenEval(session.id);
                  }}
                  aria-label="查看评测"
                  title="查看该会话的评测结果"
                >
                  <FlaskConical size={13} />
                </button>
              )}
            </div>
          ))
        ) : (
          groups.map((group) => (
            <div key={group.label} className="session-group">
              <div className="session-group__label">{group.label}</div>
              {group.items.map((session) => (
                <div
                  key={session.id}
                  className={`session-card ${
                    session.id === activeSessionId ? "session-card--active" : ""
                  }`}
                  onClick={() => onSelectSession(session.id)}
                  onDoubleClick={(e) => {
                    // 双击卡片进入重命名（点删除/重命名按钮不触发）
                    if ((e.target as HTMLElement).closest(".session-card__delete, .session-card__rename")) return;
                    startRename(session);
                  }}
                  title="双击重命名会话"
                >
                  <MessageSquare
                    size={15}
                    className="session-card__icon"
                    aria-hidden="true"
                  />
                  <div className="session-card__body">
                    {editingId === session.id ? (
                      <input
                        autoFocus
                        type="text"
                        className="session-card__rename-input"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        onBlur={commitRename}
                        onFocus={(e) => e.currentTarget.select()}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        <span className="session-card__title">{session.title}</span>
                        <span className="session-card__meta">
                          {session.tokenCount > 0
                            ? `${session.tokenCount.toLocaleString()} tokens`
                            : formatDate(session.updatedAt)}
                        </span>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    className="session-card__delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSession(session.id);
                    }}
                    aria-label="Delete session"
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    type="button"
                    className="session-card__rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(session);
                    }}
                    aria-label="Rename session"
                    title="重命名"
                  >
                    <Pencil size={13} />
                  </button>
                  {onOpenObservability && (
                    <button
                      type="button"
                      className="session-card__obs session-card__obs--activity"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenObservability(session.id);
                      }}
                      aria-label="查看观测"
                      title="查看该会话的观测（调用链）"
                    >
                      <Activity size={13} />
                    </button>
                  )}
                  {onOpenEval && (
                    <button
                      type="button"
                      className="session-card__obs session-card__obs--eval"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenEval(session.id);
                      }}
                      aria-label="查看评测"
                      title="查看该会话的评测结果"
                    >
                      <FlaskConical size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="session-sidebar__footer">
        <span>FengAgentCli v0.2.0</span>
        <span className="session-sidebar__footer-dot">·</span>
        <span>MIT License</span>
      </div>
    </aside>
  );
}

function formatDate(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
