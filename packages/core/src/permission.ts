/**
 * @fengagent/core — 权限类型定义
 *
 * 工具执行前的权限审批类型。
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
  | { decision: "allow" }
  | { decision: "deny"; reason?: string }
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

/** 快捷：拒绝 */
export function deny(reason?: string): PermissionResult {
  return { decision: "deny", reason };
}

/** 快捷：询问用户 */
export function ask(message?: string): PermissionResult {
  return { decision: "ask", message };
}
