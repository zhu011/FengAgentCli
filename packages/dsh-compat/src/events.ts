/**
 * @fengagent/dsh-compat — dsh 工具事件桥（P2）
 *
 * dsh 的工具流水线是 **waterfall 事件**外挂策略：
 *
 * ```
 * tools/pre-execute  (exec, next) -> allow | deny | ask
 * tools/execute      (exec, next) -> ToolExecutionResult        （包裹执行，本包不实现）
 * tools/post-execute (exec, result, next) -> accept | block
 * ```
 *
 * dsh 插件（如 `dsh-plugin-writing-guard` 的自动审计）全部挂在这里；
 * FengAgentCli 的执行器走自有的 `HookRegistry`（`triggerPreToolUse` /
 * `triggerPostToolUse`）。名字不同、载荷不同 → 插件「能装上但钩子静默不触发」，
 * 也就是实测里的「工具可用、行为降级」。
 *
 * 本文件把两侧接起来，**双向**都覆盖：
 *
 * 1. **dsh → feng**：`DshToolEventBridge.preExecute/postExecute` 用 Cordis 的
 *    `ctx.waterfall(...)` 发 dsh 事件，把 `deny`/`ask` 收敛成 feng 的
 *    `{allowed:false}`、把 `block` 收敛成错误结果——dsh 侧的否决真的能拦下调用；
 * 2. **feng → dsh**：`attach(hooks)` 往 `HookRegistry` 注册一对钩子，于是
 *    **FengAgentCli 原生工具**也会产生 `tools/pre-execute` / `tools/post-execute`，
 *    dsh 插件的审计不再是「只看见 dsh 工具」。
 *
 * 已被 dsh-compat 适配的 dsh 工具（`markDshTool`）由**适配器自己**发事件
 * （见 `adapter.ts`），因为只有适配器手里有那次调用的真实 `exec`（身份/token/
 * agent 同一份）。桥在钩子路径上跳过这些工具名，避免同一次调用发两遍。
 *
 * 已知偏差（`docs/DSH-CONTRACT-MAP.md` 同步）：
 * - 原生工具的 `exec.signal` 是永不 abort 的信号：feng 执行器不把取消面暴露给 hook；
 * - 原生工具的 `result.value` 用结果文本兜底（feng 的 `ToolResult` 没有 canonical
 *   JSON value 字段），`isError` 为真时给 `error.message`；
 * - `ask` 在 hook 阶段没有审批服务可用 → **fail-closed 转 deny**（放行会绕过审批）；
 * - 监听器抛错被包含（记日志后按默认决策继续），与 dsh 对 `tools/result` 的
 *   包含语义一致，避免审计插件把工具执行带崩。
 */

import type { DshAgentResolver } from "./exec-context.ts";

/** Cordis 事件面（结构类型：不把 cordis 版本绑进本包） */
export interface DshEventContextLike {
  waterfall?(name: string, ...args: unknown[]): unknown;
  emit?(name: string, ...args: unknown[]): void;
  on?(name: string, listener: (...args: unknown[]) => unknown): unknown;
}

/** dsh `PreToolDecision` 的本包子集（`ask` 保留，由桥决定如何收敛） */
export type DshPreDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "ask"; readonly reason?: string };

/** dsh `PostToolDecision` 的本包子集（content/feedback 用文本，适配器再转块） */
export type DshPostDecision =
  | { readonly kind: "accept"; readonly content?: string }
  | { readonly kind: "block"; readonly feedback: string };

/** 发事件时使用的执行视图（比 `DshToolExec` 宽松：原生工具没有 deferContext） */
export interface DshEventExec {
  readonly callId: string;
  readonly rootCallId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly agent?: unknown;
  readonly signal?: AbortSignal;
  readonly token?: symbol;
}

/** 发事件时使用的执行结果视图 */
export interface DshEventResult {
  readonly isError: boolean;
  readonly content: string;
  readonly value?: unknown;
  readonly error?: { readonly message: string };
}

/** 适配器只需要这两个方法（避免 adapter → 桥实现的运行时依赖） */
export interface DshToolEventSink {
  preExecute(exec: DshEventExec): Promise<DshPreDecision>;
  postExecute(exec: DshEventExec, result: DshEventResult): Promise<DshPostDecision>;
}

/** FengAgentCli `HookRegistry` 的注册面（只需 register/unregister） */
export interface DshHookRegistryLike {
  register(event: "pre-tool-use" | "post-tool-use", handler: (...args: never[]) => unknown): void;
  unregister?(event: "pre-tool-use" | "post-tool-use", handler: (...args: never[]) => unknown): boolean;
}

