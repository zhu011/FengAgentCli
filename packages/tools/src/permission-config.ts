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
/** 单条规则的决策动作（allow / deny / ask） */
export type PermissionAction = PermissionRule["action"];

/**
 * 规则匹配器 —— 定位要撤销的规则。
 *
 * - `tool` 按**字面**匹配（不做 `"*"` 通配展开：撤销 `"*"` 只删通配那一条，
 *   不会顺带删掉所有具体工具规则）；
 * - `action` 缺省时删除该 tool 的全部动作规则。
 */
export interface PermissionRuleMatcher {
  tool: string;
  action?: PermissionAction;
}

/** `removePermissionRule` 的返回：撤销后的配置 + 实际删掉的规则（供界面回显） */
export interface RemovePermissionRuleResult {
  config: PermissionConfig;
  removed: PermissionRule[];
}

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
 * 把配置原子写入 `.fengagent/permissions.json`（tmp + rename）。
 *
 * @param workdir - 工作目录
 * @param config - 要落盘的配置
 */
function writePermissionConfig(workdir: string, config: PermissionConfig): void {
  const configPath = resolve(workdir, PERMISSIONS_CONFIG_PATH);
  const body = `${JSON.stringify(config, null, 2)}\n`;
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, configPath);
}

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

  writePermissionConfig(workdir, config);
  return config;
}

/**
 * 撤销 `.fengagent/permissions.json` 里的永久规则（WebUI Permissions 面板「收回」）。
 *
 * - 按 {@link PermissionRuleMatcher} 匹配：`tool` 字面相等；给了 `action` 时动作也必须相等；
 * - 命中几条删几条（同 tool 的 allow/deny/ask 可被一并撤销）；
 * - 文件不存在 / 无命中 → 不写盘（不会凭空创建配置文件），`removed` 为空；
 * - 其余规则与 `cache` 开关原样保留，原子写（tmp + rename）；
 * - 返回撤销后的配置 + 实际删掉的规则（供界面回显）。
 *
 * @param workdir - 工作目录
 * @param matcher - 匹配条件（tool 必填，action 可选）
 * @returns 撤销结果
 */
export function removePermissionRule(
  workdir: string,
  matcher: PermissionRuleMatcher,
): RemovePermissionRuleResult {
  const tool = matcher.tool.trim();
  const loaded = loadPermissionConfig(workdir);
  if (!tool || loaded.rules.length === 0) {
    return { config: loaded, removed: [] };
  }

  const removed: PermissionRule[] = [];
  const kept: PermissionRule[] = [];
  for (const rule of loaded.rules) {
    const hit =
      rule.tool === tool &&
      (matcher.action === undefined || rule.action === matcher.action);
    if (hit) removed.push(rule);
    else kept.push(rule);
  }

  if (removed.length === 0) {
    return { config: loaded, removed };
  }

  const config: PermissionConfig = { cache: loaded.cache, rules: kept };
  writePermissionConfig(workdir, config);
  return { config, removed };
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
