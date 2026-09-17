/**
 * @fengagent/core — 权限类型定义
 *
 * 工具执行前的权限审批类型。
 *
 * Human-in-the-loop：`allow` 决策可携带用户修改后的工具入参
 * （`{ decision: "allow", input }`）——用户在界面上调整参数后放行时，
 * 工具以修改后的参数执行。
 */

/** 权限决策类型 */
export type PermissionDecision = "allow" | "deny" | "ask";

/** 权限请求（工具向系统请求执行许可） */
export interface Permission {
  /** 工具名 */
  toolName: string;
  /** 工具输入参数 */
  input: unknown;
  /** 请求原因（给用户看的说明） */
  reason?: string;
}

/** 权限决策结果 */
export type PermissionResult =
  | { decision: "allow"; input?: unknown }
  | {
      decision: "deny";
      reason?: string;
      /**
       * 该拒绝是否「不可恢复」——即在同一运行环境里重试同样的调用**必然**再次失败。
       *
       * 典型场景：工具需要人工审批（ask / destructive），但当前运行没有
       * `requestPermission` 回调（非交互式宿主、守护进程 ACP 路径）。模型无法
       * 通过改参或重试自救，循环继续只是空耗 token（AGE-29 现场）。
       */
      unrecoverable?: boolean;
    }
  | { decision: "ask"; message?: string };

/** 权限过滤器（用于工具注册表的 materialize） */
export interface PermissionFilter {
  /** 允许的工具列表（"*" 表示全部） */
  allowed?: string[];
  /** 禁止的工具列表 */
  denied?: string[];
  /** 是否自动批准 */
  autoApprove?: boolean;
}

/** 快捷：允许 */
export const ALLOW: PermissionResult = { decision: "allow" };

/** 快捷：允许并携带用户修改后的工具入参（human-in-the-loop 改参重试） */
export function allowWithInput(input: unknown): PermissionResult {
  return { decision: "allow", input };
}

/** 快捷：拒绝 */
export function deny(reason?: string): PermissionResult {
  return { decision: "deny", reason };
}

/**
 * 快捷：拒绝，且标记为「不可恢复」（重试必然同样失败）。
 *
 * @param reason - 给用户/模型看的拒绝原因
 * @returns 带 `unrecoverable: true` 的拒绝决策
 */
export function denyUnrecoverable(reason?: string): PermissionResult {
  return { decision: "deny", reason, unrecoverable: true };
}

/** 快捷：询问用户 */
export function ask(message?: string): PermissionResult {
  return { decision: "ask", message };
}
