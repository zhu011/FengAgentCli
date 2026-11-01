/**
 * @fengagent/dsh-compat — dsh 工具执行上下文（P2）
 *
 * dsh 的工具体签名是 `execute(args, exec: ToolRunContext)`，`exec` 携带本次调用的
 * **身份**（`callId` / `rootCallId` / `token`）、**参数**、**调用方 agent**
 * （`exec.agent`，dsh 的作用域路由键，也是会话类工具的上下文来源）与取消信号
 * `exec.signal`。
 *
 * P1 只传了 `{ signal }`：`dsh-tool-todo-plus` 这类读 `exec.agent.session` 的工具
 * 在 execute 阶段直接 `TypeError`。本文件把 feng 的 `ToolContext` 升格成 dsh 的
 * `exec`：
 *
 * - `agent`：由宿主解析。默认解析器（见 `resolveAgentFromServices`）先取
 *   `ctx.agents` 的 live registry，未注册时回落到 `ctx.sessions` 的只读投影——
 *   与 `dsh` 一致：**没有 agent 时 `exec.agent` 为 undefined**，不伪造；
 * - `token`：每次调用一个新 symbol。dsh 里它是 registry 分配的**不透明调用身份**，
 *   不是鉴权 token（别和 Multica 的 `mat_` / `mul_` 混淆）；
 * - `arguments`：深冻结后的入参快照（dsh 在进入策略层前同样冻结/物化）；
 * - `deferContext` / `concludeTurn`：dsh `ToolRunContext` 的必需方法。FengAgentCli
 *   的 `ToolResult` 既没有 `additionalContexts` 通道，也没有「本回合到此结束」标记，
 *   所以这两个方法只**记录**在本对象上（`deferredContexts` / `concludedTurn`），
 *   宿主注册了回调就交付，没有就丢弃——偏差记在 `docs/DSH-CONTRACT-MAP.md`。
 */

import type { ToolContext } from "@fengagent/core";

/** dsh `ToolExecutionToken` 的结构替身：不透明调用身份 */
export type DshToolExecutionToken = symbol;

/**
 * dsh 工具体内可见的 `exec` 面。
 *
 * 只声明 dsh 0.1.0-rc.6 `ToolRunContext` 里 **映射得到** 的成员；`callId` 等
 * 身份字段是本包按 feng 侧 `messageId` 派生（见 `createDshExecContext`）。
 */
export interface DshToolExec {
  /** 本次调用 id（feng 侧按 messageId + 工具名 + 序号派生，进程内唯一） */
  readonly callId: string;
  /** 根调用 id：非嵌套调用时等于 `callId`（feng 侧没有 transport 嵌套） */
  readonly rootCallId: string;
  /** 工具名 */
  readonly name: string;
  /** 入参快照（深冻结） */
  readonly arguments: unknown;
  /** 调用方 agent（`ctx.agents` 命中，或会话投影；未装配则为 undefined） */
  readonly agent?: unknown;
  /** 取消信号（dsh `timeoutMs` 驱动；未声明超时时是一个永不 abort 的信号） */
  readonly signal: AbortSignal;
  /** 不透明调用身份 */
  readonly token: DshToolExecutionToken;
  /** 工具 defer 进来的上下文（FengAgentCli 无 additionalContexts 通道 → 仅记录） */
  readonly deferredContexts: readonly unknown[];
  /** 工具是否声明「本回合到此结束」（FengAgentCli loop 无该标记 → 仅记录） */
  readonly concludedTurn: boolean;
  deferContext(context: unknown): void;
  concludeTurn(): void;
}

/** 构造一个 `exec` 的入参 */
export interface DshExecContextParams {
  readonly toolName: string;
  readonly input: unknown;
  readonly context: ToolContext;
  readonly signal: AbortSignal;
}

/** `exec.agent` 解析器：宿主可按会话/工具/入参决定归到哪个 agent */
export type DshAgentResolver = (params: {
  readonly toolName: string;
  readonly input: unknown;
  readonly context: ToolContext;
}) => unknown;

export interface DshExecContextOptions {
  /** 解析 `exec.agent`；缺省不注入（dsh 允许 agent 为空） */
  resolveAgent?: DshAgentResolver;
  /** 工具调用 `exec.deferContext(...)` 时的交付回调（缺省丢弃，仅记录） */
  onDeferredContext?: (context: unknown, exec: DshToolExec) => void;
  /** 工具调用 `exec.concludeTurn()` 时的交付回调（缺省丢弃，仅记录） */
  onConcludeTurn?: (exec: DshToolExec) => void;
}

/** 深冻结（dsh 的入参在进入策略层前就被冻结；工具体不应改写出参） */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as unknown as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Object.getOwnPropertyNames(object)) {
    deepFreeze((object as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/**
 * 创建一个 `exec` 构造函数（每次工具调用调一次）。
 *
 * 返回的函数是纯同步的：不读网络、不查库，agent 解析由传入的
 * `resolveAgent` 负责（宿主可在这里做 `ctx.agents.get(sessionId)`）。
 */
export function createDshExecContext(
  options: DshExecContextOptions = {},
): (params: DshExecContextParams) => DshToolExec {
  let sequence = 0;

  return (params: DshExecContextParams): DshToolExec => {
    sequence += 1;
    const callId = `feng:${params.context.messageId}:${params.toolName}:${sequence}`;
    const agent = options.resolveAgent?.({
      toolName: params.toolName,
      input: params.input,
      context: params.context,
    });
    const deferredContexts: unknown[] = [];
    let concludedTurn = false;

    const exec: DshToolExec = {
      callId,
      rootCallId: callId,
      name: params.toolName,
      arguments: deepFreeze(params.input),
      ...(agent === undefined ? {} : { agent }),
      signal: params.signal,
      token: Symbol(`dsh-tool-exec:${callId}`),
      get deferredContexts(): readonly unknown[] {
        return deferredContexts;
      },
      get concludedTurn(): boolean {
        return concludedTurn;
      },
      deferContext(context: unknown): void {
        deferredContexts.push(context);
        options.onDeferredContext?.(context, exec);
      },
      concludeTurn(): void {
        concludedTurn = true;
        options.onConcludeTurn?.(exec);
      },
    };
    return exec;
  };
}

/** dsh agent 的最小读取面（`ctx.agents` / `ctx.sessions`） */
interface AgentLookupLike {
  get?(id: string): unknown;
}

/**
 * 从已装配的服务面解析 `exec.agent`（`dsh-services` 提供 `agents` / `sessions`）。
 *
 * 顺序与 dsh 一致：先查 live registry，未命中再回落到会话的只读投影
 * （dsh 里 agent 与 session 一一对应，id 即会话 id）。两者都没有 → undefined，
 * 让插件自己判断「没有 agent」而不是拿到一个假 agent。
 *
 * @param serviceOf - 读服务：通常传 `(name) => ctx.reflect.get?.(name)`
 */
export function resolveAgentFromServices(
  serviceOf: (name: string) => unknown,
): DshAgentResolver {
  return ({ context }) => {
    const agents = serviceOf("agents") as AgentLookupLike | undefined;
    const live = agents?.get?.(context.sessionId);
    if (live !== undefined) return live;

    const sessions = serviceOf("sessions") as AgentLookupLike | undefined;
    const session = sessions?.get?.(context.sessionId);
    if (session === undefined) return undefined;
    // 只读投影：不注册进 registry（注册是 agents.register 的职责）
    return { id: context.sessionId, session };
  };
}
