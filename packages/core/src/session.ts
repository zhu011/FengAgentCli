/**
 * @fengagent/core — Session 类型定义
 *
 * Session、SessionState。
 */

import type { Message } from "./types.ts";

/** 会话状态 */
export type SessionState = "idle" | "running" | "error";

/** 会话（完整对话上下文） */
export interface Session {
  id: string;
  title: string;
  messages: Message[];
  model: string;
  createdAt: number;
  updatedAt: number;
  status: SessionState;
  tokenCount: number;
  /** 归属的智能体 id（P0；缺省 = 不属于任何智能体，运行历史里不出现） */
  agentId?: string;
}

/** 会话元信息（列表展示用，不含消息体） */
export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  status: SessionState;
  tokenCount: number;
  createdAt: number;
  updatedAt: number;
  /** 归属的智能体 id（P0） */
  agentId?: string;
}

/** 创建新会话的工厂 */
export function createSession(
  model: string,
  title = "New Session",
  agentId?: string,
): Session {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title,
    messages: [],
    model,
    createdAt: now,
    updatedAt: now,
    status: "idle",
    tokenCount: 0,
    ...(agentId === undefined || agentId === "" ? {} : { agentId }),
  };
}

/** 从 Session 提取元信息 */
export function toSessionMeta(session: Session): SessionMeta {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    status: session.status,
    tokenCount: session.tokenCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
  };
}
