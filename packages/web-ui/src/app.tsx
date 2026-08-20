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
import { SessionSidebar } from "./components/session-sidebar.tsx";
import { useSession } from "./hooks/use-session.ts";
import { type Theme } from "./lib/theme.ts";
import "./index.css";

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

  const cycleTheme = useCallback(() => {
    setTheme((prev) =>
      prev === "dark" ? "light" : prev === "light" ? "cyber" : "dark",
    );
  }, []);

  return (
    <div className="app-shell">
      <SessionSidebar
        sessions={session.sessions}
        activeSessionId={session.activeSession?.id ?? null}
        creatingSession={session.creatingSession}
        onCreateSession={() => void session.createSession()}
        onSelectSession={(id) => void session.selectSession(id)}
        onDeleteSession={(id) => void session.deleteSession(id)}
      />
      <div className="app-shell__main">
        <ChatPage
          client={client}
          session={session}
          theme={theme}
          onCycleTheme={cycleTheme}
        />
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
