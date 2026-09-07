/**
 * @fengagent/web-ui — SSE 轮次流式渲染状态机（纯函数层，无 React 依赖）
 *
 * 单次 SSE 轮次（sendMessage / rollbackRetry / 后台附加共用）的流式渲染上下文：
 * 流式状态与消息列表更新被抽成 handleTurnEvent，各链路（发送新消息 / 回退后
 * 自动重答 / 订阅回放）共用同一套「message-start → text-delta → tool-call →
 * result → message-end」渲染逻辑；setDisplayMessages 等更新器绑定到**指定会话**
 * 的状态切片 —— 后台会话的事件只写它自己的状态（会话间消息隔离）。
 *
 * AGE-29：一次提问在底层消息里会包含多段助手步骤（工具调用步骤 + 最终文字），
 * 这些步骤被聚合进同一个助手气泡（turnRowId 指向该聚合行；每步以 messageId
 * 定位更新），工具结果不产生独立气泡。
 *
 * AGE-29 R1：运行中 rejoin（页面刷新 / 第二 tab / 切回后台运行中的会话）经
 * GET /:id/events 订阅时会先把本次运行已产生的事件整轮回放，而展示列表已由
 * 快照（sessionToTurnMessages）或本地流构建（同一批 messageId）—— handleTurnEvent
 * 的 message-start 按 messageId 对既有行/步骤去重，避免已完成轮次重复出现。
 */

import type { AgentEvent, Session } from "../api/types.ts";
import type {
  DisplayMessage,
  DisplayStep,
  TokenStats,
  ToolCallInfo,
} from "./turn-messages.ts";

/** 展示消息列表更新器（React SetStateAction 的函数形态，纯层不依赖 React） */
export type SetDisplayMessages = (
  updater:
    | DisplayMessage[]
    | ((prev: DisplayMessage[]) => DisplayMessage[]),
) => void;

/**
 * 单次 SSE 轮次（sendMessage / rollbackRetry / 后台附加 共用）的流式渲染上下文。
 *
 * 流式状态与消息列表更新被抽成 handleTurnEvent，各链路（发送新消息 /
 * 回退后自动重答 / 订阅回放）共用同一套「message-start → text-delta →
 * tool-call → result → message-end」渲染逻辑；setDisplayMessages 等更新器
 * 绑定到**指定会话**的状态切片 —— 后台会话的事件只写它自己的状态。
 */
export interface TurnStreamCtx {
  /** 步骤 id → 已累积文本（读后写，避免 setState 内副作用） */
  streamingText: Map<string, string>;
  /** 步骤 id → 已累积思考文本 */
  streamingThinking: Map<string, string>;
  /** 步骤 id → 已收集工具卡片（读后写） */
  messageToolCalls: Map<string, ToolCallInfo[]>;
  /** toolUseId → 所属步骤消息 id（message-end 之后结果才到，须独立关联） */
  toolUseToMessageId: Map<string, string>;
  /** 当前正在流式输出的步骤消息 id（message-end 后置空） */
  currentMessageId: { value: string | null };
  /**
   * 当前轮次的聚合助手行 id（= 本轮首个 message-start 的消息 id）。
   * 同一轮后续步骤追加进该行（不新建气泡）；session-start 重建后置空。
   */
  turnRowId: { value: string | null };
  /** session-start 处理（默认无操作；rollbackRetry 用它重建回退截断后的消息列表） */
  onSessionStart?: (session: Session) => void;
  /** 更新目标会话的展示消息列表（绑定到该会话的状态切片） */
  setDisplayMessages: SetDisplayMessages;
  setError: (message: string | null) => void;
  setSessionTokenStats: (
    updater:
      | TokenStats
      | null
      | ((prev: TokenStats | null) => TokenStats | null),
  ) => void;
  /**
   * 读取目标会话当前展示消息列表（回放去重时用于定位既有行/步骤；
   * 由调用方绑定到该会话最新的状态镜像）。
   */
  readMessages?: () => DisplayMessage[];
}

/**
 * 构造绑定到指定会话的流式渲染上下文。
 *
 * @param updaters - 绑定到目标会话状态切片的更新器（事件只写该会话的状态）
 */
export function createTurnStreamCtx(
  updaters: Pick<
    TurnStreamCtx,
    "setDisplayMessages" | "setError" | "setSessionTokenStats"
  > &
    Partial<
      Pick<TurnStreamCtx, "onSessionStart" | "readMessages">
    >,
): TurnStreamCtx {
  return {
    streamingText: new Map<string, string>(),
    streamingThinking: new Map<string, string>(),
    messageToolCalls: new Map<string, ToolCallInfo[]>(),
    toolUseToMessageId: new Map<string, string>(),
    currentMessageId: { value: null },
    turnRowId: { value: null },
    onSessionStart: updaters.onSessionStart,
    readMessages: updaters.readMessages,
    setDisplayMessages: updaters.setDisplayMessages,
    setError: updaters.setError,
    setSessionTokenStats: updaters.setSessionTokenStats,
  };
}

