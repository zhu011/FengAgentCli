/**
 * @fengagent/tools — MCP 客户端
 *
 * 连接 MCP Server（stdio / SSE 两种传输），自动发现工具。
 * 使用 @modelcontextprotocol/sdk。
 *
 * 参考 opencode MCP 实现（D:\AgentCode\opencode\packages\opencode\src\mcp\）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  type Tool as McpToolDef,
} from "@modelcontextprotocol/sdk/types.js";
import type { StdioServerConfig, SseServerConfig, ServerConfig } from "./mcp-config.ts";
import { DEFAULT_MCP_TIMEOUT } from "./mcp-config.ts";

// ──────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────

/** MCP Server 连接状态 */
export type McpServerStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

/** 单个 MCP Server 的连接实例 */
export interface McpServerConnection {
  /** Server 名称 */
  name: string;
  /** 连接状态 */
  status: McpServerStatus;
  /** MCP SDK Client 实例 */
  client: Client;
  /** 传输层实例 */
  transport: Transport;
  /** 发现的工具列表 */
  tools: McpToolDef[];
  /** 错误信息（status === "error" 时有值） */
  error?: string;
  /** 连接超时（毫秒） */
  timeout: number;
}

// ──────────────────────────────────────────────
// 内部辅助
// ──────────────────────────────────────────────

const CLIENT_INFO = {
  name: "fengagent",
  version: "0.1.0",
} as const;

const CLIENT_OPTIONS = {
  capabilities: {},
} as const;

/** 为 stdio server 创建传输层 */
function createStdioTransport(config: StdioServerConfig): StdioClientTransport {
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ...config.env,
    },
    stderr: "pipe",
  });
}

/** 为 SSE server 创建传输层 */
function createSseTransport(config: SseServerConfig): SSEClientTransport {
  return new SSEClientTransport(new URL(config.url), {
    requestInit: config.headers
      ? { headers: config.headers }
      : undefined,
  });
}

/** 带超时地连接 client */
async function connectWithTimeout(
  client: Client,
  transport: Transport,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`MCP server connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    client.connect(transport).then(
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** 分页列出所有工具 */
async function listAllTools(
  client: Client,
  timeoutMs: number,
): Promise<McpToolDef[]> {
  const tools: McpToolDef[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  for (let page = 0; page < 1000; page++) {
    const params = cursor === undefined ? undefined : { cursor };
    const result = await client.listTools(params, { timeout: timeoutMs });
    tools.push(...result.tools);
    if (result.nextCursor === undefined) {
      break;
    }
    if (seenCursors.has(result.nextCursor)) {
      throw new Error(`MCP listTools returned duplicate cursor: ${result.nextCursor}`);
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  return tools;
}

// ──────────────────────────────────────────────
// MCP Client 管理器
// ──────────────────────────────────────────────

/**
 * MCP Client 管理器。
 *
 * 负责连接/断开所有配置的 MCP Server，发现工具，并调用工具。
 */
export class McpClient {
  private connections = new Map<string, McpServerConnection>();

  /**
   * 连接单个 MCP Server。
   *
   * @param name - Server 名称
   * @param config - Server 配置
   * @returns 连接实例
   */
  async connect(name: string, config: ServerConfig): Promise<McpServerConnection> {
    // 如果已有同名连接，先断开
    await this.disconnect(name);

    const timeout = config.timeout ?? DEFAULT_MCP_TIMEOUT;

    const client = new Client(CLIENT_INFO, CLIENT_OPTIONS);

    let transport: Transport;
    if (config.type === "stdio") {
      transport = createStdioTransport(config);
    } else {
      transport = createSseTransport(config);
    }

    const connection: McpServerConnection = {
      name,
      status: "connecting",
      client,
      transport,
      tools: [],
      timeout,
    };

    this.connections.set(name, connection);

    try {
      await connectWithTimeout(client, transport, timeout);
      connection.tools = await listAllTools(client, timeout);
      connection.status = "connected";
    } catch (err) {
      connection.status = "error";
      connection.error = err instanceof Error ? err.message : String(err);
    }

    return connection;
  }

  /**
   * 批量连接所有配置的 MCP Server。
   *
   * @param configs - Server 名称 → 配置映射
   * @returns 所有连接实例（包括失败的）
   */
  async connectAll(
    configs: Record<string, ServerConfig>,
  ): Promise<McpServerConnection[]> {
    const entries = Object.entries(configs).filter(
      ([, config]) => config.enabled !== false,
    );

    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.connect(name, config)),
    );

    // Promise.allSettled 不会因连接失败而 reject，
    // 但 connect 内部会捕获并设置 status="error"
    return results.map((r) => {
      if (r.status === "fulfilled") {
        return r.value;
      }
      // 理论上不会走到这里，connect 内部已 catch
      throw r.reason;
    });
  }

  /**
   * 断开单个 Server。
   */
  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) {
      return;
    }
    try {
      await conn.client.close();
    } catch {
      // 忽略关闭错误
    }
    conn.status = "disconnected";
    this.connections.delete(name);
  }

  /**
   * 断开所有 Server。
   */
  async disconnectAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.allSettled(names.map((n) => this.disconnect(n)));
  }

  /**
   * 获取所有已连接 Server 的所有工具定义。
   *
   * @returns Record<toolName, { serverName, def, client, timeout }>
   */
  getTools(): Record<
    string,
    { serverName: string; def: McpToolDef; client: Client; timeout: number }
  > {
    const result: Record<
      string,
      { serverName: string; def: McpToolDef; client: Client; timeout: number }
    > = {};

    for (const [serverName, conn] of this.connections) {
      if (conn.status !== "connected") {
        continue;
      }
      for (const def of conn.tools) {
        const toolName = sanitize(serverName) + "__" + sanitize(def.name);
        result[toolName] = {
          serverName,
          def,
          client: conn.client,
          timeout: conn.timeout,
        };
      }
    }

    return result;
  }

  /**
   * 获取所有连接的状态。
   */
  getConnections(): McpServerConnection[] {
    return [...this.connections.values()];
  }

  /**
   * 获取单个连接。
   */
  getConnection(name: string): McpServerConnection | undefined {
    return this.connections.get(name);
  }

  /**
   * 调用 MCP 工具。
   *
   * @param client - MCP SDK Client 实例
   * @param toolName - 工具名（MCP 原始名称，非前缀名）
   * @param args - 工具参数
   * @param timeout - 调用超时（毫秒）
   * @returns MCP 工具调用结果
   */
  async callTool(
    client: Client,
    toolName: string,
    args: Record<string, unknown>,
    timeout: number,
  ): Promise<unknown> {
    const result = await client.callTool(
      { name: toolName, arguments: args },
      CallToolResultSchema,
      { timeout },
    );
    return result;
  }
}

// ──────────────────────────────────────────────
// 工具名清理
// ──────────────────────────────────────────────

/**
 * 清理字符串为合法的工具名部分（仅字母+数字+下划线+连字符）。
 * 参考 opencode 的 sanitize 函数。
 */
export function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * 生成 MCP 工具的前缀名：mcp__<server>__<tool>
 */
export function mcpToolName(serverName: string, toolName: string): string {
  return "mcp__" + sanitize(serverName) + "__" + sanitize(toolName);
}
