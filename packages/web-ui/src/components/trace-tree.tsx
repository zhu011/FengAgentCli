/**
 * @fengagent/web-ui — AgentLoop 调用链树组件
 *
 * 参考阿里云 AgentLoop 交互设计：树形节点展示完整调用链，
 * 展开/折叠每个 LLM 调用与工具调用节点，节点详情含：
 * 工具参数、返回内容、耗时、token 明细、完成原因。
 *
 * 层级：会话 → 步骤（用户消息 / LLM 调用）→ 工具调用（LLM 子节点）
 */

import { useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Loader2,
  User,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import type { CallChainSession, CallChainStep, CallChainToolNode } from "../api/types.ts";
import { formatDuration, formatTokens } from "../lib/format.ts";

/** 步骤展开状态表（节点 id → 是否展开） */
type ExpandMap = Record<string, boolean>;

interface TraceTreeProps {
  sessions: CallChainSession[];
  /** 加载状态（切换日期时展示） */
  loading?: boolean;
  error?: string | null;
}

/** 调用链树（多会话） */
export function TraceTree({ sessions, loading, error }: TraceTreeProps) {
  const [expanded, setExpanded] = useState<ExpandMap>({});
  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  const toggle = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  if (loading) {
    return (
      <div className="trace-tree trace-tree--state">
        <Loader2 size={18} className="trace-tree__spinner" />
        <span>调用链加载中…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="trace-tree trace-tree--state trace-tree--error">
        <AlertTriangle size={18} />
        <span>{error}</span>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="trace-tree trace-tree--state">
        <span>该日期没有可观测的调用链 —— 先运行一次对话产生 llm-trace 日志。</span>
      </div>
    );
  }

  // sessions 非空（上面已提前返回），选中会话缺省取第一条
  const activeSession = sessions.find((s) => s.sessionId === selectedSession) ?? sessions[0]!;

  return (
    <div className="trace-tree">
      {/* 会话切换器 */}
      <div className="trace-tree__session-tabs">
        {sessions.map((s) => (
          <button
            key={s.sessionId}
            type="button"
            className={`trace-tree__session-tab ${s.sessionId === activeSession.sessionId ? "trace-tree__session-tab--active" : ""}`}
            onClick={() => setSelectedSession(s.sessionId)}
            title={`${s.sessionId} · ${s.steps.length} 步 · ${s.toolCallCount} 次工具调用`}
          >
            <span className="trace-tree__session-tab-id">{shortId(s.sessionId)}</span>
            <span className="trace-tree__session-tab-meta">
              {s.steps.length} 步 · {s.toolCallCount} 工具
            </span>
          </button>
        ))}
      </div>

      {/* 会话概览 */}
      <div className="trace-tree__session-summary">
        <span className="trace-tree__session-summary-item">
          <Cpu size={13} /> {activeSession.model}
        </span>
        <span className="trace-tree__session-summary-item">
          <Clock size={13} /> 总耗时 {formatDuration(activeSession.totalDurationMs)}
        </span>
        <span className="trace-tree__session-summary-item">
          <Zap size={13} /> {formatTokens(activeSession.totalInputTokens + activeSession.totalOutputTokens)}
        </span>
        <span className="trace-tree__session-summary-item">
          <Wrench size={13} /> 工具 {activeSession.toolCallCount} 次
        </span>
        {activeSession.errorCount > 0 && (
          <span className="trace-tree__session-summary-item trace-tree__session-summary-item--error">
            <AlertTriangle size={13} /> 错误 {activeSession.errorCount}
          </span>
        )}
      </div>

      {/* 步骤树 */}
      <div className="trace-tree__steps">
        {activeSession.steps.map((step) => (
          <TraceStep key={step.id} step={step} expanded={expanded} onToggle={toggle} />
        ))}
      </div>
    </div>
  );
}

/** 单步（用户消息 / LLM 调用） */
function TraceStep({
  step,
  expanded,
  onToggle,
}: {
  step: CallChainStep;
  expanded: ExpandMap;
  onToggle: (id: string) => void;
}) {
  if (step.kind === "user") {
    return (
      <div className="trace-step trace-step--user">
        <div className="trace-step__header">
          <span className="trace-step__icon trace-step__icon--user">
            <User size={13} />
          </span>
          <span className="trace-step__title">用户消息</span>
          <span className="trace-step__time">{formatTime(step.timestamp)}</span>
        </div>
        <p className="trace-step__user-text">{step.user?.text ?? ""}</p>
      </div>
    );
  }

  const llm = step.llm;
  const isOpen = Boolean(expanded[step.id]);
  const hasTools = step.tools.length > 0;
  const isError = Boolean(llm?.error);

  return (
    <div className={`trace-step trace-step--llm ${isError ? "trace-step--error" : ""}`}>
      <button
        type="button"
        className="trace-step__header trace-step__header--clickable"
        onClick={() => onToggle(step.id)}
        aria-expanded={isOpen}
      >
        <span className="trace-step__chevron">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="trace-step__icon trace-step__icon--llm">
          <Bot size={13} />
        </span>
        <span className="trace-step__title">
          LLM 调用 #{llm?.index ?? "?"}
          <span className="trace-step__model">{llm?.model ?? ""}</span>
        </span>
        {llm?.durationMs !== undefined && (
          <span className="trace-step__badge trace-step__badge--duration">
            <Clock size={11} /> {formatDuration(llm.durationMs)}
          </span>
        )}
        {llm?.outputTokens !== undefined && (
          <span className="trace-step__badge trace-step__badge--tokens">
            <Zap size={11} /> {formatTokens((llm.inputTokens ?? 0) + llm.outputTokens)}
          </span>
        )}
        {llm?.finishReason && (
          <span className={`trace-step__badge trace-step__badge--reason trace-step__badge--reason-${llm.finishReason}`}>
            {llm.finishReason}
          </span>
        )}
        {isError && (
          <span className="trace-step__badge trace-step__badge--error">
            <XCircle size={11} /> 错误
          </span>
        )}
        {hasTools && !isOpen && (
          <span className="trace-step__badge trace-step__badge--tools">
            <Wrench size={11} /> {step.tools.length}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="trace-step__body">
          {/* LLM 调用详情 */}
          {llm && (
            <div className="trace-step__llm-detail">
              <div className="trace-step__llm-grid">
                <DetailCell label="模型" value={llm.model} />
                <DetailCell
                  label="耗时"
                  value={llm.durationMs !== undefined ? formatDuration(llm.durationMs) : "—"}
                />
                <DetailCell label="输入 tokens" value={formatTokens(llm.inputTokens ?? 0)} />
                <DetailCell label="输出 tokens" value={formatTokens(llm.outputTokens ?? 0)} />
                <DetailCell
                  label="缓存读取"
                  value={llm.cacheReadTokens !== undefined ? formatTokens(llm.cacheReadTokens) : "—"}
                />
                <DetailCell
                  label="缓存创建"
                  value={llm.cacheCreationTokens !== undefined ? formatTokens(llm.cacheCreationTokens) : "—"}
                />
                <DetailCell label="完成原因" value={llm.finishReason ?? "—"} />
                <DetailCell label="工具调用" value={llm.hasToolCalls ? "是" : "否"} />
              </div>
              {llm.error && (
                <div className="trace-step__llm-error">
                  <AlertTriangle size={13} />
                  <span>{llm.error}</span>
                </div>
              )}
              {llm.responseText && (
                <details className="trace-step__collapsible">
                  <summary>回复文本</summary>
                  <pre className="trace-step__response-text">{llm.responseText}</pre>
                </details>
              )}
            </div>
          )}

          {/* 工具子节点 */}
          {step.tools.map((tool, idx) => (
            <TraceTool
              key={`${step.id}-t${idx}`}
              id={`${step.id}-t${idx}`}
              tool={tool}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 工具调用子节点 */
function TraceTool({
  id,
  tool,
  expanded,
  onToggle,
}: {
  id: string;
  tool: CallChainToolNode;
  expanded: ExpandMap;
  onToggle: (id: string) => void;
}) {
  const isOpen = Boolean(expanded[id]);
  const isError = Boolean(tool.isError);

  return (
    <div className={`trace-tool ${isError ? "trace-tool--error" : ""}`}>
      <button
        type="button"
        className="trace-tool__header"
        onClick={() => onToggle(id)}
        aria-expanded={isOpen}
      >
        <span className="trace-tool__chevron">
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="trace-tool__icon">
          <Wrench size={12} />
        </span>
        <span className="trace-tool__name">{tool.name}</span>
        {tool.durationMs !== undefined && (
          <span className="trace-tool__badge trace-tool__badge--duration">
            <Clock size={11} /> {formatDuration(tool.durationMs)}
          </span>
        )}
        {tool.result && (
          <span className={`trace-tool__badge ${tool.result.isError ? "trace-tool__badge--error" : "trace-tool__badge--ok"}`}>
            {tool.result.isError ? <XCircle size={11} /> : <CheckCircle2 size={11} />}
            {tool.result.isError ? "失败" : "成功"}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="trace-tool__body">
          <div className="trace-tool__section">
            <div className="trace-tool__section-label">参数</div>
            <pre className="trace-tool__json">{prettify(tool.input)}</pre>
          </div>
          <div className="trace-tool__section">
            <div className="trace-tool__section-label">返回结果</div>
            {tool.result ? (
              <pre className={`trace-tool__json ${tool.result.isError ? "trace-tool__json--error" : ""}`}>
                {tool.result.content}
              </pre>
            ) : (
              <p className="trace-tool__empty">
                无返回结果记录（llm-trace 暂不含工具结果；会话重启后不可回填，等待 Trace/Span 采集扩展）
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 键值详情格 */
function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="trace-step__llm-cell">
      <span className="trace-step__llm-cell-label">{label}</span>
      <span className="trace-step__llm-cell-value">{value}</span>
    </div>
  );
}

/** 短会话 ID（前 8 位） */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** ISO 时间 → HH:MM:SS */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toTimeString().slice(0, 8);
}

/** 参数/结果格式化（JSON 美化，超长截断） */
function prettify(value: unknown): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return text.length > 4000 ? `${text.slice(0, 4000)}\n… (已截断)` : text;
  } catch {
    return String(value);
  }
}
