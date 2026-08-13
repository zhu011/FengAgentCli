/**
 * @fengagent/web-ui — 消息输入框
 *
 * 多行输入，Enter 发送，Shift+Enter 换行。
 * 流式运行时显示 Stop 按钮。
 */

import { useState, type KeyboardEvent } from "react";
import { CornerDownLeft, Square } from "lucide-react";

interface MessageInputProps {
  busy: boolean;
  placeholder?: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

export function MessageInput({
  busy,
  placeholder = "Type a message...",
  onSubmit,
  onCancel,
}: MessageInputProps) {
  const [value, setValue] = useState("");
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

  return (
    <div className="message-input">
      <textarea
        className="message-input__textarea"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        placeholder={busy ? "Assistant is responding..." : placeholder}
        rows={3}
        aria-label="Message input"
      />
      <div className="message-input__footer">
        <span className="message-input__hint">
          {busy ? "Streaming..." : "Enter to send · Shift+Enter for new line"}
        </span>
        {busy ? (
          <button
            type="button"
            className="message-input__btn message-input__btn--stop"
            onClick={onCancel}
          >
            <Square size={15} />
            <span>Stop</span>
          </button>
        ) : (
          <button
            type="button"
            className="message-input__btn"
            onClick={submit}
            disabled={value.trim().length === 0}
          >
            <CornerDownLeft size={16} />
            <span>Send</span>
          </button>
        )}
      </div>
    </div>
  );
}
