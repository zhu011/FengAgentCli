/**
 * @fengagent/web-ui — 会话列表侧边栏
 *
 * 设计：日期分组（今天 / 昨天 / 近 7 天 / 更早）+ 底部信息栏，
 * 参考主流对话产品（DeepSeek / ChatGPT）的会话管理体验。
 */

import { MessageSquare, Plus, Trash2 } from "lucide-react";
import type { SessionMeta } from "../api/types.ts";

interface SessionSidebarProps {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  creatingSession: boolean;
  onCreateSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
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
}: SessionSidebarProps) {
  // 按日期分组（保持时间倒序）
  const groups: Group[] = [];
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of sorted) {
    const label = groupLabel(s.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.items.push(s);
    } else {
      groups.push({ label, items: [s] });
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

      <div className="session-sidebar__list">
        {sessions.length === 0 ? (
          <p className="session-sidebar__empty">
            还没有会话
            <br />
            点击「新对话」开始
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="session-group">
              <div className="session-group__label">{group.label}</div>
              {group.items.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={`session-card ${
                    session.id === activeSessionId ? "session-card--active" : ""
                  }`}
                  onClick={() => onSelectSession(session.id)}
                >
                  <MessageSquare
                    size={15}
                    className="session-card__icon"
                    aria-hidden="true"
                  />
                  <div className="session-card__body">
                    <span className="session-card__title">{session.title}</span>
                    <span className="session-card__meta">
                      {session.tokenCount > 0
                        ? `${session.tokenCount.toLocaleString()} tokens`
                        : formatDate(session.updatedAt)}
                    </span>
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
                </button>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="session-sidebar__footer">
        <span>FengAgentCli v0.1.0</span>
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
