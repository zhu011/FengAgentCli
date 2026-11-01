/**
 * @fengagent/dsh-compat — dsh 工具定义 → FengAgentCli 工具定义 适配器
 *
 * dsh 侧契约（`defineTool` 产物，见 `@deepseek-ai/dsh-tools`）：
 * - `parameters`：**编译后**的 JSON Schema（`type:"object"` + `properties`）；
 * - `output`：`{ schema, render(args, value) }`，render 产出展示文本块；
 * - `execute(args, exec)`：exec 携带 `signal`（取消），参数校验由 defineTool 包裹。
 *
 * FengAgentCli 侧契约（`@fengagent/core` 的 `ToolDefinition`）：
 * - `inputSchema`：Zod schema —— 但 LLM providers 的转换层是鸭子类型的：
 *   `zodToJsonSchemaCompat` 以 `_def` 判 Zod、再调 `toJSONSchema()`（见
 *   `packages/llm/src/providers/openai-compatible.ts` / `anthropic.ts`）；
 *   执行侧仅调 `inputSchema.parse(input)`（`packages/tools/src/executor.ts`）。
 *   因此这里用一个**直通 schema 对象**同时满足三点：带 `_def` 标记、
 *   `toJSONSchema()` 返回 dsh 编译参数、`parse` 直通（dsh 工具自校验）。
 * - `execute(input, context)` + `ToolResult { content, isError, metadata }`。
 */

import type { ToolContext, ToolDefinition, ToolResult } from "@fengagent/core";
import type { ToolDefinition as DshToolDefinition } from "@deepseek-ai/dsh-tools";
import { createDshExecContext, type DshExecContextParams, type DshToolExec } from "./exec-context.ts";
import type { DshToolEventSink } from "./events.ts";

export type { ToolDefinition as DshToolDefinition } from "@deepseek-ai/dsh-tools";

