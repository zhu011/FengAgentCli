/**
 * @fengagent/tools — file-read 内置工具
 *
 * 读取文件内容，支持绝对/相对路径，Windows 兼容。
 */
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import type { ToolResult } from "@fengagent/core/tool";
import { ALLOW } from "@fengagent/core/permission";
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const inputSchema = z.object({
  filePath: z.string().describe("Path to the file to read (absolute or relative)"),
  offset: z.number().int().min(0).optional().default(0).describe("Line offset to start reading from (1-indexed, 0 for start)"),
  limit: z.number().int().min(0).optional().default(0).describe("Maximum number of lines to read (0 for all)"),
});

export const fileRead: ToolDefinition<z.input<typeof inputSchema>> = {
  name: "file-read",
  description: "Read the contents of a file. Supports absolute and relative paths, with optional offset and limit for pagination.",

  inputSchema,

  isReadOnly(): boolean {
    return true;
  },

  isDestructive(): boolean {
    return false;
  },

  isConcurrencySafe(): boolean {
    return true;
  },

  checkPermissions() {
    return ALLOW;
  },

  async execute(input: z.infer<typeof inputSchema>, context: ToolContext): Promise<ToolResult> {
    const filePath = resolve(context.workdir, input.filePath);

    if (!existsSync(filePath)) {
      return {
        content: `File not found: ${filePath}`,
        isError: true,
      };
    }

    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        return {
          content: `Path is a directory, not a file: ${filePath}`,
          isError: true,
        };
      }

      if (stat.size > MAX_FILE_SIZE) {
        return {
          content: `File is too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Max file size is 10 MB.`,
          isError: true,
        };
      }

      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.split("\n");

      const offset = input.offset;
      const limit = input.limit;

      let selectedLines: string[];
      if (offset > 0 || limit > 0) {
        const start = offset > 0 ? offset - 1 : 0;
        const end = limit > 0 ? start + limit : lines.length;
        selectedLines = lines.slice(start, end);
      } else {
        selectedLines = lines;
      }

      const content = selectedLines
        .map((line, i) => {
          const lineNum = (offset > 0 ? offset + i : i + 1);
          return `${lineNum}: ${line}`;
        })
        .join("\n");

      return {
        content,
        metadata: {
          filePath,
          totalLines: lines.length,
          selectedLines: selectedLines.length,
          fileSize: stat.size,
        },
      };
    } catch (err) {
      return {
        content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },

  renderUse(input: z.infer<typeof inputSchema>): string {
    const parts = [`Read ${input.filePath}`];
    if (input.offset > 0) parts.push(`from line ${input.offset}`);
    if (input.limit > 0) parts.push(`(limit ${input.limit})`);
    return parts.join(" ");
  },
};
