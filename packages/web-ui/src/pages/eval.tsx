/**
 * @fengagent/web-ui — 评测模块页面
 *
 * 三块功能：
 * - 测试集管理：AgentBench / DeepEval 风格测试集清单 + JSON 查看/导出
 * - 评测报告：`bun run eval` 生成的 Markdown 报告浏览 + 导出
 * - 自优化建议：`bun run eval --optimize` 生成的调优建议浏览 + 导出
 *
 * 指标图表见「AgentLoop 观测」页（同一 AnalysisResult 数据源）。
 */

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
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
import type { EvalReportMeta, EvalOverview, OptimizationMeta, TestSetMeta } from "../api/types.ts";
import { MarkdownRenderer } from "../components/markdown-renderer.tsx";
import { formatTokens } from "../lib/format.ts";

interface EvalPageProps {
  client: ApiClient;
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

export function EvalPage({ client }: EvalPageProps) {
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ov = await client.getEvalOverview();
      setOverview(ov);
      // 默认选中最近一份
      if (ov.reports.length > 0) setReportDate((prev) => prev ?? ov.reports[ov.reports.length - 1].date);
      if (ov.optimizations.length > 0) setOptDate((prev) => prev ?? ov.optimizations[ov.optimizations.length - 1].date);
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

      {loading && (
        <div className="eval-page__loading">
          <Loader2 size={20} className="eval-page__loading-icon" />
          <span>加载评测数据…</span>
        </div>
      )}

      {!loading && overview && (
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
