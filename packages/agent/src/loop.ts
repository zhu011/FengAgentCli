/**
 * @fengagent/agent — Agent Loop 主循环
 *
 * 核心循环：组装上下文 → 压缩检查 → 调用 LLM → 解析工具调用 → 执行工具 → 循环。
 * 参考 ARCHITECTURE.md 第 6.1 节和 PRD 第 4.2.2 节。
 */

import type { LLMClient } from "@fengagent/llm";
import { createLlmTracer } from "@fengagent/llm";
import type { LLMEvent } from "@fengagent/llm";
import type {
  Config,
  Session,
  Message,
  ContentBlock,
  ToolCall,
  ToolResult,
  AgentEvent,
  ToolDefinition,
  ToolContext,
  FinishReason,
  SubagentRunner,
} from "@fengagent/core";
import { createSystemMessage } from "@fengagent/core";
import type { ToolRegistry, ToolExecutor } from "@fengagent/tools";
import type { ContextManager } from "@fengagent/context";
import { generateId, getEnvNumber } from "@fengagent/shared/utils";
import { createLogger } from "@fengagent/shared";
import { llmEventToAgentEvents } from "./streaming.ts";

const log = createLogger("agent-loop");

/**
 * 连续「全工具失败」轮次上限 — 死循环防护。
 *
 * 当模型反复调用同一批工具且每次都全部失败（如 task 工具参数名错误导致
 * 「Unknown agent type」反复重试，AGE-29 现场连续 25 轮），继续循环只会
 * 空耗 token 与时间。连续 N 轮工具调用全部失败即判定模型陷入失败重试循环，
 * 抛出明确错误并终止（而不是等到 maxTurns=50 才停）。
 */
const MAX_CONSECUTIVE_TOOL_ERROR_STEPS = 3;

/**
 * 同一「工具 + 入参 + 结果」三元组重复出现的次数上限 — 纯空转检测。
 *
 * 与 `MAX_CONSECUTIVE_TOOL_ERROR_STEPS` 互补：后者只看「连续全失败」，本例
 * （AGE-29）的失败是**分散**的，中间夹着大量「成功但零进展」的调用 —— 反复
 * `read_file` 同一个被截断的文件、反复 glob `**\/*` 只回同一个文件。参数与结果
 * 逐字节相同的重复调用，无论成败都不携带任何新信息，达到上限即判定空转。
 */
const MAX_IDENTICAL_TOOL_RESULTS = 3;

/**
 * 连续「无进展」步数上限。
 *
 * 一步「有进展」的定义：该步至少产生一个**首次出现且非错误**的工具结果。
 * 连续 N 步都没有新信息（全部是错误结果或历史重复结果）即判定模型陷入空转。
 */
const MAX_NO_PROGRESS_STEPS = 5;

/**
 * 同一目标路径被「只读工具」重复读取的次数上限（期间没有成功的变更类调用）。
 *
 * 覆盖「反复读同一文件的不同片段」：每次 offset 不同 → 结果不同，躲得过上面的
 * 重复结果检测，但读 N 次同一路径仍无外部变化时属于典型空转。
 */
const MAX_SAME_TARGET_READS = 6;

/**
 * 整体 wall-clock 上限（毫秒），`<= 0` 关闭。
 *
 * 兜底防护：单轮对话跑到这个时长仍未结束，无论步数/工具调用是否「看起来正常」
 * 都强制结算，避免对话无限期挂起（用户侧表现为「一直转圈」）。
 */
const MAX_WALL_CLOCK_MS = 10 * 60_000;

/** 死循环防护阈值（可注入覆盖，便于测试与调用方按场景收紧） */
export interface LoopGuardOptions {
  /** 同一「工具+入参+结果」重复次数上限 */
  maxIdenticalToolResults: number;
  /** 连续无进展步数上限 */
  maxNoProgressSteps: number;
  /** 同一路径重复读取次数上限 */
  maxSameTargetReads: number;
  /** 整体 wall-clock 上限（毫秒），<=0 关闭 */
  maxWallClockMs: number;
}

