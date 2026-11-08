/**
 * @fengagent/cli — TUI 顶部细 header（T1）
 *
 * claude-code 风格的一行顶栏：左（品牌 · 会话标题/短 ID · 模型），
 * 右（运行态指示）。会话信息从底部状态栏上移到这里。
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.ts";

export interface HeaderProps {
  /** 会话标题（缺省用短 ID） */
  sessionTitle?: string;
  /** 会话 ID（短显示） */
  sessionId?: string;
  /** 当前模型 */
  model: string;
  /** 运行状态（右侧指示） */
  status: "idle" | "running" | "error" | "compacting";
}

/** 顶部细 header — 一行 */
export function Header({
  sessionTitle,
  sessionId,
  model,
  status,
}: HeaderProps): React.ReactElement {
  const label = sessionTitle?.trim() || (sessionId ? sessionId.slice(0, 8) : "新会话");
  const statusLabel =
    status === "running" ? "生成中" : status === "error" ? "出错" : status === "compacting" ? "压缩中" : "";

  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      paddingX={1}
      flexShrink={0}
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderColor={theme.border}
    >
      <Box>
        <Text color={theme.brand} bold>⚡ FengAgentCli</Text>
        <Text color={theme.subtle}> · {label}</Text>
        <Text dimColor> · {model}</Text>
      </Box>
      <Box>
        {statusLabel ? (
          <Text color={status === "error" ? theme.error : theme.warning}>{statusLabel}</Text>
        ) : (
          <Text color={theme.subtle}>Ctrl+O 工具详情 · /help 命令</Text>
        )}
      </Box>
    </Box>
  );
}
