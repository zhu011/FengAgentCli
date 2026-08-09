/**
 * @fengagent/tools — 输出截断
 *
 * 工具输出超过 FENG_TOOL_OUTPUT_MAX_CHARS 时，
 * 截断为摘要 + 溢出到临时文件。
 */
import { TOOL_OUTPUT_MAX_CHARS } from "@fengagent/shared/constants";
import { generateId, getEnvNumber } from "@fengagent/shared/utils";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TruncateResult {
  content: string;
  overflowFile?: string;
}

const FENG_OUTPUT_DIR = join(tmpdir(), "fengagent-output");

function ensureOutputDir(): void {
  if (!existsSync(FENG_OUTPUT_DIR)) {
    mkdirSync(FENG_OUTPUT_DIR, { recursive: true });
  }
}

export function truncateOutput(content: string): TruncateResult {
  const maxChars = getEnvNumber("FENG_TOOL_OUTPUT_MAX_CHARS", TOOL_OUTPUT_MAX_CHARS);

  if (content.length <= maxChars) {
    return { content };
  }

  const truncated = content.slice(0, maxChars - 30);
  const overflowContent = content;

  ensureOutputDir();
  const filename = `tool-output-${generateId()}.txt`;
  const filepath = join(FENG_OUTPUT_DIR, filename);
  writeFileSync(filepath, overflowContent, "utf-8");

  const summary = `${truncated}...\n[Output truncated: ${content.length} total chars. Full output written to ${filepath}]`;

  return {
    content: summary,
    overflowFile: filepath,
  };
}

export function getOutputDir(): string {
  return FENG_OUTPUT_DIR;
}
