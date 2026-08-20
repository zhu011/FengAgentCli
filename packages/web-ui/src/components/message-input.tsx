/**
 * @fengagent/web-ui — 消息输入框（Composer）
 *
 * 圆角卡片式输入区（参考 DeepSeek / 豆包 Composer）：
 * 多行输入，Enter 发送，Shift+Enter 换行。
 * 流式运行时显示 Stop 按钮。
 */

import { useState, type KeyboardEvent } from "react";
import { CornerDownLeft, Square } from "lucide-react";

interface MessageInputProps {
  busy: boolean;
  placeholder?: string;
  /** Round 3：建议卡片填入的初始文本（配合 key 重挂载生效） */
  initialValue?: string;
  /** Round 3：挂载后自动聚焦输入框 */
  autoFocus?: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

export function MessageInput({
  busy,
  placeholder = "Type a message...",
  initialValue = "",
  autoFocus = false,
  onSubmit,
  onCancel,
}: MessageInputProps) {
  const [value, setValue] = useState(initialValue);
  const [isComposing, setIsComposing] = useState(false);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setValue("");
    onSubmit(trimmed);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 输入法组合中不触发
    if (
      isComposing ||
      e.nativeEvent.isComposing ||
      e.key === "Process" ||
      e.keyCode === 229
    ) {
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const canSend = value.trim().length > 0 && !busy;

  return (
    <div className={`composer${busy ? " composer--busy" : ""}`}>
      <textarea
        className="composer__textarea"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        placeholder={busy ? "FengAgent 正在回复..." : placeholder}
        rows={3}
        aria-label="Message input"
      />
      <div className="composer__footer">
        <span className="composer__hint">
          {busy ? "Streaming..." : "Enter 发送 · Shift+Enter 换行"}
        </span>
        {busy ? (
          <button
            type="button"
            className="composer__btn composer__btn--stop"
            onClick={onCancel}
          >
            <Square size={15} />
            <span>Stop</span>
          </button>
        ) : (
          <button
            type="button"
            className="composer__btn"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send message"
          >
            <CornerDownLeft size={16} />
            <span>发送</span>
          </button>
        )}
      </div>
    </div>
  );
}
