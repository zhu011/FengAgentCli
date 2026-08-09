/**
 * @fengagent/context — 系统上下文加载
 *
 * 从多个来源组装系统提示：基础身份、日期、AGENTS.md、记忆、额外指令。
 * 参考 ARCHITECTURE.md 第 3.1 节步骤 3（上下文组装）。
 */

import { expandTilde } from "@fengagent/shared/utils";
import { buildMemoryPrompt } from "./memory.ts";

/** 系统上下文加载选项 */
export interface SystemContextOptions {
  /** 工作目录（用于查找 AGENTS.md 和 MEMORY.md） */
  workdir?: string;
  /** AGENTS.md 文件路径（覆盖默认 workdir/AGENTS.md） */
  agentsMdPath?: string;
  /** 额外的系统指令 */
  extraInstructions?: string;
  /** 是否加载 MEMORY.md 和记忆目录（默认 true） */
  loadMemory?: boolean;
  /** 额外的记忆提示片段（手动注入，不读取文件系统） */
  memoryPrompt?: string;
}

/**
 * 加载并组装系统上下文。
 *
 * 组装顺序：
 * 1. 基础 Agent 身份
 * 2. 当前日期时间
 * 3. AGENTS.md（如存在）
 * 4. 记忆（MEMORY.md + .fengagent/memory/ 目录）
 * 5. 额外指令
 *
 * @returns 组装后的系统提示字符串
 */
export async function loadSystemContext(
  options?: SystemContextOptions,
): Promise<string> {
  const parts: string[] = [];

  // 1. 基础身份
  parts.push("You are a helpful AI coding assistant.");

  // 2. 日期信息
  const now = new Date();
  parts.push(`\nCurrent date and time: ${now.toISOString()}`);

  // 3. AGENTS.md
  const agentsPath =
    options?.agentsMdPath ??
    `${options?.workdir ?? "."}/AGENTS.md`;
  try {
    const expanded = expandTilde(agentsPath);
    const file = Bun.file(expanded);
    if (await file.exists()) {
      const content = await file.text();
      parts.push(`\n## Project Instructions (AGENTS.md)\n${content}`);
    }
  } catch {
    // 文件不存在或读取失败 — 忽略
  }

  // 4. 记忆（MEMORY.md + 记忆目录）
  if (options?.memoryPrompt) {
    // 手动注入的记忆片段
    parts.push(`\n${options.memoryPrompt}`);
  } else if (options?.loadMemory !== false && options?.workdir) {
    // 从文件系统加载
    try {
      const memoryPrompt = await buildMemoryPrompt(options.workdir);
      if (memoryPrompt) {
        parts.push(`\n${memoryPrompt}`);
      }
    } catch {
      // 记忆加载失败 — 忽略，不阻塞系统提示
    }
  }

  // 5. 额外指令
  if (options?.extraInstructions) {
    parts.push(`\n${options.extraInstructions}`);
  }

  return parts.join("\n");
}
