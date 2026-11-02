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
 *
 * 「agent 团队」统一模块（M1）：导航收敛为四页（会话/观测/评测/团队）。
 * 旧路由 ?view=agents / ?view=groups 以别名映射重定向到团队页（不断链）：
 * ?view=agents[&task=X] → ?view=teams&sub=tasks&task=X（有群的任务在团队内展开）
 * ?view=groups → ?view=teams
 */

import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
// WebUI 插件宿主（S1）：react 共享单例 + Provider；后端未装配时零影响
import * as __ReactShared from "react";
import { WebUiProvider, SlotHost } from "./webui/index.tsx";

// react 外部共享：插件 bundle 的 react 作 external，运行时从这里取（单例）
(window as unknown as Record<string, unknown>).__FENG_REACT__ = __ReactShared;
import { createRoot } from "react-dom/client";
import { createApiClient } from "./api/client.ts";
import { ChatPage } from "./pages/chat.tsx";
import { ObservabilityPage } from "./pages/observability.tsx";
import { EvalPage } from "./pages/eval.tsx";
import { TeamsPage } from "./pages/teams.tsx";
import { SettingsPage } from "./pages/settings.tsx";
import { SessionSidebar } from "./components/session-sidebar.tsx";
import { useSession } from "./hooks/use-session.ts";
import { type Theme } from "./lib/theme.ts";
import "./index.css";

/** 应用视图（agents/groups 已并入 teams，旧 URL 走别名重定向） */
export type AppView = "chat" | "observability" | "eval" | "teams" | "settings";

/** 团队页子视图（?sub= 参数） */
export type TeamsSubViewParam = "tasks" | "members";

/** deep-link 目标（会话 + 可选消息；团队深链可带群/子视图/任务） */
export interface DeepLinkTarget {
  sessionId?: string;
  messageId?: string;
  /** 任务深链：有 groupId 的任务在对应团队内展开任务卡，无群的进任务库详情 */
  taskId?: string;
  /** 团队深链：定位到某团队（?group=<id>） */
  groupId?: string;
  /** 团队子视图（?sub=tasks|members，缺省为团队视图） */
  subView?: TeamsSubViewParam;
}

/** URL 里的合法 view 值（含旧别名，解析时归一） */
const KNOWN_VIEWS = new Set(["chat", "observability", "eval", "teams", "settings", "agents", "groups"]);

function App() {
  const client = useMemo(() => createApiClient(), []);
  const session = useSession(client);

  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("feng-theme");
    if (stored === "light" || stored === "cyber" || stored === "dark") {
      return stored;
    }
    return "light";
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

  // 视图切换（会话 / 观测 / 评测 / 团队）
  const [view, setView] = useState<AppView>("chat");
  // deep-link 目标（会话/消息/团队定位）
  const [deepLink, setDeepLink] = useState<DeepLinkTarget>({});

  // 初始化：解析 URL 参数（?view=observability&sessionId=X&messageId=Y 等）
  // 旧视图（agents/groups）别名映射到 teams 并把 URL 重写为规范形式（不断链）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("view");
    if (!v || !KNOWN_VIEWS.has(v)) return;

    const legacy = v === "agents" || v === "groups";
    const target: DeepLinkTarget = {
      sessionId: params.get("sessionId") ?? undefined,
      messageId: params.get("messageId") ?? undefined,
      taskId: params.get("task") ?? undefined,
      groupId: params.get("group") ?? undefined,
      subView: ((): TeamsSubViewParam | undefined => {
        const sub = params.get("sub");
        if (sub === "tasks" || sub === "members") return sub;
        // 旧 Agents 页语义 ≈ 任务库（无任务深链时）
        if (v === "agents" && !params.get("task")) return "tasks";
        return undefined;
      })(),
    };
    setView("teams");
    setDeepLink(target);

    if (legacy) {
      // 重写为规范 URL（replaceState：书签自然更新，不堆历史）
      const canonical = new URLSearchParams();
      canonical.set("view", "teams");
      if (target.subView) canonical.set("sub", target.subView);
      if (target.groupId) canonical.set("group", target.groupId);
      if (target.taskId) canonical.set("task", target.taskId);
      window.history.replaceState(null, "", `?${canonical.toString()}`);
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
    if (target?.taskId) params.set("task", target.taskId);
    if (target?.groupId) params.set("group", target.groupId);
    if (target?.subView) params.set("sub", target.subView);
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
    <WebUiProvider>
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
            <span aria-hidden="true">💬</span> 会话
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
          <button
            type="button"
            role="tab"
            aria-selected={view === "teams"}
            className={`app-nav__tab ${view === "teams" ? "app-nav__tab--active" : ""}`}
            onClick={() => setView("teams")}
          >
            <span aria-hidden="true">👥</span> 团队
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "settings"}
            className={`app-nav__tab ${view === "settings" ? "app-nav__tab--active" : ""}`}
            onClick={() => setView("settings")}
          >
            <span aria-hidden="true">⚙️</span> 设置
          </button>
        </div>
      </nav>

      <div className="app-shell__body">
        {view === "chat" ? (
          <>
            <SessionSidebar
              sessions={session.sessions}
              activeSessionId={session.activeSession?.id ?? null}
              runningSessionIds={session.runningSessionIds}
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
        ) : view === "teams" ? (
          <div className="app-shell__main">
            <TeamsPage client={client} deepLink={deepLink} onNavigate={navigate} />
          </div>
        ) : view === "settings" ? (
          <div className="app-shell__main">
            <SettingsPage theme={theme} onSelectTheme={selectTheme} />
          </div>
        ) : (
          <div className="app-shell__main">
            <EvalPage client={client} deepLink={deepLink} onNavigate={navigate} />
          </div>
        )}
      </div>
      {/* WebUI 插件 slot（S1 首挂点：导航扩展；后端未装配时渲染 null） */}
      <SlotHost slotId="nav-extension" />
    </div>
    </WebUiProvider>
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
