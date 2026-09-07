/**
 * @fengagent/web-ui — 会话消息按「轮」聚合（工具调用聚合在同一个回复里）
 *
 * 背景（AGE-29）：Agent Loop 一轮提问在底层消息里会拆成多条：
 *   用户提问(user text) → 助手步骤(assistant, tool-use) → 工具结果(user,
 *   tool-result) → 助手步骤(assistant) → … → 最终文字(assistant)
 * 直接把每条消息渲染成独立气泡，就会出现「执行工具时对话被拆成多段」、
 * 「工具结果变成一排空白用户气泡」。
 *
 * 本模块把消息投影为「展示消息」：
 * - 真实用户提问（含文本的 user 消息）→ 一个用户气泡；
 * - 工具结果 user 消息（只含 tool-result 块）→ 不产生气泡（其结果已并入
 *   对应工具卡片）；
 * - 同一轮提问下的多段助手步骤 → 聚合进同一个助手回复（steps 段，按序：
 *   文本 / 思考 / 工具卡片），一轮一个回复。
 *
 * 纯函数、无 React 依赖，便于单测与两端（历史重载 / SSE 流式）复用。
 */

import type { Message } from "../api/types.ts";

/** 前端展示用的工具调用信息 */
export interface ToolCallInfo {
  toolUseId: string;
  name: string;
  input: unknown;
  result?: { content: string; isError?: boolean };
  status: "running" | "completed" | "failed";
  /** 入参是否被用户在审批环节人工修改后执行（human-in-the-loop） */
  edited?: boolean;
}

/** Token 用量统计 */
export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** 助手回合内的一个步骤（对应一条真实 assistant 消息 / 一次 LLM 步骤） */
export interface DisplayStep {
  /** 真实助手消息 id（deep-link 定位 / 回退溯源用） */
  messageId: string;
  text: string;
  thinking: string;
  toolCalls: ToolCallInfo[];
  /** 该步骤是否仍在流式输出 */
  streaming: boolean;
  createdAt: number;
  tokenStats?: TokenStats;
}

/** 前端展示用的消息项（含工具调用列表；assistant 消息可含多段步骤） */
export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  /** 聚合文本（多段步骤时 = 各段文本按序拼接；无 steps 时为单段文本） */
  text: string;
  /** 思考内容（多段步骤时按序拼接） */
  thinking: string;
  toolCalls: ToolCallInfo[];
  streaming: boolean;
  createdAt: number;
  /** AI 消息的 token 用量统计 */
  tokenStats?: TokenStats;
  /**
   * 助手回合内按序的多段步骤（同一轮多次工具调用 / 多次 LLM 步骤聚合进
   * 同一个回复）。单步回答时缺省 undefined，走原单段渲染路径。
   */
  steps?: DisplayStep[];
}

/** 是否真实用户提问（工具结果 user 消息不算；其只含 tool-result 块） */
export function isRealUserQuestion(msg: Message): boolean {
  if (msg.role !== "user") return false;
  if (msg.content.length === 0) return true; // 历史数据兜底：视为提问
  return !msg.content.some((b) => b.type === "tool-result");
}

/** 工具结果 user 消息 → 是否（含 tool-result 块即可判定，辅助过滤） */
export function isToolResultMessage(msg: Message): boolean {
  return msg.role === "user" && msg.content.some((b) => b.type === "tool-result");
}

/** 收集全量 toolUseId → 结果（供助手 tool-use 块关联结果，含成功/失败） */
export function buildToolResults(
  messages: Message[],
): Map<string, { content: string; isError?: boolean }> {
  const map = new Map<string, { content: string; isError?: boolean }>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool-result") {
        map.set(block.toolUseId, {
          content: block.content,
          isError: block.isError,
        });
      }
    }
  }
  return map;
}