/** 在展示列表中定位已包含指定步骤的聚合行（行 id 或某 step.messageId 命中） */
export function findRowContainingStep(
  messages: DisplayMessage[],
  stepId: string,
): string | null {
  for (const m of messages) {
    if (m.id === stepId) return m.id;
    if (m.steps?.some((s) => s.messageId === stepId)) return m.id;
  }
  return null;
}

/** 处理单个 AgentEvent — 流式渲染（sendMessage / rollbackRetry / 后台附加共用） */
export function handleTurnEvent(event: AgentEvent, ctx: TurnStreamCtx): void {
  const {
    streamingText,
    streamingThinking,
    messageToolCalls,
    toolUseToMessageId,
    currentMessageId,
    setDisplayMessages,
    setError,
    setSessionTokenStats,
  } = ctx;
  const rowIdOf = () => ctx.turnRowId.value;

  switch (event.type) {
    case "session-start": {
      // rollbackRetry：首帧 session-start 携带回退截断后的会话 → 重建消息列表。
      // 重建后本轮聚合行从零开始（旧 turnRowId 已随旧列表作废）。
      ctx.onSessionStart?.(event.session);
      ctx.turnRowId.value = null;
      currentMessageId.value = null;
      streamingText.clear();
      streamingThinking.clear();
      messageToolCalls.clear();
      toolUseToMessageId.clear();
      break;
    }

    case "message-start": {
      currentMessageId.value = event.messageId;
      const stepId = event.messageId;
      const step: DisplayStep = {
        messageId: stepId,
        text: "",
        thinking: "",
        toolCalls: [],
        streaming: true,
        createdAt: Date.now(),
      };

      // AGE-29 R1：回放/重复事件按 messageId 去重 —— 该步骤已存在于展示列表
      // （快照构建或本地流已渲染）时不再新建行/重复追加步骤，只把流式状态指向
      // 既有行，后续 delta/end 原位更新（运行中 rejoin 的回放不再复制已完成轮次）。
      const existingRowId = ctx.readMessages
        ? findRowContainingStep(ctx.readMessages(), stepId)
        : null;
      if (existingRowId) {
        ctx.turnRowId.value = existingRowId;
        break;
      }

      const rowId = rowIdOf();
      if (rowId) {
        // 同一轮提问的后续 LLM 步骤 → 并入既有聚合行（不拆成新气泡）
        setDisplayMessages((prev) =>
          prev.map((m) => {
            if (m.id !== rowId || !m.steps) return m;
            const steps = [...m.steps, step];
            return { ...m, steps, ...recomputeAggregates(steps, m) };
          }),
        );
      } else {
        // 本轮首个助手步骤 → 新建聚合行（行 id = 首步骤 id）
        ctx.turnRowId.value = stepId;
        setDisplayMessages((prev) => [
          ...prev,
          {
            id: stepId,
            role: event.role,
            text: "",
            thinking: "",
            toolCalls: [],
            streaming: true,
            createdAt: Date.now(),
            steps: [step],
          },
        ]);
      }
      break;
    }

    case "text-delta": {
      const stepId = event.messageId;
      const rowId = rowIdOf();
      if (!rowId) break;
      const accumulated = (streamingText.get(stepId) ?? "") + event.text;
      streamingText.set(stepId, accumulated);
      setDisplayMessages((prev) =>
        updateStepInRow(prev, rowId, stepId, (s) => ({
          ...s,
          text: accumulated,
        })),
      );
      break;
    }

    case "thinking-delta": {
      // 思考过程内容 — 流式累积，前端可实时展示（展开/折叠）
      const stepId = event.messageId;
      const rowId = rowIdOf();
      if (!rowId) break;
      const accumulated =
        (streamingThinking.get(stepId) ?? "") + event.text;
      streamingThinking.set(stepId, accumulated);
      setDisplayMessages((prev) =>
        updateStepInRow(prev, rowId, stepId, (s) => ({
          ...s,
          thinking: accumulated,
        })),
      );
      break;
    }

    case "tool-call-start": {
      // 工具调用归属于当前正在生成的助手步骤
      const stepId = currentMessageId.value;
      const rowId = rowIdOf();
      if (!stepId || !rowId) break;
      toolUseToMessageId.set(event.toolUseId, stepId);
      const calls = messageToolCalls.get(stepId) ?? [];
      calls.push({
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
        status: "running",
      });
      messageToolCalls.set(stepId, calls);
      setDisplayMessages((prev) =>
        updateStepInRow(prev, rowId, stepId, (s) => ({
          ...s,
          toolCalls: [...calls],
        })),
      );
      break;
    }

    case "tool-call-result": {
      // 按 toolUseId → 步骤消息 映射定位归属（message-end 已把 currentMessageId
      // 置空，工具结果在其后到达，不能再用 currentMessageId 关联）
      const stepId =
        toolUseToMessageId.get(event.toolUseId) ?? currentMessageId.value;
      const rowId = rowIdOf();
      toolUseToMessageId.delete(event.toolUseId);
      if (!stepId || !rowId) break;
      const calls = messageToolCalls.get(stepId) ?? [];
      const idx = calls.findIndex((c) => c.toolUseId === event.toolUseId);
      if (idx !== -1) {
        const existing = calls[idx];
        if (existing) {
          // 用户改参后执行：tool-call-result 携带实际执行入参 → 卡片输入同步为实际参数
          const corrected = event.input !== undefined;
          calls[idx] = {
            toolUseId: existing.toolUseId,
            name: existing.name,
            input: corrected ? event.input : existing.input,
            edited: corrected ? true : existing.edited,
            result: event.result,
            status: event.result.isError ? "failed" : "completed",
          };
          messageToolCalls.set(stepId, calls);
          setDisplayMessages((prev) =>
            updateStepInRow(prev, rowId, stepId, (s) => ({
              ...s,
              toolCalls: [...calls],
            })),
          );
        }
      }
      break;
    }

    case "message-end": {
      const stepId = event.messageId;
      streamingText.delete(stepId);
      streamingThinking.delete(stepId);
      currentMessageId.value = null;
      const rowId = rowIdOf();
      if (!rowId) break;
      // 该步骤流式结束（行是否仍 streaming 由 recompute 按剩余步骤推导）
      setDisplayMessages((prev) =>
        updateStepInRow(prev, rowId, stepId, (s) => ({
          ...s,
          streaming: false,
        })),
      );
      break;
    }

    case "error": {
      setError(event.error.message);
      break;
    }

    // turn-end / session-end — 兜底清理：确保所有消息标记为非流式
    // （防止 message-end 未到达时 streaming: true 永不消除）；
    // 同时复位仍处于 running 的工具调用（loop 终止/出错时不再转圈）。
    // 注意：turn-end(tool_use) 出现在同轮步骤之间，不能关闭聚合行；
    // 行的最终关闭由 session-end 与客户端 finally 兜底完成。
    case "turn-end": {
      if (currentMessageId.value) {
        streamingText.delete(currentMessageId.value);
        streamingThinking.delete(currentMessageId.value);
        currentMessageId.value = null;
      }
      setDisplayMessages((prev) => markRunningToolCallsFailed(prev));
      break;
    }

    case "session-end": {
      if (currentMessageId.value) {
        streamingText.delete(currentMessageId.value);
        streamingThinking.delete(currentMessageId.value);
        currentMessageId.value = null;
      }
      ctx.turnRowId.value = null;
      // 安全清理：关闭所有流式行/步骤 + 复位 running 工具调用
      setDisplayMessages((prev) =>
        markRunningToolCallsFailed(closeOpenTurns(prev)),
      );
      break;
    }

    case "compaction-start":
    case "compaction-end":
      break;

    case "usage": {
      // 捕获 token 用量和缓存命中统计
      const usageStats: TokenStats = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        ...(event.cacheReadTokens ? { cacheReadTokens: event.cacheReadTokens } : {}),
        ...(event.cacheCreationTokens ? { cacheCreationTokens: event.cacheCreationTokens } : {}),
      };
      // 附加到当前 assistant 步骤
      const stepId = currentMessageId.value;
      const rowId = rowIdOf();
      if (stepId && rowId) {
        setDisplayMessages((prev) =>
          updateStepInRow(prev, rowId, stepId, (s) => ({
            ...s,
            tokenStats: usageStats,
          })),
        );
      }
      // 累加到会话级统计
      setSessionTokenStats((prev) => ({
        inputTokens: (prev?.inputTokens ?? 0) + usageStats.inputTokens,
        outputTokens: (prev?.outputTokens ?? 0) + usageStats.outputTokens,
        cacheReadTokens: (prev?.cacheReadTokens ?? 0) + (usageStats.cacheReadTokens ?? 0),
        cacheCreationTokens: (prev?.cacheCreationTokens ?? 0) + (usageStats.cacheCreationTokens ?? 0),
      }));
      break;
    }
  }
}

