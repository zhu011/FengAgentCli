/**
 * @fengagent/events — 事件投影（读模型，Phase 1 + Phase 2 分支感知）
 *
 * 从事件日志按 seq 重放重建会话读模型（#2 逻辑复现 / #3 会话生命周期）：
 * - 标题/状态/模型：session/created（初始）→ session/title / session/status（变更）；
 * - 消息：user/message → 用户消息；assistant 消息由 step/start + assistant/chunk
 *   投影组装（#2 逻辑复现），step/end 收口；FENG_EVENT_FULL_REQUEST=1 时
 *   assistant/message / turn/end.assembled 直接落组装结果；
 * - tokenCount：turn/end / step/end 携带；
 * - Phase 2 分支感知：rollback/fork 事件按「回退点/分叉点节点 → 消息」截断
 *   消息历史（旧分支消息从读模型移除，事件本身不可变保留）；后续事件从截断点
 *   继续追加。node/quality 为图事实事件，本模块不消费（图投影消费）。
 */

import type { ContentBlock, Message, Session, SessionState } from "@fengagent/core";
import type { AnySessionEvent, SessionStatus } from "./types.ts";
import {
  assistantNodeId,
  branchPointNodeId,
  userNodeId,
} from "./node-ids.ts";

/** 事件会话状态 → core SessionState（事件词汇无 error，归 idle） */
export function toSessionState(status: SessionStatus): SessionState {
  return status === "running" ? "running" : "idle";
}

/** core SessionState → 事件会话状态（error 无词汇，归 idle） */
export function toEventStatus(state: SessionState): SessionStatus {
  return state === "running" ? "running" : "idle";
}

/** assistant 组装中的消息帧 */
interface AssistantFrame {
  messageId: string;
  blocks: ContentBlock[];
  createdAt: number;
}

function createFrame(messageId: string, createdAt: number): AssistantFrame {
  return { messageId, blocks: [], createdAt };
}

/** 组装负载 → ContentBlock[]（字符串视为单个文本块） */
export function normalizeAssembled(assembled: unknown): ContentBlock[] {
  if (typeof assembled === "string") {
    return [{ type: "text", text: assembled }];
  }
  if (Array.isArray(assembled)) {
    return assembled as ContentBlock[];
  }
  return [];
}

/** 追加一块增量（字符串 → 合并进末尾文本块；对象 → 原样追加块） */
function pushDelta(frame: AssistantFrame, delta: unknown): void {
  if (typeof delta === "string") {
    const last = frame.blocks[frame.blocks.length - 1];
    if (last && last.type === "text") {
      last.text += delta;
    } else {
      frame.blocks.push({ type: "text", text: delta });
    }
    return;
  }
  if (delta !== null && typeof delta === "object") {
    frame.blocks.push(delta as ContentBlock);
  }
}

/**
 * 从事件序列投影会话（#2/#3 读模型）。
 * @returns 完整 Session；事件流缺少 session/created 时返回 null（非会话事件流）
 */
