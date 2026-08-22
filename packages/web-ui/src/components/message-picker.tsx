/**
 * @fengagent/web-ui — 会话消息选择器（deep-link 会话级进入时展示）
 *
 * 列出会话的按消息粒度摘要（用户消息 + 助手消息），
 * 点击某条消息后聚焦其调用链 / 评测结果。
 */

import type { MessageTraceSummary } from "../api/types.ts";
import { formatDuration } from "../lib/format.ts";

interface MessagePickerProps {
  messages: MessageTraceSummary[];
  /** 当前聚焦的消息 ID（高亮） */
  activeMessageId: string | null;
  /** 点击消息回调 */
  onPick: (m: MessageTraceSummary) => void;
  /** 空态文案 */
  emptyText?: string;
}

export function MessagePicker({
  messages,
  activeMessageId,
  onPick,
  emptyText = "该会话暂无消息（可能尚未产生 trace 记录）",
}: MessagePickerProps) {
  if (messages.length === 0) {
    return (
      <div className="obs-msg-picker obs-msg-picker--empty">
        {emptyText}
      </div>
    );
  }
  return (
    <div className="obs-msg-picker">
      <div className="obs-msg-picker__head">
        <span className="obs-msg-picker__title">会话消息</span>
        <span className="obs-msg-picker__count">{messages.length} 条 · 点击查看详情</span>
      </div>
      <ul className="obs-msg-picker__list">
        {messages.map((m, i) => (
          <li key={m.messageId ?? `u-${i}`}>
            <button
              type="button"
              className={`obs-msg-picker__item ${m.messageId === activeMessageId ? "obs-msg-picker__item--active" : ""}`}
              onClick={() => onPick(m)}
              title="查看该消息的详情"
            >
              <span className={`obs-msg-picker__role obs-msg-picker__role--${m.role}`}>
                {m.role === "user" ? "用户" : "助手"}
              </span>
              <span className="obs-msg-picker__text">
                {truncateText(m.text, 64) || "（空回复）"}
              </span>
              <span className="obs-msg-picker__meta">
                {m.role === "assistant"
                  ? `${m.llmCallCount} LLM · ${m.toolCallCount} 工具 · ${formatDuration(m.durationMs ?? 0)}`
                  : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 截断文本 */
function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
