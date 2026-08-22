/**
 * @fengagent/web-ui — AgentLoop 可观测面板
 *
 * 完整调用链可视化 + 指标总览：
 * - 日期切换（llm-trace 日志按天）
 * - 汇总指标卡（调用数 / 耗时 / token / 错误率 / 缓存命中）
 * - 调用链树（会话 → 消息 → LLM 调用 → 工具调用，可展开/折叠）
 * - 指标详情（模型对比、工具使用分布、完成原因分布）
 *
 * Deep-link（聊天页「查看调用链」/ 会话列表「查看观测」）：
 * - ?sessionId=X&messageId=Y：自动定位会话与消息，聚焦展示该轮调用链
 * - ?sessionId=X：展示该会话的全部消息列表，点击消息后聚焦其调用链
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Clock,
  Cpu,
  Database,
  FlaskConical,
  Loader2,
  RefreshCw,
  Wrench,
  Zap,
} from "lucide-react";
import type { ApiClient } from "../api/client.ts";
import type {
  CallChainResponse,
  CallChainSession,
  MessageTraceSummary,
  SerializedAnalysis,
  TraceFileMeta,
} from "../api/types.ts";
import { TraceTree } from "../components/trace-tree.tsx";
import { MessagePicker } from "../components/message-picker.tsx";
import { BarChart, DonutChart, MetricCard } from "../components/metric-charts.tsx";
import { formatDuration, formatTokens } from "../lib/format.ts";
import { findSessionTraceDate } from "../lib/trace-date.ts";
import type { AppView, DeepLinkTarget } from "../app.tsx";

interface ObservabilityPageProps {
  client: ApiClient;
  /** deep-link 目标（聊天消息 / 会话列表跳转） */
  deepLink?: DeepLinkTarget;
  /** 视图导航（返回对话 / 切换评测 / 选择消息） */
  onNavigate?: (view: AppView, target?: DeepLinkTarget) => void;
}

type DetailTab = "callchain" | "metrics";

