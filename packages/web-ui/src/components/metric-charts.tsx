/**
 * @fengagent/web-ui — 轻量指标图表组件
 *
 * 零依赖 SVG 图表（bar / donut / sparkline），用于评测与观测页：
 * - BarChart：模型对比（耗时 / token / 成功率等）
 * - DonutChart：占比分布（完成原因 / 工具使用）
 * 跟随主题 CSS 变量取色，支持 light / dark / cyber。
 */

import type { ReactNode } from "react";

interface BarDatum {
  label: string;
  value: number;
  /** 归一化基准（默认取本组最大值） */
  max?: number;
  /** 覆盖颜色（CSS 色值） */
  color?: string;
  /** 附加展示文本（默认 = value 原样） */
  display?: string;
}

/** 横向条形图（模型对比） */
export function BarChart({
  data,
  color = "var(--accent)",
  height = 180,
  unit = "",
}: {
  data: BarDatum[];
  color?: string;
  height?: number;
  unit?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.max ?? d.value));
  const rowH = 22;
  const gap = 8;
  const chartH = Math.max(height, data.length * (rowH + gap) + 8);

  return (
    <div className="metric-chart metric-chart--bar" role="img" aria-label="bar chart">
      <svg width="100%" height={chartH} viewBox={`0 0 100 ${chartH}`} preserveAspectRatio="none">
        {data.map((d, i) => {
          const y = 4 + i * (rowH + gap);
          const w = Math.max(1, (d.value / max) * 100);
          return (
            <g key={d.label}>
              {/* 轨道 */}
              <rect x="0" y={y} width="100" height={rowH} rx="4" fill="var(--bg-tertiary)" />
              {/* 数值条 */}
              <rect
                x="0"
                y={y}
                width={w}
                height={rowH}
                rx="4"
                fill={d.color ?? color}
                opacity="0.85"
              >
                <title>{`${d.label}: ${d.display ?? d.value}${unit}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      {/* 标签行（SVG 文本在窄条上易溢出，用 HTML 叠加） */}
      <div className="metric-chart__labels">
        {data.map((d) => (
          <div key={d.label} className="metric-chart__label-row">
            <span className="metric-chart__label" title={d.label}>
              {d.label}
            </span>
            <span className="metric-chart__label-value">
              {d.display ?? d.value}
              {unit}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 环形图（占比分布） */
export function DonutChart({
  data,
  size = 150,
  thickness = 18,
  centerLabel,
  centerValue,
}: {
  data: Array<{ label: string; value: number; color?: string }>;
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const total = Math.max(1, data.reduce((s, d) => s + d.value, 0));
  const r = (size - thickness) / 2;
  const circumference = 2 * Math.PI * r;
  let offset = 0;

  const PALETTE = [
    "var(--accent)",
    "var(--accent-2)",
    "var(--success)",
    "var(--warning)",
    "var(--danger)",
    "#38bdf8",
    "#f472b6",
  ];

  return (
    <div className="metric-chart metric-chart--donut">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--bg-tertiary)"
          strokeWidth={thickness}
        />
        {data.map((d, i) => {
          const frac = d.value / total;
          const len = frac * circumference;
          const seg = (
            <circle
              key={d.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={d.color ?? PALETTE[i % PALETTE.length]}
              strokeWidth={thickness}
              strokeDasharray={`${len} ${circumference - len}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            >
              <title>{`${d.label}: ${d.value} (${Math.round(frac * 100)}%)`}</title>
            </circle>
          );
          offset += len;
          return seg;
        })}
      </svg>
      {(centerLabel || centerValue) && (
        <div className="metric-chart__donut-center">
          {centerValue && <strong>{centerValue}</strong>}
          {centerLabel && <span>{centerLabel}</span>}
        </div>
      )}
      <div className="metric-chart__legend">
        {data.map((d, i) => (
          <span key={d.label} className="metric-chart__legend-item">
            <i
              className="metric-chart__legend-dot"
              style={{ background: d.color ?? PALETTE[i % PALETTE.length] }}
            />
            {d.label}
            <em>{d.value}</em>
          </span>
        ))}
      </div>
    </div>
  );
}

/** 汇总指标卡片 */
export function MetricCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  return (
    <div className={`metric-card metric-card--${tone}`}>
      {icon && <span className="metric-card__icon">{icon}</span>}
      <div className="metric-card__body">
        <span className="metric-card__value">{value}</span>
        <span className="metric-card__label">{label}</span>
        {hint && <span className="metric-card__hint">{hint}</span>}
      </div>
    </div>
  );
}
