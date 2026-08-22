/**
 * @fengagent/web-ui — 消息列表
 *
 * 设计：助手消息带头像（品牌渐变圆标）+ 全文展示；
 * 用户消息右侧圆角气泡。参考 DeepSeek / 豆包对话流排版。
 * 保留工具调用卡片与流式加载指示器。
 * Round 2：消息流底部「生成中」动画指示器（豆包式彩色光点）——
 * 发送消息后、首条助手消息出现前的空窗期显示。
 * Round 3：生成中指示器增强 — 已用时长 + 「按 Esc 中断」提示。
 * Round 4：思考过程可视化 — 思考内容流式显示 + 点击展开/折叠。
 * Round 5：每条消息右侧「查看调用链 / 查看评测」按钮（deep-link 到观测/评测页）。
 */

import { memo, useEffect, useRef, useState } from "react";
import { Activity, FlaskConical } from "lucide-react";
import type { DisplayMessage } from "../hooks/use-session.ts";
import { MarkdownRenderer } from "./markdown-renderer.tsx";
import { ToolCallCard } from "./tool-call-card.tsx";

interface MessageListProps {
  messages: DisplayMessage[];
  isStreaming: boolean;
  /** 查看该消息的调用链（deep-link 到观测页） */
  onViewCallChain?: (messageId: string) => void;
  /** 查看该消息的评测结果（deep-link 到评测页） */
  onViewEval?: (messageId: string) => void;
}

/** Round 3：生成中已用秒数计时（指示器消失时归零） */
function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [active]);
  return elapsed;
}

function MessageListImpl({ messages, isStreaming, onViewCallChain, onViewEval }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="message-list__empty">
        <p>在下方输入消息，开始与 FengAgent 对话。</p>
      </div>
    );
  }

  // 生成中指示器：正在流式输出且没有任何处于 streaming 的助手消息
  const hasActiveStreaming = messages.some((m) => m.streaming);
  const showGenerating = isStreaming && !hasActiveStreaming;
  const elapsed = useElapsed(showGenerating);

  return (
    <div className="message-list">
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          onViewCallChain={onViewCallChain}
          onViewEval={onViewEval}
        />
      ))}
      {showGenerating && (
        <div className="message-row message-row--assistant">
          <div className="message-avatar" aria-hidden="true">⚡</div>
          <div className="generating-indicator" role="status" aria-label="正在生成">
            <span className="generating-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="generating-indicator__text">正在生成…</span>
            {elapsed > 0 && (
              <span className="generating-elapsed" aria-hidden="true">
                {elapsed}s
              </span>
            )}
            <span className="generating-hint">
              按 <kbd>Esc</kbd> 中断
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export const MessageList = memo(MessageListImpl);

function MessageBubble({
  message,
  onViewCallChain,
  onViewEval,
}: {
  message: DisplayMessage;
  onViewCallChain?: (messageId: string) => void;
  onViewEval?: (messageId: string) => void;
}) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  // 系统消息：居中置灰卡片
  if (isSystem) {
    return (
      <div className="message-row message-row--system">
        <div className="message-bubble message-bubble--system">
          <div className="message-bubble__body">
            <p className="message-bubble__text">{message.text}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`message-row message-row--${message.role}`}>
      {!isUser && (
        <div className="message-avatar" aria-hidden="true">⚡</div>
      )}
      <div className={`message-bubble message-bubble--${message.role}`}>
        <div className="message-bubble__header">
          <span className="message-bubble__role">
            {isUser ? "You" : "FengAgentCli"}
          </span>
          {message.streaming && (
            <span className="message-bubble__streaming">
              <span className="streaming-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </span>
          )}
        </div>

        <div className="message-bubble__body">
          {isUser ? (
            <p className="message-bubble__text">{message.text}</p>
          ) : message.text.length > 0 ? (
            <>
              {message.thinking.length > 0 && (
                <ThinkingPanel
                  text={message.thinking}
                  streaming={message.streaming}
                />
              )}
              <MarkdownRenderer text={message.text} />
              {message.streaming && (
                <span className="typing-cursor" aria-hidden="true">▍</span>
              )}
            </>
          ) : message.thinking.length > 0 ? (
            <>
              <ThinkingPanel
                text={message.thinking}
                streaming={message.streaming}
              />
              {message.streaming && (
                <span className="typing-cursor" aria-hidden="true">▍</span>
              )}
            </>
          ) : message.streaming ? (
            <span className="message-bubble__placeholder">
              <span className="streaming-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              思考中...
            </span>
          ) : null}

          {message.toolCalls.length > 0 && (
            <div className="message-bubble__tools">
              {message.toolCalls.map((tc) => (
                <ToolCallCard key={tc.toolUseId} toolCall={tc} />
              ))}
            </div>
          )}
        </div>

        {/* Round 5：每轮对话查看调用链 / 评测（deep-link） */}
        {!message.streaming && (onViewCallChain || onViewEval) && (
          <div className="message-bubble__actions">
            {onViewCallChain && (
              <button
                type="button"
                className="message-bubble__action"
                onClick={() => onViewCallChain(message.id)}
                title="查看该轮对话的调用链（观测页）"
              >
                <Activity size={12} /> 查看调用链
              </button>
            )}
            {onViewEval && (
              <button
                type="button"
                className="message-bubble__action"
                onClick={() => onViewEval(message.id)}
                title="查看该轮对话的评测结果（评测页）"
              >
                <FlaskConical size={12} /> 查看评测
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 思考过程面板（Round 4）— 流式显示思考内容，支持点击展开/折叠。
 *
 * 交互：
 * - 思考内容流式到达时自动展开一次，之后交还用户控制；
 * - 点击标题栏在展开 / 折叠间切换（折叠后仍可见「深度思考 · N 字」摘要）；
 * - 折叠 / 展开带平滑过渡动画（max-height + opacity）。
 */
function ThinkingPanel({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const hasAutoOpened = useRef(false);

  // 流式期间思考内容首次出现时自动展开一次（之后交还用户控制）
  useEffect(() => {
    if (streaming && text.length > 0 && !hasAutoOpened.current) {
      hasAutoOpened.current = true;
      setCollapsed(false);
    }
  }, [streaming, text]);

  const toggle = () => setCollapsed((c) => !c);

  return (
    <div
      className={`thinking-panel ${collapsed ? "thinking-panel--collapsed" : "thinking-panel--expanded"}`}
    >
      <button
        type="button"
        className="thinking-panel__header"
        onClick={toggle}
        aria-expanded={!collapsed}
        title={collapsed ? "展开思考过程" : "折叠思考过程"}
      >
        <span className="thinking-panel__icon" aria-hidden="true">💭</span>
        <span className="thinking-panel__label">深度思考</span>
        <span className="thinking-panel__meta">
          {text.length} 字
          {streaming && (
            <span className="thinking-panel__streaming" aria-hidden="true">
              <span className="streaming-dots">
                <span />
                <span />
                <span />
              </span>
            </span>
          )}
        </span>
        <span
          className="thinking-panel__chevron"
          aria-hidden="true"
        >
          ▾
        </span>
      </button>
      {!collapsed && (
        <div className="thinking-panel__body" role="region">
          {text}
        </div>
      )}
    </div>
  );
}
