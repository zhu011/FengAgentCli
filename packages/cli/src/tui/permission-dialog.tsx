/**
 * @fengagent/cli — TUI 权限审批对话框
 *
 * 当工具需要用户审批时，渲染确认对话框。五键决策：
 * - y / Enter → 允许（本次）
 * - e         → 改参后允许（编辑 JSON 入参，走 human-in-the-loop 改参链路）
 * - s         → 本会话总允许（同工具后续调用不再弹窗）
 * - p         → 永久允许（写 `.fengagent/permissions.json` 规则，下次启动生效）
 * - n / Esc   → 拒绝
 *
 * 参考 ARCHITECTURE.md 第 6.5 节权限审批方案；改参语义见 core `PermissionResult`。
 */

import React, { useCallback, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionResult } from "@fengagent/core";
import { appendPermissionRule } from "@fengagent/tools/permission-config";
import { theme, statusIcons } from "./theme.ts";

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

/** 放行记忆方式（respond 的附加语义） */
export type PermissionRemember = "session" | "permanent";

/** 选择模式下按键 → 决策（纯函数，供测试） */
export type ChoiceAction =
  | { kind: "allow" }
  | { kind: "allow-remember"; remember: PermissionRemember }
  | { kind: "deny" }
  | { kind: "edit" };

/**
 * 解析选择模式按键：
 * - y / Enter → 允许（本次）
 * - e → 改参后允许（进入编辑模式）
 * - s → 本会话总允许
 * - p → 永久允许
 * - n / Esc → 拒绝
 * - 其它 → null（无动作）
 */
export function resolveChoiceKey(
  input: string,
  key: { return: boolean; escape: boolean },
): ChoiceAction | null {
  if (input === "y" || input === "Y" || key.return) return { kind: "allow" };
  if (input === "e" || input === "E") return { kind: "edit" };
  if (input === "s" || input === "S") return { kind: "allow-remember", remember: "session" };
  if (input === "p" || input === "P") return { kind: "allow-remember", remember: "permanent" };
  if (input === "n" || input === "N" || key.escape) return { kind: "deny" };
  return null;
}

/** 改参编辑的种子文本：对象序列化为紧凑 JSON，其它原样字符串化 */
export function seedEditValue(input: unknown): string {
  if (input === null || input === undefined) return "{}";
  if (typeof input === "object") return JSON.stringify(input);
  return JSON.stringify(input);
}