/**
 * 将仍处于 running 的工具调用复位为 failed（含分步步骤内的工具卡片）。
 *
 * loop 正常收尾时每个 tool-call-start 都有对应的 tool-call-result（completed/failed），
 * 不会有 running 残留；running 残留只出现在异常终止路径（死循环防护/LLM 错误/中断/
 * 超时/连接断开），此时把子项从「转圈」复位为明确的失败态。
 */
export function markRunningToolCallsFailed(messages: DisplayMessage[]): DisplayMessage[] {
  const failCards = (cards: ToolCallInfo[]): ToolCallInfo[] =>
    cards.map((tc) =>
      tc.status === "running"
        ? {
            ...tc,
            status: "failed",
            result: {
              content: "工具调用未完成（对话已终止或中断）",
              isError: true,
            },
          }
        : tc,
    );
  return messages.map((m) => {
    const steps = m.steps;
    const changed =
      m.toolCalls.some((tc) => tc.status === "running") ||
      (steps?.some((s) => s.toolCalls.some((tc) => tc.status === "running")) ??
        false);
    if (!changed) return m;
    return {
      ...m,
      toolCalls: failCards(m.toolCalls),
      ...(steps
        ? {
            steps: steps.map((s) =>
              s.toolCalls.some((tc) => tc.status === "running")
                ? { ...s, toolCalls: failCards(s.toolCalls) }
                : s,
            ),
          }
        : {}),
    };
  });
}