/** 单条助手消息 → 展示步骤（文本/思考/工具卡片按块序提取） */
export function messageToStep(
  msg: Message,
  toolResults: Map<string, { content: string; isError?: boolean }>,
): DisplayStep {
  let text = "";
  let thinking = "";
  const toolCalls: ToolCallInfo[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "thinking") {
      thinking += block.text;
    } else if (block.type === "tool-use") {
      const result = toolResults.get(block.id);
      toolCalls.push({
        toolUseId: block.id,
        name: block.name,
        input: block.input,
        result,
        // 有结果按结果定态；无结果（会话中断/终止，工具未返回）按失败处理
        status:
          result === undefined
            ? "failed"
            : result.isError
              ? "failed"
              : "completed",
      });
    }
  }
  return {
    messageId: msg.id,
    text,
    thinking,
    toolCalls,
    streaming: false,
    createdAt: msg.createdAt,
  };
}

/** 把多段步骤聚合成一个助手展示消息（文本/思考/工具卡片按序拼接） */
export function mergeAssistantSteps(steps: DisplayStep[]): DisplayMessage {
  const text = steps
    .map((s) => s.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
  const thinking = steps
    .map((s) => s.thinking)
    .filter((t) => t.length > 0)
    .join("\n\n");
  const toolCalls = steps.flatMap((s) => s.toolCalls);
  const streaming = steps.some((s) => s.streaming);
  return {
    id: steps[0]!.messageId,
    role: "assistant",
    text,
    thinking,
    toolCalls,
    streaming,
    createdAt: steps[0]!.createdAt,
    // 单步回答保持无 steps（走原单段渲染）；多步才带 steps 分步展示
    ...(steps.length > 1 ? { steps } : {}),
  };
}

/** 真实用户提问消息 → 用户展示消息 */
export function userMessageToDisplay(msg: Message): DisplayMessage {
  let text = "";
  for (const block of msg.content) {
    if (block.type === "text") text += block.text;
  }
  return {
    id: msg.id,
    role: "user",
    text,
    thinking: "",
    toolCalls: [],
    streaming: false,
    createdAt: msg.createdAt,
  };
}

/** 系统消息 → 系统展示消息（文本型内容） */
export function systemMessageToDisplay(msg: Message): DisplayMessage {
  let text = "";
  for (const block of msg.content) {
    if (block.type === "text") text += block.text;
  }
  return {
    id: msg.id,
    role: "system",
    text,
    thinking: "",
    toolCalls: [],
    streaming: false,
    createdAt: msg.createdAt,
  };
}

/**
 * 把会话消息列表投影为「按轮聚合」的展示消息列表。
 *
 * 规则：
 * 1. 工具结果 user 消息不产生气泡（消化进工具卡片结果）；
 * 2. 真实提问 → 用户气泡；其后到下一个真实提问前的助手消息 → 聚合进
 *    同一个助手回复（多段步骤按序保留）；
 * 3. 无前置提问的孤立助手消息（导入历史等）连续段聚合成一个回复。
 */
export function sessionToTurnMessages(messages: Message[]): DisplayMessage[] {
  const toolResults = buildToolResults(messages);
  const out: DisplayMessage[] = [];
  let i = 0;

  const collectAssistantRun = (): DisplayMessage | null => {
    const steps: DisplayStep[] = [];
    while (i < messages.length) {
      const m = messages[i]!;
      if (m.role === "assistant") {
        steps.push(messageToStep(m, toolResults));
        i++;
        continue;
      }
      if (m.role === "user" && isToolResultMessage(m)) {
        i++; // 工具结果 — 消化
        continue;
      }
      break; // 下一个真实提问 / 系统消息 / 其它
    }
    if (steps.length === 0) return null;
    return mergeAssistantSteps(steps);
  };

  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === "system") {
      out.push(systemMessageToDisplay(msg));
      i++;
      continue;
    }
    if (msg.role === "user") {
      if (!isRealUserQuestion(msg)) {
        i++; // 工具结果 / 其它内部 user 消息 — 不渲染
        continue;
      }
      out.push(userMessageToDisplay(msg));
      i++;
      // 该提问的回答：吸收其后的助手步骤（与可能夹在步骤间的工具结果）
      const merged = collectAssistantRun();
      if (merged) out.push(merged);
      continue;
    }
    if (msg.role === "assistant") {
      const merged = collectAssistantRun();
      if (merged) out.push(merged);
      continue;
    }
    i++;
  }
  return out;
}
