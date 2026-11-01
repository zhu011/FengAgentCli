/**
 * @fengagent/dsh-compat — 消息 → dsh 会话事件投影（P2）
 *
 * FengAgentCli 的事实源是 `Message[]`（`packages/core/src/types.ts`），dsh 的事实源是
 * append-only `SessionEvent[]`。P2 只做**读投影**：
 *
 *   user 消息   → `user/message`（text/thinking/image 块）
 *   user 消息里的 tool-result 块 → `tool/result`（每次调用一条）
 *   assistant 消息 → `assistant/message`（text/thinking/tool-use 块）
 *
 * 投影是**有损**的，且不伪造 dsh 的 chunk/lifecycle 事件：
 * - 没有 `assistant/chunk`（FengAgentCli 不持久化 token 级 chunk）；
 * - 没有 `request/header`、`request/context`、`turn/start`、`turn/end` 等
 *   生命周期事件——`turn`/`step` 字段取保守的合成值（每个用户消息一轮、step=1），
 *   只用于满足消费者读字段的形状，不作为因果依据；
 * - 没有 `surfaceOp` / `sourceEventSeqs` / `session/end-seed`，
 *   因此 `DshSessionLike.surface` 明确不支持；
 * - system 消息没有 dsh 对应事件，跳过（dsh 的 system prompt 走 request/header）。
 *
 * 逐成员裁决与偏差说明见 `docs/DSH-CONTRACT-MAP.md`。
 */

import type { ContentBlock, Message } from "@fengagent/core";
import type { DshSessionEvent } from "./contracts.ts";

/** 投影出的事件：额外带「来自第几条消息」以便 fork 按 seq 边界截断 */
export interface ProjectedSessionEvent extends DshSessionEvent {
  /** 来源消息在 `Message[]` 中的下标（用于 fork 边界换算） */
  readonly messageIndex: number;
}

/** dsh 块形状（结构化，避免依赖 dsh-llm 类型） */
type DshBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: string }
  | {
      type: "tool-result";
      toolCallId: string;
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    };

/** 把 FengAgentCli 的内容块映射为 dsh 内容块；无等价语义的块剔除（投影只保证已知语义） */
function toDshBlocks(blocks: readonly ContentBlock[]): DshBlock[] {
  const out: DshBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        out.push({ type: "text", text: block.text });
        break;
      case "thinking":
        out.push({ type: "reasoning", text: block.text });
        break;
      case "tool-use":
        out.push({
          type: "tool-call",
          id: block.id,
          name: block.name,
          arguments: stringifyArguments(block.input),
        });
        break;
      case "image":
        // dsh 的图片块引用 attachment 服务；FengAgentCli 内联 base64，无法等价投影。
        break;
      default:
        break;
    }
  }
  return out;
}

function stringifyArguments(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "{}";
  } catch {
    return "{}";
  }
}

/** `tool-result` 块 → dsh `tool/result` 事件 data */
function toolResultEventData(
  message: Message,
  block: Extract<ContentBlock, { type: "tool-result" }>,
  index: number,
  turn: number,
): Record<string, unknown> {
  return {
    turn,
    step: 1,
    message: {
      id: `${message.id}:tool:${index}`,
      role: "user",
      content: [
        {
          type: "tool-result",
          toolCallId: block.toolUseId,
          content: [{ type: "text", text: block.content }],
          ...(block.isError === undefined ? {} : { isError: block.isError }),
        },
      ],
      source: { kind: "tool" },
    },
  };
}

/**
 * 把一条会话的消息投影成 dsh 事件序列。
 *
 * @param messages - 会话消息（按时间顺序）
 * @returns 连续 `seq`（从 0 开始）的事件数组；不修改入参
 */
export function projectSessionEvents(
  messages: readonly Message[],
): ProjectedSessionEvent[] {
  const events: ProjectedSessionEvent[] = [];
  let turn = 0;

  const push = (
    messageIndex: number,
    type: string,
    time: number,
    data: Record<string, unknown>,
  ): void => {
    events.push({ seq: events.length, type, time, data, messageIndex });
  };

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "system") continue;

    if (message.role === "user") {
      turn += 1;
      const textual: ContentBlock[] = [];
      let toolIndex = 0;
      for (const block of message.content) {
        if (block.type === "tool-result") {
          push(
            index,
            "tool/result",
            message.createdAt,
            toolResultEventData(message, block, toolIndex++, turn),
          );
        } else {
          textual.push(block);
        }
      }
      const content = toDshBlocks(textual);
      if (content.length > 0) {
        push(index, "user/message", message.createdAt, {
          turn,
          step: 1,
          message: {
            id: message.id,
            role: "user",
            content,
            source: { kind: "user" },
          },
        });
      }
      continue;
    }

    // assistant
    const content = toDshBlocks(message.content);
    if (content.length === 0) continue;
    push(index, "assistant/message", message.createdAt, {
      turn: Math.max(turn, 1),
      step: 1,
      message: {
        id: message.id,
        role: "assistant",
        content,
        source: { kind: "model" },
      },
    });
  }

  return events;
}

/**
 * 把 dsh 的 seq 边界换算成「保留到第几条消息」（含）。
 *
 * @param events - {@link projectSessionEvents} 的产物
 * @param boundary - dsh 的 inclusive seq；越界时拒绝（与 dsh 一致：不能在日志外分叉）
 * @returns 消息下标上界（含）；空日志返回 -1
 * @throws RangeError - boundary 不是日志内的整数 seq
 */
export function messageBoundaryForSeq(
  events: readonly ProjectedSessionEvent[],
  boundary: number,
): number {
  if (!Number.isInteger(boundary) || boundary < 0 || boundary >= events.length) {
    throw new RangeError(
      `fork boundary ${boundary} is outside the projected log (0..${events.length - 1})`,
    );
  }
  return events[boundary]!.messageIndex;
}
