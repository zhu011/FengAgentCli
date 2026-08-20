/**
 * @fengagent/web-ui — 聊天页面
 *
 * 设计语言参考 DeepSeek / 豆包 / 通义千问：
 * - 顶栏：品牌字标 + 会话标题（双击重命名）+ 模型选择 + 设置下拉（主题 / 面板）
 * - 欢迎态：居中 Hero + 建议卡片（点击直接发起对话，贴合 Agent 场景）
 * - 对话流：居中窄栏（max-width 768px），助手带头像、用户右对齐气泡
 */

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Settings,
} from "lucide-react";
import type { ApiClient } from "../api/client.ts";
import type { PermissionRequest } from "../api/types.ts";
import { formatValue } from "../lib/format.ts";
import { useModels } from "../hooks/use-models.ts";
import type { UseSessionResult, TokenStats } from "../hooks/use-session.ts";
import { MessageInput } from "../components/message-input.tsx";
import { MessageList } from "../components/message-list.tsx";
import { ModelSelector } from "../components/model-selector.tsx";
import { THEME_ICONS, THEME_NAMES, THEMES, type Theme } from "../lib/theme.ts";

interface ChatPageProps {
  client: ApiClient;
  session: UseSessionResult;
  theme: Theme;
  onSelectTheme: (theme: Theme) => void;
  onRenameSession: (id: string, title: string) => void;
}

/** 欢迎页建议卡片（点击即发起对话）— Round 2 文案贴合 Agent 场景 */
const SUGGESTIONS = [
  {
    icon: "🔍",
    title: "让 Agent 分析项目代码",
    desc: "上传仓库路径，读懂架构与关键模块",
    prompt: "请帮我分析当前项目的代码结构：梳理主要模块、核心入口、依赖关系，并指出值得关注的设计点。",
  },
  {
    icon: "🤝",
    title: "多 Agent 协作完成任务",
    desc: "主 Agent 派遣子 Agent 并行处理子任务",
    prompt: "请演示多 Agent 协作：把一个「调研并总结 3 个开源 TUI 框架」的任务拆解成子任务，派子 Agent 分工执行后汇总结果。",
  },
  {
    icon: "🧪",
    title: "用沙箱试跑实验性代码",
    desc: "临时脚本在隔离沙箱执行，安全可控",
    prompt: "请用沙箱工具帮我写并运行一个 Python 脚本，生成一份 2024 年 1-6 月的模拟销售数据并输出统计摘要。",
  },
  {
    icon: "⚡",
    title: "写一个 CLI 工具",
    desc: "从零搭建 Node.js 命令行程序",
    prompt: "请帮我设计并实现一个简单的 Node.js CLI 工具：支持参数解析、子命令和彩色输出。",
  },
];

