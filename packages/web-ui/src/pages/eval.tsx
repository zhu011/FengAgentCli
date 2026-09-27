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
 * - ?sessionId=X&messageId=Y：单条消息评测视图（trace 指标摘要 + LLM-judge 结果）
 * - ?sessionId=X：该会话消息选择器，点击消息进入单条消息评测
 *
 * LLM-judge 结果由评测引擎 judgeMessage() 产出，服务端按 (date,sessionId,messageId)
 * 落盘缓存；judgeStatus=pending 表示后台评审中，本页轮询等待（见下方轮询 effect）。
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

/** judge 后台评审的轮询间隔 / 上限（3s × 40 ≈ 2 分钟，覆盖 10–33s 的实测评审耗时） */
const JUDGE_POLL_INTERVAL_MS = 3000;
const JUDGE_POLL_MAX_ATTEMPTS = 40;

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
  /** 该会话 trace 所在日期（judge 轮询需要） */
  const [focusDate, setFocusDate] = useState<string | null>(null);
  const [messageEval, setMessageEval] = useState<MessageEvalResponse | null>(null);
  const [msgList, setMsgList] = useState<MessageTraceSummary[]>([]);
  const [focusLoading, setFocusLoading] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);
  /** 报告生成中（POST /api/eval/reports） */
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ov = await client.getEvalOverview();
      setOverview(ov);
      // 默认只选中最近一份评测报告；自优化建议/测试集查看器由用户点击后打开，
      // 避免两个查看器同时展开（AGE-29 观测/评测信息缺口 ③）。
      if (ov.reports.length > 0) setReportDate((prev) => prev ?? ov.reports[ov.reports.length - 1]!.date);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 三块查看器互斥，避免叠加展示 */
  const openReport = useCallback((date: string | null) => {
    setReportDate(date);
    if (date) {
      setOptDate(null);
      setTestSetName(null);
    }
  }, []);
  const openOptimization = useCallback((date: string | null) => {
    setOptDate(date);
    if (date) {
      setReportDate(null);
      setTestSetName(null);
    }
  }, []);
  const openTestSet = useCallback((name: string | null) => {
    setTestSetName(name);
    if (name) {
      setReportDate(null);
      setOptDate(null);
    }
  }, []);

  /** 触发生成评测报告（复用 CLI 评测管线，落点与 `bun run eval` 一致） */
  const generateReport = useCallback(
    async (optimize: boolean) => {
      setGenerating(true);
      setGenerateError(null);
      try {
        const ov = await client.generateEvalReport(undefined, { optimize });
        setOverview(ov);
        const latest = ov.reports[ov.reports.length - 1];
        if (latest) openReport(latest.date);
        const latestOpt = ov.optimizations[ov.optimizations.length - 1];
        if (optimize && latestOpt) openOptimization(latestOpt.date);
      } catch (err) {
        setGenerateError(err instanceof Error ? err.message : String(err));
      } finally {
        setGenerating(false);
      }
    },
    [client, openReport, openOptimization],
  );

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
      setFocusDate(null);
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
          setFocusDate(null);
          setMessageEval(null);
          setMsgList([]);
          setFocusError("未找到该会话的 trace 日志（可能该会话尚无对话产生调用链）");
          return;
        }
        const msgs = await client.getMessageTraces(date, deepLinkSession);
        if (cancelled) return;
        setMsgList(msgs.messages);
        setFocusSessionId(deepLinkSession);
        setFocusDate(date);
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

  // judge 后台评审中（judgeStatus=pending）→ 轮询等待缓存命中。
  // 服务端把 10–33s 的真实模型调用移出请求周期并以 (date,sessionId,messageId) 落盘缓存，
  // 这里只需轮询到缓存出现即可（未命中缓存的连点不会再重复烧 token）。
  useEffect(() => {
    if (!focusDate || !focusSessionId || !focusMessageId) return;
    if (messageEval?.judgeStatus !== "pending") return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      attempts++;
      try {
        const res = await client.getMessageEval(focusDate, focusSessionId, focusMessageId);
        if (cancelled) return;
        setMessageEval(res);
        if (res.judgeStatus !== "pending") return;
      } catch {
        // 网络抖动：继续重试直至上限
      }
      if (attempts >= JUDGE_POLL_MAX_ATTEMPTS) return;
      timer = setTimeout(() => void tick(), JUDGE_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void tick(), JUDGE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, focusDate, focusSessionId, focusMessageId, messageEval?.judgeStatus]);

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
                    {messageEval.message ? (
                      <div className="eval-msg-card">
                        <div className="eval-msg-card__head">
                          <span className={`obs-msg-picker__role obs-msg-picker__role--${messageEval.message.role}`}>
                            {messageEval.message.role === "user" ? "用户" : "助手"}
                          </span>
                          <span className="eval-msg-card__label">消息内容</span>
                        </div>
                        <p className="eval-msg-card__text">{messageEval.message.text}</p>
                      </div>
                    ) : (
                      <div className="eval-msg-card">
                        <div className="eval-msg-card__head">
                          <span className="eval-msg-card__label">消息内容</span>
                        </div>
                        <p className="eval-deeplink__empty">
                          该消息没有文本内容（例如纯工具调用轮次或中断的空回复）；下方指标来自其 trace 记录。
                        </p>
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

                    {/* LLM-judge 评测结果 */}
                    <div className="eval-msg-card">
                      <div className="eval-msg-card__head">
                        <Sparkles size={14} />
                        <span className="eval-msg-card__label">LLM-judge 单条消息评测</span>
                        {messageEval.judgeStatus === "cached" && (
                          <span className="eval-msg-card__label">（缓存结果）</span>
                        )}
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
                      ) : messageEval.judgeStatus === "pending" ? (
                        <div className="eval-judge eval-judge--pending">
                          <p>
                            <Loader2 size={13} className="eval-page__loading-icon" />
                            {" "}LLM-judge 评审中…（单条消息评审是一次真实模型调用，通常 10–30 秒）
                          </p>
                          <p className="eval-judge__hint">
                            评审在后台进行，结果会按 (日期, 会话, 消息) 落盘缓存，完成后此处自动显示；
                            重复查看同一条消息不再重复评审。
                          </p>
                        </div>
                      ) : (
                        <div className="eval-judge eval-judge--pending">
                          <p>
                            该消息暂无 LLM-judge 结果：未配置模型客户端，或该消息没有对应的 trace 步骤。
                          </p>
                          <p className="eval-judge__hint">
                            当前已展示该轮对话的 trace 指标；配置模型后重新打开即可评审。
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
                      onClick={() => openTestSet(ts.name)}
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
              <button
                type="button"
                className="eval-page__export"
                onClick={() => void generateReport(false)}
                disabled={generating}
                title="分析今天的 trace 日志并生成评测报告（等价于 bun run eval）"
              >
                {generating ? (
                  <Loader2 size={13} className="eval-page__loading-icon" />
                ) : (
                  <RefreshCw size={13} />
                )}
                生成报告
              </button>
              <button
                type="button"
                className="eval-page__export"
                onClick={() => void generateReport(true)}
                disabled={generating}
                title="生成报告并运行自优化诊断（等价于 bun run eval --optimize）"
              >
                <Sparkles size={13} />
                生成报告 + 自优化
              </button>
            </div>
            {generateError && (
              <p className="eval-page__empty">
                <AlertTriangle size={13} className="eval-page__bad" /> 生成失败：{generateError}
              </p>
            )}
            {overview.reports.length === 0 ? (
              <p className="eval-page__empty">
                暂无评测报告。点击上方「生成报告」，或运行 <code>bun run eval</code> 生成
                <code> eval-report-{`{date}`}.md</code>。
              </p>
            ) : (
              <ul className="eval-page__list">
                {overview.reports.map((r) => (
                  <li key={r.date} className="eval-page__list-item">
                    <button
                      type="button"
                      className={`eval-page__list-main ${reportDate === r.date ? "eval-page__list-main--active" : ""}`}
                      onClick={() => openReport(r.date)}
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
                      onClick={() => openOptimization(o.date)}
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
