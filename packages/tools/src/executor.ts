/**
 * @fengagent/tools — 工具执行器
 *
 * 并行/串行调度、权限检查、Hook 触发、超时控制、输出截断。
 *
 * 执行流程（单个工具）：
 * 1. 校验输入 schema（失败且可交互时 → 请求用户改参后放行，human-in-the-loop）
 * 2. 触发 pre-tool-use hooks（可阻止执行）
 * 3. 检查权限（自动批准 / 允许列表 / 禁止列表 / 配置规则 / 工具级检查）
 * 4. 如需询问用户，调用 requestPermission 回调（allow 可携带修改后的入参）
 * 5. 执行工具（带超时，以用户修改后的参数执行）
 * 6. 截断输出
 * 7. 触发 post-tool-use hooks（可修改结果）
 */
import type { ToolDefinition, ToolResult, ToolContext } from "@fengagent/core/tool";
import { BASH_TIMEOUT, MAX_TOOL_CONCURRENCY } from "@fengagent/shared/constants";
import { getEnvNumber } from "@fengagent/shared/utils";
import type { PermissionChecker } from "./permission.ts";
import { createPermissionChecker } from "./permission.ts";
import { truncateOutput } from "./truncate.ts";
import type { HookRegistry, HookContext } from "./hooks.ts";
import { createHookRegistry } from "./hooks.ts";
import { createLogger } from "@fengagent/shared";

const log = createLogger("tool-executor");

