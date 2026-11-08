/**
 * @fengagent/cli — TUI 状态栏（T1 极简单行版）
 *
 * claude-code 风格：一行 footer，左组（状态 · 模型），右组（上下文进度 + token）；
 * 会话信息上移到顶部 header。上下文进度保留分段块状条语义：
 * - 百分比保留 1 位小数（大 contextWindow 下不被压成 0%）；
 * - tokenCount>0 时至少 1 格填充，与 0 区分；
 * - ≥85% 转警示色。
 */

import React from "react";
import { Box, Text, useStdout } from "ink";
import { SpinnerGlyph } from "./spinner.tsx";
import { theme, statusColors, getThemeMode } from "./theme.ts";

export interface StatusBarProps {
  /** 当前模型名称 */
  model: string;
  /** 累计 Token 数 */
  tokenCount: number;
  /** Agent 运行状态 */
  status: "idle" | "running" | "error" | "compacting";
  /** 当前会话 ID（短显示；T1 起仅用于兼容旧调用，不再展示） */
  sessionId?: string;
  /** 上下文窗口大小 */
  contextWindow?: number;
  /** 工具卡详情开关（右侧提示 Ctrl+O 的当前态） */
  verboseTools?: boolean;
}

/** 百分比格式化：≥10% 取整，≥1% 保留 1 位，<0.05% 显示 <0.1%，其余保留 1 位 */
export function formatPercent(pct: number): string {
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct < 0.05) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}

/** 状态栏 — 单行极简 footer */
export function StatusBar({
  model,
  tokenCount,
  status,
  contextWindow,
  verboseTools = false,
}: StatusBarProps): React.ReactElement {
  // 状态指示器：idle/error/compacting 用静态图标，running 用动态帧
  const statusMap = {
    idle: { label: "●", color: statusColors.idle, dynamic: false },
    running: { label: "◐", color: theme.warning, dynamic: true },
    error: { label: "✗", color: statusColors.error, dynamic: false },
    compacting: { label: "↻", color: theme.brand, dynamic: false },
  };
  const s = statusMap[status];
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;

  // Token 占比（保留小数，避免大 contextWindow 下被四舍五入成 0）
  const hasWindow = !!contextWindow && contextWindow > 0;
  const tokenPct = hasWindow ? (tokenCount / contextWindow!) * 100 : null;

  // 上下文占用进度条（紧凑 12 格）
  const barWidth = 12;
  const filledRaw = tokenPct !== null ? Math.round((tokenPct / 100) * barWidth) : 0;
  // tokenCount>0 时至少显示 1 格，避免「有 token 但进度条仍全空」的假 0
  const filled =
    tokenPct !== null && tokenCount > 0
      ? Math.max(1, Math.min(barWidth, filledRaw))
      : Math.max(0, Math.min(barWidth, filledRaw));
  const barColor = tokenPct !== null && tokenPct >= 85 ? theme.warning : theme.brandDim;
  const pctLabel = tokenPct !== null ? formatPercent(tokenPct) : null;

  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      {/* 细分割线（opencode 风格：无重边框，一行细分隔） */}
      <Text color={theme.border}>{"─".repeat(Math.max(10, columns))}</Text>

      {/* 单行：左（状态 · 模型 · 主题）· 右（进度条 + token · 提示） */}
      <Box paddingX={1} justifyContent="space-between" flexShrink={0}>
        <Box>
          {s.dynamic && status === "running" ? (
            <SpinnerGlyph frames={["◐", "◓", "◑", "◒"]} intervalMs={240} color={theme.warning} withSpace={false} />
          ) : (
            <Text color={s.color}>{s.label}</Text>
          )}
          <Text>
            <Text color={theme.subtle}> · </Text>
            <Text bold color={theme.text}>{model}</Text>
            <Text color={theme.subtle}> · {getThemeMode()}</Text>
          </Text>
        </Box>
        <Box>
          {pctLabel !== null && (
            <Text>
              <Text color={barColor}>{`${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`}</Text>
              <Text dimColor> {pctLabel}</Text>
              <Text color={theme.subtle}> · {tokenCount.toLocaleString()} tok</Text>
            </Text>
          )}
          <Text color={theme.subtle}> · Ctrl+O {verboseTools ? "收起" : "详情"}</Text>
        </Box>
      </Box>
    </Box>
  );
}
