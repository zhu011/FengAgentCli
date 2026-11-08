/**
 * @fengagent/cli — TUI 工具调用卡片组件
 *
 * T1 起默认**单行折叠**（状态图标 + 工具名 + 结果摘要），详情模式（verbose）
 * 显示完整参数与结果——由 App 的 Ctrl+O 全局切换。
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
  /** 显示完整详情（参数 + 结果卡片）；默认单行折叠 */
  verbose?: boolean;
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

/** 单行摘要：优先取首个字符串字段（command/path/pattern…），否则紧凑 JSON */
function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return truncate(input, 48);
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "path", "pattern", "query", "url", "file_path"]) {
      const v = record[key];
      if (typeof v === "string" && v) return truncate(v, 48);
    }
    try {
      return truncate(JSON.stringify(input), 48);
    } catch {
      return "";
    }
  }
  return truncate(String(input), 48);
}

/** 格式化工具结果为可读字符串 */
function formatResult(content: string): string {
  return truncate(content, 500);
}

/** 工具调用卡片 — 默认单行折叠；verbose 展开完整卡片 */
export function ToolView({ info, verbose = false }: ToolViewProps): React.ReactElement {
  const hasResult = info.result !== undefined;
  const isError = info.result?.isError === true;
  const statusIcon = hasResult
    ? (isError ? statusIcons.error : statusIcons.success)
    : "⏳";
  const statusColor = hasResult
    ? (isError ? statusColors.error : statusColors.success)
    : theme.warning;

  // ── 默认：单行折叠（✓ 工具名 · 摘要 — 结果首行）──
  if (!verbose) {
    const argSummary = summarizeInput(info.input);
    const resultSummary = hasResult
      ? truncate(info.result!.content.split("\n")[0] ?? "", 40)
      : "";
    return (
      <Box flexDirection="row">
        <Text color={statusColor}>{statusIcon}</Text>
        <Text dimColor> {info.name}</Text>
        {argSummary && <Text color={theme.subtle}> · {argSummary}</Text>}
        {resultSummary && (
          <Text dimColor> — {resultSummary}</Text>
        )}
      </Box>
    );
  }

  // ── verbose：完整卡片 ──
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
