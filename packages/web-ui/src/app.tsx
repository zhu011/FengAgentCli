/**
 * @fengagent/web-ui — 应用入口
 *
 * 组合 SessionSidebar + ChatPage，
 * 管理全局状态（API 客户端、会话状态、主题）。
 * 设计语言参考主流大模型对话产品（DeepSeek / 豆包 / 通义千问）：
 * 居中对话流 + 建议卡片 + 圆角 Composer + 日期分组会话侧栏。
 *
 * Deep-link（聊天 → 观测/评测）：
 * 聊天页每条消息的「查看调用链 / 查看评测」按钮携带 sessionId+messageId
 * 跳转到观测/评测页；URL 同步为 ?view=observability&sessionId=X&messageId=Y
 * （或 eval），刷新/分享后仍可定位到同一会话与消息。
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

/** deep-link 目标（会话 + 可选消息） */
export interface DeepLinkTarget {
  sessionId?: string;
  messageId?: string;
}

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
  // deep-link 目标（会话/消息定位）
  const [deepLink, setDeepLink] = useState<DeepLinkTarget>({});

  // 初始化：解析 URL 参数（?view=observability&sessionId=X&messageId=Y）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("view");
    if (v === "observability" || v === "eval") {
      setView(v);
      setDeepLink({
        sessionId: params.get("sessionId") ?? undefined,
        messageId: params.get("messageId") ?? undefined,
      });
    }
  }, []);

  /** 视图 + deep-link 导航（同步 URL，支持刷新/分享定位） */
  const navigate = useCallback((nextView: AppView, target?: DeepLinkTarget) => {
    setView(nextView);
    setDeepLink(target ?? {});
    const params = new URLSearchParams();
    if (nextView !== "chat") params.set("view", nextView);
    if (target?.sessionId) params.set("sessionId", target.sessionId);
    if (target?.messageId) params.set("messageId", target.messageId);
    const qs = params.toString();
    window.history.pushState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, []);

  /** 打开观测页（可选定位到消息） */
  const openObservability = useCallback(
    (sessionId: string, messageId?: string) => {
      navigate("observability", { sessionId, messageId });
    },
    [navigate],
  );

  /** 打开评测页（可选定位到消息） */
  const openEval = useCallback(
    (sessionId: string, messageId?: string) => {
      navigate("eval", { sessionId, messageId });
    },
    [navigate],
  );

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
              onOpenObservability={openObservability}
              onOpenEval={openEval}
            />
            <div className="app-shell__main">
              <ChatPage
                client={client}
                session={session}
                theme={theme}
                onSelectTheme={selectTheme}
                onRenameSession={(id, title) => void session.renameSession(id, title)}
                onOpenObservability={openObservability}
                onOpenEval={openEval}
              />
            </div>
          </>
        ) : view === "observability" ? (
          <div className="app-shell__main">
            <ObservabilityPage client={client} deepLink={deepLink} onNavigate={navigate} />
          </div>
        ) : (
          <div className="app-shell__main">
            <EvalPage client={client} deepLink={deepLink} onNavigate={navigate} />
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