/** FengAgentCli `HookContext` 的本包视图 */
export interface DshHookContextLike {
  readonly workdir: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly metadata?: Record<string, unknown>;
}

/** FengAgentCli `ToolResult` 的本包视图 */
export interface DshHookToolResultLike {
  readonly content: string;
  readonly isError?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface DshToolEventBridgeOptions {
  /** 解析原生工具事件的 `exec.agent`（缺省 undefined） */
  resolveAgent?: DshAgentResolver;
  /** 诊断输出（缺省 console.warn） */
  onWarning?: (message: string, error?: unknown) => void;
}

/** 永不 abort 的取消信号（原生工具在 hook 阶段拿不到 feng 的取消面） */
const NEVER_ABORT = new AbortController();

/** 从任意返回值里取 `kind`（监听器可能返回 undefined / 非法对象） */
function decisionKind(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

/**
 * dsh 工具事件桥。
 *
 * 装配一次即可，随插件 fiber 一起释放（`attach` 返回的 disposer 负责钩子）。
 */
export class DshToolEventBridge implements DshToolEventSink {
  /** 已被适配器接管的 dsh 工具名（这些工具的事件由适配器发，桥不重复发） */
  private readonly adapted = new Set<string>();
  /** pre/post 之间共享同一个 exec（原生工具路径） */
  private readonly pending = new WeakMap<object, DshEventExec>();
  private sequence = 0;

  constructor(
    private readonly ctx: DshEventContextLike,
    private readonly options: DshToolEventBridgeOptions = {},
  ) {}

  /** 标记「该工具由适配器发事件」 */
  markDshTool(toolName: string): void {
    this.adapted.add(toolName);
  }

  /** 撤销标记（工具被 unregister 时调用） */
  unmarkDshTool(toolName: string): void {
    this.adapted.delete(toolName);
  }

  /** 该工具是否由适配器发事件 */
  isDshTool(toolName: string): boolean {
    return this.adapted.has(toolName);
  }

  /**
   * 发 `tools/pre-execute`（waterfall）。
   *
   * 无监听器 / 全部调用 `next()` → `allow`；监听器不调 `next()` 且没给决策 → `deny`
   * （fail-closed，与 dsh「不调 next 即否决」一致）。
   */
  async preExecute(exec: DshEventExec): Promise<DshPreDecision> {
    const waterfall = this.ctx.waterfall;
    if (typeof waterfall !== "function") return { kind: "allow" };
    let produced: unknown;
    try {
      produced = await this.ctx.waterfall!("tools/pre-execute", exec, async (): Promise<DshPreDecision> => ({
        kind: "allow",
      }));
    } catch (err) {
      this.warn(`tools/pre-execute listener failed for "${exec.name}"; call allowed by default`, err);
      return { kind: "allow" };
    }
    const kind = decisionKind(produced);
    if (kind === "allow") return { kind: "allow" };
    if (kind === "deny") {
      const reason = (produced as { reason?: unknown }).reason;
      return { kind: "deny", reason: typeof reason === "string" ? reason : "denied by tools/pre-execute" };
    }
    if (kind === "ask") {
      const reason = (produced as { reason?: unknown }).reason;
      return { kind: "ask", ...(typeof reason === "string" ? { reason } : {}) };
    }
    return {
      kind: "deny",
      reason: `tools/pre-execute returned no decision for "${exec.name}" (a listener vetoed without calling next())`,
    };
  }

  /**
   * 发 `tools/post-execute`（waterfall）。
   *
   * 监听器可 `block`（转成错误结果）或 `accept` 并替换展示文本；抛错/无决策
   * → 接受原结果（不能让审计插件把已完成的调用变成失败）。
   */
  async postExecute(exec: DshEventExec, result: DshEventResult): Promise<DshPostDecision> {
    const waterfall = this.ctx.waterfall;
    if (typeof waterfall !== "function") return { kind: "accept" };
    const payload: Record<string, unknown> = {
      isError: result.isError,
      content: [{ type: "text", text: result.content }],
      ...(result.value === undefined ? {} : { value: result.value }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
    let produced: unknown;
    try {
      produced = await this.ctx.waterfall!(
        "tools/post-execute",
        exec,
        payload,
        async (): Promise<DshPostDecision> => ({ kind: "accept" }),
      );
    } catch (err) {
      this.warn(`tools/post-execute listener failed for "${exec.name}"; result accepted as-is`, err);
      return { kind: "accept" };
    }
    const kind = decisionKind(produced);
    if (kind === "block") {
      const feedback = (produced as { feedback?: unknown }).feedback;
      return {
        kind: "block",
        feedback: Array.isArray(feedback)
          ? blocksToText(feedback)
          : typeof feedback === "string"
            ? feedback
            : "blocked by tools/post-execute",
      };
    }
    if (kind === "accept") {
      const content = (produced as { content?: unknown }).content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? blocksToText(content)
            : undefined;
      return text === undefined ? { kind: "accept" } : { kind: "accept", content: text };
    }
    return { kind: "accept" };
  }

  /**
   * 把 dsh 事件接到 FengAgentCli 的 `HookRegistry`（feng → dsh 方向）。
   *
   * @param hooks - `createHookRegistry()` 的实例（或同形状对象）
   * @returns 卸载函数（撤销两个钩子）
   */
  attach(hooks: DshHookRegistryLike): () => void {
    const preHandler = async (
      toolName: string,
      input: unknown,
      hookCtx: DshHookContextLike,
    ): Promise<{ allowed: boolean; reason?: string }> => {
      // 适配器自己发过事件的 dsh 工具：跳过（否则同一次调用两份事件）
      if (this.adapted.has(toolName)) return { allowed: true };

      const exec = this.synthesize(toolName, input, hookCtx);
      this.pending.set(hookCtx as object, exec);
      const decision = await this.preExecute(exec);
      if (decision.kind === "allow") return { allowed: true };
      if (decision.kind === "deny") return { allowed: false, reason: decision.reason };
      return {
        allowed: false,
        reason:
          `tools/pre-execute asked for approval${decision.reason ? ` (${decision.reason})` : ""}; ` +
          "FengAgentCli has no approval service at the hook stage, so the call is denied (fail-closed)",
      };
    };

    const postHandler = async (
      toolName: string,
      input: unknown,
      result: DshHookToolResultLike,
      hookCtx: DshHookContextLike,
    ): Promise<DshHookToolResultLike> => {
      if (this.adapted.has(toolName)) return result;

      const exec = this.pending.get(hookCtx as object) ?? this.synthesize(toolName, input, hookCtx);
      this.pending.delete(hookCtx as object);
      const decision = await this.postExecute(exec, {
        isError: result.isError === true,
        content: result.content,
      });
      if (decision.kind === "block") {
        return {
          content: decision.feedback,
          isError: true,
          metadata: { ...(result.metadata ?? {}), blockedByDshPostExecute: true },
        };
      }
      if (decision.content !== undefined) {
        return { ...result, content: decision.content };
      }
      return result;
    };

    hooks.register("pre-tool-use", preHandler as never);
    hooks.register("post-tool-use", postHandler as never);
    return () => {
      hooks.unregister?.("pre-tool-use", preHandler as never);
      hooks.unregister?.("post-tool-use", postHandler as never);
    };
  }

  /** 原生工具的执行视图（hook 阶段只有 workdir/session/message） */
  private synthesize(
    toolName: string,
    input: unknown,
    hookCtx: DshHookContextLike,
  ): DshEventExec {
    this.sequence += 1;
    const callId = `feng-hook:${hookCtx.messageId}:${toolName}:${this.sequence}`;
    const agent = this.options.resolveAgent?.({
      toolName,
      input,
      context: {
        workdir: hookCtx.workdir,
        sessionId: hookCtx.sessionId,
        messageId: hookCtx.messageId,
        metadata: hookCtx.metadata,
      },
    });
    return {
      callId,
      rootCallId: callId,
      name: toolName,
      arguments: input,
      ...(agent === undefined ? {} : { agent }),
      signal: NEVER_ABORT.signal,
      token: Symbol(`dsh-hook-exec:${callId}`),
    };
  }

  private warn(message: string, error?: unknown): void {
    if (this.options.onWarning) {
      this.options.onWarning(message, error);
      return;
    }
    console.warn(`[dsh-compat] ${message}${error === undefined ? "" : `: ${String(error)}`}`);
  }
}

/** 把 dsh 的 `ContentBlock[]` 文本块拼成字符串（非文本块丢弃，与投影同口径） */
function blocksToText(blocks: readonly unknown[]): string {
  return blocks
    .filter((block): block is { type: string; text?: string } => {
      return block !== null && typeof block === "object";
    })
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

