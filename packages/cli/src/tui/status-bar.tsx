/**
 * @fengagent/cli — TUI 状态栏组件
 *
 * 显示当前模型、Token 数、会话状态、压缩状态。
 */

import React from "react";
import { Box, Text } from "ink";

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

/** 状态栏 — 底部状态信息条 */
export function StatusBar({
  model,
  tokenCount,
  status,
  sessionId,
  contextWindow,
}: StatusBarProps): React.ReactElement {
  // 状态指示器
  const statusMap = {
    idle: { label: "●", color: "green" as const },
    running: { label: "◐", color: "yellow" as const },
    error: { label: "✗", color: "red" as const },
    compacting: { label: "↻", color: "blue" as const },
  };
  const s = statusMap[status];

  // Token 占比
  const tokenPct =
    contextWindow && contextWindow > 0
      ? Math.round((tokenCount / contextWindow) * 100)
      : null;

  // 会话 ID 短格式
  const shortId = sessionId ? sessionId.slice(0, 8) : "—";

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color={s.color}>{s.label}</Text>
      <Text dimColor> | </Text>
      <Text bold>{model}</Text>
      <Text dimColor> | </Text>
      <Text>Tokens: {tokenCount.toLocaleString()}{tokenPct !== null ? ` (${tokenPct}%)` : ""}</Text>
      <Text dimColor> | </Text>
      <Text dimColor>Session: {shortId}</Text>
      <Text dimColor> | </Text>
      <Text dimColor>/help for commands</Text>
    </Box>
  );
}
