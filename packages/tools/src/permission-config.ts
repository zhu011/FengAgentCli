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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
// 配置写入
// ──────────────────────────────────────────────

/**
 * 追加一条权限规则到 `.fengagent/permissions.json`（TUI「永久放行」用）。
 *
 * - 已存在同 `tool` + `action` 的规则时不重复添加；
 * - 文件/目录不存在时创建；原子写（tmp + rename）；
 * - 返回写入后的完整配置（副本，不共享 `EMPTY_PERMISSION_CONFIG`）。
 *
 * @param workdir - 工作目录
 * @param rule - 要追加的规则
 * @returns 写入后的权限配置
 */
export function appendPermissionRule(
  workdir: string,
  rule: PermissionRule,
): PermissionConfig {
  const loaded = loadPermissionConfig(workdir);
  const config: PermissionConfig = { cache: loaded.cache, rules: [...loaded.rules] };
  if (!config.rules.some((r) => r.tool === rule.tool && r.action === rule.action)) {
    config.rules.push(rule);
  }

  const configPath = resolve(workdir, PERMISSIONS_CONFIG_PATH);
  const body = `${JSON.stringify(config, null, 2)}\n`;
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, configPath);
  return config;
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
