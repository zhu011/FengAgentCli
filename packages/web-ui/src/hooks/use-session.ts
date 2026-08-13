/**
 * @fengagent/web-ui — use-session hook
 *
 * 会话管理：创建、切换、列表、消息发送、中断、权限响应。
 * 内部组合 use-sse 的 consumeSSEStream 进行 SSE 流消费。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { consumeSSEStream } from "./use-sse.ts";
import type {
  PermissionRequest,
  Session,
  SessionMeta,
} from "../api/types.ts";

/** 前端展示用的工具调用信息 */
export interface ToolCallInfo {
  toolUseId: string;
  name: string;
  input: unknown;
  result?: { content: string; isError?: boolean };
  status: "running" | "completed" | "failed";
}

/** 前端展示用的消息项（含工具调用列表） */
export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  toolCalls: ToolCallInfo[];
  streaming: boolean;
  createdAt: number;
}

export interface UseSessionResult {
  sessions: SessionMeta[];
  activeSession: Session | null;
  activeMessages: DisplayMessage[];
  pendingPermissions: PermissionRequest[];
  isStreaming: boolean;
  error: string | null;
  creatingSession: boolean;
  createSession: (title?: string) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  sendMessage: (text: string, model?: string) => Promise<void>;
  interrupt: () => Promise<void>;
  respondPermission: (
    reqId: string,
    result: { decision: "allow" } | { decision: "deny"; reason?: string },
  ) => Promise<void>;
}

