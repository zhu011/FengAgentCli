/**
 * @fengagent/cli — TUI 状态栏组件
 *
 * 设计语言借鉴 opencode 状态栏（D:\AgentCode\opencode）：
 * - 单行 footer：左组（状态指示 · model · tokens · session），右组帮助提示，space-between；
 * - 上下文占用进度条独立一行（分段块状条 + 精确百分比 + token 计数）。
 *
 * Token 进度显示修复：
 * - contextWindow 很大（如项目配置 1,000,000）时，百分比会被 Math.round 压成 0%，
 *   导致「token 进度一直为 0」。改为保留 1 位小数（0.2% / 12.4%），
 *   极小占比（<0.05%）显示 <0.1%，且 tokenCount>0 时进度条至少填充 1 格，
 *   让进度「动起来」、永远与 0 区分。
 */

import React from "react";
import { Box, Text, useStdout } from "ink";
import { SpinnerGlyph } from "./spinner.tsx";
import { theme, statusColors } from "./theme.ts";

export interface StatusBarProps {
  /** 当前模型名称 */
  model: string;
  /** 累计 Token 数 */
  tokenCount: number;
  /** Agent 运行状态 */
  status: "idle" | "running" | "error" | "compacting";
  /** 当前会话 ID（短显示） */
  sessionId?: string;
  /** 上下文窗口大小 */
  contextWindow?: number;
}

/** 分隔符（中点分隔） */
function Dot({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text>
      <Text color={theme.subtle}> · </Text>
      {children}
    </Text>
  );
}

/** 百分比格式化：≥10% 取整，≥1% 保留 1 位，<0.05% 显示 <0.1%，其余保留 1 位 */
function formatPercent(pct: number): string {
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct < 0.05) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}

/** 状态栏 — 底部状态信息条 */
export function StatusBar({
  model,
  tokenCount,
  status,
  sessionId,
  contextWindow,
}: StatusBarProps): React.ReactElement {
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;

  // 状态指示器：idle/error/compacting 用静态图标，running 用动态帧
  const statusMap = {
    idle: { label: "●", color: statusColors.idle, dynamic: false },
    running: { label: "◐", color: theme.warning, dynamic: true },
    error: { label: "✗", color: statusColors.error, dynamic: false },
    compacting: { label: "↻", color: theme.brand, dynamic: false },
  };
  const s = statusMap[status];

  // Token 占比（保留小数，避免大 contextWindow 下被四舍五入成 0）
  const hasWindow = !!contextWindow && contextWindow > 0;
  const tokenPct = hasWindow ? (tokenCount / contextWindow!) * 100 : null;

  // 会话 ID 短格式
  const shortId = sessionId ? sessionId.slice(0, 8) : "—";

  // 上下文占用进度条（右端百分比 + 左侧填充条）
  const barWidth = 16;
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
      {/* 上下文占用进度条 */}
      {tokenPct !== null && (
        <Box paddingX={1}>
          <Text color={barColor}>{`${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`}</Text>
          <Text dimColor> {pctLabel}</Text>
          <Text color={theme.subtle}> · {tokenCount.toLocaleString()} tok</Text>
        </Box>
      )}

      {/* 细分割线（opencode 风格：无重边框，一行细分隔） */}
      <Text color={theme.border}>{"─".repeat(Math.max(10, columns))}</Text>

      {/* 底部单行：左组状态信息 · 右组提示 */}
      <Box paddingX={1} justifyContent="space-between" flexShrink={0}>
        <Box>
          {s.dynamic && status === "running" ? (
            <SpinnerGlyph frames={["◐", "◓", "◑", "◒"]} intervalMs={240} color={theme.warning} withSpace={false} />
          ) : (
            <Text color={s.color}>{s.label}</Text>
          )}
          <Dot>
            <Text bold color={theme.text}>{model}</Text>
          </Dot>
          <Dot>
            <Text color={theme.dim}>
              Tokens: {tokenCount.toLocaleString()}
            </Text>
          </Dot>
          <Dot>
            <Text color={theme.subtle}>Session: {shortId}</Text>
          </Dot>
        </Box>
        <Box>
          <Text color={theme.subtle}>/help</Text>
        </Box>
      </Box>
    </Box>
  );
}