/**
 * 解析死循环防护阈值：显式覆盖 > 环境变量 > 内置默认。
 *
 * 环境变量：`FENG_MAX_IDENTICAL_TOOL_RESULTS`、`FENG_MAX_NO_PROGRESS_STEPS`、
 * `FENG_MAX_SAME_TARGET_READS`、`FENG_MAX_WALL_CLOCK_MS`。
 *
 * @param overrides - 调用方显式指定的阈值（优先级最高）
 * @returns 生效的阈值
 */
export function resolveLoopGuards(
  overrides?: Partial<LoopGuardOptions>,
): LoopGuardOptions {
  return {
    maxIdenticalToolResults:
      overrides?.maxIdenticalToolResults ??
      getEnvNumber("FENG_MAX_IDENTICAL_TOOL_RESULTS", MAX_IDENTICAL_TOOL_RESULTS),
    maxNoProgressSteps:
      overrides?.maxNoProgressSteps ??
      getEnvNumber("FENG_MAX_NO_PROGRESS_STEPS", MAX_NO_PROGRESS_STEPS),
    maxSameTargetReads:
      overrides?.maxSameTargetReads ??
      getEnvNumber("FENG_MAX_SAME_TARGET_READS", MAX_SAME_TARGET_READS),
    maxWallClockMs:
      overrides?.maxWallClockMs ??
      getEnvNumber("FENG_MAX_WALL_CLOCK_MS", MAX_WALL_CLOCK_MS),
  };
}

/** 可能是「文件路径」的入参键名（只读工具的重复读取检测用） */
const PATH_ARG_KEYS = [
  "filePath",
  "file_path",
  "filepath",
  "path",
  "file",
  "target_file",
  "notebook_path",
];

