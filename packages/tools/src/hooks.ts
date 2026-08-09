/**
 * @fengagent/tools — Hook 系统
 *
 * 生命周期钩子注册和触发。
 *
 * 支持的 Hook 事件：
 * - pre-tool-use：工具执行前（可阻止执行）
 * - post-tool-use：工具执行后（可修改结果）
 * - pre-compact：上下文压缩前
 * - post-compact：上下文压缩后
 *
 * 参考 ARCHITECTURE.md 第 4.6 节 Hook 系统设计。
 */
import type { ToolResult } from "@fengagent/core/tool";

// ──────────────────────────────────────────────
// Hook 上下文
// ──────────────────────────────────────────────

/** Hook 执行上下文 — 传递给所有 hook handler 的运行时信息 */
export interface HookContext {
  /** 工作目录 */
  workdir: string;
  /** 当前会话 ID */
  sessionId: string;
  /** 当前消息 ID */
  messageId: string;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

// ──────────────────────────────────────────────
// Hook 处理器类型
// ──────────────────────────────────────────────

/** pre-tool-use hook 返回值 */
export interface PreToolUseResult {
  /** 是否允许执行 */
  allowed: boolean;
  /** 阻止原因（allowed=false 时） */
  reason?: string;
}

/** pre-tool-use hook — 工具执行前调用，可阻止执行 */
export type PreToolUseHook = (
  toolName: string,
  input: unknown,
  context: HookContext,
) => Promise<PreToolUseResult> | PreToolUseResult;

/** post-tool-use hook — 工具执行后调用，可修改结果 */
export type PostToolUseHook = (
  toolName: string,
  input: unknown,
  result: ToolResult,
  context: HookContext,
) => Promise<ToolResult> | ToolResult;

/** pre-compact hook — 上下文压缩前调用 */
export type PreCompactHook = (
  messageCount: number,
  tokenCount: number,
  context: HookContext,
) => Promise<void> | void;

/** post-compact hook — 上下文压缩后调用 */
export type PostCompactHook = (
  summary: string,
  keptMessageCount: number,
  context: HookContext,
) => Promise<void> | void;

// ──────────────────────────────────────────────
// Hook 事件类型
// ──────────────────────────────────────────────

/** 所有支持的 Hook 事件名称 */
export type HookEvent =
  | "pre-tool-use"
  | "post-tool-use"
  | "pre-compact"
  | "post-compact";

// ──────────────────────────────────────────────
// Hook 注册器接口
// ──────────────────────────────────────────────

/** Hook handler 的泛型类型映射 */
export interface HookHandlers {
  "pre-tool-use": PreToolUseHook;
  "post-tool-use": PostToolUseHook;
  "pre-compact": PreCompactHook;
  "post-compact": PostCompactHook;
}

/** Hook 注册器接口 */
export interface HookRegistry {
  /** 注册 hook 处理器 */
  register<E extends HookEvent>(
    event: E,
    handler: HookHandlers[E],
  ): void;

  /** 注销 hook 处理器 */
  unregister<E extends HookEvent>(
    event: E,
    handler: HookHandlers[E],
  ): boolean;

  /** 获取指定事件的所有 handler */
  getHandlers<E extends HookEvent>(event: E): HookHandlers[E][];

  /** 触发 pre-tool-use hooks */
  triggerPreToolUse(
    toolName: string,
    input: unknown,
    context: HookContext,
  ): Promise<PreToolUseResult>;

  /** 触发 post-tool-use hooks */
  triggerPostToolUse(
    toolName: string,
    input: unknown,
    result: ToolResult,
    context: HookContext,
  ): Promise<ToolResult>;

  /** 触发 pre-compact hooks */
  triggerPreCompact(
    messageCount: number,
    tokenCount: number,
    context: HookContext,
  ): Promise<void>;

  /** 触发 post-compact hooks */
  triggerPostCompact(
    summary: string,
    keptMessageCount: number,
    context: HookContext,
  ): Promise<void>;

  /** 清除所有 hook */
  clear(): void;
}

// ──────────────────────────────────────────────
// Hook 注册器实现
// ──────────────────────────────────────────────

/**
 * 创建 Hook 注册器。
 *
 * Hook 按注册顺序执行。pre-tool-use hooks 中任一返回 allowed=false
 * 则阻止工具执行（短路）。post-tool-use hooks 链式传递结果，
 * 每个 hook 可以修改 result 并传给下一个。
 */
export function createHookRegistry(): HookRegistry {
  const handlers: {
    "pre-tool-use": PreToolUseHook[];
    "post-tool-use": PostToolUseHook[];
    "pre-compact": PreCompactHook[];
    "post-compact": PostCompactHook[];
  } = {
    "pre-tool-use": [],
    "post-tool-use": [],
    "pre-compact": [],
    "post-compact": [],
  };

  return {
    register<E extends HookEvent>(event: E, handler: HookHandlers[E]): void {
      (handlers[event] as unknown[]).push(handler);
    },

    unregister<E extends HookEvent>(
      event: E,
      handler: HookHandlers[E],
    ): boolean {
      const list = handlers[event] as unknown[];
      const idx = list.indexOf(handler);
      if (idx !== -1) {
        list.splice(idx, 1);
        return true;
      }
      return false;
    },

    getHandlers<E extends HookEvent>(event: E): HookHandlers[E][] {
      return [...(handlers[event] as HookHandlers[E][])] as HookHandlers[E][];
    },

    async triggerPreToolUse(
      toolName: string,
      input: unknown,
      context: HookContext,
    ): Promise<PreToolUseResult> {
      for (const hook of handlers["pre-tool-use"]) {
        const result = await hook(toolName, input, context);
        if (!result.allowed) {
          // 短路 — 阻止执行
          return result;
        }
      }
      return { allowed: true };
    },

    async triggerPostToolUse(
      toolName: string,
      input: unknown,
      result: ToolResult,
      context: HookContext,
    ): Promise<ToolResult> {
      let current = result;
      for (const hook of handlers["post-tool-use"]) {
        current = await hook(toolName, input, current, context);
      }
      return current;
    },

    async triggerPreCompact(
      messageCount: number,
      tokenCount: number,
      context: HookContext,
    ): Promise<void> {
      for (const hook of handlers["pre-compact"]) {
        await hook(messageCount, tokenCount, context);
      }
    },

    async triggerPostCompact(
      summary: string,
      keptMessageCount: number,
      context: HookContext,
    ): Promise<void> {
      for (const hook of handlers["post-compact"]) {
        await hook(summary, keptMessageCount, context);
      }
    },

    clear(): void {
      handlers["pre-tool-use"] = [];
      handlers["post-tool-use"] = [];
      handlers["pre-compact"] = [];
      handlers["post-compact"] = [];
    },
  };
}
