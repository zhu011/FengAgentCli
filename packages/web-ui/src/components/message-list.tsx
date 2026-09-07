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
import type { DisplayMessage, DisplayStep } from "../hooks/use-session.ts";
import { MarkdownRenderer } from "./markdown-renderer.tsx";
import { ToolCallCard } from "./tool-call-card.tsx";

interface MessageListProps {
  messages: DisplayMessage[];
  isStreaming: boolean;
  /**
   * 本轮生成的开始时间戳（useSession.runStartedAt，App 级锚点）。
   *
   * 计时以「轮」为锚而非组件挂载：view 切换（如切到评测页再回来）会卸载/重挂
   * MessageList，若锚点在组件内（ref/state）必然随卸载归零 → 计时「重启」假象。
   * 锚点由 useSession 持有、跨 view 存活，这里只负责按 now - runStartedAt 跳动。
   */
  runStartedAt?: number | null;
  /** 查看该消息的调用链（deep-link 到观测页） */
  onViewCallChain?: (messageId: string) => void;
  /** 查看该消息的评测结果（deep-link 到评测页） */
  onViewEval?: (messageId: string) => void;
}

/**
 * 「正在生成… Ns」已用秒数。
 *
 * 修复（AGE-29）：锚点 runStartedAt 由 useSession（App 层）持有，组件卸载/
 * 重挂（切评测/观测页再回来）不重启；只有新的一轮生成（runStartedAt 更新）
 * 才重新计时。组件内不保存任何开始时间。
 */
function useElapsed(active: boolean, since: number | null): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active || since === null) {
      setElapsed(0);
      return;
    }
    const tick = () => {
      setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000)));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active, since]);
  return elapsed;
}

function MessageListImpl({ messages, isStreaming, runStartedAt, onViewCallChain, onViewEval }: MessageListProps) {
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
  const elapsed = useElapsed(showGenerating, runStartedAt ?? null);

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

  // AGE-29：同一轮提问的多段助手步骤聚合进同一个回复（steps 按序渲染，
  // 工具调用不再拆成多段独立对话；单段回答无 steps，走原渲染路径）
  const steps =
    message.steps && message.steps.length > 0 ? message.steps : null;

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
          ) : steps ? (
            <div className="message-bubble__steps">
              {steps.map((step, i) => (
                <AssistantStep
                  key={step.messageId}
                  step={step}
                  index={i}
                  count={steps.length}
                  onViewCallChain={onViewCallChain}
                  onViewEval={onViewEval}
                />
              ))}
            </div>
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

          {!steps && message.toolCalls.length > 0 && (
            <div className="message-bubble__tools">
              {message.toolCalls.map((tc) => (
                <ToolCallCard key={tc.toolUseId} toolCall={tc} />
              ))}
            </div>
          )}
        </div>

        {/* Round 5：每轮对话查看调用链 / 评测（deep-link；聚合行内每步一条） */}
        {!steps && !message.streaming && (onViewCallChain || onViewEval) && (
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
 * 助手回复中的一个步骤段（AGE-29 聚合行）。
 *
 * 同一轮回复含多次工具调用 / 多段 LLM 步骤时，按序渲染：步骤标注 → 思考 →
 * 文本 → 工具卡片 → （该步骤的）调用链/评测入口。每步保留真实 messageId，
 * deep-link 到观测/评测页仍定位到具体步骤。
 */
function AssistantStep({
  step,
  index,
  count,
  onViewCallChain,
  onViewEval,
}: {
  step: DisplayStep;
  index: number;
  count: number;
  onViewCallChain?: (messageId: string) => void;
  onViewEval?: (messageId: string) => void;
}) {
  const isLast = index === count - 1;
  const toolNames = step.toolCalls.map((tc) => tc.name).filter(unique);

  return (
    <div
      className={`message-step${isLast ? " message-step--last" : ""}`}
    >
      {count > 1 && (
        <div className="message-step__label">
          <span className="message-step__label-index">步骤 {index + 1}</span>
          {toolNames.length > 0 && (
            <span className="message-step__label-tools">
              🔧 {toolNames.join("、")}
            </span>
          )}
        </div>
      )}

      {step.thinking.length > 0 && (
        <ThinkingPanel text={step.thinking} streaming={step.streaming} />
      )}
      {step.text.length > 0 ? (
        <>
          <MarkdownRenderer text={step.text} />
          {step.streaming && (
            <span className="typing-cursor" aria-hidden="true">▍</span>
          )}
        </>
      ) : step.streaming ? (
        step.thinking.length === 0 && step.toolCalls.length === 0 ? (
          <span className="message-bubble__placeholder">
            <span className="streaming-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            思考中...
          </span>
        ) : null
      ) : null}

      {step.toolCalls.length > 0 && (
        <div className="message-bubble__tools">
          {step.toolCalls.map((tc) => (
            <ToolCallCard key={tc.toolUseId} toolCall={tc} />
          ))}
        </div>
      )}

      {/* 每个步骤独立 deep-link（真实 messageId） */}
      {!step.streaming && (onViewCallChain || onViewEval) && (
        <div className="message-step__actions">
          {onViewCallChain && (
            <button
              type="button"
              className="message-bubble__action"
              onClick={() => onViewCallChain(step.messageId)}
              title="查看该步骤的调用链（观测页）"
            >
              <Activity size={12} /> 查看调用链
            </button>
          )}
          {onViewEval && (
            <button
              type="button"
              className="message-bubble__action"
              onClick={() => onViewEval(step.messageId)}
              title="查看该步骤的评测结果（评测页）"
            >
              <FlaskConical size={12} /> 查看评测
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function unique<T>(value: T, index: number, array: T[]): boolean {
  return array.indexOf(value) === index;
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
