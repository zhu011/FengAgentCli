/**
 * @fengagent/cli — TUI 权限审批对话框
 *
 * 当工具需要用户审批时，渲染确认对话框。
 * 用户按 y/Enter 允许，n/N 拒绝。
 *
 * 参考 ARCHITECTURE.md 第 6.5 节权限审批方案。
 */

import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionResult } from "@fengagent/core";

/** 权限请求信息 */
export interface PermissionDialogRequest {
  /** 唯一 ID */
  id: string;
  /** 工具名 */
  toolName: string;
  /** 工具输入参数 */
  input: unknown;
  /** 请求原因 */
  reason?: string;
}

/** 权限对话框属性 */
export interface PermissionDialogProps {
  /** 权限请求 */
  request: PermissionDialogRequest;
  /** 用户响应回调 */
  onRespond: (decision: PermissionResult) => void;
}

/**
 * 权限审批对话框。
 *
 * 显示工具名、参数预览和请求原因，
 * 等待用户按键决策：
 * - y / Enter → 允许
 * - n / Esc → 拒绝
 */
export function PermissionDialog({
  request,
  onRespond,
}: PermissionDialogProps): React.ReactElement {
  const [responded, setResponded] = useState(false);

  // 格式化输入预览（截断长内容）
  const inputPreview = formatInputPreview(request.input);

  useInput((input, key) => {
    if (responded) return;

    // y 或 Enter → 允许
    if (input === "y" || input === "Y" || key.return) {
      setResponded(true);
      onRespond({ decision: "allow" });
      return;
    }

    // n 或 Esc → 拒绝
    if (input === "n" || input === "N" || key.escape) {
      setResponded(true);
      onRespond({ decision: "deny", reason: "User denied" });
      return;
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      paddingY={0}
      marginY={1}
    >
      <Text color="yellow" bold>
        ⚠ 权限请求
      </Text>
      <Box flexDirection="column" marginY={0}>
        <Text>
          <Text color="gray">工具: </Text>
          <Text color="cyan" bold>{request.toolName}</Text>
        </Text>
        {inputPreview && (
          <Text>
            <Text color="gray">参数: </Text>
            <Text>{inputPreview}</Text>
          </Text>
        )}
        {request.reason && (
          <Text>
            <Text color="gray">原因: </Text>
            <Text color="yellow">{request.reason}</Text>
          </Text>
        )}
      </Box>
      <Box marginTop={0}>
        <Text color="gray">
          {responded ? "已响应" : "[y] 允许  [n] 拒绝"}
        </Text>
      </Box>
    </Box>
  );
}

/** 格式化输入参数为预览字符串（截断长内容） */
function formatInputPreview(input: unknown): string {
  if (input === null || input === undefined) {
    return "";
  }

  let str: string;
  if (typeof input === "string") {
    str = input;
  } else if (typeof input === "object") {
    str = JSON.stringify(input);
  } else {
    str = String(input);
  }

  // 截断到 120 字符
  if (str.length > 120) {
    return str.slice(0, 117) + "...";
  }

  return str;
}

// ──────────────────────────────────────────────
// React Hook：usePermissionRequester
// ──────────────────────────────────────────────

/**
 * React Hook：创建权限请求器。
 *
 * 返回：
 * - pendingRequest: 当前待处理的请求（null 表示无）
 * - requestPermission: 回调函数，传给 agent.prompt()
 * - respond: 响应函数，从 PermissionDialog onRespond 调用
 *
 * 用法：
 * ```tsx
 * const { pendingRequest, requestPermission, respond } = usePermissionRequester();
 *
 * // 传入 agent.prompt(text, session, { requestPermission })
 * // 渲染:
 * // {pendingRequest && <PermissionDialog request={pendingRequest} onRespond={respond} />}
 * ```
 */
export function usePermissionRequester(): {
  pendingRequest: PermissionDialogRequest | null;
  requestPermission: (permission: {
    toolName: string;
    input: unknown;
    reason?: string;
  }) => Promise<PermissionResult>;
  respond: (decision: PermissionResult) => void;
  clear: () => void;
} {
  const [pendingRequest, setPendingRequest] =
    useState<PermissionDialogRequest | null>(null);
  const resolveRef = useRef<
    ((result: PermissionResult) => void) | null
  >(null);

  const requestPermission = useCallback(
    (permission: {
      toolName: string;
      input: unknown;
      reason?: string;
    }): Promise<PermissionResult> => {
      return new Promise<PermissionResult>((resolve) => {
        const id = crypto.randomUUID();
        resolveRef.current = resolve;
        setPendingRequest({
          id,
          toolName: permission.toolName,
          input: permission.input,
          reason: permission.reason,
        });
      });
    },
    [],
  );

  const respond = useCallback((decision: PermissionResult): void => {
    if (resolveRef.current) {
      resolveRef.current(decision);
      resolveRef.current = null;
    }
    setPendingRequest(null);
  }, []);

  const clear = useCallback((): void => {
    if (resolveRef.current) {
      resolveRef.current({ decision: "deny", reason: "Cleared" });
      resolveRef.current = null;
    }
    setPendingRequest(null);
  }, []);

  return { pendingRequest, requestPermission, respond, clear };
}
