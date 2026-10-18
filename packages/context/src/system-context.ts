/**
 * @fengagent/context — 系统上下文加载
 *
 * 从多个来源组装系统提示：基础身份、日期、AGENTS.md、记忆、额外指令。
 * 参考 ARCHITECTURE.md 第 3.1 节步骤 3（上下文组装）。
 */

import { existsSync, readFileSync } from "node:fs";
import { expandTilde } from "@fengagent/shared/utils";
import {
  isReflectInjectionEnabled,
  resolvePromptOverlayPath,
  resolveReflectBudget,
} from "@fengagent/shared";
import type { ReflectionCard } from "@fengagent/core";
import { buildMemoryPrompt } from "./memory.ts";
import { buildReflectionInjection } from "./reflection.ts";

/** 系统上下文加载选项 */
export interface SystemContextOptions {
  /** 工作目录（用于查找 AGENTS.md 和 MEMORY.md） */
  workdir?: string;
  /** AGENTS.md 文件路径（覆盖默认 workdir/AGENTS.md） */
  agentsMdPath?: string;
  /** 额外的系统指令 */
  extraInstructions?: string;
  /** 是否加载 AGENTS.md（默认 true；设为 false 可避免运行时指令注入对话 Agent） */
  loadAgentsMd?: boolean;
  /** 是否加载 MEMORY.md 和记忆目录（默认 true） */
  loadMemory?: boolean;
  /** 额外的记忆提示片段（手动注入，不读取文件系统） */
  memoryPrompt?: string;
  /**
   * 自省卡（RSI P0 注入通道）。
   *
   * 传数组或同步取值函数（后者每次重载系统提示时重新取，便于「评测写入卡片 →
   * 下一轮注入」）。`FENG_REFLECT_INJECT=off` 时整段跳过；注入过程异常时降级为
   * 无卡继续，不阻塞系统提示。
   */
  reflections?: readonly ReflectionCard[] | (() => readonly ReflectionCard[]);
  /**
   * 数据根：给了就读取 `<数据根>/reflect/prompt-overlay.md`（验证闸采纳后写回的
   * 「本项目学到的规则」）。这是自改进真正生效的那一跳：写回 → 下一轮系统提示。
   * 与自省卡共用同一个关闭开关（`FENG_REFLECT_INJECT=off`）。
   */
  reflectDataRoot?: string;
  /** 自省注入环境变量（默认 process.env；测试可注入） */
  reflectEnv?: Record<string, string | undefined>;
}

/**
 * 读取验证闸写回的 overlay 文本（内部使用）。
 *
 * @returns overlay 内容（不存在/空/关闭时为空串）
 */
function resolveOverlaySection(options: SystemContextOptions): string {
  if (!options.reflectDataRoot) return "";
  const env = options.reflectEnv ?? process.env;
  if (!isReflectInjectionEnabled(env)) return "";
  try {
    const file = resolvePromptOverlayPath(options.reflectDataRoot);
    if (!existsSync(file)) return "";
    const content = readFileSync(file, "utf-8").trim();
    return content === "" ? "" : content;
  } catch {
    // 读失败 → 降级为无 overlay 继续
    return "";
  }
}

/**
 * 取注入用的自省小节文本（内部使用）。
 *
 * @returns 渲染好的小节（不需要注入时为空串）
 */
function resolveReflectionSection(options: SystemContextOptions): string {
  if (!options.reflections) return "";
  const env = options.reflectEnv ?? process.env;
  if (!isReflectInjectionEnabled(env)) return "";
  try {
    const cards =
      typeof options.reflections === "function"
        ? options.reflections()
        : options.reflections;
    if (!cards || cards.length === 0) return "";
    const budget = resolveReflectBudget(env);
    const injection = buildReflectionInjection(cards, {
      maxCards: budget.maxCards,
      maxTokens: budget.maxTokens,
    });
    return injection.text;
  } catch {
    // 注入失败 → 降级为无卡继续（不打断主循环）
    return "";
  }
}

/**
 * 加载并组装系统上下文。
 *
 * 组装顺序：
 * 1. 基础 Agent 身份
 * 2. 当前日期时间
 * 3. AGENTS.md（如存在）
 * 4. 记忆（MEMORY.md + .fengagent/memory/ 目录）
 * 5. 自省卡（RSI P0，硬预算 ≤5 条 / ≤600 token；`FENG_REFLECT_INJECT=off` 可关）
 * 6. 额外指令
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

  // 3. AGENTS.md（可选：默认加载，可通过 loadAgentsMd: false 禁用）
  if (options?.loadAgentsMd !== false) {
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

  // 5. 自省卡（RSI P0 注入通道；失败降级为无卡）
  const reflectionSection = options ? resolveReflectionSection(options) : "";
  if (reflectionSection) {
    parts.push(`\n${reflectionSection}`);
  }

  // 5.5 验证闸写回的规则（prompt-overlay.md；同一开关）
  const overlaySection = options ? resolveOverlaySection(options) : "";
  if (overlaySection) {
    parts.push(`\n${overlaySection}`);
  }

  // 6. 额外指令
  if (options?.extraInstructions) {
    parts.push(`\n${options.extraInstructions}`);
  }

  return parts.join("\n");
}
