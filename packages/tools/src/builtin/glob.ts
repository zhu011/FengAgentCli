/**
 * @fengagent/tools — glob 内置工具
 *
 * 文件模式匹配。
 */
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import type { ToolResult } from "@fengagent/core/tool";
import { ALLOW } from "@fengagent/core/permission";
import { z } from "zod";
import { resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";

const inputSchema = z.object({
  pattern: z.string().describe("The glob pattern to match (e.g. 'src/**/*.ts'). Supports brace expansion '{a,b}', negation '!', and recursive '**'."),
  path: z.string().optional().describe("Directory to search in (defaults to current working directory)"),
});

type GlobInput = z.infer<typeof inputSchema>;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDirectory(dir: string, maxDepth = 2): string[] {
  const entries: string[] = [];
  try {
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = `${dir}\\${item.name}`;
      entries.push(fullPath + (item.isDirectory() ? "\\" : ""));
      if (item.isDirectory() && maxDepth > 0) {
        entries.push(...listDirectory(fullPath, maxDepth - 1));
      }
    }
  } catch {
    // skip inaccessible
  }
  return entries;
}

export const globTool: ToolDefinition<GlobInput> = {
  name: "glob",
  description: "Find files matching a glob pattern. Supports recursive '**' patterns and brace expansion.",

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

  async execute(input: GlobInput, context: ToolContext): Promise<ToolResult> {
    const root = input.path
      ? resolve(context.workdir, input.path)
      : context.workdir;

    if (!input.pattern.includes("*") && !input.pattern.includes("?") && !input.pattern.includes("[")) {
      const exactPath = resolve(root, input.pattern);
      if (isDirectory(exactPath)) {
        const files = listDirectory(exactPath).sort();
        const content = files.length > 0
          ? files.join("\n")
          : `${exactPath}\\(empty directory)`;
        return {
          content,
          metadata: { count: files.length, root: exactPath },
        };
      }
    }

    try {
      const normalizedPattern = input.pattern.replace(/\//g, "\\");
      const glob = new Bun.Glob(normalizedPattern);
      const scanResults = glob.scanSync({
        cwd: root,
        absolute: true,
        onlyFiles: false,
      });

      const results = [...scanResults];

      const sorted = results.sort(
        (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }),
      );

      const content = sorted.length > 0
        ? sorted.map((f) =>
            f.replace(/\\/g, "/") + (isDirectory(f) ? "/" : ""),
          ).join("\n")
        : "No files matched the pattern";

      return {
        content,
        metadata: { count: sorted.length, pattern: input.pattern },
      };
    } catch (err) {
      return {
        content: `Error matching glob pattern: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },

  renderUse(input: GlobInput): string {
    return `glob ${input.pattern}${input.path ? ` in ${input.path}` : ""}`;
  },
};
