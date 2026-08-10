/**
 * @fengagent/web-ui — 会话列表侧边栏
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

export function SessionSidebar({
  sessions,
  activeSessionId,
  creatingSession,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
}: SessionSidebarProps) {
  return (
    <aside className="session-sidebar">
      <div className="session-sidebar__header">
        <h1 className="session-sidebar__title">⚡ FENGAGENTCLI</h1>
        <button
          type="button"
          className="session-sidebar__new-btn"
          onClick={onCreateSession}
          disabled={creatingSession}
        >
          <Plus size={16} />
          <span>{creatingSession ? "Creating..." : "New Chat"}</span>
        </button>
      </div>

      <div className="session-sidebar__list">
        {sessions.length === 0 ? (
          <p className="session-sidebar__empty">No sessions yet</p>
        ) : (
          sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session-card ${
                session.id === activeSessionId ? "session-card--active" : ""
              }`}
              onClick={() => onSelectSession(session.id)}
            >
              <MessageSquare size={15} className="session-card__icon" aria-hidden="true" />
              <div className="session-card__body">
                <span className="session-card__title">{session.title}</span>
                <span className="session-card__meta">
                  {session.tokenCount > 0
                    ? `${session.tokenCount} tokens`
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
          ))
        )}
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
