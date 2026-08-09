/**
 * @fengagent/tools — file-write 内置工具
 *
 * 写入文件，需权限审批。
 */
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import type { ToolResult } from "@fengagent/core/tool";
import { ask } from "@fengagent/core/permission";
import { z } from "zod";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const inputSchema = z.object({
  filePath: z.string().describe("Path to write the file to (absolute or relative)"),
  content: z.string().describe("Content to write to the file"),
});

type WriteInput = z.infer<typeof inputSchema>;

export const fileWrite: ToolDefinition<WriteInput> = {
  name: "file-write",
  description: "Write content to a file. Creates parent directories if needed. Requires permission approval.",

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

  checkPermissions(_input: WriteInput) {
    return ask("file-write will modify the filesystem. Confirm to proceed.");
  },

  async execute(input: WriteInput, context: ToolContext): Promise<ToolResult> {
    const filePath = resolve(context.workdir, input.filePath);

    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const existed = existsSync(filePath);
      writeFileSync(filePath, input.content, "utf-8");

      return {
        content: existed
          ? `Successfully overwrote ${filePath} (${input.content.length} characters)`
          : `Successfully created ${filePath} (${input.content.length} characters)`,
        metadata: {
          filePath,
          size: input.content.length,
          existed,
        },
      };
    } catch (err) {
      return {
        content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },

  renderUse(input: WriteInput): string {
    return `Write ${input.filePath} (${input.content.length} chars)`;
  },
};
