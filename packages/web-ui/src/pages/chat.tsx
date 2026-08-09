/**
 * @fengagent/web-ui — 聊天页面
 *
 * 组合消息列表、输入框、模型选择器、状态栏。
 * 接受外部传入的 session 状态（由 App 层统一管理）。
 */

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { ApiClient } from "../api/client.ts";
import type { PermissionRequest } from "../api/types.ts";
import { formatValue } from "../lib/format.ts";
import { useModels } from "../hooks/use-models.ts";
import type { UseSessionResult } from "../hooks/use-session.ts";
import { MessageInput } from "../components/message-input.tsx";
import { MessageList } from "../components/message-list.tsx";
import { ModelSelector } from "../components/model-selector.tsx";

interface ChatPageProps {
  client: ApiClient;
  session: UseSessionResult;
}

export function ChatPage({ client, session }: ChatPageProps) {
  const models = useModels(client);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [showInspector, setShowInspector] = useState(false);
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

  return (
    <div className="chat-page">
      {/* 顶部状态栏 */}
      <header className="chat-page__header">
        <div className="chat-page__header-left">
          <h2 className="chat-page__session-title">
            {session.activeSession?.title ?? "No session"}
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
          >
            {showInspector ? (
              <PanelRightClose size={18} />
            ) : (
              <PanelRightOpen size={18} />
            )}
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
            <p>No active session. Create a new chat to get started.</p>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>

      {/* 输入框 */}
      <footer className="chat-page__footer">
        {session.activeSession ? (
          <MessageInput
            busy={session.isStreaming}
            placeholder="Ask FengAgent anything..."
            onSubmit={(text) => void session.sendMessage(text, selectedModel ?? undefined)}
            onCancel={() => void session.interrupt()}
          />
        ) : (
          <div className="chat-page__no-session-input">
            <button
              type="button"
              className="chat-page__create-btn"
              onClick={() => void session.createSession()}
              disabled={session.creatingSession}
            >
              {session.creatingSession ? "Creating..." : "New Chat"}
            </button>
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