/** 从工具入参里提取目标路径（提取不到返回 undefined） */
function targetPathOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of PATH_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** 稳定序列化：对象键排序，保证「同参数」判定不受键顺序影响 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
    .join(",")}}`;
}

/** 调用签名：工具名 + 稳定序列化后的入参 */
function callSignature(name: string, input: unknown): string {
  let args: string;
  try {
    args = stableStringify(input);
  } catch {
    args = String(input);
  }
  return `${name}::${args.slice(0, 512)}`;
}

/** 工具结果的稳定摘要（用于「同结果」判定；截断以免长输出撑爆内存） */
function resultDigest(result: ToolResult): string {
  const body =
    typeof result.content === "string"
      ? result.content
      : (() => {
          try {
            return JSON.stringify(result.content);
          } catch {
            return String(result.content);
          }
        })();
  return `${result.isError ? "ERR" : "OK"}:${body.slice(0, 2000)}`;
}

/** AgentLoop 构造选项 */
export interface AgentLoopOptions {
  llmClient: LLMClient;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  contextManager: ContextManager;
  config: Config;
  workdir: string;
  /** 子 Agent 派遣函数（由 agent 层注入，task 工具使用） */
  spawnSubagent?: SubagentRunner;
  /** 当前 Agent 深度（0 = 顶层 Agent） */
  agentDepth?: number;
  /** 死循环防护阈值覆盖（缺省走 resolveLoopGuards） */
  guards?: Partial<LoopGuardOptions>;
}

/**
 * Agent Loop — Agent 核心循环。
 *
 * 每次循环：
 * 1. 组装上下文（系统提示 + 历史）
 * 2. 检查并执行压缩
 * 3. 准备工具
 * 4. 调用 LLM（流式）
 * 5. 收集 text-delta 和 tool-call
 * 6. 执行工具（如有）
 * 7. 将结果加入历史
 * 8. 判断是否继续
 *
 * 循环退出条件：
 * - LLM 无工具调用（正常结束）
 * - 达到 maxTurns
 * - LLM 返回 error
 */
export class AgentLoop {
  constructor(private options: AgentLoopOptions) {}

  /**
   * 运行 Agent Loop。
   *
   * @param session - 当前会话（消息历史会被修改）
   * @param options - 可选运行参数（如权限回调）
   * @returns AgentEvent 异步生成器
   */
  async *run(
    session: Session,
    options?: {
      requestPermission?: ToolContext["requestPermission"];
    },
  ): AsyncGenerator<AgentEvent> {
    let needsContinuation = true;
    let step = 0;
    let consecutiveToolErrorSteps = 0;
    const { maxTurns } = this.options.config;

    // ── 死循环防护状态（本轮 run 内累积）──────────────────────────────
    const guards = resolveLoopGuards(this.options.guards);
    const runStartedAt = Date.now();
    /** 「工具+入参+结果」三元组 → 出现次数 */
    const identicalResults = new Map<string, number>();
    /** 目标路径 → 连续被只读工具读取的次数（成功的变更类调用会清空） */
    const targetReads = new Map<string, number>();
    /** 连续无进展步数 */
    let noProgressSteps = 0;

    while (needsContinuation && step < maxTurns) {
      step++;

      // 兜底：整体 wall-clock 超时（步数/工具层面看起来正常也要结算）
      if (guards.maxWallClockMs > 0 && Date.now() - runStartedAt > guards.maxWallClockMs) {
        const message =
          `本轮对话已运行 ${Math.round((Date.now() - runStartedAt) / 1000)}s，` +
          `超过 wall-clock 上限 ${Math.round(guards.maxWallClockMs / 1000)}s，` +
          `已终止本轮对话防止无限挂起（可通过 FENG_MAX_WALL_CLOCK_MS 调整）。`;
        log.error("run", `wall-clock guard: ${message}`);
        yield { type: "error", error: { message } };
        yield { type: "turn-end", reason: "error" };
        return;
      }

      log.info("run", `loop start step=${step}, model=${session.model}`);

      // 1. 组装上下文
      const context = await this.options.contextManager.assemble(session);

      // 2. 检查并执行压缩
      if (this.options.contextManager.shouldCompact(context)) {
        yield { type: "compaction-start" };
        const compacted = await this.options.contextManager.compact(
          session.messages,
        );
        // 用摘要替换 head 段，保留 recent 段
        session.messages = compacted.summary
          ? [createSystemMessage(compacted.summary), ...compacted.recent]
          : compacted.recent;
        session.tokenCount =
          this.options.contextManager.estimateTokens(session.messages);
        yield { type: "compaction-end", summary: compacted.summary };
      }

      // 3. 准备工具（最后一轮禁用工具）
      const tools = this.options.toolRegistry.materialize();
      const disableTools = step >= maxTurns;

      // 4. 调用 LLM
      const messageId = generateId();
      const assistantContent: ContentBlock[] = [];
      const toolCalls: ToolCall[] = [];

      // 累积器：text-delta / thinking-delta 合并为单个块
      let textAccumulator = "";
      let thinkingAccumulator = "";

      yield { type: "message-start", messageId, role: "assistant" };

      let llmError: { message: string; code?: string } | null = null;
      let finishReason: FinishReason = "end_turn";

      log.info("run", `LLM call start model=${session.model}, messageCount=${context.messages.length}`);

      // LLM trace：记录请求
      const llmTracer = createLlmTracer();
      const llmRequest = {
        model: session.model,
        system: context.system,
        messages: context.messages,
        tools: disableTools ? undefined : tools,
        maxTokens: this.options.config.maxTokens,
        temperature: this.options.config.temperature,
      };
      llmTracer.logRequest(session.id, llmRequest, messageId);
      const llmStartTime = Date.now();
      const llmEvents: LLMEvent[] = [];

      for await (const event of this.options.llmClient.stream(llmRequest)) {
        llmEvents.push(event);
        // 收集内容
        switch (event.type) {
          case "text-delta":
            textAccumulator += event.text;
            break;
          case "thinking-delta":
            thinkingAccumulator += event.text;
            break;
          case "tool-call":
            toolCalls.push({
              id: event.id,
              name: event.name,
              input: event.input,
            });
            assistantContent.push({
              type: "tool-use",
              id: event.id,
              name: event.name,
              input: event.input,
            });
            log.debug("run", `tool call name=${event.name}, input=${JSON.stringify(event.input).slice(0, 50)}`);
            break;
          case "finish":
            finishReason = event.reason;
            break;
          case "error":
            llmError = {
              message: event.error.message,
              code: event.error.code,
            };
            break;
        }

        // 转发为 AgentEvent
        for (const agentEvent of llmEventToAgentEvents(event, messageId)) {
          yield agentEvent;
        }

        // LLM 错误 — 终止循环
        if (event.type === "error") {
          break;
        }
      }

      // LLM trace：记录回复
      llmTracer.logResponse(session.id, session.model, llmEvents, Date.now() - llmStartTime, messageId);

      // 将累积的 text / thinking 转为 ContentBlock（顺序：thinking → text → tool-use）
      if (thinkingAccumulator) {
        assistantContent.unshift({ type: "thinking", text: thinkingAccumulator });
      }
      if (textAccumulator) {
        // 插入到 thinking 之后、tool-use 之前
        const insertIdx = thinkingAccumulator ? 1 : 0;
        assistantContent.splice(insertIdx, 0, { type: "text", text: textAccumulator });
      }

      yield { type: "message-end", messageId };

      // LLM 错误处理
      if (llmError) {
        yield {
          type: "error",
          error: { message: llmError.message, code: llmError.code },
        };
        log.error("run", `LLM error: ${llmError.message}`);
        yield { type: "turn-end", reason: "error" };
        return;
      }

      // 5. 执行工具
      if (toolCalls.length > 0) {
        const toolContext: ToolContext = {
          workdir: this.options.workdir,
          sessionId: session.id,
          messageId,
          requestPermission: options?.requestPermission,
          spawnSubagent: this.options.spawnSubagent,
          agentDepth: this.options.agentDepth,
        };

        // 收集所有工具调用的结果
        const toolResults: Array<{
          toolUseId: string;
          result: ToolResult;
        }> = [];

        // 记录「用户改参后执行」的调用（executor 在结果 metadata 打 userCorrectedInput 标记）
        const correctedToolUses = new Map<string, unknown>();

        log.info("run", `executing tools count=${toolCalls.length}`);

        // 准备可执行的工具调用（工具在注册表中存在）
        const calls: Array<{ tool: ToolDefinition; input: unknown }> = [];
        const callToToolCallIndex: number[] = [];

        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i]!;
          const toolDef = this.options.toolRegistry.get(tc.name);
          if (toolDef) {
            calls.push({ tool: toolDef, input: tc.input });
            callToToolCallIndex.push(i);
          }
        }

        // 执行找到的工具
        let execResults: ReturnType<ToolExecutor["executeMany"]> extends Promise<infer R> ? R : never = [];
        if (calls.length > 0) {
          execResults = await this.options.toolExecutor.executeMany(
            calls,
            toolContext,
          );
        }

        // 按原始工具调用顺序映射结果
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i]!;
          const callIdx = callToToolCallIndex.indexOf(i);

          if (callIdx === -1) {
            // 工具未注册
            toolResults.push({
              toolUseId: tc.id,
              result: {
                content: `Error: Tool "${tc.name}" not found`,
                isError: true,
              },
            });
          } else {
            const execResult = execResults[callIdx]!;
            toolResults.push({
              toolUseId: tc.id,
              result: execResult.result,
            });
            const meta = execResult.result.metadata as
              | Record<string, unknown>
              | undefined;
            if (meta?.userCorrectedInput === true) {
              correctedToolUses.set(tc.id, execResult.input);
              // 历史 tool-use 块同步为实际执行入参（用户改参后执行的是新参数）
              const block = assistantContent.find(
                (b) => b.type === "tool-use" && b.id === tc.id,
              );
              if (block && block.type === "tool-use") {
                block.input = execResult.input;
              }
            }
          }
        }

        // 转发工具结果事件
        for (const { toolUseId, result } of toolResults) {
          if (result.isError) {
            log.error("run", `tool result: error, content=${String(result.content).slice(0, 50)}`);
          } else {
            log.debug("run", `tool result: success, content=${String(result.content).slice(0, 50)}`);
          }
          yield {
            type: "tool-call-result",
            toolUseId,
            result,
            ...(correctedToolUses.has(toolUseId)
              ? { input: correctedToolUses.get(toolUseId) }
              : {}),
          };
        }

        // 将助手消息加入历史
        const assistantMessage: Message = {
          id: messageId,
          role: "assistant",
          content: assistantContent,
          createdAt: Date.now(),
        };
        session.messages.push(assistantMessage);

        // 将工具结果作为 user 消息加入历史
        for (const { toolUseId, result } of toolResults) {
          session.messages.push({
            id: generateId(),
            role: "user",
            content: [
              {
                type: "tool-result",
                toolUseId,
                content: result.content,
                isError: result.isError,
              },
            ],
            createdAt: Date.now(),
          });
        }

        session.updatedAt = Date.now();
        session.tokenCount =
          this.options.contextManager.estimateTokens(session.messages);

        // ── 死循环防护 ────────────────────────────────────────────────
        // 0) 不可恢复的错误（如需人工审批但本轮没有权限回调）：重试必然同样失败，
        //    立即结算并给出可操作的说明，不再把这一轮喂回模型空转。
        const unrecoverable = toolResults.find(
          (tr) =>
            (tr.result.metadata as Record<string, unknown> | undefined)
              ?.unrecoverable === true,
        );
        if (unrecoverable) {
          const detail =
            typeof unrecoverable.result.content === "string"
              ? unrecoverable.result.content.slice(0, 200)
              : String(unrecoverable.result.content).slice(0, 200);
          const message =
            `工具调用遇到不可恢复的错误（同一环境下重试必然再次失败），已终止本轮对话。` +
            `原因: ${detail}`;
          log.error("run", `unrecoverable tool result guard: ${message}`);
          yield { type: "error", error: { message } };
          yield { type: "turn-end", reason: "error" };
          return;
        }

        // 1) 连续多轮工具调用全部失败 → 判定模型陷入失败重试循环，
        //    抛出明确错误并终止（而非继续空耗到 maxTurns）。
        const allToolsFailed =
          toolResults.length > 0 && toolResults.every((tr) => tr.result.isError);
        if (allToolsFailed) {
          consecutiveToolErrorSteps++;
        } else {
          consecutiveToolErrorSteps = 0;
        }
        if (consecutiveToolErrorSteps >= MAX_CONSECUTIVE_TOOL_ERROR_STEPS) {
          const failedNames = toolResults
            .map((tr) => tr.result.content)
            .filter((c): c is string => typeof c === "string")
            .map((c) => String(c).slice(0, 80))
            .join(" | ");
          const message =
            `工具调用连续 ${consecutiveToolErrorSteps} 轮全部失败（模型可能陷入重复失败重试循环），` +
            `已终止本轮对话防止死循环。最近错误: ${failedNames || "(无错误内容)"}`;
          log.error("run", `consecutive tool failure guard: ${message}`);
          yield { type: "error", error: { message } };
          yield { type: "turn-end", reason: "error" };
          return;
        }

        // 2) 空转防护：同参数+同结果的重复调用 / 连续无进展步 / 同文件反复读取。
        //    这些调用**不返回 isError**，所以上面的连续失败防护永远攒不满
        //    （AGE-29：25 步 42 次工具、end_turn 正常结束，失败分散在大量
        //    「成功但零进展」的调用之间）。
        let progressed = false;
        let repeatedCall: { signature: string; count: number } | null = null;
        let rereadTarget: { path: string; count: number } | null = null;

        for (let i = 0; i < toolResults.length; i++) {
          const { toolUseId, result } = toolResults[i]!;
          const toolCall = toolCalls.find((tc) => tc.id === toolUseId);
          const toolName = toolCall?.name ?? "(unknown)";

          // 2a) 同一「工具+入参+结果」重复出现 → 该调用不携带新信息
          const signature = callSignature(toolName, toolCall?.input);
          const combo = `${signature}\u0000${resultDigest(result)}`;
          const seen = (identicalResults.get(combo) ?? 0) + 1;
          identicalResults.set(combo, seen);
          if (seen > 1) {
            // 重复结果 = 零进展；达到上限才升级为终止
            if (seen >= guards.maxIdenticalToolResults && !repeatedCall) {
              repeatedCall = { signature, count: seen };
            }
          } else if (!result.isError) {
            progressed = true;
          }

          // 2b) 只读工具反复读同一路径（期间无成功的变更类调用）
          if (toolCall) {
            const def = this.options.toolRegistry.get(toolCall.name);
            const readOnly = def?.isReadOnly
              ? def.isReadOnly(toolCall.input)
              : false;
            const target = readOnly ? targetPathOf(toolCall.input) : undefined;
            if (target !== undefined && !result.isError) {
              const reads = (targetReads.get(target) ?? 0) + 1;
              targetReads.set(target, reads);
              if (reads >= guards.maxSameTargetReads && !rereadTarget) {
                rereadTarget = { path: target, count: reads };
              }
            }
            if (!readOnly && !result.isError) {
              // 变更类调用成功 → 环境已改变，读取计数重新开始
              targetReads.clear();
            }
          }
        }

        if (repeatedCall) {
          const message =
            `检测到重复工具调用（同一工具、同一入参、同一结果已出现 ${repeatedCall.count} 次，` +
            `不携带任何新信息），已终止本轮对话防止死循环。` +
            `重复调用: ${repeatedCall.signature.slice(0, 200)}`;
          log.error("run", `repeated tool call guard: ${message}`);
          yield { type: "error", error: { message } };
          yield { type: "turn-end", reason: "error" };
          return;
        }

        if (rereadTarget) {
          const message =
            `检测到同一文件被重复读取 ${rereadTarget.count} 次且期间没有写入（` +
            `${rereadTarget.path}），已终止本轮对话防止死循环。` +
            `如确需多次读取，可调大 FENG_MAX_SAME_TARGET_READS。`;
          log.error("run", `repeated file read guard: ${message}`);
          yield { type: "error", error: { message } };
          yield { type: "turn-end", reason: "error" };
          return;
        }

        noProgressSteps = progressed ? 0 : noProgressSteps + 1;
        if (noProgressSteps >= guards.maxNoProgressSteps) {
          const message =
            `连续 ${noProgressSteps} 步工具调用没有任何新进展（结果全部为错误或历史重复），` +
            `模型可能陷入空转，已终止本轮对话防止死循环。` +
            `如确需较长探索，可调大 FENG_MAX_NO_PROGRESS_STEPS。`;
          log.error("run", `no-progress guard: ${message}`);
          yield { type: "error", error: { message } };
          yield { type: "turn-end", reason: "error" };
          return;
        }

        needsContinuation = true;
      } else {
        // 无工具调用 — 结束循环
        session.messages.push({
          id: messageId,
          role: "assistant",
          content: assistantContent,
          createdAt: Date.now(),
        });
        session.updatedAt = Date.now();
        session.tokenCount =
          this.options.contextManager.estimateTokens(session.messages);
        needsContinuation = false;
      }

      // 6. 轮次结束
      let turnReason: FinishReason;
      if (!needsContinuation) {
        turnReason = finishReason;
      } else if (step >= maxTurns) {
        // 达到最大轮次但 LLM 仍想继续
        turnReason = "max_tokens";
      } else {
        turnReason = "tool_use";
      }
      yield { type: "turn-end", reason: turnReason };
      log.info("run", `turn end reason=${turnReason}, step=${step}`);
    }
  }
}
