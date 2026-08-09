/**
 * @fengagent/tools — MCP 配置定义
 *
 * MCP Server 配置的 Zod Schema 和加载逻辑。
 * 支持 .fengagent/mcp-servers.json 配置文件和 FENG_MCP_SERVERS 环境变量。
 */
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { safeJsonParse, getEnv } from "@fengagent/shared/utils";

// ──────────────────────────────────────────────
// Schema 定义
// ──────────────────────────────────────────────

/** Stdio 传输的 MCP Server 配置 */
export const StdioServerConfigSchema = z.object({
  /** 传输类型 */
  type: z.literal("stdio").default("stdio"),
  /** 可执行文件名或路径（如 "npx", "node"） */
  command: z.string(),
  /** 命令行参数 */
  args: z.array(z.string()).default([]),
  /** 环境变量（合并到 process.env） */
  env: z.record(z.string(), z.string()).optional(),
  /** 工作目录 */
  cwd: z.string().optional(),
  /** 连接超时（毫秒，默认 30000） */
  timeout: z.number().int().positive().optional(),
  /** 是否启用 */
  enabled: z.boolean().default(true),
});

/** SSE 传输的 MCP Server 配置 */
export const SseServerConfigSchema = z.object({
  /** 传输类型 */
  type: z.literal("sse"),
  /** SSE Server URL */
  url: z.string(),
  /** 自定义 HTTP 头 */
  headers: z.record(z.string(), z.string()).optional(),
  /** 连接超时（毫秒，默认 30000） */
  timeout: z.number().int().positive().optional(),
  /** 是否启用 */
  enabled: z.boolean().default(true),
});

/** 单个 MCP Server 配置（stdio 或 sse） */
export const ServerConfigSchema = z.discriminatedUnion("type", [
  StdioServerConfigSchema,
  SseServerConfigSchema,
]);

/** 完整的 MCP 配置（server name → config 映射） */
export const McpServersConfigSchema = z.record(z.string(), ServerConfigSchema);

// ──────────────────────────────────────────────
// 类型导出
// ──────────────────────────────────────────────

export type StdioServerConfig = z.infer<typeof StdioServerConfigSchema>;
export type SseServerConfig = z.infer<typeof SseServerConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type McpServersConfig = z.infer<typeof McpServersConfigSchema>;

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────

/** 项目级 MCP 配置文件路径 */
export const MCP_SERVERS_CONFIG_PATH = ".fengagent/mcp-servers.json";

/** 默认连接超时（毫秒） */
export const DEFAULT_MCP_TIMEOUT = 30_000;

// ──────────────────────────────────────────────
// 配置加载
// ──────────────────────────────────────────────

/**
 * 加载 MCP Server 配置。
 *
 * 来源优先级（从低到高）：
 * 1. .fengagent/mcp-servers.json（项目级）
 * 2. FENG_MCP_SERVERS 环境变量（JSON 格式）
 *
 * @param workdir - 工作目录（用于查找 .fengagent/mcp-servers.json）
 * @returns 合并后的 MCP Server 配置
 */
export function loadMcpConfig(workdir: string): McpServersConfig {
  // 1. 项目配置文件
  const configPath = resolve(workdir, MCP_SERVERS_CONFIG_PATH);
  let fileConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    fileConfig = safeJsonParse(raw, {} as Record<string, unknown>);
  }

  // 2. 环境变量（JSON 格式）
  const envRaw = getEnv("FENG_MCP_SERVERS", "");
  let envConfig: Record<string, unknown> = {};
  if (envRaw) {
    envConfig = safeJsonParse(envRaw, {} as Record<string, unknown>);
  }

  // 合并（环境变量覆盖文件配置）
  const merged = { ...fileConfig, ...envConfig };

  if (Object.keys(merged).length === 0) {
    return {};
  }

  // 校验
  return McpServersConfigSchema.parse(merged);
}
