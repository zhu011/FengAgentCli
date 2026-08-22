/**
 * @fengagent/web-ui — 应用入口
 *
 * 组合 SessionSidebar + ChatPage，
 * 管理全局状态（API 客户端、会话状态、主题）。
 * 设计语言参考主流大模型对话产品（DeepSeek / 豆包 / 通义千问）：
 * 居中对话流 + 建议卡片 + 圆角 Composer + 日期分组会话侧栏。
 */

import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "./api/client.ts";
import { ChatPage } from "./pages/chat.tsx";
import { ObservabilityPage } from "./pages/observability.tsx";
import { EvalPage } from "./pages/eval.tsx";
import { SessionSidebar } from "./components/session-sidebar.tsx";
import { useSession } from "./hooks/use-session.ts";
import { type Theme } from "./lib/theme.ts";
import "./index.css";

/** 应用视图 */
export type AppView = "chat" | "observability" | "eval";

function App() {
  const client = useMemo(() => createApiClient(), []);
  const session = useSession(client);

  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("feng-theme");
    if (stored === "light" || stored === "cyber" || stored === "dark") {
      return stored;
    }
    return "dark";
  });

  // 应用 data-theme 属性 + dark class 按需切换
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    if (theme === "dark" || theme === "cyber") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    localStorage.setItem("feng-theme", theme);
  }, [theme]);

  const selectTheme = useCallback((t: Theme) => {
    setTheme(t);
  }, []);

  // 视图切换（对话 / 观测 / 评测）
  const [view, setView] = useState<AppView>("chat");

  return (
    <div className="app-shell">
      <nav className="app-nav" aria-label="主导航">
        <div className="app-nav__brand">
          <span className="app-nav__brand-mark" aria-hidden="true">⚡</span>
          <span className="app-nav__brand-name">FengAgentCli</span>
        </div>
        <div className="app-nav__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "chat"}
            className={`app-nav__tab ${view === "chat" ? "app-nav__tab--active" : ""}`}
            onClick={() => setView("chat")}
          >
            <span aria-hidden="true">💬</span> 对话
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "observability"}
            className={`app-nav__tab ${view === "observability" ? "app-nav__tab--active" : ""}`}
            onClick={() => setView("observability")}
          >
            <span aria-hidden="true">📡</span> 观测
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "eval"}
            className={`app-nav__tab ${view === "eval" ? "app-nav__tab--active" : ""}`}
            onClick={() => setView("eval")}
          >
            <span aria-hidden="true">🧪</span> 评测
          </button>
        </div>
      </nav>

      <div className="app-shell__body">
        {view === "chat" ? (
          <>
            <SessionSidebar
              sessions={session.sessions}
              activeSessionId={session.activeSession?.id ?? null}
              creatingSession={session.creatingSession}
              onCreateSession={() => void session.createSession()}
              onSelectSession={(id) => void session.selectSession(id)}
              onDeleteSession={(id) => void session.deleteSession(id)}
              onRenameSession={(id, title) => void session.renameSession(id, title)}
            />
            <div className="app-shell__main">
              <ChatPage
                client={client}
                session={session}
                theme={theme}
                onSelectTheme={selectTheme}
                onRenameSession={(id, title) => void session.renameSession(id, title)}
              />
            </div>
          </>
        ) : view === "observability" ? (
          <div className="app-shell__main">
            <ObservabilityPage client={client} />
          </div>
        ) : (
          <div className="app-shell__main">
            <EvalPage client={client} />
          </div>
        )}
      </div>
    </div>
  );
}

function main() {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Root element not found");
  }
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

main();
