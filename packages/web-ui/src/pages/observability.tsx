/**
 * @fengagent/web-ui — AgentLoop 可观测面板
 *
 * 完整调用链可视化 + 指标总览：
 * - 日期切换（llm-trace 日志按天）
 * - 汇总指标卡（调用数 / 耗时 / token / 错误率 / 缓存命中）
 * - 调用链树（会话 → 消息 → LLM 调用 → 工具调用，可展开/折叠）
 * - 指标详情（模型对比、工具使用分布、完成原因分布）
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Clock,
  Cpu,
  Database,
  Loader2,
  RefreshCw,
  Wrench,
  Zap,
} from "lucide-react";
import type { ApiClient } from "../api/client.ts";
import type { CallChainSession, SerializedAnalysis, TraceFileMeta } from "../api/types.ts";
import { TraceTree } from "../components/trace-tree.tsx";
import { BarChart, DonutChart, MetricCard } from "../components/metric-charts.tsx";
import { formatDuration, formatTokens } from "../lib/format.ts";

interface ObservabilityPageProps {
  client: ApiClient;
}

type DetailTab = "callchain" | "metrics";

export function ObservabilityPage({ client }: ObservabilityPageProps) {
  const [traces, setTraces] = useState<TraceFileMeta[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<SerializedAnalysis | null>(null);
  const [callChains, setCallChains] = useState<CallChainSession[]>([]);
  const [tab, setTab] = useState<DetailTab>("callchain");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const latestDate = traces.length > 0 ? traces[traces.length - 1].date : null;

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
              <TraceTree sessions={callChains} loading={loading} error={error} />
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
