/**
 * @fengagent/tools — MCP 模块入口
 *
 * MCP 客户端、配置加载、工具适配的统一导出。
 */
export { McpClient } from "./mcp-client.ts";
export type {
  McpServerStatus,
  McpServerConnection,
} from "./mcp-client.ts";
export { sanitize, mcpToolName } from "./mcp-client.ts";

export { adaptMcpTool, adaptMcpTools } from "./mcp-adapter.ts";

export {
  loadMcpConfig,
  StdioServerConfigSchema,
  SseServerConfigSchema,
  ServerConfigSchema,
  McpServersConfigSchema,
  MCP_SERVERS_CONFIG_PATH,
  DEFAULT_MCP_TIMEOUT,
} from "./mcp-config.ts";
export type {
  StdioServerConfig,
  SseServerConfig,
  ServerConfig,
  McpServersConfig,
} from "./mcp-config.ts";

// ──────────────────────────────────────────────
// MCP 工具注册
// ──────────────────────────────────────────────

import type { ToolRegistry } from "../registry.ts";
import { McpClient } from "./mcp-client.ts";
import { loadMcpConfig } from "./mcp-config.ts";
import { adaptMcpTools } from "./mcp-adapter.ts";

/**
 * MCP 注册结果。
 */
export interface McpRegistrationResult {
  /** MCP 客户端实例（用于后续断开连接） */
  client: McpClient;
  /** 注册的工具数量 */
  toolCount: number;
  /** 连接的 Server 名称列表 */
  connectedServers: string[];
  /** 连接失败的 Server 及错误信息 */
  failedServers: Array<{ name: string; error: string }>;
}

/**
 * 连接所有配置的 MCP Server，发现工具并注册到 ToolRegistry。
 *
 * 流程：
 * 1. 从 workdir/.fengagent/mcp-servers.json 和 FENG_MCP_SERVERS 环境变量加载配置
 * 2. 连接所有配置的 MCP Server（并行）
 * 3. 发现的工具适配为 ToolDefinition 并注册到 registry
 *
 * @param registry - 工具注册表
 * @param workdir - 工作目录（用于查找配置文件）
 * @returns 注册结果（含 MCP 客户端实例，用于后续清理）
 */
export async function registerMcpTools(
  registry: ToolRegistry,
  workdir: string,
): Promise<McpRegistrationResult> {
  const client = new McpClient();
  const configs = loadMcpConfig(workdir);

  if (Object.keys(configs).length === 0) {
    return {
      client,
      toolCount: 0,
      connectedServers: [],
      failedServers: [],
    };
  }

  // 连接所有 Server
  const connections = await client.connectAll(configs);

  const connectedServers: string[] = [];
  const failedServers: Array<{ name: string; error: string }> = [];

  for (const conn of connections) {
    if (conn.status === "connected") {
      connectedServers.push(conn.name);
    } else if (conn.status === "error") {
      failedServers.push({ name: conn.name, error: conn.error ?? "unknown error" });
    }
  }

  // 获取所有工具并适配注册
  const toolsMap = client.getTools();
  const adapted = adaptMcpTools(toolsMap);

  for (const tool of adapted) {
    // MCP 工具名前缀为 mcp__，不会与内置工具冲突
    // 如果已有同名工具（重复注册），先注销旧的
    if (registry.get(tool.name)) {
      registry.unregister(tool.name);
    }
    registry.register(tool);
  }

  return {
    client,
    toolCount: adapted.length,
    connectedServers,
    failedServers,
  };
}
