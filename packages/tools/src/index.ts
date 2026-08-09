/**
 * @fengagent/tools — 工具系统
 *
 * 工具注册中心、执行器、权限检查、Hook 系统、输出截断、内置工具、MCP 集成。
 */
export { createToolRegistry } from "./registry.ts";
export type { ToolRegistry } from "./registry.ts";

export { createToolExecutor } from "./executor.ts";
export type {
  ToolExecutor,
  ExecutionContext,
  ExecutedToolResult,
} from "./executor.ts";

export { createPermissionChecker } from "./permission.ts";
export type { PermissionChecker } from "./permission.ts";

export { createHookRegistry } from "./hooks.ts";
export type {
  HookRegistry,
  HookEvent,
  HookContext,
  HookHandlers,
  PreToolUseHook,
  PostToolUseHook,
  PreCompactHook,
  PostCompactHook,
  PreToolUseResult,
} from "./hooks.ts";

export {
  loadPermissionConfig,
  findMatchingRule,
  PermissionConfigSchema,
  PermissionRuleSchema,
  PERMISSIONS_CONFIG_PATH,
  EMPTY_PERMISSION_CONFIG,
} from "./permission-config.ts";
export type { PermissionConfig, PermissionRule } from "./permission-config.ts";

export { truncateOutput, getOutputDir } from "./truncate.ts";
export type { TruncateResult } from "./truncate.ts";

export { fileRead } from "./builtin/file-read.ts";
export { fileWrite } from "./builtin/file-write.ts";
export { fileEdit } from "./builtin/file-edit.ts";
export { bashTool } from "./builtin/bash.ts";
export { globTool } from "./builtin/glob.ts";
export { grepTool } from "./builtin/grep.ts";
export { taskTool } from "./builtin/task.ts";
export { memorySave } from "./builtin/memory.ts";
export { memorySearch } from "./builtin/memory.ts";
export { memoryList } from "./builtin/memory.ts";
export { skillTool, createSkillTool, createSkillLoader } from "./builtin/skill.ts";
export type { SkillDefinition, SkillLoader, SkillLoaderOptions } from "./builtin/skill.ts";

// MCP 集成
export {
  McpClient,
  registerMcpTools,
  adaptMcpTool,
  adaptMcpTools,
  loadMcpConfig,
  mcpToolName,
  sanitize,
  StdioServerConfigSchema,
  SseServerConfigSchema,
  ServerConfigSchema,
  McpServersConfigSchema,
  MCP_SERVERS_CONFIG_PATH,
  DEFAULT_MCP_TIMEOUT,
} from "./mcp/index.ts";
export type {
  McpServerStatus,
  McpServerConnection,
  McpRegistrationResult,
  StdioServerConfig,
  SseServerConfig,
  ServerConfig,
  McpServersConfig,
} from "./mcp/index.ts";

import { createToolRegistry } from "./registry.ts";
import { fileRead } from "./builtin/file-read.ts";
import { fileWrite } from "./builtin/file-write.ts";
import { fileEdit } from "./builtin/file-edit.ts";
import { bashTool } from "./builtin/bash.ts";
import { globTool } from "./builtin/glob.ts";
import { grepTool } from "./builtin/grep.ts";
import { taskTool } from "./builtin/task.ts";
import { memorySave } from "./builtin/memory.ts";
import { memorySearch } from "./builtin/memory.ts";
import { memoryList } from "./builtin/memory.ts";
import { skillTool } from "./builtin/skill.ts";

export function registerBuiltinTools(registry: ReturnType<typeof createToolRegistry>): void {
  registry.register(fileRead);
  registry.register(fileWrite);
  registry.register(fileEdit);
  registry.register(bashTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(taskTool);
  registry.register(memorySave);
  registry.register(memorySearch);
  registry.register(memoryList);
  registry.register(skillTool);
}