export function projectSession(events: AnySessionEvent[]): Session | null {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let title = "New Session";
  let status: SessionState = "idle";
  let model = "";
  let createdAt: number | null = null;
  let updatedAt: number | null = null;
  let tokenCount = 0;
  const messages: Message[] = [];
  const frames = new Map<string, AssistantFrame>();
  // Phase 2：nodeId → messageId（rollback/fork 截断定位；与图投影共用确定性 id 方案）
  const messageIdByNodeId = new Map<string, string>();
  // 已被分支截断移除的消息 id（防御：防止截断后旧分支事件重新入列）
  const truncatedIds = new Set<string>();

  /** 分支截断：把消息历史截断到某节点对应的消息（含该消息），旧分支移除 */
  const truncateAt = (nodeId: string) => {
    const msgId = messageIdByNodeId.get(nodeId);
    if (!msgId) return; // 无法解析（如遗留 gnode id）— 保守不截断
    const idx = messages.findIndex((m) => m.id === msgId);
    if (idx === -1) return;
    for (const m of messages.slice(idx + 1)) truncatedIds.add(m.id);
    messages.length = idx + 1;
    // 丢弃已截断消息的组装帧（防止后续 step/end 重新入列）
    for (const [mid] of frames) {
      if (truncatedIds.has(mid)) frames.delete(mid);
    }
  };

  for (const e of sorted) {
    const ts = Date.parse(e.timestamp);
    if (!Number.isNaN(ts)) updatedAt = ts;

    switch (e.type) {
      case "session/created": {
        title = e.payload.title;
        status = toSessionState(e.payload.status);
        if (e.payload.initialModel) model = e.payload.initialModel;
        createdAt = ts;
        break;
      }
      case "session/title":
        title = e.payload.title;
        break;
      case "session/status":
        status = toSessionState(e.payload.status);
        break;
      case "user/message": {
        messageIdByNodeId.set(
          userNodeId(e.sessionId, e.payload.messageId),
          e.payload.messageId,
        );
        messages.push({
          id: e.payload.messageId,
          role: "user",
          content: e.payload.content as ContentBlock[],
          createdAt: ts,
        });
        break;
      }
      case "step/start": {
        messageIdByNodeId.set(
          assistantNodeId(e.sessionId, e.payload.messageId),
          e.payload.messageId,
        );
        frames.set(e.payload.messageId, createFrame(e.payload.messageId, ts));
        if (e.payload.model && !model) model = e.payload.model;
        break;
      }
      case "assistant/chunk": {
        const frame =
          frames.get(e.payload.messageId) ?? createFrame(e.payload.messageId, ts);
        pushDelta(frame, e.payload.delta);
        frames.set(e.payload.messageId, frame);
        break;
      }
      case "assistant/message": {
        // #2：FENG_EVENT_FULL_REQUEST=1 时直接落组装结果
        const frame =
          frames.get(e.payload.messageId) ?? createFrame(e.payload.messageId, ts);
        frame.blocks = normalizeAssembled(e.payload.assembled);
        frames.set(e.payload.messageId, frame);
        break;
      }
      case "step/end": {
        const frame = frames.get(e.payload.messageId);
        if (frame && !truncatedIds.has(e.payload.messageId)) {
          messages.push({
            id: frame.messageId,
            role: "assistant",
            content: frame.blocks,
            createdAt: frame.createdAt,
          });
          frames.delete(e.payload.messageId);
        }
        if (e.payload.tokenCount !== undefined) tokenCount = e.payload.tokenCount;
        break;
      }
      case "turn/end": {
        if (e.payload.tokenCount !== undefined) tokenCount = e.payload.tokenCount;
        if (
          e.payload.assembled !== undefined &&
          !frames.has(e.payload.messageId) &&
          !truncatedIds.has(e.payload.messageId)
        ) {
          messages.push({
            id: e.payload.messageId,
            role: "assistant",
            content: normalizeAssembled(e.payload.assembled),
            createdAt: ts,
          });
        }
        break;
      }
      case "rollback": {
        // #4/#6 分支感知：消息历史截断到回退点（目标节点对应消息，含该消息）
        const targetMsgId = messageIdByNodeId.get(e.payload.targetNodeId);
        truncateAt(e.payload.targetNodeId);
        // 分支点节点 id → 回退点消息（后续 rollback 可再次以分支点为回退目标）
        if (targetMsgId) {
          messageIdByNodeId.set(
            branchPointNodeId(e.sessionId, e.seq),
            targetMsgId,
          );
        }
        break;
      }
      case "fork": {
        // 分叉：消息历史截断到分叉点（父节点对应消息，含该消息）
        const parentMsgId = messageIdByNodeId.get(e.payload.parentNodeId);
        truncateAt(e.payload.parentNodeId);
        if (parentMsgId) {
          messageIdByNodeId.set(
            branchPointNodeId(e.sessionId, e.seq),
            parentMsgId,
          );
        }
        break;
      }
      default:
        // node/quality — 图事实事件，图投影消费
        break;
    }
  }

  if (createdAt === null) return null;
  const first = sorted[0];
  return {
    id: first?.sessionId ?? "",
    title,
    status,
    model,
    tokenCount,
    createdAt,
    updatedAt: updatedAt ?? createdAt,
    messages,
  };
}
