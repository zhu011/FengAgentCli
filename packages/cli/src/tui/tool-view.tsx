/**
 * @fengagent/cli — TUI 工具调用卡片组件
 *
 * 显示工具名、输入参数、执行结果。
 * 视觉语言借鉴 dsh design-system：语义状态图标（✓/✗/⏳）+ 状态色边框。
 */

import React from "react";
import { Box, Text } from "ink";
import { theme, statusIcons, statusColors } from "./theme.ts";

/** 工具调用展示数据 */
export interface ToolCallInfo {
  /** 工具调用 ID */
  id: string;
  /** 工具名 */
  name: string;
  /** 输入参数 */
  input: unknown;
  /** 执行结果（完成后填充） */
  result?: {
    content: string;
    isError?: boolean;
  };
}

export interface ToolViewProps {
  info: ToolCallInfo;
  /** 是否折叠详情（默认展开） */
  collapsed?: boolean;
}

/** 截断字符串到最大长度 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/** 格式化工具输入为可读字符串 */
function formatInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return truncate(input, 200);
  try {
    return truncate(JSON.stringify(input, null, 2), 500);
  } catch {
    return String(input);
  }
}

/** 格式化工具结果为可读字符串 */
function formatResult(content: string): string {
  return truncate(content, 500);
}

/** 工具调用卡片 — 显示工具名、参数、结果 */
export function ToolView({ info, collapsed }: ToolViewProps): React.ReactElement {
  const hasResult = info.result !== undefined;
  const isError = info.result?.isError === true;
  const statusIcon = hasResult
    ? (isError ? statusIcons.error : statusIcons.success)
    : "⏳";
  const statusColor = hasResult
    ? (isError ? statusColors.error : statusColors.success)
    : theme.warning;

  if (collapsed) {
    return (
      <Box flexDirection="row">
        <Text color={statusColor}>{statusIcon}</Text>
        <Text dimColor> {info.name}</Text>
        {hasResult && (
          <Text dimColor> — {truncate(info.result!.content, 60)}</Text>
        )}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isError ? theme.error : hasResult ? theme.success : theme.tool}
      paddingX={1}
      marginY={0}
    >
      <Box flexDirection="row">
        <Text color={statusColor} bold>{statusIcon}</Text>
        <Text bold color={theme.text}> {info.name}</Text>
        <Text dimColor>  ·  {isError ? "失败" : hasResult ? "完成" : "执行中"}</Text>
      </Box>

      {/* 输入参数 */}
      {info.input !== undefined && (
        <Box flexDirection="column">
          <Text color={theme.subtle}>args:</Text>
          <Text color={theme.brand}>{formatInput(info.input)}</Text>
        </Box>
      )}

      {/* 执行结果 */}
      {hasResult && (
        <Box flexDirection="column">
          <Text color={theme.subtle}>result:</Text>
          <Text color={isError ? theme.error : theme.dim}>
            {formatResult(info.result!.content)}
          </Text>
        </Box>
      )}
    </Box>
  );
}