export function useSession(client: ApiClient): UseSessionResult {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<
    PermissionRequest[]
  >([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // 用 ref 存储最新 activeSessionId，避免闭包陈旧问题
  const activeSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // ──────────────────────────────────────────────
  // 初始化：加载会话列表
  // ──────────────────────────────────────────────
  const refreshSessions = useCallback(async () => {
    try {
      const list = await client.listSessions();
      setSessions(list);
      setActiveSessionId((current) => current ?? (list[0]?.id ?? null));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    }
  }, [client]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // ──────────────────────────────────────────────
  // 加载活跃会话详情
  // ──────────────────────────────────────────────
  useEffect(() => {
    if (!activeSessionId) {
      setActiveSession(null);
      setDisplayMessages([]);
      return;
    }

    let cancelled = false;
    client
      .getSession(activeSessionId)
      .then((session) => {
        if (cancelled) return;
        setActiveSession(session);
        setDisplayMessages(sessionToDisplayMessages(session));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load session",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [client, activeSessionId]);

  // ──────────────────────────────────────────────
  // 创建会话
  // ──────────────────────────────────────────────
  const createSession = useCallback(
    async (title?: string) => {
      setCreatingSession(true);
      setError(null);
      try {
        const session = await client.createSession({ title });
        setSessions((prev) => [
          {
            id: session.id,
            title: session.title,
            model: session.model,
            status: session.status,
            tokenCount: session.tokenCount,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          },
          ...prev,
        ]);
        setActiveSessionId(session.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create session");
      } finally {
        setCreatingSession(false);
      }
    },
    [client],
  );

  const selectSession = useCallback(async (id: string) => {
    setActiveSessionId(id);
    setPendingPermissions([]);
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await client.deleteSession(id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (activeSessionIdRef.current === id) {
          setActiveSessionId(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete session");
      }
    },
    [client],
  );

  // ──────────────────────────────────────────────
  // 发送消息（SSE 流消费）
  // ──────────────────────────────────────────────
  const sendMessage = useCallback(
    async (text: string, model?: string) => {
      // 使用 ref 读取最新 activeSessionId，避免闭包陈旧
      let sessionId = activeSessionIdRef.current;

      // 无活跃会话时自动创建
      if (!sessionId) {
        setCreatingSession(true);
        setError(null);
        try {
          const newSession = await client.createSession({});
          setSessions((prev) => [
            {
              id: newSession.id,
              title: newSession.title,
              model: newSession.model,
              status: newSession.status,
              tokenCount: newSession.tokenCount,
              createdAt: newSession.createdAt,
              updatedAt: newSession.updatedAt,
            },
            ...prev,
          ]);
          setActiveSessionId(newSession.id);
          activeSessionIdRef.current = newSession.id;
          sessionId = newSession.id;

          // 设置 activeSession 以让 UI 立即显示输入框
          setActiveSession(newSession);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to create session");
          setCreatingSession(false);
          return;
        }
        setCreatingSession(false);
      }

      if (!sessionId || !text.trim()) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);
      setError(null);

      // 超时兜底：30s 无任何 SSE 事件 → abort（防止后端未启动时永久挂起）
      let firstEventReceived = false;
      const timeoutTimer = setTimeout(() => {
        if (!firstEventReceived) {
          controller.abort();
          setError("请求超时（30s 无响应），请检查后端服务是否正常启动。");
        }
      }, 30_000);

      // 立即添加用户消息到 UI
      // crypto.randomUUID 在非安全上下文（http://192.168.x.x）下不可用，需要 fallback
      const genId = () => {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
          return crypto.randomUUID();
        }
        return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      };
      const userMsg: DisplayMessage = {
        id: genId(),
        role: "user",
        text,
        toolCalls: [],
        streaming: false,
        createdAt: Date.now(),
      };
      setDisplayMessages((prev) => [...prev, userMsg]);

      // 流式状态（闭包内追踪）
      const streamingText = new Map<string, string>();
      const messageToolCalls = new Map<string, ToolCallInfo[]>();
      let currentMessageId: string | null = null;

      try {
        await consumeSSEStream(client, sessionId, text, controller.signal, {
          onEvent: (event) => {
            firstEventReceived = true; // 收到任意事件，取消超时
            switch (event.type) {
              case "message-start": {
                currentMessageId = event.messageId;
                // 创建 assistant 消息占位
                setDisplayMessages((prev) => {
                  if (prev.some((m) => m.id === event.messageId)) return prev;
                  return [
                    ...prev,
                    {
                      id: event.messageId,
                      role: event.role,
                      text: "",
                      toolCalls: [],
                      streaming: true,
                      createdAt: Date.now(),
                    },
                  ];
                });
                break;
              }

              case "text-delta": {
                const id = event.messageId;
                const accumulated = (streamingText.get(id) ?? "") + event.text;
                streamingText.set(id, accumulated);
                setDisplayMessages((prev) =>
                  prev.map((m) =>
                    m.id === id ? { ...m, text: accumulated } : m,
                  ),
                );
                break;
              }

              case "tool-call-start": {
                // 工具调用归属于当前正在生成的 assistant 消息
                const msgId = currentMessageId;
                if (!msgId) break;
                const calls = messageToolCalls.get(msgId) ?? [];
                calls.push({
                  toolUseId: event.toolUseId,
                  name: event.name,
                  input: event.input,
                  status: "running",
                });
                messageToolCalls.set(msgId, calls);
                setDisplayMessages((prev) =>
                  prev.map((m) =>
                    m.id === msgId ? { ...m, toolCalls: [...calls] } : m,
                  ),
                );
                break;
              }

              case "tool-call-result": {
                const msgId = currentMessageId;
                if (!msgId) break;
                const calls = messageToolCalls.get(msgId) ?? [];
                const idx = calls.findIndex(
                  (c) => c.toolUseId === event.toolUseId,
                );
                if (idx !== -1) {
                  const existing = calls[idx];
                  if (existing) {
                    calls[idx] = {
                      toolUseId: existing.toolUseId,
                      name: existing.name,
                      input: existing.input,
                      result: event.result,
                      status: event.result.isError ? "failed" : "completed",
                    };
                    messageToolCalls.set(msgId, calls);
                    setDisplayMessages((prev) =>
                      prev.map((m) =>
                        m.id === msgId ? { ...m, toolCalls: [...calls] } : m,
                      ),
                    );
                  }
                }
                break;
              }

              case "message-end": {
                setDisplayMessages((prev) =>
                  prev.map((m) =>
                    m.id === event.messageId
                      ? { ...m, streaming: false }
                      : m,
                  ),
                );
                streamingText.delete(event.messageId);
                currentMessageId = null;
                break;
              }

              case "error": {
                setError(event.error.message);
                break;
              }

              // turn-end / session-end — 兜底清理：确保所有消息标记为非流式
              // （防止 message-end 未到达时 streaming: true 永不消除）
              case "turn-end":
              case "session-end": {
                if (currentMessageId) {
                  setDisplayMessages((prev) =>
                    prev.map((m) =>
                      m.id === currentMessageId ? { ...m, streaming: false } : m,
                    ),
                  );
                  streamingText.delete(currentMessageId);
                  currentMessageId = null;
                }
                // 安全清理：标记所有消息为非流式
                setDisplayMessages((prev) =>
                  prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
                );
                break;
              }

              case "session-start":
              case "usage":
              case "compaction-start":
              case "compaction-end":
                break;
            }
          },
          onError: (err) => {
            setError(err.message);
          },
        }, model);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : "Streaming failed");
        }
      } finally {
        clearTimeout(timeoutTimer);
        setIsStreaming(false);
        abortRef.current = null;
        // 安全清理：标记所有消息为非流式
        setDisplayMessages((prev) =>
          prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        );
        void refreshSessions();
      }
    },
    [client, refreshSessions],
  );

  const interrupt = useCallback(async () => {
    // 始终清除 streaming 状态，不依赖 abort 副作用
    abortRef.current?.abort();
    setIsStreaming(false);
    // 安全清理：标记所有消息为非流式
    setDisplayMessages((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    );
    // 使用 ref 读取最新 sessionId
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    try {
      await client.interrupt(sessionId);
    } catch {
      // 忽略中断错误
    }
  }, [client]);

  const respondPermission = useCallback(
    async (
      reqId: string,
      result: { decision: "allow" } | { decision: "deny"; reason?: string },
    ) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return;
      setPendingPermissions((prev) =>
        prev.filter((p) => p.reqId !== reqId),
      );
      try {
        await client.respondPermission(sessionId, reqId, result);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to respond permission",
        );
      }
    },
    [client],
  );

  return {
    sessions,
    activeSession,
    activeMessages: displayMessages,
    pendingPermissions,
    isStreaming,
    error,
    creatingSession,
    createSession,
    selectSession,
    deleteSession,
    sendMessage,
    interrupt,
    respondPermission,
  };
}

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

/** 将 Session 转换为 DisplayMessage 列表 */
function sessionToDisplayMessages(session: Session): DisplayMessage[] {
  return session.messages.map((msg) => {
    let text = "";
    const toolCalls: ToolCallInfo[] = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool-use") {
        toolCalls.push({
          toolUseId: block.id,
          name: block.name,
          input: block.input,
          status: "completed",
        });
      } else if (block.type === "tool-result") {
        const idx = toolCalls.findIndex(
          (c) => c.toolUseId === block.toolUseId,
        );
        if (idx !== -1) {
          const tc = toolCalls[idx];
          if (tc) {
            tc.result = {
              content: block.content,
              isError: block.isError,
            };
          }
        }
      }
    }

    return {
      id: msg.id,
      role: msg.role,
      text,
      toolCalls,
      streaming: false,
      createdAt: msg.createdAt,
    };
  });
}
