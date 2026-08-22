/**
 * @fengagent/web-ui — 评测模块页面
 *
 * 三块功能：
 * - 测试集管理：AgentBench / DeepEval 风格测试集清单 + JSON 查看/导出
 * - 评测报告：`bun run eval` 生成的 Markdown 报告浏览 + 导出
 * - 自优化建议：`bun run eval --optimize` 生成的调优建议浏览 + 导出
 *
 * 指标图表见「AgentLoop 观测」页（同一 AnalysisResult 数据源）。
 *
 * Deep-link（聊天页「查看评测」/ 会话列表「查看评测」）：
 * - ?sessionId=X&messageId=Y：单条消息评测视图（trace 指标摘要 + LLM-judge 扩展点）
 * - ?sessionId=X：该会话消息选择器，点击消息进入单条消息评测
 *   judge 字段（单条消息 LLM-judge 结果）由 KG 的 judgeMessage 在 R2/R3 接入。
 */

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  Download,
  FileText,
  FlaskConical,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { ApiClient } from "../api/client.ts";
import type { EvalReportMeta, EvalOverview, MessageEvalResponse, MessageTraceSummary, OptimizationMeta, TestSetMeta } from "../api/types.ts";
import { MarkdownRenderer } from "../components/markdown-renderer.tsx";
import { MessagePicker } from "../components/message-picker.tsx";
import { formatDuration, formatTokens } from "../lib/format.ts";
import { findSessionTraceDate } from "../lib/trace-date.ts";
import type { AppView, DeepLinkTarget } from "../app.tsx";

interface EvalPageProps {
  client: ApiClient;
  /** deep-link 目标（聊天消息 / 会话列表跳转） */
  deepLink?: DeepLinkTarget;
  /** 视图导航（返回对话 / 切换观测） */
  onNavigate?: (view: AppView, target?: DeepLinkTarget) => void;
}