export function ObservabilityPage({ client, deepLink, onNavigate }: ObservabilityPageProps) {
  const [traces, setTraces] = useState<TraceFileMeta[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<SerializedAnalysis | null>(null);
  const [callChains, setCallChains] = useState<CallChainSession[]>([]);
  const [tab, setTab] = useState<DetailTab>("callchain");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // deep-link 状态：聚焦会话/消息 + 消息选择器
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const [focusedChain, setFocusedChain] = useState<CallChainResponse | null>(null);
  const [messagePicker, setMessagePicker] = useState<MessageTraceSummary[] | null>(null);
  const [pickerSessionId, setPickerSessionId] = useState<string | null>(null);
  const [focusLoading, setFocusLoading] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);

  // 加载 trace 文件列表
  const loadTraces = useCallback(async () => {
    try {
      const list = await client.listTraces();
      setTraces(list);
      setSelectedDate((prev) => prev ?? list[list.length - 1]?.date ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  // 加载选中日期的分析 + 调用链
  const loadDate = useCallback(
    async (date: string) => {
      setLoading(true);
      setError(null);
      try {
        const [a, cc] = await Promise.all([
          client.getTraceAnalysis(date),
          client.getCallChains(date),
        ]);
        setAnalysis(a.analysis);
        setCallChains(cc.sessions);
      } catch (err) {
        setAnalysis(null);
        setCallChains([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void loadTraces();
  }, [loadTraces]);

  useEffect(() => {
    if (selectedDate) void loadDate(selectedDate);
  }, [selectedDate, loadDate]);

  // ──────────────────────────────────────────────
  // deep-link：定位会话/消息
  // ──────────────────────────────────────────────
  const deepLinkSession = deepLink?.sessionId;
  const deepLinkMessage = deepLink?.messageId;

  useEffect(() => {
    if (!deepLinkSession) {
      setFocusSessionId(null);
      setFocusMessageId(null);
      setFocusedChain(null);
      setMessagePicker(null);
      setPickerSessionId(null);
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
          setFocusedChain(null);
          setMessagePicker([]);
          setPickerSessionId(deepLinkSession);
          setFocusError("未找到该会话的 trace 日志（可能该会话尚无对话产生调用链）");
          return;
        }
        setSelectedDate(date);
        setFocusSessionId(deepLinkSession);
        setFocusMessageId(deepLinkMessage ?? null);
        if (deepLinkMessage) {
          const [chain, msgs] = await Promise.all([
            client.getCallChainForMessage(date, deepLinkSession, deepLinkMessage),
            client.getMessageTraces(date, deepLinkSession),
          ]);
          if (cancelled) return;
          setFocusedChain(chain);
          setMessagePicker(msgs.messages);
          setPickerSessionId(deepLinkSession);
        } else {
          const msgs = await client.getMessageTraces(date, deepLinkSession);
          if (cancelled) return;
          setFocusedChain(null);
          setMessagePicker(msgs.messages);
          setPickerSessionId(deepLinkSession);
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

  const latestDate = traces.length > 0 ? traces[traces.length - 1]!.date : null;

  const chartData = useMemo(() => {
    if (!analysis) return null;
    const modelDuration = analysis.modelComparisons.map((m) => ({
      label: m.model,
      value: m.avgDurationMs,
      display: formatDuration(m.avgDurationMs),
    }));
    const modelTokens = analysis.modelComparisons.map((m) => ({
      label: m.model,
      value: m.avgInputTokens + m.avgOutputTokens,
      display: formatTokens(m.avgInputTokens + m.avgOutputTokens),
    }));
    const toolUsage = Object.entries(analysis.toolUsage).map(([label, value]) => ({
      label,
      value,
    }));
    const finishReasons = Object.entries(analysis.finishReasons).map(([label, value]) => ({
      label,
      value,
      color:
        label === "end_turn"
          ? "var(--success)"
          : label === "error"
            ? "var(--danger)"
            : label === "tool_use"
              ? "var(--accent)"
              : "var(--warning)",
    }));
    return { modelDuration, modelTokens, toolUsage, finishReasons };
  }, [analysis]);

  const refresh = () => {
    void loadTraces();
    if (selectedDate) void loadDate(selectedDate);
  };

  /** 选择消息 → 聚焦其调用链（更新 URL deep-link） */
  const pickMessage = (messageId: string | null) => {
    if (!pickerSessionId) return;
    onNavigate?.("observability", {
      sessionId: pickerSessionId,
      messageId: messageId ?? undefined,
    });
  };

  /** 返回完整调用链（取消消息聚焦） */
  const clearFocus = () => {
    if (!focusSessionId) return;
    onNavigate?.("observability", { sessionId: focusSessionId });
  };

  return (
    <div className="obs-page">
      <header className="obs-page__header">
        <div className="obs-page__header-left">
          <span className="obs-page__title-icon" aria-hidden="true">📡</span>
          <h1 className="obs-page__title">AgentLoop 观测</h1>
          <span className="obs-page__subtitle">完整调用链 · 模型耗时 · Token 消耗 · 工具耗时</span>
        </div>
        <div className="obs-page__header-right">
          <label className="obs-page__date-label" htmlFor="obs-date">日期</label>
          <select
            id="obs-date"
            className="obs-page__date-select"
            value={selectedDate ?? ""}
            onChange={(e) => setSelectedDate(e.target.value)}
            disabled={traces.length === 0}
          >
            {traces.length === 0 && <option value="">无 trace 日志</option>}
            {traces.map((t) => (
              <option key={t.date} value={t.date}>
                {t.date} · {t.sessions} 会话 · {t.records} 条
              </option>
            ))}
          </select>
          <button
            type="button"
            className="obs-page__refresh"
            onClick={refresh}
            title="刷新"
            aria-label="刷新"
          >
            <RefreshCw size={15} className={loading ? "obs-page__refresh--spin" : ""} />
          </button>
        </div>
      </header>

      {error && (
        <div className="obs-page__error">
          <AlertTriangle size={15} />
          <span>{error}</span>
        </div>
      )}

      {/* deep-link 横幅（聚焦会话/消息） */}
      {focusSessionId && (
        <div className="obs-banner">
          <span className="obs-banner__icon" aria-hidden="true">🔗</span>
          <div className="obs-banner__body">
            <span className="obs-banner__title">
              聚焦会话 <code>{shortId(focusSessionId)}</code>
              {focusMessageId && (
                <>
                  {" "}· 消息 <code>{shortId(focusMessageId)}</code>
                </>
              )}
            </span>
            {focusMessageId && (
              <span className="obs-banner__hint">
                {focusedChain?.focus?.legacyMatch
                  ? "旧格式日志（无 messageId），已按文本匹配定位到该轮对话"
                  : "已定位到该消息所属轮次的调用链"}
              </span>
            )}
          </div>
          <div className="obs-banner__actions">
            {focusMessageId && (
              <button
                type="button"
                className="obs-banner__btn"
                onClick={clearFocus}
                title="查看该会话完整调用链"
              >
                <Activity size={13} /> 完整调用链
              </button>
            )}
            <button
              type="button"
              className="obs-banner__btn"
              onClick={() => onNavigate?.("eval", { sessionId: focusSessionId, messageId: focusMessageId ?? undefined })}
              title="在评测页查看该消息"
            >
              <FlaskConical size={13} /> 查看评测
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
      )}

      {!loading && traces.length === 0 && (
        <div className="obs-page__empty">
          <div className="obs-page__empty-icon">📡</div>
          <h2>暂无观测数据</h2>
          <p>
            尚未发现 <code>llm-trace-*.jsonl</code> 日志。先通过 CLI / WebUI 与 Agent 对话，
            每次 LLM 调用与工具调用会自动落盘到数据根的 <code>logs/</code> 目录，随后在此展示完整调用链。
          </p>
          <p className="obs-page__empty-hint">
            数据根：<code>.fengagent-cordis/</code>（refactor 分支）或 <code>.fengagent/</code>（main 分支）
          </p>
        </div>
      )}

      {selectedDate && (analysis || loading) && (
        <div className="obs-page__content">
          {/* 汇总指标卡 */}
          {analysis && (
            <section className="obs-page__cards">
              <MetricCard
                label="LLM 调用"
                value={String(analysis.totalLlmCalls)}
                hint={`${analysis.sessionCount} 个会话`}
                icon={<Bot size={18} />}
              />
              <MetricCard
                label="平均耗时"
                value={formatDuration(analysis.avgDurationMs)}
                hint={`总耗时 ${formatDuration(analysis.totalDurationMs)}`}
                icon={<Clock size={18} />}
              />
              <MetricCard
                label="Token 用量"
                value={formatTokens(analysis.totalInputTokens + analysis.totalOutputTokens)}
                hint={`输入 ${formatTokens(analysis.totalInputTokens)} / 输出 ${formatTokens(analysis.totalOutputTokens)}`}
                icon={<Zap size={18} />}
              />
              <MetricCard
                label="工具调用"
                value={`${analysis.toolCallCount} 次`}
                hint={`调用率 ${analysis.toolCallRate}%`}
                icon={<Wrench size={18} />}
              />
              <MetricCard
                label="错误率"
                value={`${analysis.errorRate}%`}
                hint={`${analysis.errorCount} 次错误`}
                icon={<AlertTriangle size={18} />}
                tone={analysis.errorRate > 20 ? "bad" : analysis.errorRate > 0 ? "warn" : "good"}
              />
              <MetricCard
                label="KV 缓存命中率"
                value={`${analysis.cacheHitRate}%`}
                hint={`读取 ${formatTokens(analysis.totalCacheReadTokens)} tokens`}
                icon={<Database size={18} />}
                tone={analysis.cacheHitRate >= 20 ? "good" : "warn"}
              />
            </section>
          )}

          {/* 详情切换 */}
          <div className="obs-page__tabs">
            <button
              type="button"
              className={`obs-page__tab ${tab === "callchain" ? "obs-page__tab--active" : ""}`}
              onClick={() => setTab("callchain")}
            >
              <Activity size={14} /> 调用链
            </button>
            <button
              type="button"
              className={`obs-page__tab ${tab === "metrics" ? "obs-page__tab--active" : ""}`}
              onClick={() => setTab("metrics")}
            >
              <Cpu size={14} /> 指标总览
            </button>
          </div>

          {tab === "callchain" ? (
            <section className="obs-page__section">
              {/* 聚焦视图：单条消息的调用链 */}
              {focusMessageId && pickerSessionId ? (
                focusLoading ? (
                  <div className="trace-tree trace-tree--state">
                    <Loader2 size={18} className="trace-tree__spinner" />
                    <span>定位消息调用链…</span>
                  </div>
                ) : focusError ? (
                  <div className="trace-tree trace-tree--state trace-tree--error">
                    <AlertTriangle size={18} />
                    <span>{focusError}</span>
                  </div>
                ) : focusedChain && focusedChain.sessions.length > 0 ? (
                  <>
                    <MessagePicker
                      messages={messagePicker ?? []}
                      activeMessageId={focusMessageId}
                      onPick={(m) => pickMessage(m.messageId)}
                    />
                    <TraceTree
                      sessions={focusedChain.sessions}
                      loading={false}
                      autoExpand
                    />
                  </>
                ) : (
                  <div className="trace-tree trace-tree--state trace-tree--error">
                    <AlertTriangle size={18} />
                    <span>
                      {focusError ?? "该日期没有此消息的调用链 —— 先运行一次对话产生 llm-trace 日志。"}
                    </span>
                  </div>
                )
              ) : focusSessionId && pickerSessionId ? (
                /* 会话级 deep-link：消息选择器 + 完整调用链 */
                <>
                  <MessagePicker
                    messages={messagePicker ?? []}
                    activeMessageId={null}
                    onPick={(m) => pickMessage(m.messageId)}
                  />
                  <TraceTree
                    sessions={callChains}
                    loading={loading}
                    error={error}
                    initialSessionId={focusSessionId}
                  />
                </>
              ) : (
                <TraceTree sessions={callChains} loading={loading} error={error} />
              )}
            </section>
          ) : (
            <section className="obs-page__section">
              {chartData && (
                <div className="obs-page__charts">
                  <div className="obs-page__chart-card">
                    <h3 className="obs-page__chart-title">模型平均耗时</h3>
                    <BarChart data={chartData.modelDuration} color="var(--accent)" unit="" />
                  </div>
                  <div className="obs-page__chart-card">
                    <h3 className="obs-page__chart-title">模型平均 Token（输入+输出）</h3>
                    <BarChart data={chartData.modelTokens} color="var(--accent-2)" />
                  </div>
                  <div className="obs-page__chart-card">
                    <h3 className="obs-page__chart-title">工具使用分布</h3>
                    {chartData.toolUsage.length > 0 ? (
                      <DonutChart
                        data={chartData.toolUsage}
                        centerLabel="工具调用"
                        centerValue={String(analysis?.toolCallCount ?? 0)}
                      />
                    ) : (
                      <p className="obs-page__chart-empty">当日无工具调用</p>
                    )}
                  </div>
                  <div className="obs-page__chart-card">
                    <h3 className="obs-page__chart-title">完成原因分布</h3>
                    <DonutChart
                      data={chartData.finishReasons}
                      centerLabel="LLM 调用"
                      centerValue={String(analysis?.totalLlmCalls ?? 0)}
                    />
                  </div>
                  {/* 模型对比表 */}
                  <div className="obs-page__chart-card obs-page__chart-card--wide">
                    <h3 className="obs-page__chart-title">模型对比</h3>
                    <div className="obs-page__table-wrap">
                      <table className="obs-page__table">
                        <thead>
                          <tr>
                            <th>模型</th>
                            <th>调用</th>
                            <th>工具成功率</th>
                            <th>任务完成率</th>
                            <th>错误率</th>
                            <th>平均耗时</th>
                            <th>平均 Token</th>
                            <th>缓存命中率</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analysis?.modelComparisons.map((m) => (
                            <tr key={m.model}>
                              <td className="obs-page__table-model">{m.model}</td>
                              <td>{m.totalCalls}</td>
                              <td>{m.toolSuccessRate}%</td>
                              <td>{m.taskCompletionRate}%</td>
                              <td className={m.errorRate > 20 ? "obs-page__cell--bad" : ""}>
                                {m.errorRate}%
                              </td>
                              <td>{formatDuration(m.avgDurationMs)}</td>
                              <td>{formatTokens(m.avgInputTokens + m.avgOutputTokens)}</td>
                              <td>{m.cacheHitRate}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* 无选中日期时的加载态 */}
      {loading && traces.length === 0 && (
        <div className="obs-page__loading">
          <Loader2 size={20} className="obs-page__loading-icon" />
          <span>加载 trace 列表…</span>
        </div>
      )}

      {latestDate && !selectedDate && !loading && (
        <div className="obs-page__empty">
          <p>暂无可用 trace 日志（最近日志：{latestDate}）</p>
        </div>
      )}
    </div>
  );
}

/** 会话消息选择器（deep-link 会话级进入时展示，点击聚焦单条消息） */

/** 短 ID（前 8 位） */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