/** 解析编辑后的参数文本（纯函数，供测试） */
export function parseEditedInput(
  text: string,
): { ok: true; input: unknown } | { ok: false } {
  try {
    return { ok: true, input: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** 权限对话框属性 */
export interface PermissionDialogProps {
  /** 权限请求 */
  request: PermissionDialogRequest;
  /** 用户响应回调（remember 携带会话级/永久放行的附加语义） */
  onRespond: (decision: PermissionResult, remember?: PermissionRemember) => void;
}

/**
 * 权限审批对话框。
 *
 * 显示工具名、参数预览和请求原因；选择模式下五键决策，
 * 编辑模式下逐字符修改 JSON 入参（Enter 提交、Esc 返回选择模式）。
 */
export function PermissionDialog({
  request,
  onRespond,
}: PermissionDialogProps): React.ReactElement {
  const [responded, setResponded] = useState(false);
  /** 选择模式 / 改参编辑模式 */
  const [mode, setMode] = useState<"choice" | "edit">("choice");
  /** 编辑中的参数 JSON 文本 */
  const [editValue, setEditValue] = useState("");
  /** 编辑模式的 JSON 解析错误提示 */
  const [editError, setEditError] = useState<string | null>(null);

  // 格式化输入预览（截断长内容）
  const inputPreview = formatInputPreview(request.input);

  const finish = useCallback(
    (decision: PermissionResult, remember?: PermissionRemember) => {
      setResponded(true);
      onRespond(decision, remember);
    },
    [onRespond],
  );

  useInput((input, key) => {
    if (responded) return;

    if (mode === "edit") {
      // Esc → 返回选择模式
      if (key.escape) {
        setMode("choice");
        setEditError(null);
        return;
      }
      // Enter → 解析 JSON，成功则带改后入参放行
      if (key.return) {
        const parsed = parseEditedInput(editValue);
        if (parsed.ok) {
          finish({ decision: "allow", input: parsed.input });
        } else {
          setEditError("JSON 解析失败，请修正后回车（Esc 返回）");
        }
        return;
      }
      // 退格
      if (key.backspace || key.delete) {
        setEditValue((v) => v.slice(0, -1));
        setEditError(null);
        return;
      }
      // 可打印字符（含中文；排除控制键组合）
      if (input.length > 0 && !key.ctrl && !key.meta) {
        setEditValue((v) => v + input);
        setEditError(null);
      }
      return;
    }

    // ── 选择模式 ──
    const action = resolveChoiceKey(input, { return: key.return, escape: key.escape });
    if (action === null) return;
    if (action.kind === "allow") {
      finish({ decision: "allow" });
    } else if (action.kind === "deny") {
      finish({ decision: "deny", reason: "User denied" });
    } else if (action.kind === "edit") {
      setEditValue(seedEditValue(request.input));
      setEditError(null);
      setMode("edit");
    } else {
      finish({ decision: "allow" }, action.remember);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={1}
      paddingY={0}
      marginY={1}
    >
      <Box flexDirection="row">
        <Text color={theme.warning} bold>
          {statusIcons.warning} 权限请求
        </Text>
        <Text dimColor>  — {request.toolName}</Text>
      </Box>
      <Box flexDirection="column" marginY={0}>
        {inputPreview && (
          <Text>
            <Text color={theme.subtle}>参数: </Text>
            <Text color={theme.text}>{inputPreview}</Text>
          </Text>
        )}
        {request.reason && (
          <Text>
            <Text color={theme.subtle}>原因: </Text>
            <Text color={theme.warning}>{request.reason}</Text>
          </Text>
        )}
      </Box>
      {mode === "edit" ? (
        <EditParamView value={editValue} error={editError} />
      ) : (
        <Box marginTop={0}>
          <Text color={theme.dim}>
            {responded
              ? "已响应"
              : "[y] 允许   [e] 改参后允许   [s] 本会话总允许   [p] 永久允许   [n] 拒绝"}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** 改参编辑视图（编辑中的 JSON 文本 + 光标 + 错误/提示行） */
export function EditParamView({
  value,
  error,
}: {
  value: string;
  error?: string | null;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={0}>
      <Text color={theme.subtle}>参数(JSON)&gt; </Text>
      <Text color={theme.text}>
        {value}
        <Text color={theme.brand}>▏</Text>
      </Text>
      {error ? (
        <Text color={theme.error}>{error}</Text>
      ) : (
        <Text color={theme.dim}>回车提交 · Esc 返回</Text>
      )}
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
 * React Hook：创建权限请求器（带会话级/永久放行记忆）。
 *
 * 返回：
 * - pendingRequest: 当前待处理的请求（null 表示无）
 * - requestPermission: 回调函数，传给 agent.prompt()
 * - respond: 响应函数，从 PermissionDialog onRespond 调用（可带 remember 语义）
 * - clear: 强制清空（Ctrl+C 中断时拒绝在途请求）
 *
 * 会话级放行：同工具后续请求直接 allow，不再弹窗（进程内存，重启即失效）；
 * 永久放行：追加 `.fengagent/permissions.json` 规则（下次启动起生效），
 * 同时加入本会话放行集，保证当次会话也立即生效。
 *
 * 用法：
 * ```tsx
 * const { pendingRequest, requestPermission, respond, clear } = usePermissionRequester(workdir);
 * // 传入 agent.prompt(text, session, { requestPermission })
 * // 渲染:
 * // {pendingRequest && <PermissionDialog request={pendingRequest} onRespond={respond} />}
 * ```
 */
export function usePermissionRequester(workdir?: string): {
  pendingRequest: PermissionDialogRequest | null;
  requestPermission: (permission: {
    toolName: string;
    input: unknown;
    reason?: string;
  }) => Promise<PermissionResult>;
  respond: (decision: PermissionResult, remember?: PermissionRemember) => void;
  clear: () => void;
} {
  const [pendingRequest, setPendingRequest] =
    useState<PermissionDialogRequest | null>(null);
  const resolveRef = useRef<
    ((result: PermissionResult) => void) | null
  >(null);
  /** 会话级放行集（工具名 → 本会话内不再询问） */
  const sessionAllowedRef = useRef<Set<string>>(new Set());
  /** 当前待处理请求的镜像（respond 回调里避免闭包过期） */
  const pendingRef = useRef<PermissionDialogRequest | null>(null);

  const requestPermission = useCallback(
    (permission: {
      toolName: string;
      input: unknown;
      reason?: string;
    }): Promise<PermissionResult> => {
      // 会话级放行：同工具直接放行，不再弹窗
      if (sessionAllowedRef.current.has(permission.toolName)) {
        return Promise.resolve({ decision: "allow" });
      }
      return new Promise<PermissionResult>((resolve) => {
        const id = crypto.randomUUID();
        resolveRef.current = resolve;
        const request: PermissionDialogRequest = {
          id,
          toolName: permission.toolName,
          input: permission.input,
          reason: permission.reason,
        };
        pendingRef.current = request;
        setPendingRequest(request);
      });
    },
    [],
  );

  const respond = useCallback(
    (decision: PermissionResult, remember?: PermissionRemember): void => {
      // 放行 + 记忆：更新会话集 / 追加永久规则
      if (decision.decision === "allow" && remember) {
        const toolName = pendingRef.current?.toolName;
        if (toolName) {
          sessionAllowedRef.current.add(toolName);
          if (remember === "permanent" && workdir) {
            try {
              appendPermissionRule(workdir, {
                tool: toolName,
                action: "allow",
                reason: "TUI 永久放行",
              });
            } catch (err) {
              // 写盘失败不影响本次放行；只留 stderr 一行，不打断 TUI
              process.stderr.write(
                `Warn: 永久放行写入失败（${toolName}）：${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          }
        }
      }
      pendingRef.current = null;
      if (resolveRef.current) {
        resolveRef.current(decision);
        resolveRef.current = null;
      }
      setPendingRequest(null);
    },
    [workdir],
  );

  const clear = useCallback((): void => {
    pendingRef.current = null;
    if (resolveRef.current) {
      resolveRef.current({ decision: "deny", reason: "Cleared" });
      resolveRef.current = null;
    }
    setPendingRequest(null);
  }, []);

  return { pendingRequest, requestPermission, respond, clear };
}
