/**
 * @fengagent/tools — MCP 工具适配器
 *
 * 将 MCP Server 发现的工具适配为 FengAgent 的 ToolDefinition 接口。
 * MCP 工具使用 JSON Schema，而 FengAgent 使用 Zod schema，
 * 通过 zodJsonSchema 将 JSON Schema 转为宽松的 Zod schema。
 *
 * 参考 opencode catalog.ts 的 convertTool 函数。
 */
import type { ToolDefinition, ToolContext, ToolResult } from "@fengagent/core/tool";
import { ALLOW } from "@fengagent/core/permission";
import { z } from "zod";
import type { Tool as McpToolDef } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mcpToolName } from "./mcp-client.ts";

// ──────────────────────────────────────────────
// JSON Schema → Zod 转换
// ──────────────────────────────────────────────

/**
 * 将 JSON Schema 转为宽松的 Zod schema。
 *
 * MCP 工具的 inputSchema 是标准 JSON Schema（type: "object"），
 * 我们使用 z.object({}).passthrough() 来接受任意属性，
 * 同时保留原始 schema 信息供 LLM 使用。
 *
 * 注意：这里不做严格校验，因为 MCP 工具的 schema 可能包含
 * Zod 不支持的 JSON Schema 特性（如 $ref、oneOf 等）。
 * 实际校验由 MCP Server 端完成。
 */
function jsonSchemaToZod(_jsonSchema: unknown): z.ZodType<unknown> {
  // 使用宽松的 passthrough schema — 接受任意属性
  // 真正的 schema 校验由 MCP Server 执行
  return z.object({}).passthrough();
}

// ──────────────────────────────────────────────
// MCP 工具结果转换
// ──────────────────────────────────────────────

/**
 * 将 MCP 工具调用结果转为 FengAgent ToolResult。
 *
 * MCP 结果格式：
 * - content: Array<{ type: "text", text: string } | { type: "image", ... } | { type: "resource", ... }>
 * - isError: boolean
 */
function mcpResultToToolResult(
  mcpResult: unknown,
): ToolResult {
  const result = mcpResult as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  };

  // 提取所有 text 内容
  const textParts: string[] = [];
  if (result.content && Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item.type === "text" && item.text) {
        textParts.push(item.text);
      }
    }
  }

  // 如果没有 text 内容但有 structuredContent，序列化它
  if (textParts.length === 0 && result.structuredContent != null) {
    textParts.push(JSON.stringify(result.structuredContent, null, 2));
  }

  const content = textParts.join("\n\n") || "(empty result)";

  return {
    content,
    isError: result.isError === true,
  };
}

// ──────────────────────────────────────────────
// 工具适配
// ──────────────────────────────────────────────

/**
 * 将单个 MCP 工具定义适配为 FengAgent ToolDefinition。
 *
 * @param serverName - MCP Server 名称
 * @param mcpTool - MCP 工具定义
 * @param client - MCP SDK Client 实例（用于调用工具）
 * @param timeout - 调用超时（毫秒）
 * @returns 适配后的 ToolDefinition
 */
export function adaptMcpTool(
  serverName: string,
  mcpTool: McpToolDef,
  client: Client,
  timeout: number,
): ToolDefinition {
  const prefixedName = mcpToolName(serverName, mcpTool.name);
  const inputSchema = jsonSchemaToZod(mcpTool.inputSchema);

  return {
    name: prefixedName,
    description: mcpTool.description ?? `MCP tool: ${mcpTool.name} (from server: ${serverName})`,

    inputSchema,

    isReadOnly(): boolean {
      // MCP 协议不区分只读/写入，保守起见返回 false
      return false;
    },

    isDestructive(): boolean {
      // MCP 协议不区分破坏性，保守起见返回 false
      // 权限系统会根据配置决定是否需要询问
      return false;
    },

    isConcurrencySafe(): boolean {
      // MCP 工具可能涉及外部状态，不并行执行
      return false;
    },

    checkPermissions() {
      // MCP 工具默认允许，由 permission.ts 的全局规则控制
      return ALLOW;
    },

    async execute(
      input: unknown,
      _context: ToolContext,
    ): Promise<ToolResult> {
      try {
        const args = (input as Record<string, unknown>) ?? {};
        const mcpResult = await client.callTool(
          { name: mcpTool.name, arguments: args },
          undefined,
          { timeout },
        );
        return mcpResultToToolResult(mcpResult);
      } catch (err) {
        return {
          content: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },

    renderUse(input: unknown): string {
      const inputStr = typeof input === "object" && input !== null
        ? JSON.stringify(input)
        : String(input);
      const preview = inputStr.length > 80
        ? inputStr.slice(0, 77) + "..."
        : inputStr;
      return `mcp [${serverName}/${mcpTool.name}]: ${preview}`;
    },
  };
}

/**
 * 批量适配 MCP 工具。
 *
 * @param tools - getTools() 返回的 Record<toolName, { serverName, def, client, timeout }>
 * @returns ToolDefinition[]
 */
export function adaptMcpTools(
  tools: Record<
    string,
    { serverName: string; def: McpToolDef; client: Client; timeout: number }
  >,
): ToolDefinition[] {
  return Object.values(tools).map(({ serverName, def, client, timeout }) =>
    adaptMcpTool(serverName, def, client, timeout),
  );
}