/** 松散签名（dsh 的 render/execute 带具体泛型参数，这里按结构调用） */
type LooseRender = (args: unknown, value: unknown) => Array<{ type: string; text?: string }>;
type LooseExecute = (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>;

/** 永不触发的取消信号（dsh 工具未声明 timeoutMs 时使用） */
const NEVER_ABORT = new AbortController();

/** 缺省 `exec` 构造器：无 agent 解析（宿主未装配 `dsh-services` 时） */
const defaultExecContext = createDshExecContext();

/** 适配选项 */
export interface AdaptDshToolOptions {
  /**
   * `exec` 构造器（`createDshExecContext(...)` 的产物）。
   *
   * 注入后，dsh 工具体能拿到 `exec.agent` / `exec.token` / `exec.arguments` /
   * `exec.deferContext()` / `exec.concludeTurn()`——P1 只给过 `{ signal }`，
   * 依赖会话上下文的工具（如 todo-plus）会在 execute 阶段 TypeError。
   */
  execContext?: (params: DshExecContextParams) => DshToolExec;
  /**
   * dsh 工具事件桥（`DshToolEventBridge`）。
   *
   * 提供后，本工具的一次调用会依次产生 `tools/pre-execute` → 工具执行 →
   * `tools/post-execute`，且三段共享**同一个** `exec`（身份/agent/token 一致）。
   */
  events?: DshToolEventSink;
}

/**
 * 构造带超时的取消信号。
 *
 * 注意不能用 `AbortSignal.timeout`：其内部定时器是 unref 的，在安静进程
 * （事件循环无其他活动，如测试）里永不触发（Bun 挂起 / Node 直接退出）。
 * 这里用 ref 的 `setTimeout` 保证定时器一定会跑，finally 里清理。
 */
function createTimeoutSignal(toolName: string, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`tool "${toolName}" timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/** 判断是否为 defineTool 编译后的 dsh 工具定义 */
export function isDshToolDefinition(value: unknown): value is DshToolDefinition {
  if (value === null || typeof value !== "object") return false;
  const def = value as Partial<DshToolDefinition> & { parameters?: unknown; output?: unknown };
  if (typeof def.name !== "string" || typeof def.description !== "string") return false;
  if (typeof def.execute !== "function") return false;
  const parameters = def.parameters;
  if (parameters === null || typeof parameters !== "object") return false;
  const record = parameters as Record<string, unknown>;
  if (record["type"] !== "object" || !("properties" in record)) {
    // 未编译的 author-form（裸 property map）——dsh 侧 register 同样不接受，引导用 defineTool
    return false;
  }
  const output = def.output;
  if (output === null || typeof output !== "object") return false;
  return typeof (output as { render?: unknown }).render === "function";
}

/** JSON 摘要（render 不可用时的回退） */
function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 用 dsh 的 render 产出展示文本；失败回退 JSON 摘要 */
function renderDshText(render: LooseRender, args: unknown, value: unknown): string {
  if (value === undefined || value === null) return "(no output)";
  try {
    const blocks = render(args, value) ?? [];
    const text = blocks
      .filter((b) => b !== null && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text !== "") return text;
  } catch {
    // render 抛错不影响执行结果，回退到 JSON 摘要
  }
  return safeJson(value);
}

/**
 * 把 dsh 工具定义适配成 FengAgentCli 工具定义。
 *
 * - LLM 可见参数 = dsh 编译后的 JSON Schema（直通，零转换损耗）；
 * - 参数校验 = dsh 工具自带（defineTool 包裹），feng 侧 `parse` 直通；
 * - 执行结果：`content` = dsh render 文本，`metadata` = dsh 返回原值；
 * - 取消语义：dsh `timeoutMs` → ref 定时器驱动的 AbortController（见
 *   `createTimeoutSignal`；不用 `AbortSignal.timeout`，其 unref 定时器在安静
 *   进程里永不触发）；
 * - 执行上下文（P2）：`options.execContext` 注入 `exec.agent` / `exec.token` /
 *   `deferContext` / `concludeTurn`（缺省只带身份与 signal）；
 * - 事件（P2）：`options.events` 注入后，一次调用 = `tools/pre-execute` →
 *   工具体 → `tools/post-execute`，三段共享同一个 `exec`。
 */
export function adaptDshTool(
  dsh: DshToolDefinition,
  options: AdaptDshToolOptions = {},
): ToolDefinition {
  const render = dsh.output.render as unknown as LooseRender;
  const execute = dsh.execute as unknown as LooseExecute;
  const parameters = dsh.parameters as Record<string, unknown>;
  const isConcurrencySafe = dsh.isConcurrencySafe as
    | ((args: unknown) => boolean)
    | undefined;
  const buildExec = options.execContext ?? defaultExecContext;
  const events = options.events;

  // 鸭子类型直通 schema：同时满足 providers 的 `_def` 门 + `toJSONSchema()`
  // 与 executor 的 `parse()`（dsh 工具的 execute 自带参数校验）
  const duckInputSchema = {
    _def: {},
    toJSONSchema: (): Record<string, unknown> => parameters,
    parse: (input: unknown): unknown => input,
    safeParse: (input: unknown): { success: true; data: unknown } => ({
      success: true,
      data: input,
    }),
  };

  const tool: ToolDefinition = {
    name: dsh.name,
    description: dsh.description,
    inputSchema: duckInputSchema as unknown as ToolDefinition["inputSchema"],

    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const timeout =
        typeof dsh.timeoutMs === "number" && dsh.timeoutMs > 0
          ? createTimeoutSignal(dsh.name, dsh.timeoutMs)
          : { signal: NEVER_ABORT.signal, dispose: () => {} };
      const exec = buildExec({
        toolName: dsh.name,
        input,
        context,
        signal: timeout.signal,
      });
      try {
        // 1. tools/pre-execute：dsh 侧的 deny/ask 在这里真的要拦下调用
        const pre = (await events?.preExecute(exec)) ?? { kind: "allow" as const };
        if (pre.kind !== "allow") {
          const reason =
            pre.kind === "deny"
              ? pre.reason
              : `asked for approval${pre.reason ? ` (${pre.reason})` : ""}; no approval service at the tool stage`;
          return {
            content: `Blocked by tools/pre-execute: ${reason}`,
            isError: true,
            metadata: { blockedByDshPreExecute: true },
          };
        }

        // 2. 工具执行（dsh 工具体拿到完整 exec）
        let value: unknown;
        try {
          value = await execute(input, exec as unknown as { signal: AbortSignal });
        } catch (err) {
          // dsh 的抛错结果同样会经过 post-execute；这里只做观察，不采纳替换
          await events
            ?.postExecute(exec, {
              isError: true,
              content: err instanceof Error ? err.message : String(err),
              error: { message: err instanceof Error ? err.message : String(err) },
            })
            .catch(() => undefined);
          throw err;
        }

        // 3. tools/post-execute：accept（可换展示文本）/ block（转错误结果）
        let result: ToolResult = { content: renderDshText(render, input, value), metadata: value };
        const post = await events?.postExecute(exec, {
          isError: false,
          content: result.content,
          value,
        });
        if (post?.kind === "block") {
          return {
            content: post.feedback,
            isError: true,
            metadata: { dshValue: result.metadata, blockedByDshPostExecute: true },
          };
        }
        if (post?.kind === "accept" && post.content !== undefined) {
          result = { ...result, content: post.content };
        }
        return result;
      } finally {
        timeout.dispose();
      }
    },

    ...(isConcurrencySafe === undefined
      ? {}
      : {
          isConcurrencySafe: (input: unknown): boolean => isConcurrencySafe(input) === true,
        }),

    renderUse: (input: unknown): string => `${dsh.name}(${clip(safeJson(input), 80)})`,
    renderResult: (result: ToolResult): string => {
      if (result.metadata !== undefined) {
        try {
          const text = renderDshText(render, undefined, result.metadata);
          if (text !== "" && text !== "(no output)") return text;
        } catch {
          // 回退 content
        }
      }
      return result.content;
    },
  };
  return tool;
}
