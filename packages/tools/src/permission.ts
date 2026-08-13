/**
 * @fengagent/tools — 运行时权限检查
 *
 * 权限决策来源（优先级从高到低）：
 * 1. FENG_AUTO_APPROVE_TOOLS 环境变量 — 自动批准所有工具
 * 2. FENG_ALLOWED_TOOLS / FENG_DENIED_TOOLS 环境变量 — 允许/禁止列表
 * 3. .fengagent/permissions.json — 细粒度权限规则
 * 4. 工具自身的 checkPermissions — 工具级权限检查
 * 5. 工具属性推断 — 只读工具自动允许，破坏性工具询问用户
 *
 * 支持：权限决策缓存（同一工具+参数的记忆）。
 */
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import type { PermissionResult } from "@fengagent/core/permission";
import { ALLOW, deny, ask } from "@fengagent/core/permission";
import { getEnv, getEnvBoolean } from "@fengagent/shared/utils";
import { createLogger } from "@fengagent/shared";
import {
  loadPermissionConfig,
  findMatchingRule,
  EMPTY_PERMISSION_CONFIG,
  type PermissionConfig,
} from "./permission-config.ts";

const log = createLogger("permission");

export interface PermissionChecker {
  checkPermissions(
    tool: ToolDefinition,
    input: unknown,
    context: ToolContext,
  ): PermissionResult;

  /** 清除决策缓存 */
  clearCache(): void;
}

// ──────────────────────────────────────────────
// 决策缓存
// ──────────────────────────────────────────────

/** 缓存键：toolName + 参数哈希 */
type CacheKey = string;

/**
 * 生成权限缓存的键。
 *
 * 同一工具 + 同一参数 → 同一键。
 * 参数通过 JSON 序列化保证一致性。
 */
function cacheKey(toolName: string, input: unknown): CacheKey {
  const inputStr = typeof input === "string" ? input : JSON.stringify(input);
  return `${toolName}:${inputStr}`;
}

// ──────────────────────────────────────────────
// 权限检查器实现
// ──────────────────────────────────────────────

/**
 * 创建权限检查器。
 *
 * @param workdir - 工作目录（用于加载 .fengagent/permissions.json）
 * @param config - 可选的预加载权限配置（跳过文件读取）
 */
export function createPermissionChecker(
  workdir?: string,
  config?: PermissionConfig,
): PermissionChecker {
  // 加载权限配置（文件级规则）
  const permConfig: PermissionConfig =
    config ?? (workdir ? loadPermissionConfig(workdir) : EMPTY_PERMISSION_CONFIG);

  // 决策缓存
  const cacheEnabled = permConfig.cache;
  const decisionCache = new Map<CacheKey, PermissionResult>();

  function checkPermissions(
    tool: ToolDefinition,
    input: unknown,
    context: ToolContext,
  ): PermissionResult {
    // 1. 自动批准 — 最高优先级
    if (getEnvBoolean("FENG_AUTO_APPROVE_TOOLS", false)) {
      log.info("checkPermissions", `tool=${tool.name}, decision=allow, reason=autoApproveTools`);
      return ALLOW;
    }

    // 2. 决策缓存 — 检查是否已有记录
    const key = cacheKey(tool.name, input);
    if (cacheEnabled && decisionCache.has(key)) {
      return decisionCache.get(key)!;
    }

    // 3. 环境变量：允许列表
    const allowedRaw = getEnv("FENG_ALLOWED_TOOLS", "*");
    if (allowedRaw !== "*") {
      const allowed = allowedRaw.split(",").map((s) => s.trim());
      if (!allowed.includes(tool.name)) {
        const result = deny(`Tool "${tool.name}" is not in FENG_ALLOWED_TOOLS`);
        if (cacheEnabled) decisionCache.set(key, result);
        log.info("checkPermissions", `tool=${tool.name}, decision=deny, reason=notInAllowedList`);
        return result;
      }
    }

    // 4. 环境变量：禁止列表
    const deniedRaw = getEnv("FENG_DENIED_TOOLS", "");
    if (deniedRaw) {
      const denied = deniedRaw.split(",").map((s) => s.trim());
      if (denied.includes(tool.name)) {
        const result = deny(`Tool "${tool.name}" is in FENG_DENIED_TOOLS`);
        if (cacheEnabled) decisionCache.set(key, result);
        log.info("checkPermissions", `tool=${tool.name}, decision=deny, reason=inDeniedList`);
        return result;
      }
    }

    // 5. 配置文件规则（.fengagent/permissions.json）
    const rule = findMatchingRule(permConfig, tool.name);
    if (rule) {
      const result: PermissionResult =
        rule.action === "allow"
          ? ALLOW
          : rule.action === "deny"
            ? deny(rule.reason ?? `Tool "${tool.name}" is denied by permissions config`)
            : ask(rule.reason ?? `Tool "${tool.name}" requires approval`);
      if (cacheEnabled && result.decision !== "ask") {
        // 只缓存 allow/deny，ask 需要每次询问
        decisionCache.set(key, result);
      }
      return result;
    }

    // 6. 工具自身的权限检查（不缓存 — 可能依赖 context）
    if (tool.checkPermissions) {
      const result = tool.checkPermissions(input, context);
      if (result.decision !== "allow") {
        return result;
      }
    }

    // 7. 工具属性推断（不缓存 — 破坏性检查依赖 context.requestPermission）
    if (!tool.isReadOnly || tool.isReadOnly(input)) {
      if (cacheEnabled) decisionCache.set(key, ALLOW);
      return ALLOW;
    }

    if (tool.isDestructive && tool.isDestructive(input)) {
      if (context.requestPermission) {
        return ask(`Tool "${tool.name}" is destructive. Confirm execution?`);
      }
      // 不缓存 — 此 deny 依赖 context.requestPermission 是否存在
      return deny(
        `Tool "${tool.name}" is destructive and no permission callback available`,
      );
    }

    // 默认允许非破坏性工具
    if (cacheEnabled) decisionCache.set(key, ALLOW);
    log.debug("checkPermissions", `tool=${tool.name}, decision=allow, reason=default`);
    return ALLOW;
  }

  return {
    checkPermissions,
    clearCache(): void {
      decisionCache.clear();
    },
  };
}
