/**
 * @fengagent/web-ui — 工具调用卡片
 *
 * 显示工具名称、输入参数、执行结果。
 * 可展开/折叠查看详情。
 */

import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Loader2,
  Terminal,
} from "lucide-react";
import type { ToolCallInfo } from "../hooks/use-session.ts";
import { formatValue } from "../lib/format.ts";

interface ToolCallCardProps {
  toolCall: ToolCallInfo;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon =
    toolCall.status === "running" ? (
      <Loader2 size={14} className="tool-card__icon--running" />
    ) : toolCall.status === "failed" ? (
      <CircleAlert size={14} className="tool-card__icon--failed" />
    ) : (
      <CheckCircle2 size={14} className="tool-card__icon--done" />
    );

  const inputStr = formatValue(toolCall.input);
  const resultStr = toolCall.result ? toolCall.result.content : null;

  return (
    <div className="tool-card">
      <button
        type="button"
        className="tool-card__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`Tool: ${toolCall.name}`}
      >
        {expanded ? (
          <ChevronDown size={14} aria-hidden="true" />
        ) : (
          <ChevronRight size={14} aria-hidden="true" />
        )}
        <Terminal size={14} className="tool-card__terminal-icon" aria-hidden="true" />
        <span className="tool-card__name">{toolCall.name}</span>
        <span className="tool-card__status">{statusIcon}</span>
      </button>
      {toolCall.status === "running" && (
        <div className="tool-card__progress" />
      )}

      {expanded && (
        <div className="tool-card__body">
          {inputStr && (
            <div className="tool-card__section">
              <span className="tool-card__label">Input</span>
              <pre className="tool-card__code">{inputStr}</pre>
            </div>
          )}
          {resultStr && (
            <div className="tool-card__section">
              <span className="tool-card__label">
                {toolCall.result?.isError ? "Error" : "Result"}
              </span>
              <pre
                className={`tool-card__code ${
                  toolCall.result?.isError ? "tool-card__code--error" : ""
                }`}
              >
                {resultStr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
