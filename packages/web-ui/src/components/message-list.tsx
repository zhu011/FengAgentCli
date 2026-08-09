/**
 * @fengagent/web-ui — 消息列表
 *
 * 渲染对话消息列表，区分 user/assistant。
 * 包含工具调用卡片和流式加载指示器。
 */

import { memo } from "react";
import { Bot, User } from "lucide-react";
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
        <p>Start a conversation by sending a message below.</p>
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

  return (
    <div className={`message-bubble message-bubble--${message.role}`}>
      <div className="message-bubble__header">
        {isUser ? <User size={15} aria-hidden="true" /> : <Bot size={15} aria-hidden="true" />}
        <span className="message-bubble__role">
          {isUser ? "You" : "Assistant"}
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
          <MarkdownRenderer text={message.text} />
        ) : message.streaming ? (
          <span className="message-bubble__placeholder">
            <span className="streaming-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            Thinking...
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
  );
}
