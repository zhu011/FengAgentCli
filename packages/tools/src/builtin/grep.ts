/**
 * @fengagent/tools — grep 内置工具
 *
 * 文件内容正则搜索。
 */
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import type { ToolResult } from "@fengagent/core/tool";
import { ALLOW } from "@fengagent/core/permission";
import { z } from "zod";
import { resolve } from "node:path";
import { readFileSync, statSync, existsSync } from "node:fs";

const MAX_MATCHES = 200;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_LINE_LENGTH = 1000;

const inputSchema = z.object({
  pattern: z.string().describe("The regular expression pattern to search for"),
  path: z.string().optional().describe("Directory to search in (defaults to current working directory)"),
  include: z.string().optional().describe("Glob pattern to filter files (e.g. '*.ts', '*.{ts,tsx}')"),
});

type GrepInput = z.infer<typeof inputSchema>;

interface Match {
  file: string;
  line: number;
  content: string;
}

export const grepTool: ToolDefinition<GrepInput> = {
  name: "grep",
  description: "Search file contents using a regular expression pattern. Returns file paths, line numbers, and matching lines.",

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

  async execute(input: GrepInput, context: ToolContext): Promise<ToolResult> {
    const root = input.path
      ? resolve(context.workdir, input.path)
      : context.workdir;

    if (!existsSync(root)) {
      return {
        content: `Directory not found: ${root}`,
        isError: true,
      };
    }

    try {
      new RegExp(input.pattern);
    } catch (e) {
      return {
        content: `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }

    const regex = new RegExp(input.pattern);

    try {
      const includePattern = input.include ?? "**/*";
      const normalizedPattern = includePattern.replace(/\//g, "\\");
      const glob = new Bun.Glob(normalizedPattern);
      const scanResults = glob.scanSync({
        cwd: root,
        absolute: true,
        onlyFiles: true,
      });

      const files = [...scanResults];
      const matches: Match[] = [];

      for (const file of files) {
        if (matches.length >= MAX_MATCHES) break;

        try {
          const stat = statSync(file);
          if (stat.isDirectory() || stat.size > MAX_FILE_SIZE) continue;

          const content = readFileSync(file, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= MAX_MATCHES) break;

            const line = lines[i];
            if (line === undefined) continue;

            if (regex.test(line)) {
              const displayLine = line.length > MAX_LINE_LENGTH
                ? line.slice(0, MAX_LINE_LENGTH) + "..."
                : line;

              matches.push({
                file: file.replace(/\\/g, "/"),
                line: i + 1,
                content: displayLine.trimEnd(),
              });
            }
          }
        } catch {
          // skip inaccessible files
        }
      }

      const grouped = new Map<string, Match[]>();
      for (const m of matches) {
        if (!grouped.has(m.file)) grouped.set(m.file, []);
        grouped.get(m.file)!.push(m);
      }

      const output: string[] = [];
      for (const [file, fileMatches] of grouped) {
        output.push(`## ${file}`);
        for (const m of fileMatches) {
          output.push(`  ${m.line}: ${m.content}`);
        }
      }

      const resultContent = matches.length === 0
        ? `No matches found for pattern: ${input.pattern}`
        : output.join("\n");

      const truncated = matches.length >= MAX_MATCHES
        ? `Truncated at ${MAX_MATCHES} matches\n\n${resultContent}`
        : resultContent;

      return {
        content: truncated,
        metadata: { matchCount: matches.length, pattern: input.pattern },
      };
    } catch (err) {
      return {
        content: `Error searching files: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },

  renderUse(input: GrepInput): string {
    return `grep "${input.pattern}"${input.include ? ` (${input.include})` : ""}`;
  },
};
