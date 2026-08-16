/**
 * @fengagent/cli — TUI 状态栏组件
 *
 * 借鉴 dsh-TUI StatusLine / Byline 设计语言：
 * - 上：上下文占用进度条（分段，借鉴 dsh renderContextBar 思路）
 * - 下：左组 model · tokens · session（中点分隔），右组帮助提示
 * - 运行中状态指示器为逐帧循环动态图标（SpinnerGlyph）
 */

import React from "react";
import { Box, Text } from "ink";
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

/** 分隔符（dsh Byline 中点分隔） */
function Dot({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text>
      <Text dimColor> · </Text>
      {children}
    </Text>
  );
}

/** 状态栏 — 底部状态信息条 */
export function StatusBar({
  model,
  tokenCount,
  status,
  sessionId,
  contextWindow,
}: StatusBarProps): React.ReactElement {
  // 状态指示器：idle/error/compacting 用静态图标，running 用动态帧
  const statusMap = {
    idle: { label: "●", color: statusColors.idle, dynamic: false },
    running: { label: "◐", color: theme.warning, dynamic: true },
    error: { label: "✗", color: statusColors.error, dynamic: false },
    compacting: { label: "↻", color: theme.brand, dynamic: false },
  };
  const s = statusMap[status];

  // Token 占比
  const tokenPct =
    contextWindow && contextWindow > 0
      ? Math.round((tokenCount / contextWindow) * 100)
      : null;

  // 会话 ID 短格式
  const shortId = sessionId ? sessionId.slice(0, 8) : "—";

  // 上下文占用进度条（右端百分比 + 左侧填充条，借鉴 dsh context bar）
  const barWidth = 16;
  const filled =
    tokenPct !== null ? Math.max(0, Math.min(barWidth, Math.round((tokenPct / 100) * barWidth))) : 0;
  const barColor = tokenPct !== null && tokenPct >= 85 ? theme.warning : theme.brandDim;

  return (
    <Box flexDirection="column" width="100%">
      {/* 上下文占用进度条 */}
      {tokenPct !== null && (
        <Box paddingX={1}>
          <Text color={barColor}>{`${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`}</Text>
          <Text dimColor> {tokenPct}%</Text>
        </Box>
      )}
      <Box borderStyle="single" borderColor={theme.border} paddingX={1} justifyContent="space-between">
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