/**
 * 关闭仍在流式状态的「轮」（行 + 其分步）：
 * 消息列表重建 / 会话切换 / 中断兜底时，把 streaming 行与 streaming 步骤复位。
 */
export function closeOpenTurns(messages: DisplayMessage[]): DisplayMessage[] {
  return messages.map((m) => {
    const steps = m.steps;
    const stepOpen = steps?.some((s) => s.streaming) ?? false;
    if (!m.streaming && !stepOpen) return m;
    return {
      ...m,
      streaming: false,
      ...(steps
        ? {
            steps: steps.map((s) =>
              s.streaming ? { ...s, streaming: false } : s,
            ),
          }
        : {}),
    };
  });
}

/** 由步骤数组重算聚合行字段（text/thinking/toolCalls/streaming） */
function recomputeAggregates(
  steps: DisplayStep[],
  base?: Pick<DisplayMessage, "tokenStats">,
): Pick<DisplayMessage, "text" | "thinking" | "toolCalls" | "streaming" | "tokenStats"> {
  return {
    text: steps
      .map((s) => s.text)
      .filter((t) => t.length > 0)
      .join("\n\n"),
    thinking: steps
      .map((s) => s.thinking)
      .filter((t) => t.length > 0)
      .join("\n\n"),
    toolCalls: steps.flatMap((s) => s.toolCalls),
    streaming: steps.some((s) => s.streaming),
    tokenStats: base?.tokenStats,
  };
}

/**
 * 更新指定行内指定步骤（按步骤 messageId 定位）。
 *
 * - 聚合行（steps 存在）：定位对应步骤原位更新，随后重算聚合字段；
 * - 单步扁平行（快照/历史投影，无 steps）：步骤 id 即行 id，直接更新行的
 *   扁平字段 —— 运行中 rejoin 的回放会把事件喂给快照构建的行（AGE-29 R1）。
 * 找不到行/步骤返回原数组。
 */
function updateStepInRow(
  prev: DisplayMessage[],
  rowId: string,
  stepMessageId: string,
  update: (step: DisplayStep) => DisplayStep,
): DisplayMessage[] {
  return prev.map((m) => {
    if (m.id !== rowId) return m;
    if (m.steps) {
      let touched = false;
      const steps = m.steps.map((s) => {
        if (s.messageId !== stepMessageId) return s;
        touched = true;
        return update(s);
      });
      if (!touched) return m;
      return { ...m, ...recomputeAggregates(steps, m), steps };
    }
    // 单步扁平行：无 steps 字段（快照投影只对单步助手消息省略 steps）——
    // 步骤 id === 行 id 时按行内扁平字段原位更新
    if (m.id !== stepMessageId) return m;
    const stepLike: DisplayStep = {
      messageId: m.id,
      text: m.text,
      thinking: m.thinking,
      toolCalls: m.toolCalls,
      streaming: m.streaming,
      createdAt: m.createdAt,
      ...(m.tokenStats !== undefined ? { tokenStats: m.tokenStats } : {}),
    };
    const updated = update(stepLike);
    return {
      ...m,
      text: updated.text,
      thinking: updated.thinking,
      toolCalls: updated.toolCalls,
      streaming: updated.streaming,
      ...(updated.tokenStats !== undefined
        ? { tokenStats: updated.tokenStats }
        : m.tokenStats !== undefined
          ? { tokenStats: m.tokenStats }
          : {}),
    };
  });
}
