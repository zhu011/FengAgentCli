/**
 * @fengagent/tools — 工具注册中心
 *
 * register/get/list/materialize。
 */
import type { ToolDefinition } from "@fengagent/core/tool";
import type { PermissionFilter } from "@fengagent/core/permission";
import { TOOL_NAME_REGEX } from "@fengagent/shared/constants";

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  materialize(filter?: PermissionFilter): ToolDefinition[];
  unregister(name: string): boolean;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      if (!TOOL_NAME_REGEX.test(tool.name)) {
        throw new Error(
          `Invalid tool name "${tool.name}": must match ${TOOL_NAME_REGEX}`,
        );
      }
      if (tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" is already registered`);
      }
      tools.set(tool.name, tool);
    },

    get(name: string): ToolDefinition | undefined {
      return tools.get(name);
    },

    list(): ToolDefinition[] {
      return [...tools.values()];
    },

    materialize(filter?: PermissionFilter): ToolDefinition[] {
      const all = this.list();

      if (!filter) {
        return all;
      }

      const { allowed, denied, autoApprove } = filter;

      if (autoApprove) {
        return all;
      }

      let result = all;

      if (allowed !== undefined && !allowed.includes("*")) {
        const allowedSet = new Set(allowed);
        result = result.filter((t) => allowedSet.has(t.name));
      }

      if (denied !== undefined && denied.length > 0) {
        const deniedSet = new Set(denied);
        result = result.filter((t) => !deniedSet.has(t.name));
      }

      return result;
    },

    unregister(name: string): boolean {
      return tools.delete(name);
    },
  };
}
