/**
 * @fengagent/events — 双写映射（迁移期：旧存储 + 事件日志并行写，Phase 1）
 *
 * DualWriteSessionStore 包装旧会话存储（SQLite SessionStore / 内存存储均可，
 * 结构性满足 SessionStorePort），同一会话事实既写旧存储、也以事件形式
 * 追加到事件日志（#2/#3/#5 语义）：
 * - saveSession 首写 → session/created（title/status/model/createdAt）；
 *   变更（title/status/tokenCount）→ session/title / session/status / turn/end；
 * - saveMessage/saveMessages → user/message；assistant 消息 → step/start +
 *   assistant/chunk（逐内容块）+ step/end；按 messageId 幂等（重复保存不重复落事件）；
 * - loadSession/deleteSession 透传旧存储（事件日志 append-only，删除只作用于旧存储）。
 *
 * 投影侧约束：回退/分叉（rollback/fork 事件）导致的消息截断属 Phase 2
 * （分支感知投影），本阶段对账覆盖线性会话。
 */

import type { Message, Session } from "@fengagent/core";
import { EventStore } from "./event-store.ts";
import { projectSession, toEventStatus } from "./projection.ts";

/** 旧存储最小端口（SQLite SessionStore / 内存存储均结构性满足） */
export interface SessionStorePort {
  saveSession(session: Session): void;
  loadSession(id: string): Session | null | undefined;
  deleteSession(id: string): void;
  saveMessage?(sessionId: string, message: Message): void;
  saveMessages?(sessionId: string, messages: Message[]): void;
}

export interface DualWriteSessionStoreOptions {
  /** 旧存储（主读路径，Phase 1 仍是权威） */
  legacy: SessionStorePort;
  /** 事件日志存储（双写目标） */
  events: EventStore;
  /** assistant step/start 的 model 兜底（session.model 优先） */
  model?: string;
}

/** epoch ms → ISO-8601（事件时间戳；反向 Date.parse 无损还原） */
function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export class DualWriteSessionStore implements SessionStorePort {
  private readonly legacy: SessionStorePort;
  private readonly events: EventStore;
  private readonly fallbackModel?: string;
  /** sessionId → 已落事件的 messageId（幂等去重） */
  private readonly seenMessages = new Map<string, Set<string>>();

  constructor(options: DualWriteSessionStoreOptions) {
    this.legacy = options.legacy;
    this.events = options.events;
    this.fallbackModel = options.model;
  }

  /** 双写：旧存储 + 事件日志（首写 created，变更 title/status/tokenCount） */
  saveSession(session: Session): void {
    this.legacy.saveSession(session);

    const existing = projectSession(this.events.replay(session.id));
    if (!existing) {
      // 首写：session/created（#3 生命周期入词汇）
      this.events.append({
        sessionId: session.id,
        type: "session/created",
        payload: {
          title: session.title,
          status: toEventStatus(session.status),
          initialModel: session.model,
        },
        timestamp: iso(session.createdAt),
      });
      return;
    }

    if (existing.title !== session.title) {
      this.events.append({
        sessionId: session.id,
        type: "session/title",
        payload: { title: session.title },
        timestamp: iso(session.updatedAt),
      });
    }
    if (existing.status !== session.status) {
      this.events.append({
        sessionId: session.id,
        type: "session/status",
        payload: { status: toEventStatus(session.status) },
        timestamp: iso(session.updatedAt),
      });
    }
    if (existing.tokenCount !== session.tokenCount) {
      const last = session.messages[session.messages.length - 1];
      this.events.append({
        sessionId: session.id,
        type: "turn/end",
        payload: { messageId: last?.id ?? "", tokenCount: session.tokenCount },
        timestamp: iso(session.updatedAt),
      });
    }
  }

  /** 双写单条消息（按 messageId 幂等） */
  saveMessage(sessionId: string, message: Message): void {
    this.legacy.saveMessage?.(sessionId, message);
    this.appendMessageEvent(sessionId, message);
  }

  /** 双写整批消息（按 messageId 幂等，重复保存不重复落事件） */
  saveMessages(sessionId: string, messages: Message[]): void {
    this.legacy.saveMessages?.(sessionId, messages);
    for (const message of messages) {
      this.appendMessageEvent(sessionId, message);
    }
  }

  loadSession(id: string): Session | null | undefined {
    return this.legacy.loadSession(id);
  }

  deleteSession(id: string): void {
    this.legacy.deleteSession(id);
  }

  /** 事件日志可重放（对账/调试） */
  replay(sessionId: string) {
    return this.events.replay(sessionId);
  }

  private appendMessageEvent(sessionId: string, message: Message): void {
    const seen = this.seenIds(sessionId);
    if (seen.has(message.id)) return;

    if (message.role === "user") {
      this.events.append({
        sessionId,
        type: "user/message",
        payload: { messageId: message.id, content: message.content },
        timestamp: iso(message.createdAt),
      });
    } else if (message.role === "assistant") {
      // #2 逻辑复现：step/start（参数）→ assistant/chunk（逐内容块）→ step/end
      this.events.append({
        sessionId,
        type: "step/start",
        payload: { messageId: message.id, model: this.fallbackModel },
        timestamp: iso(message.createdAt),
      });
      message.content.forEach((block, index) => {
        this.events.append({
          sessionId,
          type: "assistant/chunk",
          payload: { messageId: message.id, index, delta: block },
          timestamp: iso(message.createdAt),
        });
      });
      this.events.append({
        sessionId,
        type: "step/end",
        payload: { messageId: message.id },
        timestamp: iso(message.createdAt),
      });
    }
    // system 等其他角色：事件词汇暂缺，仅落旧存储
    seen.add(message.id);
  }

  /** sessionId → 已落事件 messageId 集合（懒加载自重放） */
  private seenIds(sessionId: string): Set<string> {
    let set = this.seenMessages.get(sessionId);
    if (!set) {
      set = new Set<string>();
      for (const ev of this.events.replay(sessionId)) {
        if (
          ev.type === "user/message" ||
          ev.type === "step/start" ||
          ev.type === "assistant/message"
        ) {
          set.add(ev.payload.messageId);
        }
      }
      this.seenMessages.set(sessionId, set);
    }
    return set;
  }
}
