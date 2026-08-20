/**
 * @fengagent/web-ui — 聊天页面
 *
 * 设计语言参考 DeepSeek / 豆包 / 通义千问：
 * - 顶栏：品牌字标 + 模型选择 + 面板开关 + 主题切换
 * - 欢迎态：居中 Hero + 建议卡片（点击直接发起对话）
 * - 对话流：居中窄栏（max-width 768px），助手带头像、用户右对齐气泡
 */

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  GitBranch,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import type { ApiClient } from "../api/client.ts";
import type { PermissionRequest } from "../api/types.ts";
import { formatValue } from "../lib/format.ts";
import { useModels } from "../hooks/use-models.ts";
import type { UseSessionResult, TokenStats } from "../hooks/use-session.ts";
import { MessageInput } from "../components/message-input.tsx";
import { MessageList } from "../components/message-list.tsx";
import { ModelSelector } from "../components/model-selector.tsx";
import { GraphPanel } from "../components/graph-panel.tsx";
import { THEME_ICONS, THEME_NAMES, type Theme } from "../lib/theme.ts";

interface ChatPageProps {
  client: ApiClient;
  session: UseSessionResult;
  theme: Theme;
  onCycleTheme: () => void;
}

/** 欢迎页建议卡片（点击即发起对话） */
const SUGGESTIONS = [
  {
    icon: "🛠️",
    title: "写一个 CLI 工具",
    desc: "从零搭建一个 Node.js 命令行程序",
    prompt: "请帮我设计并实现一个简单的 Node.js CLI 工具：支持参数解析、子命令和彩色输出。",
  },
  {
    icon: "💡",
    title: "解释这段代码",
    desc: "粘贴代码，理解它的逻辑与作用",
    prompt: "请解释下面这段代码的逻辑：",
  },
  {
    icon: "🧠",
    title: "头脑风暴",
    desc: "一起构思产品功能与方案",
    prompt: "我们来做一次头脑风暴：请针对「个人知识库工具」给出 5 个有趣的产品功能点子。",
  },
  {
    icon: "📝",
    title: "总结文章要点",
    desc: "长文本 → 结构化摘要",
    prompt: "请把下面这段内容总结为带要点的结构化摘要：",
  },
];

export function ChatPage({ client, session, theme, onCycleTheme }: ChatPageProps) {
  const models = useModels(client);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [showInspector, setShowInspector] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

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

  /** 无活跃会话时：创建会话并发送建议问题 */
  const startWithPrompt = async (prompt: string) => {
    if (session.creatingSession || session.isStreaming) return;
    await session.createSession();
    setTimeout(() => {
      void session.sendMessage(prompt, selectedModel ?? undefined);
    }, 100);
  };

  return (
    <div className="chat-page">
      {/* 顶部状态栏 */}
      <header className="chat-page__header">
        <div className="chat-page__header-left">
          <span className="chat-page__brand-mark" aria-hidden="true">⚡</span>
          <h2 className="chat-page__session-title">
            {session.activeSession?.title ?? "FengAgentCli"}
          </h2>
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
          {session.activeSession && (
            <button
              type="button"
              className="chat-page__toggle-inspector"
              onClick={() => {
                setShowGraph((v) => !v);
                if (!showGraph) void session.refreshGraph();
              }}
              aria-label={showGraph ? "Hide graph" : "Show graph"}
              title="对话图（分支可视化 / 回退）"
            >
              <GitBranch size={18} color={showGraph ? "#38bdf8" : undefined} />
            </button>
          )}
          <button
            type="button"
            className="chat-page__toggle-inspector chat-page__theme-btn"
            onClick={onCycleTheme}
            aria-label="Toggle theme"
            title={`主题：${THEME_NAMES[theme]}（点击切换）`}
          >
            <span className="chat-page__theme-icon">{THEME_ICONS[theme]}</span>
          </button>
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
          <MessageList messages={session.activeMessages} />
        ) : (
          <div className="chat-page__no-session">
            <div className="welcome-hero">
              <div className="welcome-hero__icon" aria-hidden="true">⚡</div>
              <h2 className="welcome-hero__title">FengAgentCli</h2>
              <p className="welcome-hero__subtitle">
                开源本地 AI Agent 对话平台 · 对话 / 工具调用 / 多 Agent / MCP
              </p>
              <div className="welcome-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.title}
                    type="button"
                    className="welcome-suggestion"
                    onClick={() => void startWithPrompt(s.prompt)}
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
              <div className="welcome-features">
                <span className="welcome-card__feature-tag">💬 智能对话</span>
                <span className="welcome-card__feature-tag">🔧 工具调用</span>
                <span className="welcome-card__feature-tag">🤖 多 Agent</span>
                <span className="welcome-card__feature-tag">🧩 插件化</span>
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
              busy={session.creatingSession || session.isStreaming}
              placeholder="输入消息开始对话..."
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

      {/* 对话图面板（Phase 4：分支可视化 + 回退） */}
      {showGraph && session.activeSession && session.graph && (
        <GraphPanel
          graph={session.graph}
          busy={session.isStreaming}
          onRollback={(nodeId) => void session.rollback(nodeId)}
        />
      )}
      {showGraph && session.activeSession && !session.graph && (
        <aside className="chat-page__graph-panel" style={{ padding: 16 }}>
          <p className="chat-page__inspector-empty">
            {session.graphError ?? "对话图加载中..."}
          </p>
        </aside>
      )}

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
