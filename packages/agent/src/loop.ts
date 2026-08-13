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
import { generateId } from "@fengagent/shared/utils";
import { createLogger } from "@fengagent/shared";
import { llmEventToAgentEvents } from "./streaming.ts";

const log = createLogger("agent-loop");

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
    const { maxTurns } = this.options.config;

    while (needsContinuation && step < maxTurns) {
      step++;

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
      llmTracer.logRequest(session.id, llmRequest);
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
      llmTracer.logResponse(session.id, session.model, llmEvents, Date.now() - llmStartTime);

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
