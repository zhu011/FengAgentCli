/**
 * @fengagent/web-ui — 消息列表
 *
 * 设计：助手消息带头像（品牌渐变圆标）+ 全文展示；
 * 用户消息右侧圆角气泡。参考 DeepSeek / 豆包对话流排版。
 * 保留工具调用卡片与流式加载指示器。
 */

import { memo } from "react";
import type { DisplayMessage } from "../hooks/use-session.ts";
import { MarkdownRenderer } from "./markdown-renderer.tsx";
import { ToolCallCard } from "./tool-call-card.tsx";

interface MessageListProps {
  messages: DisplayMessage[];
}

function MessageListImpl({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="message-list__empty">
        <p>在下方输入消息，开始与 FengAgent 对话。</p>
      </div>
    );
  }

  return (
    <div className="message-list">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </div>
  );
}

export const MessageList = memo(MessageListImpl);

function MessageBubble({ message }: { message: DisplayMessage }) {
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
              <MarkdownRenderer text={message.text} />
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
      </div>
    </div>
  );
}