/** 浏览器端触发文件下载（导出报告 / 测试集） */
function downloadText(filename: string, content: string, mime = "text/markdown;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function EvalPage({ client, deepLink, onNavigate }: EvalPageProps) {
  const [overview, setOverview] = useState<EvalOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 报告查看器状态
  const [reportDate, setReportDate] = useState<string | null>(null);
  const [reportContent, setReportContent] = useState<string | null>(null);
  const [optDate, setOptDate] = useState<string | null>(null);
  const [optContent, setOptContent] = useState<string | null>(null);
  const [testSetName, setTestSetName] = useState<string | null>(null);
  const [testSetJson, setTestSetJson] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);

  // deep-link 状态：单条消息评测
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const [messageEval, setMessageEval] = useState<MessageEvalResponse | null>(null);
  const [msgList, setMsgList] = useState<MessageTraceSummary[]>([]);
  const [focusLoading, setFocusLoading] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ov = await client.getEvalOverview();
      setOverview(ov);
      // 默认选中最近一份
      if (ov.reports.length > 0) setReportDate((prev) => prev ?? ov.reports[ov.reports.length - 1]!.date);
      if (ov.optimizations.length > 0) setOptDate((prev) => prev ?? ov.optimizations[ov.optimizations.length - 1]!.date);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // 加载报告内容
  useEffect(() => {
    if (!reportDate) return;
    setViewerLoading(true);
    client
      .getEvalReport(reportDate)
      .then((r) => setReportContent(r.content))
      .catch(() => setReportContent("（报告加载失败）"))
      .finally(() => setViewerLoading(false));
  }, [reportDate, client]);

  useEffect(() => {
    if (!optDate) return;
    setViewerLoading(true);
    client
      .getOptimizationReport(optDate)
      .then((r) => setOptContent(r.content))
      .catch(() => setOptContent("（报告加载失败）"))
      .finally(() => setViewerLoading(false));
  }, [optDate, client]);

  useEffect(() => {
    if (!testSetName) return;
    setViewerLoading(true);
    client
      .getTestSet(testSetName)
      .then((data) => setTestSetJson(JSON.stringify(data, null, 2)))
      .catch(() => setTestSetJson("（测试集加载失败）"))
      .finally(() => setViewerLoading(false));
  }, [testSetName, client]);

  // ──────────────────────────────────────────────
  // deep-link：单条消息评测
  // ──────────────────────────────────────────────
  const deepLinkSession = deepLink?.sessionId;
  const deepLinkMessage = deepLink?.messageId;

  useEffect(() => {
    if (!deepLinkSession) {
      setFocusSessionId(null);
      setFocusMessageId(null);
      setMessageEval(null);
      setMsgList([]);
      setFocusError(null);
      return;
    }
    let cancelled = false;
    setFocusLoading(true);
    setFocusError(null);
    (async () => {
      try {
        const date = await findSessionTraceDate(client, deepLinkSession);
        if (cancelled) return;
        if (!date) {
          setFocusSessionId(deepLinkSession);
          setFocusMessageId(deepLinkMessage ?? null);
          setMessageEval(null);
          setMsgList([]);
          setFocusError("未找到该会话的 trace 日志（可能该会话尚无对话产生调用链）");
          return;
        }
        const msgs = await client.getMessageTraces(date, deepLinkSession);
        if (cancelled) return;
        setMsgList(msgs.messages);
        setFocusSessionId(deepLinkSession);
        if (deepLinkMessage) {
          const evalRes = await client.getMessageEval(date, deepLinkSession, deepLinkMessage);
          if (cancelled) return;
          setMessageEval(evalRes);
          setFocusMessageId(deepLinkMessage);
        } else {
          setMessageEval(null);
          setFocusMessageId(null);
        }
      } catch (err) {
        if (cancelled) return;
        setFocusError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setFocusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, deepLinkSession, deepLinkMessage]);

  /** 选择消息 → 单条消息评测（更新 URL deep-link） */
  const pickMessage = (m: MessageTraceSummary) => {
    if (!focusSessionId || !m.messageId) return;
    onNavigate?.("eval", { sessionId: focusSessionId, messageId: m.messageId });
  };

  /** 返回评测总览（清除消息聚焦） */
  const clearFocus = () => {
    if (!focusSessionId) return;
    onNavigate?.("eval", { sessionId: focusSessionId });
  };

  const exportReport = (meta: EvalReportMeta) => {
    if (reportDate === meta.date && reportContent) {
      downloadText(`eval-report-${meta.date}.md`, reportContent);
    }
  };

  const exportOptimization = (meta: OptimizationMeta) => {
    if (optDate === meta.date && optContent) {
      downloadText(`optimization-${meta.date}.md`, optContent);
    }
  };

  const exportTestSet = (meta: TestSetMeta) => {
    if (testSetName === meta.name && testSetJson) {
      downloadText(`${meta.name}.json`, testSetJson, "application/json;charset=utf-8");
    }
  };

  return (
    <div className="eval-page">
      <header className="eval-page__header">
        <div className="eval-page__header-left">
          <span className="eval-page__title-icon" aria-hidden="true">🧪</span>
          <h1 className="eval-page__title">评测模块</h1>
          <span className="eval-page__subtitle">测试集管理 · 评测报告 · 自优化建议</span>
        </div>
        <button
          type="button"
          className="eval-page__refresh"
          onClick={() => void load()}
          title="刷新"
          aria-label="刷新"
        >
          <RefreshCw size={15} />
        </button>
      </header>

      {error && (
        <div className="eval-page__error">
          <AlertTriangle size={15} />
          <span>{error}</span>
        </div>
      )}

      {/* deep-link：单条消息评测视图 */}
      {focusSessionId && (
        <div className="eval-deeplink">
          {/* 横幅 */}
          <div className="obs-banner">
            <span className="obs-banner__icon" aria-hidden="true">🔗</span>
            <div className="obs-banner__body">
              <span className="obs-banner__title">
                单条消息评测 · 会话 <code>{shortId(focusSessionId)}</code>
                {focusMessageId && (
                  <>
                    {" "}· 消息 <code>{shortId(focusMessageId)}</code>
                  </>
                )}
              </span>
              <span className="obs-banner__hint">
                按每轮对话粒度查看 trace 指标与评测结果
              </span>
            </div>
            <div className="obs-banner__actions">
              {focusMessageId && (
                <button
                  type="button"
                  className="obs-banner__btn"
                  onClick={clearFocus}
                  title="返回评测总览"
                >
                  <BarChart3 size={13} /> 评测总览
                </button>
              )}
              <button
                type="button"
                className="obs-banner__btn"
                onClick={() => onNavigate?.("observability", { sessionId: focusSessionId, messageId: focusMessageId ?? undefined })}
                title="在观测页查看该消息调用链"
              >
                <FlaskConical size={13} /> 查看调用链
              </button>
              <button
                type="button"
                className="obs-banner__btn"
                onClick={() => onNavigate?.("chat")}
                title="返回对话"
              >
                <ArrowLeft size={13} /> 返回对话
              </button>
            </div>
          </div>

          {focusLoading ? (
            <div className="eval-deeplink__loading">
              <Loader2 size={18} className="eval-page__loading-icon" />
              <span>加载单条消息评测…</span>
            </div>
          ) : focusError ? (
            <div className="eval-deeplink__error">
              <AlertTriangle size={15} />
              <span>{focusError}</span>
            </div>
          ) : (
            <div className="eval-deeplink__grid">
              {/* 消息选择器（切换消息） */}
              <div className="eval-deeplink__picker">
                <MessagePicker
                  messages={msgList}
                  activeMessageId={focusMessageId}
                  onPick={pickMessage}
                  emptyText="该会话暂无消息（可能尚未产生 trace 记录）"
                />
              </div>

              {/* 单条消息评测结果 */}
              <div className="eval-deeplink__result">
                {messageEval ? (
                  <>
                    {/* 消息上下文 */}
                    {messageEval.message && (
                      <div className="eval-msg-card">
                        <div className="eval-msg-card__head">
                          <span className={`obs-msg-picker__role obs-msg-picker__role--${messageEval.message.role}`}>
                            {messageEval.message.role === "user" ? "用户" : "助手"}
                          </span>
                          <span className="eval-msg-card__label">消息内容</span>
                        </div>
                        <p className="eval-msg-card__text">{messageEval.message.text}</p>
                      </div>
                    )}

                    {/* trace 指标 */}
                    <div className="eval-msg-card">
                      <div className="eval-msg-card__head">
                        <BarChart3 size={14} />
                        <span className="eval-msg-card__label">该轮对话 trace 指标</span>
                      </div>
                      {messageEval.trace ? (
                        <div className="eval-msg-metrics">
                          <Metric label="LLM 调用" value={String(messageEval.trace.llmCallCount)} />
                          <Metric label="工具调用" value={`${messageEval.trace.toolCallCount} 次`} />
                          <Metric label="耗时" value={formatDuration(messageEval.trace.durationMs)} />
                          <Metric label="Token" value={formatTokens(messageEval.trace.inputTokens + messageEval.trace.outputTokens)} />
                          <Metric label="完成原因" value={messageEval.trace.finishReasons.join(", ") || "—"} />
                          <Metric
                            label="错误"
                            value={messageEval.trace.errors.length > 0 ? `${messageEval.trace.errors.length} 个` : "无"}
                            tone={messageEval.trace.errors.length > 0 ? "bad" : "good"}
                          />
                        </div>
                      ) : (
                        <p className="eval-deeplink__empty">该消息没有对应的 trace 记录。</p>
                      )}
                    </div>

                    {/* LLM-judge 评测结果（KG judgeMessage 扩展点） */}
                    <div className="eval-msg-card">
                      <div className="eval-msg-card__head">
                        <Sparkles size={14} />
                        <span className="eval-msg-card__label">LLM-judge 单条消息评测</span>
                      </div>
                      {messageEval.judge ? (
                        <div className="eval-judge">
                          <div className="eval-judge__scores">
                            <ScoreBar label="任务完成度" value={messageEval.judge.completionScore} />
                            <ScoreBar label="输出正确性" value={messageEval.judge.correctnessScore} />
                          </div>
                          <p className="eval-judge__conclusion">结论：{messageEval.judge.conclusion}</p>
                          {messageEval.judge.note && (
                            <p className="eval-judge__note">{messageEval.judge.note}</p>
                          )}
                        </div>
                      ) : (
                        <div className="eval-judge eval-judge--pending">
                          <p>
                            单条消息的 LLM-judge 评测结果将在评测引擎接入
                            <code> judgeMessage(sessionId, messageId) </code>
                            后展示（数据层由 KG 提供，R2/R3 落地）。
                          </p>
                          <p className="eval-judge__hint">
                            当前已展示该轮对话的 trace 指标；接入后此处自动显示
                            完成度 / 正确性 / 结论 / 判定依据。
                          </p>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="eval-deeplink__empty">
                    从左侧消息列表选择一条消息，查看该轮对话的评测结果。
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {!focusSessionId && loading && (
        <div className="eval-page__loading">
          <Loader2 size={20} className="eval-page__loading-icon" />
          <span>加载评测数据…</span>
        </div>
      )}

      {!focusSessionId && !loading && overview && (
        <div className="eval-page__grid">
          {/* ── 测试集管理 ── */}
          <section className="eval-page__card">
            <div className="eval-page__card-head">
              <FlaskConical size={16} />
              <h2>测试集管理</h2>
              <span className="eval-page__count">{overview.testsets.length}</span>
            </div>
            {overview.testsets.length === 0 ? (
              <p className="eval-page__empty">
                暂无测试集。将 AgentBench / DeepEval 风格测试集放入
                <code> &lt;数据根&gt;/testsets/*.json </code>
                后刷新即可管理（接入由评测引擎完成）。
              </p>
            ) : (
              <ul className="eval-page__list">
                {overview.testsets.map((ts) => (
                  <li key={ts.name} className="eval-page__list-item">
                    <button
                      type="button"
                      className={`eval-page__list-main ${testSetName === ts.name ? "eval-page__list-main--active" : ""}`}
                      onClick={() => setTestSetName(ts.name)}
                      title={ts.path}
                    >
                      <span className="eval-page__list-name">{ts.name}</span>
                      <span className="eval-page__list-meta">
                        {ts.valid ? (
                          <CheckCircle2 size={12} className="eval-page__ok" />
                        ) : (
                          <AlertTriangle size={12} className="eval-page__bad" />
                        )}
                        {ts.records} 用例 · {ts.shape}
                      </span>
                    </button>
                    {testSetName === ts.name && testSetJson && (
                      <button
                        type="button"
                        className="eval-page__export"
                        onClick={() => exportTestSet(ts)}
                        title="导出 JSON"
                      >
                        <Download size={13} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {testSetName && (
              <div className="eval-page__viewer">
                <div className="eval-page__viewer-title">
                  <span>{testSetName}.json</span>
                  <button
                    type="button"
                    className="eval-page__viewer-close"
                    onClick={() => setTestSetName(null)}
                    aria-label="关闭"
                  >
                    ×
                  </button>
                </div>
                {viewerLoading && testSetJson === null ? (
                  <div className="eval-page__viewer-loading">
                    <Loader2 size={14} className="eval-page__loading-icon" />
                  </div>
                ) : (
                  <pre className="eval-page__viewer-json">{testSetJson}</pre>
                )}
              </div>
            )}
          </section>

          {/* ── 评测报告 ── */}
          <section className="eval-page__card">
            <div className="eval-page__card-head">
              <FileText size={16} />
              <h2>评测报告</h2>
              <span className="eval-page__count">{overview.reports.length}</span>
            </div>
            {overview.reports.length === 0 ? (
              <p className="eval-page__empty">
                暂无评测报告。运行 <code>bun run eval</code> 生成
                <code> eval-report-{`{date}`}.md</code>。
              </p>
            ) : (
              <ul className="eval-page__list">
                {overview.reports.map((r) => (
                  <li key={r.date} className="eval-page__list-item">
                    <button
                      type="button"
                      className={`eval-page__list-main ${reportDate === r.date ? "eval-page__list-main--active" : ""}`}
                      onClick={() => setReportDate(r.date)}
                      title={r.path}
                    >
                      <span className="eval-page__list-name">{r.date}</span>
                      <span className="eval-page__list-meta">
                        {formatTokens(r.size)} B · {new Date(r.modifiedAt).toLocaleString()}
                      </span>
                    </button>
                    {reportDate === r.date && reportContent && (
                      <button
                        type="button"
                        className="eval-page__export"
                        onClick={() => exportReport(r)}
                        title="导出 Markdown"
                      >
                        <Download size={13} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {reportDate && (
              <div className="eval-page__viewer eval-page__viewer--markdown">
                <div className="eval-page__viewer-title">
                  <span>eval-report-{reportDate}.md</span>
                  <button
                    type="button"
                    className="eval-page__viewer-close"
                    onClick={() => setReportDate(null)}
                    aria-label="关闭"
                  >
                    ×
                  </button>
                </div>
                {viewerLoading && reportContent === null ? (
                  <div className="eval-page__viewer-loading">
                    <Loader2 size={14} className="eval-page__loading-icon" />
                  </div>
                ) : (
                  <div className="eval-page__markdown">
                    <MarkdownRenderer text={reportContent ?? ""} />
                  </div>
                )}
              </div>
            )}
          </section>

          {/* ── 自优化建议 ── */}
          <section className="eval-page__card">
            <div className="eval-page__card-head">
              <Sparkles size={16} />
              <h2>自优化建议</h2>
              <span className="eval-page__count">{overview.optimizations.length}</span>
            </div>
            {overview.optimizations.length === 0 ? (
              <p className="eval-page__empty">
                暂无自优化建议。运行 <code>bun run eval --optimize</code> 生成
                <code> optimization-{`{date}`}.md</code>。
              </p>
            ) : (
              <ul className="eval-page__list">
                {overview.optimizations.map((o) => (
                  <li key={o.date} className="eval-page__list-item">
                    <button
                      type="button"
                      className={`eval-page__list-main ${optDate === o.date ? "eval-page__list-main--active" : ""}`}
                      onClick={() => setOptDate(o.date)}
                      title={o.path}
                    >
                      <span className="eval-page__list-name">{o.date}</span>
                      <span className="eval-page__list-meta">
                        {formatTokens(o.size)} B · {new Date(o.modifiedAt).toLocaleString()}
                      </span>
                    </button>
                    {optDate === o.date && optContent && (
                      <button
                        type="button"
                        className="eval-page__export"
                        onClick={() => exportOptimization(o)}
                        title="导出 Markdown"
                      >
                        <Download size={13} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {optDate && (
              <div className="eval-page__viewer eval-page__viewer--markdown">
                <div className="eval-page__viewer-title">
                  <span>optimization-{optDate}.md</span>
                  <button
                    type="button"
                    className="eval-page__viewer-close"
                    onClick={() => setOptDate(null)}
                    aria-label="关闭"
                  >
                    ×
                  </button>
                </div>
                {viewerLoading && optContent === null ? (
                  <div className="eval-page__viewer-loading">
                    <Loader2 size={14} className="eval-page__loading-icon" />
                  </div>
                ) : (
                  <div className="eval-page__markdown">
                    <MarkdownRenderer text={optContent ?? ""} />
                  </div>
                )}
              </div>
            )}
          </section>

          {/* 指标图表入口提示 */}
          <section className="eval-page__card eval-page__card--hint">
            <BarChart3 size={16} />
            <div>
              <h2>指标图表</h2>
              <p>
                模型耗时 / Token / 成功率 / 完成原因等指标图表位于
                <strong>「AgentLoop 观测 → 指标总览」</strong>，
                与评测报告共用同一分析数据源。
              </p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/** 指标格（单条消息评测） */
function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className={`eval-msg-metric ${tone ? `eval-msg-metric--${tone}` : ""}`}>
      <span className="eval-msg-metric__label">{label}</span>
      <span className="eval-msg-metric__value">{value}</span>
    </div>
  );
}

/** 分数条（LLM-judge 完成度/正确性） */
function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="eval-judge__score">
      <span className="eval-judge__score-label">{label}</span>
      <div className="eval-judge__score-track">
        <div
          className="eval-judge__score-fill"
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
      <span className="eval-judge__score-value">{value}</span>
    </div>
  );
}

/** 短 ID（前 8 位） */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