export interface ExecutionContext {
  workdir: string;
  sessionId: string;
  messageId: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutedToolResult {
  toolName: string;
  input: unknown;
  result: ToolResult;
  error?: Error;
}

export interface ToolExecutor {
  execute(
    tool: ToolDefinition,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolResult>;

  executeMany(
    calls: Array<{ tool: ToolDefinition; input: unknown }>,
    context: ToolContext,
  ): Promise<ExecutedToolResult[]>;

  /** 获取关联的 Hook 注册器（用于注册/注销 hook） */
  getHookRegistry(): HookRegistry;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  name: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function errorResult(error: Error): ToolResult {
  return {
    content: `Error: ${error.message}`,
    isError: true,
  };
}

/** 解析 Zod 校验错误为可读信息（含 JSON 序列化兜底） */
function validationErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * 尝试校验工具入参。
 *
 * @returns 校验通过时返回 { ok: true, value }；失败时返回 { ok: false, message }
 */
function tryValidate(
  tool: ToolDefinition,
  input: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: tool.inputSchema.parse(input) };
  } catch (err) {
    return { ok: false, message: validationErrorText(err) };
  }
}

/** 从 ToolContext 构建 HookContext */
function toHookContext(context: ToolContext): HookContext {
  return {
    workdir: context.workdir,
    sessionId: context.sessionId,
    messageId: context.messageId,
    metadata: context.metadata,
  };
}

export function createToolExecutor(
  permissionChecker?: PermissionChecker,
  hookRegistry?: HookRegistry,
): ToolExecutor {
  const permChecker = permissionChecker ?? createPermissionChecker();
  const hooks = hookRegistry ?? createHookRegistry();

  /**
   * 执行单个工具，返回「实际执行的入参」+ 结果。
   *
   * Human-in-the-loop：以下两种情况会给用户在界面上「改参重试」的机会
   * （仅当 context.requestPermission 存在，即 server/WebUI 交互式会话）：
   * 1. 权限审批 ask：用户可携带修改后的入参放行（{ decision: "allow", input }）；
   * 2. 入参校验失败：把校验错误作为审批原因推给用户，用户可修正参数后放行，
   *    或 Deny 拒绝（无交互回调时保持原行为：直接返回校验错误）。
   */
  async function executeOne(
    tool: ToolDefinition,
    input: unknown,
    context: ToolContext,
  ): Promise<{ input: unknown; result: ToolResult }> {
    const originalInput = input;
    // 用户是否在审批环节修改了入参（用于上层把「实际执行入参」同步进历史/卡片）
    let correctedByUser = false;
    // 0. 入参校验 — 失败且工具本就需要人工审批（ask）时，先给用户改参机会；
    //    自动放行场景（autoApprove / 只读工具）保持原行为：直接把校验错误回给模型自行修正
    let validated = tryValidate(tool, input);
    if (!validated.ok) {
      if (!context.requestPermission) {
        return {
          input,
          result: {
            content: `Error: ${validated.message}`,
            isError: true,
            metadata: { inputValidationFailed: true },
          },
        };
      }
      // 权限策略是否会对该工具 ask（决定「是否打扰用户」）：
      // autoApprove / 只读自动放行 → 不打扰；destructive / 配置 ask 规则 → 交给用户改参
      const wouldAsk = permChecker.checkPermissions(tool, input, context);
      if (wouldAsk.decision !== "ask") {
        return {
          input,
          result: {
            content: `Error: ${validated.message}`,
            isError: true,
            metadata: { inputValidationFailed: true },
          },
        };
      }
      const userDecision = await context.requestPermission({
        toolName: tool.name,
        input,
        reason: `工具入参校验失败：${validated.message}。可直接 Allow 让模型自行修正，或修改参数后以新参数执行（Deny 则拒绝本次调用）。`,
      });
      if (userDecision.decision === "deny") {
        return {
          input,
          result: {
            content: `Permission denied by user: ${userDecision.reason ?? ""}`,
            isError: true,
            metadata: { permissionDecision: "deny" },
          },
        };
      }
      // requestPermission 的结果理论上只有 allow/deny；出现 ask 视为拒绝
      if (userDecision.decision !== "allow") {
        return {
          input,
          result: {
            content: "Permission request unresolved (ask), treated as denied.",
            isError: true,
            metadata: { permissionDecision: "deny" },
          },
        };
      }
      // allow — 以用户提供的入参（有修改用修改，无修改用原入参）重新校验
      const candidate =
        userDecision.input !== undefined ? userDecision.input : input;
      const recheck = tryValidate(tool, candidate);
      if (!recheck.ok) {
        return {
          input: candidate,
          result: {
            content: `Error: 用户确认/修改后的入参仍校验失败：${recheck.message}`,
            isError: true,
            metadata: { inputValidationFailed: true },
          },
        };
      }
      // 校验能通过即说明用户修正了入参（原入参校验失败、相同入参不可能通过）
      correctedByUser = true;
      input = candidate;
      validated = recheck;
    }

    log.info("executeOne", `tool=${tool.name}, input=${JSON.stringify(validated.value).slice(0, 50)}`);
    const hookCtx = toHookContext(context);

    // 1. 触发 pre-tool-use hooks（可阻止执行）
    const preResult = await hooks.triggerPreToolUse(tool.name, validated.value, hookCtx);
    if (!preResult.allowed) {
      return {
        input,
        result: {
          content: `Blocked by pre-tool-use hook: ${preResult.reason ?? "no reason given"}`,
          isError: true,
          metadata: { blockedByHook: true },
        },
      };
    }

    // 2. 权限检查
    const perm = permChecker.checkPermissions(tool, validated.value, context);

    log.info("executeOne", `permission decision=${perm.decision}, tool=${tool.name}`);

    if (perm.decision === "deny") {
      return {
        input,
        result: {
          content: `Permission denied: ${perm.reason ?? "not allowed"}`,
          isError: true,
          metadata: { permissionDecision: "deny" },
        },
      };
    }

    if (perm.decision === "ask") {
      if (context.requestPermission) {
        const userDecision = await context.requestPermission({
          toolName: tool.name,
          input: validated.value,
          reason: perm.message,
        });

        if (userDecision.decision === "deny") {
          return {
            input,
            result: {
              content: `Permission denied by user: ${userDecision.reason ?? ""}`,
              isError: true,
              metadata: { permissionDecision: "deny" },
            },
          };
        }

        // requestPermission 的结果理论上只有 allow/deny；出现 ask 视为拒绝
        if (userDecision.decision !== "allow") {
          return {
            input,
            result: {
              content: "Permission request unresolved (ask), treated as denied.",
              isError: true,
              metadata: { permissionDecision: "deny" },
            },
          };
        }

        // allow 携带修改后的入参 → 重新校验并以新参数执行（human-in-the-loop 改参）
        if (userDecision.input !== undefined) {
          const corrected = tryValidate(tool, userDecision.input);
          if (!corrected.ok) {
            return {
              input: userDecision.input,
              result: {
                content: `Error: 用户修改后的入参校验失败：${corrected.message}`,
                isError: true,
                metadata: { inputValidationFailed: true },
              },
            };
          }
          // 入参与原校验值不同才算用户改参（相同则等价于普通 allow）
          if (JSON.stringify(userDecision.input) !== JSON.stringify(originalInput)) {
            correctedByUser = true;
          }
          input = userDecision.input;
          validated = corrected;
        }
      } else {
        return {
          input,
          result: {
            content: `Tool "${tool.name}" requires user approval but no permission callback is available.`,
            isError: true,
            metadata: { permissionDecision: "deny" },
          },
        };
      }
    }

    const startTime = Date.now();

    // 3. 执行工具（带超时）
    const timeoutMs =
      tool.name === "bash"
        ? getEnvNumber("FENG_BASH_TIMEOUT", BASH_TIMEOUT)
        : 0;

    let result: ToolResult;
    try {
      const execPromise = tool.execute(validated.value, context);
      if (timeoutMs > 0) {
        result = await withTimeout(execPromise, timeoutMs, tool.name);
      } else {
        result = await execPromise;
      }
    } catch (err) {
      // 工具执行抛出异常 — 转为 errorResult，仍触发 post-tool-use hooks
      const errorRes = errorResult(
        err instanceof Error ? err : new Error(String(err)),
      );
      if (correctedByUser) {
        errorRes.metadata = {
          ...(errorRes.metadata as Record<string, unknown>),
          userCorrectedInput: true,
        };
      }
      result = await hooks.triggerPostToolUse(tool.name, validated.value, errorRes, hookCtx);
      log.error("executeOne", `execution error tool=${tool.name}, error=${err instanceof Error ? err.message : String(err)}`);
      return { input, result };
    }

    if (result.isError) {
      // 仍然触发 post-tool-use hooks（即使出错）
      if (correctedByUser) {
        result.metadata = {
          ...(result.metadata as Record<string, unknown>),
          userCorrectedInput: true,
        };
      }
      result = await hooks.triggerPostToolUse(tool.name, validated.value, result, hookCtx);
      return { input, result };
    }

    // 4. 截断输出
    const truncated = truncateOutput(result.content);

    log.debug("executeOne", `result success, tool=${tool.name}, duration=${Date.now() - startTime}ms, isError=${result.isError}`);

    let finalResult: ToolResult = {
      ...result,
      content: truncated.content,
      metadata: {
        ...(result.metadata as Record<string, unknown>),
        ...(correctedByUser ? { userCorrectedInput: true } : {}),
        ...(truncated.overflowFile
          ? { overflowFile: truncated.overflowFile }
          : {}),
      },
    };

    // 5. 触发 post-tool-use hooks（可修改结果）
    finalResult = await hooks.triggerPostToolUse(tool.name, validated.value, finalResult, hookCtx);

    return { input, result: finalResult };
  }

  return {
    async execute(
      tool: ToolDefinition,
      input: unknown,
      context: ToolContext,
    ): Promise<ToolResult> {
      try {
        const { result } = await executeOne(tool, input, context);
        return result;
      } catch (err) {
        return errorResult(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    },

    async executeMany(
      calls: Array<{ tool: ToolDefinition; input: unknown }>,
      context: ToolContext,
    ): Promise<ExecutedToolResult[]> {
      const maxConcurrency = getEnvNumber(
        "FENG_MAX_TOOL_CONCURRENCY",
        MAX_TOOL_CONCURRENCY,
      );

      const serial: Array<{ tool: ToolDefinition; input: unknown }> = [];
      const parallel: Array<{ tool: ToolDefinition; input: unknown }> = [];

      for (const call of calls) {
        const safe = call.tool.isConcurrencySafe
          ? call.tool.isConcurrencySafe(call.input)
          : false;
        if (safe) {
          parallel.push(call);
        } else {
          serial.push(call);
        }
      }

      log.info("executeMany", `batch start total=${calls.length}, parallel=${parallel.length}, serial=${serial.length}`);

      const results: ExecutedToolResult[] = [];

      const parallelBatches: Array<
        Array<{ tool: ToolDefinition; input: unknown }>
      > = [];
      for (let i = 0; i < parallel.length; i += maxConcurrency) {
        parallelBatches.push(parallel.slice(i, i + maxConcurrency));
      }

      for (const batch of parallelBatches) {
        const batchResults = await Promise.allSettled(
          batch.map((call) =>
            executeOne(call.tool, call.input, context),
          ),
        );
        for (let i = 0; i < batchResults.length; i++) {
          const r = batchResults[i]!;
          const call = batch[i]!;
          if (r.status === "fulfilled") {
            results.push({
              toolName: call.tool.name,
              input: r.value.input,
              result: r.value.result,
            });
          } else {
            results.push({
              toolName: call.tool.name,
              input: call.input,
              result: errorResult(r.reason),
              error: r.reason,
            });
          }
        }
      }

      for (const call of serial) {
        try {
          const { input: execInput, result } = await executeOne(
            call.tool,
            call.input,
            context,
          );
          results.push({
            toolName: call.tool.name,
            input: execInput,
            result,
          });
        } catch (err) {
          results.push({
            toolName: call.tool.name,
            input: call.input,
            result: errorResult(
              err instanceof Error ? err : new Error(String(err)),
            ),
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }

      log.info("executeMany", `batch end total=${results.length}`);

      return results;
    },

    getHookRegistry(): HookRegistry {
      return hooks;
    },
  };
}
