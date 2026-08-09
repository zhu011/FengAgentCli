/**
 * @fengagent/tools — 权限配置加载器
 *
 * 从 .fengagent/permissions.json 加载细粒度权限规则。
 * 支持工具级别的 allow / deny / ask 决策。
 *
 * 配置文件格式：
 * ```json
 * {
 *   "rules": [
 *     { "tool": "bash", "action": "ask", "reason": "Bash requires approval" },
 *     { "tool": "file-write", "action": "allow" },
 *     { "tool": "file-read", "action": "allow" }
 *   ]
 * }
 * ```
 */
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { safeJsonParse } from "@fengagent/shared/utils";
import type { PermissionDecision } from "@fengagent/core/permission";

// ──────────────────────────────────────────────
// Schema 定义
// ──────────────────────────────────────────────

/** 单条权限规则 */
export const PermissionRuleSchema = z.object({
  /** 工具名（或 "*" 匹配所有工具） */
  tool: z.string(),
  /** 决策动作 */
  action: z.enum(["allow", "deny", "ask"]),
  /** 原因说明（可选） */
  reason: z.string().optional(),
});

/** 完整的权限配置文件 */
export const PermissionConfigSchema = z.object({
  /** 权限规则列表（按顺序匹配，第一个匹配的规则生效） */
  rules: z.array(PermissionRuleSchema).default([]),
  /** 是否启用决策缓存（默认 true） */
  cache: z.boolean().default(true),
});

// ──────────────────────────────────────────────
// 类型导出
// ──────────────────────────────────────────────

export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export type PermissionConfig = z.infer<typeof PermissionConfigSchema>;

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────

/** 项目级权限配置文件路径 */
export const PERMISSIONS_CONFIG_PATH = ".fengagent/permissions.json";

/** 空配置（默认行为） */
export const EMPTY_PERMISSION_CONFIG: PermissionConfig = {
  rules: [],
  cache: true,
};

// ──────────────────────────────────────────────
// 配置加载
// ──────────────────────────────────────────────

/**
 * 加载权限配置文件。
 *
 * 从 workdir/.fengagent/permissions.json 读取。
 * 文件不存在时返回空配置（不应用任何规则）。
 *
 * @param workdir - 工作目录
 * @returns 权限配置
 */
export function loadPermissionConfig(workdir: string): PermissionConfig {
  const configPath = resolve(workdir, PERMISSIONS_CONFIG_PATH);

  if (!existsSync(configPath)) {
    return EMPTY_PERMISSION_CONFIG;
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = safeJsonParse(raw, null);

  if (parsed === null) {
    return EMPTY_PERMISSION_CONFIG;
  }

  const result = PermissionConfigSchema.safeParse(parsed);
  if (!result.success) {
    return EMPTY_PERMISSION_CONFIG;
  }

  return result.data;
}

// ──────────────────────────────────────────────
// 规则匹配
// ──────────────────────────────────────────────

/**
 * 查找匹配的权限规则。
 *
 * 按顺序遍历规则列表，返回第一个匹配 toolName 的规则。
 * "*" 规则匹配所有工具名。
 *
 * @param config - 权限配置
 * @param toolName - 工具名
 * @returns 匹配的规则，或 null（无匹配）
 */
export function findMatchingRule(
  config: PermissionConfig,
  toolName: string,
): PermissionRule | null {
  for (const rule of config.rules) {
    if (rule.tool === "*" || rule.tool === toolName) {
      return rule;
    }
  }
  return null;
}

/**
 * 从规则获取 PermissionDecision。
 *
 * @param rule - 权限规则
 * @returns PermissionDecision 字符串
 */
export function ruleToDecision(rule: PermissionRule): PermissionDecision {
  return rule.action;
}