export function ChatPage({ client, session, theme, onSelectTheme, onRenameSession }: ChatPageProps) {
  const models = useModels(client);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [showInspector, setShowInspector] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // 顶栏会话标题行内编辑（双击进入）
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  // 欢迎页建议卡片 → 填入输入框（Round 3：DeepSeek 式「点卡片填框待编辑」）
  const [suggestedPrompt, setSuggestedPrompt] = useState("");
  const [composerKey, setComposerKey] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null);

  // 自动选择默认模型
  useEffect(() => {
    if (!selectedModel && models.models.length > 0) {
      const defaultModel = models.models.find((m) => m.isDefault);
      setSelectedModel(defaultModel?.id ?? models.models[0]?.id ?? null);
    }
  }, [models.models, selectedModel]);

  // 自动滚动到底部（依赖消息数量变化而非整个数组，避免流式更新抖动）
  const messageCount = session.activeMessages.length;
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageCount]);

  // 点击外部关闭设置菜单
  useEffect(() => {
    if (!showSettings) return;
    const onPointerDown = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [showSettings]);

  // Round 3：设置下拉 Esc 关闭（关闭后焦点回到齿轮按钮）+ 打开时聚焦首项
  useEffect(() => {
    if (!showSettings) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowSettings(false);
        settingsBtnRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showSettings]);

  // Round 3：流式生成中「按 Esc 中断」— 全局 Esc（重命名输入框内的 Esc 不拦截）
  useEffect(() => {
    if (!session.isStreaming) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(".session-card__rename-input, .chat-page__session-title-input")) return;
      e.preventDefault();
      void session.interrupt();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [session.isStreaming, session]);

  /** Round 3：建议卡片 → 填入输入框待编辑后发送（DeepSeek 式交互） */
  const fillPrompt = (prompt: string) => {
    if (session.creatingSession || session.isStreaming) return;
    setSuggestedPrompt(prompt);
    setComposerKey((k) => k + 1);
  };

  const commitTitleEdit = () => {
    const id = session.activeSession?.id;
    if (id) onRenameSession(id, titleDraft);
    setEditingTitle(false);
  };

  return (
    <div className="chat-page">
      {/* 顶部状态栏 */}
      <header className="chat-page__header">
        <div className="chat-page__header-left">
          <span className="chat-page__brand-mark" aria-hidden="true">⚡</span>
          {editingTitle && session.activeSession ? (
            <input
              autoFocus
              type="text"
              className="chat-page__session-title-input"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTitleEdit();
                if (e.key === "Escape") setEditingTitle(false);
              }}
              onBlur={commitTitleEdit}
              onFocus={(e) => e.currentTarget.select()}
            />
          ) : (
            <h2
              className="chat-page__session-title"
              title={session.activeSession ? "双击重命名会话" : "FengAgentCli"}
              onDoubleClick={() => {
                if (!session.activeSession) return;
                setTitleDraft(session.activeSession.title);
                setEditingTitle(true);
              }}
            >
              {session.activeSession?.title ?? "FengAgentCli"}
            </h2>
          )}
          {session.isStreaming && (
            <span className="chat-page__status chat-page__status--running">
              Running
            </span>
          )}
        </div>
        <div className="chat-page__header-right">
          {models.loading ? (
            <span className="chat-page__model-loading">
              <Loader2 size={14} className="chat-page__model-loading-icon" />
              <span>Loading…</span>
            </span>
          ) : models.error ? (
            <span className="chat-page__model-error" title={models.error}>
              <AlertCircle size={14} />
            </span>
          ) : (
            <ModelSelector
              models={models.models}
              selectedModel={selectedModel}
              onSelect={setSelectedModel}
            />
          )}
          {session.error && (
            <span className="chat-page__error-icon" title={session.error}>
              <AlertCircle size={16} />
            </span>
          )}
          <button
            type="button"
            className="chat-page__toggle-inspector"
            onClick={() => setShowInspector((v) => !v)}
            aria-label={showInspector ? "Hide inspector" : "Show inspector"}
            title="检查器（权限 / 消息）"
          >
            {showInspector ? (
              <PanelRightClose size={18} />
            ) : (
              <PanelRightOpen size={18} />
            )}
          </button>
          {/* 设置下拉：主题选择 + 面板开关（Round 2） */}
          <div className="chat-page__settings" ref={settingsRef}>
            <button
              type="button"
              ref={settingsBtnRef}
              className="chat-page__toggle-inspector chat-page__settings-btn"
              onClick={() => setShowSettings((v) => !v)}
              aria-label="Settings"
              aria-expanded={showSettings}
              title={`设置 · 主题：${THEME_NAMES[theme]}`}
            >
              <Settings size={17} className={showSettings ? "chat-page__settings-icon--open" : ""} />
            </button>
            {showSettings && (
              <div className="settings-menu" role="menu" aria-label="设置">
                <div className="settings-menu__group">
                  <div className="settings-menu__label">主题外观</div>
                  {THEMES.map((t, i) => (
                    <button
                      key={t}
                      type="button"
                      autoFocus={i === 0}
                      className={`settings-menu__item ${theme === t ? "settings-menu__item--active" : ""}`}
                      onClick={() => {
                        onSelectTheme(t);
                        setShowSettings(false);
                        settingsBtnRef.current?.focus();
                      }}
                    >
                      <span className="settings-menu__icon">{THEME_ICONS[t]}</span>
                      <span className="settings-menu__text">{THEME_NAMES[t]}</span>
                      {theme === t && <Check size={14} className="settings-menu__check" />}
                    </button>
                  ))}
                </div>
                <div className="settings-menu__divider" />
                <div className="settings-menu__group">
                  <div className="settings-menu__label">面板</div>
                  <button
                    type="button"
                    className="settings-menu__item"
                    onClick={() => setShowInspector((v) => !v)}
                  >
                    <span className="settings-menu__text">消息检查器</span>
                    <span className={`settings-menu__toggle ${showInspector ? "settings-menu__toggle--on" : ""}`}>
                      {showInspector ? "开" : "关"}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* 错误提示 */}
      {session.error && (
        <div className="chat-page__error-bar">
          <AlertCircle size={15} />
          <span>{session.error}</span>
        </div>
      )}

      {/* 消息列表 */}
      <main className="chat-page__messages">
        {session.activeSession ? (
          session.activeMessages.length === 0 ? (
            /* Round 3：空会话引导 — 新会话尚未发消息时给出轻量引导 */
            <div className="chat-page__empty-guide">
              <div className="empty-guide__icon" aria-hidden="true">⚡</div>
              <p className="empty-guide__title">新会话已就绪</p>
              <p className="empty-guide__desc">
                在下方输入消息，或从建议问题开始 —— 试试这些：
              </p>
              <div className="empty-guide__chips">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.title}
                    type="button"
                    className="empty-guide__chip"
                    onClick={() =>
                      void session.sendMessage(s.prompt, selectedModel ?? undefined)
                    }
                  >
                    <span aria-hidden="true">{s.icon}</span>
                    {s.title}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <MessageList messages={session.activeMessages} isStreaming={session.isStreaming} />
          )
        ) : (
          <div className="chat-page__no-session">
            <div className="welcome-hero">
              <div className="welcome-hero__icon" aria-hidden="true">⚡</div>
              <h2 className="welcome-hero__title">FengAgentCli</h2>
              <p className="welcome-hero__subtitle">
                开源本地 AI Agent 对话平台 · 对话 / 工具调用 / 多 Agent / MCP / 沙箱
              </p>
              <div className="welcome-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.title}
                    type="button"
                    className="welcome-suggestion"
                    onClick={() => fillPrompt(s.prompt)}
                  >
                    <span className="welcome-suggestion__icon" aria-hidden="true">
                      {s.icon}
                    </span>
                    <span className="welcome-suggestion__body">
                      <span className="welcome-suggestion__title">{s.title}</span>
                      <span className="welcome-suggestion__desc">{s.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="welcome-hint">
                💡 点击卡片将问题填入输入框，确认后按 Enter 发送
              </p>
              <div className="welcome-features">
                <span className="welcome-card__feature-tag">💬 智能对话</span>
                <span className="welcome-card__feature-tag">🔧 工具调用</span>
                <span className="welcome-card__feature-tag">🤖 多 Agent</span>
                <span className="welcome-card__feature-tag">🧪 沙箱</span>
                <span className="welcome-card__feature-tag">🧠 记忆系统</span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>

      {/* Token 用量统计栏 */}
      {session.activeSession && session.sessionTokenStats && (
        <TokenStatsBar stats={session.sessionTokenStats} />
      )}

      {/* 输入框 */}
      <footer className="chat-page__footer">
        {session.activeSession ? (
          <MessageInput
            busy={session.isStreaming}
            placeholder="问 FengAgent 任何问题..."
            onSubmit={(text) => void session.sendMessage(text, selectedModel ?? undefined)}
            onCancel={() => void session.interrupt()}
          />
        ) : (
          <div className="chat-page__no-session-input">
            <MessageInput
              key={composerKey}
              busy={session.creatingSession || session.isStreaming}
              placeholder="输入消息开始对话..."
              initialValue={suggestedPrompt}
              autoFocus={composerKey > 0}
              onSubmit={async (text) => {
                // 无活跃会话时自动创建，然后发送消息
                await session.createSession();
                // 等待 createSession 完成后 activeSessionId 会更新
                // 使用 setTimeout 让 React 状态更新后再发送
                setTimeout(() => {
                  void session.sendMessage(text, selectedModel ?? undefined);
                }, 100);
              }}
              onCancel={() => void session.interrupt()}
            />
          </div>
        )}
      </footer>

      {/* 检查器面板 */}
      {showInspector && (
        <aside className="chat-page__inspector">
          <h3 className="chat-page__inspector-title">Permissions</h3>
          {session.pendingPermissions.length === 0 ? (
            <p className="chat-page__inspector-empty">
              No pending permission requests.
            </p>
          ) : (
            <div className="chat-page__permissions">
              {session.pendingPermissions.map((req) => (
                <PermissionCard
                  key={req.reqId}
                  request={req}
                  onAllow={() =>
                    void session.respondPermission(req.reqId, {
                      decision: "allow",
                    })
                  }
                  onDeny={() =>
                    void session.respondPermission(req.reqId, {
                      decision: "deny",
                    })
                  }
                />
              ))}
            </div>
          )}
          <h3 className="chat-page__inspector-title">Messages</h3>
          <div className="chat-page__inspector-messages">
            {session.activeMessages.map((msg) => (
              <div key={msg.id} className="chat-page__inspector-msg">
                <span className="chat-page__inspector-msg-role">{msg.role}</span>
                <span className="chat-page__inspector-msg-text">
                  {msg.text.slice(0, 60)}
                  {msg.text.length > 60 ? "..." : ""}
                </span>
                {msg.toolCalls.length > 0 && (
                  <span className="chat-page__inspector-msg-tools">
                    {msg.toolCalls.length} tools
                  </span>
                )}
              </div>
            ))}
            {session.activeMessages.length === 0 && (
              <p className="chat-page__inspector-empty">No messages.</p>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

/** 权限请求卡片 */
function PermissionCard({
  request,
  onAllow,
  onDeny,
}: {
  request: PermissionRequest;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="permission-card">
      <div className="permission-card__header">
        <span className="permission-card__tool">{request.toolName}</span>
      </div>
      {request.reason && (
        <p className="permission-card__reason">{request.reason}</p>
      )}
      <pre className="permission-card__input">
        {formatValue(request.input)}
      </pre>
      <div className="permission-card__actions">
        <button
          type="button"
          className="permission-card__btn permission-card__btn--allow"
          onClick={onAllow}
        >
          Allow
        </button>
        <button
          type="button"
          className="permission-card__btn permission-card__btn--deny"
          onClick={onDeny}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

/** Token 用量统计栏 — 显示会话级累计 token 和缓存命中 */
function TokenStatsBar({ stats }: { stats: TokenStats }) {
  const totalInput = stats.inputTokens;
  const totalOutput = stats.outputTokens;
  const totalCacheRead = stats.cacheReadTokens ?? 0;

  // 缓存命中率 = cacheRead / (cacheRead + 非缓存输入)
  const nonCachedInput = totalInput - totalCacheRead;
  const cacheHitRate = totalCacheRead + nonCachedInput > 0
    ? Math.round((totalCacheRead / (totalCacheRead + nonCachedInput)) * 100)
    : 0;

  return (
    <div className="token-stats-bar">
      <span className="token-stats-bar__item">
        📥 输入 <strong>{totalInput.toLocaleString()}</strong>
      </span>
      <span className="token-stats-bar__item">
        📤 输出 <strong>{totalOutput.toLocaleString()}</strong>
      </span>
      {totalCacheRead > 0 && (
        <>
          <span className="token-stats-bar__item">
            ⚡ 缓存命中 <strong>{totalCacheRead.toLocaleString()}</strong>
          </span>
          <span className="token-stats-bar__item token-stats-bar__item--highlight">
            🎯 命中率 <strong>{cacheHitRate}%</strong>
          </span>
        </>
      )}
      <span className="token-stats-bar__item token-stats-bar__item--muted">
        合计 <strong>{(totalInput + totalOutput).toLocaleString()}</strong> tokens
      </span>
    </div>
  );
}
