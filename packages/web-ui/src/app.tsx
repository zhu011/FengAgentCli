/**
 * @fengagent/web-ui — 应用入口
 *
 * 组合 SessionSidebar + ChatPage，
 * 管理全局状态（主题切换、API 客户端、会话状态）。
 */

import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Moon, Sun } from "lucide-react";
import { createApiClient } from "./api/client.ts";
import { ChatPage } from "./pages/chat.tsx";
import { SessionSidebar } from "./components/session-sidebar.tsx";
import { useSession } from "./hooks/use-session.ts";
import "./index.css";

type Theme = "light" | "dark";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem("fengagent-theme");
  if (stored === "dark" || stored === "light") return stored;
  // 跟随系统偏好
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function App() {
  const client = useMemo(() => createApiClient(), []);
  const session = useSession(client);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  // 应用主题 class
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("fengagent-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
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
        <ChatPage client={client} session={session} />
      </div>
      <button
        type="button"
        className="app-shell__theme-toggle"
        onClick={toggleTheme}
        aria-label="Toggle theme"
      >
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>
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
