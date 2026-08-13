/**
 * @fengagent/tools — 工具执行器
 *
 * 并行/串行调度、权限检查、Hook 触发、超时控制、输出截断。
 *
 * 执行流程（单个工具）：
 * 1. 校验输入 schema
 * 2. 触发 pre-tool-use hooks（可阻止执行）
 * 3. 检查权限（自动批准 / 允许列表 / 禁止列表 / 配置规则 / 工具级检查）
 * 4. 如需询问用户，调用 requestPermission 回调
 * 5. 执行工具（带超时）
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

  async function executeOne(
    tool: ToolDefinition,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const validated = tool.inputSchema.parse(input);

    log.info("executeOne", `tool=${tool.name}, input=${JSON.stringify(validated).slice(0, 50)}`);
    const hookCtx = toHookContext(context);

    // 1. 触发 pre-tool-use hooks（可阻止执行）
    const preResult = await hooks.triggerPreToolUse(tool.name, validated, hookCtx);
    if (!preResult.allowed) {
      return {
        content: `Blocked by pre-tool-use hook: ${preResult.reason ?? "no reason given"}`,
        isError: true,
        metadata: { blockedByHook: true },
      };
    }

    // 2. 权限检查
    const perm = permChecker.checkPermissions(tool, validated, context);

    log.info("executeOne", `permission decision=${perm.decision}, tool=${tool.name}`);

    if (perm.decision === "deny") {
      return {
        content: `Permission denied: ${perm.reason ?? "not allowed"}`,
        isError: true,
        metadata: { permissionDecision: "deny" },
      };
    }

    if (perm.decision === "ask") {
      if (context.requestPermission) {
        const userDecision = await context.requestPermission({
          toolName: tool.name,
          input: validated,
          reason: perm.message,
        });

        if (userDecision.decision === "deny") {
          return {
            content: `Permission denied by user: ${userDecision.reason ?? ""}`,
            isError: true,
            metadata: { permissionDecision: "deny" },
          };
        }
      } else {
        return {
          content: `Tool "${tool.name}" requires user approval but no permission callback is available.`,
          isError: true,
          metadata: { permissionDecision: "deny" },
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
      const execPromise = tool.execute(validated, context);
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
      result = await hooks.triggerPostToolUse(tool.name, validated, errorRes, hookCtx);
      log.error("executeOne", `execution error tool=${tool.name}, error=${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    if (result.isError) {
      // 仍然触发 post-tool-use hooks（即使出错）
      result = await hooks.triggerPostToolUse(tool.name, validated, result, hookCtx);
      return result;
    }

    // 4. 截断输出
    const truncated = truncateOutput(result.content);

    log.debug("executeOne", `result success, tool=${tool.name}, duration=${Date.now() - startTime}ms, isError=${result.isError}`);

    let finalResult: ToolResult = {
      ...result,
      content: truncated.content,
      metadata: {
        ...(result.metadata as Record<string, unknown>),
        ...(truncated.overflowFile
          ? { overflowFile: truncated.overflowFile }
          : {}),
      },
    };

    // 5. 触发 post-tool-use hooks（可修改结果）
    finalResult = await hooks.triggerPostToolUse(tool.name, validated, finalResult, hookCtx);

    return finalResult;
  }

  return {
    async execute(
      tool: ToolDefinition,
      input: unknown,
      context: ToolContext,
    ): Promise<ToolResult> {
      try {
        return await executeOne(tool, input, context);
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
              input: call.input,
              result: r.value,
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
          const result = await executeOne(
            call.tool,
            call.input,
            context,
          );
          results.push({
            toolName: call.tool.name,
            input: call.input,
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
