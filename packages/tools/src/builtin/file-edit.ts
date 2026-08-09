/**
 * @fengagent/tools — file-edit 内置工具
 *
 * 精确字符串替换编辑（参考 opencode Edit 工具）。
 */
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import type { ToolResult } from "@fengagent/core/tool";
import { ask } from "@fengagent/core/permission";
import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const inputSchema = z.object({
  filePath: z.string().describe("Path to the file to edit (absolute or relative)"),
  oldString: z.string().describe("The exact text to find and replace"),
  newString: z.string().describe("The text to replace it with (must be different from oldString)"),
  replaceAll: z.boolean().optional().default(false).describe("Replace all occurrences of oldString (default false)"),
});

export const fileEdit: ToolDefinition<z.input<typeof inputSchema>> = {
  name: "file-edit",
  description: "Perform exact string replacements in an existing file. When replaceAll is false, replaces only the first occurrence. When true, replaces all occurrences.",

  inputSchema,

  isReadOnly(): boolean {
    return false;
  },

  isDestructive(): boolean {
    return true;
  },

  isConcurrencySafe(): boolean {
    return false;
  },

  checkPermissions(_input: z.input<typeof inputSchema>) {
    return ask("file-edit will modify the filesystem. Confirm to proceed.");
  },

  async execute(input: z.input<typeof inputSchema>, context: ToolContext): Promise<ToolResult> {
    const filePath = resolve(context.workdir, input.filePath);

    if (input.oldString === input.newString) {
      return {
        content: "Error: oldString and newString must be different",
        isError: true,
      };
    }

    try {
      const original = readFileSync(filePath, "utf-8");

      if (input.replaceAll) {
        if (!original.includes(input.oldString)) {
          return {
            content: `Error: oldString not found in file ${filePath}`,
            isError: true,
          };
        }

        const adjusted = original.replaceAll(input.oldString, input.newString);
        writeFileSync(filePath, adjusted, "utf-8");

        const count = original.split(input.oldString).length - 1;
        return {
          content: `Successfully replaced ${count} occurrence(s) of oldString in ${filePath}`,
          metadata: { filePath, occurrences: count },
        };
      }

      const index = original.indexOf(input.oldString);
      if (index === -1) {
        return {
          content: `Error: oldString not found in file ${filePath}`,
          isError: true,
        };
      }

      const adjusted =
        original.slice(0, index) +
        input.newString +
        original.slice(index + input.oldString.length);

      writeFileSync(filePath, adjusted, "utf-8");

      return {
        content: `Successfully replaced oldString in ${filePath}`,
        metadata: { filePath, occurrences: 1 },
      };
    } catch (err) {
      return {
        content: `Error editing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },

  renderUse(input: z.input<typeof inputSchema>): string {
    const mode = input.replaceAll ? "(replace all)" : "";
    return `Edit ${input.filePath} ${mode}`;
  },
};
