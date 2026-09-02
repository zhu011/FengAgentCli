/**
 * @fengagent/web-ui — use-session hook
 *
 * 会话管理：创建、切换、列表、消息发送、中断、权限响应。
 * 内部组合 use-sse 的 consumeSSEStream 进行 SSE 流消费。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import type {
  AgentEvent,
  GraphData,
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
  /** 入参是否被用户在审批环节人工修改后执行（human-in-the-loop） */
  edited?: boolean;
}

/** 前端展示用的消息项（含工具调用列表） */
/** Token 用量统计 */
export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** 思考过程内容（流式增量累积；历史消息从 thinking 块提取） */
  thinking: string;
  toolCalls: ToolCallInfo[];
  streaming: boolean;
  createdAt: number;
  /** AI 消息的 token 用量统计 */
  tokenStats?: TokenStats;
}

export interface UseSessionResult {
  sessions: SessionMeta[];
  activeSession: Session | null;
  activeMessages: DisplayMessage[];
  pendingPermissions: PermissionRequest[];
  isStreaming: boolean;
  error: string | null;
  creatingSession: boolean;
  /** 会话级 token 用量统计 */
  sessionTokenStats: TokenStats | null;
  /** 对话图数据（Phase 3/4 分支可视化） */
  graph: GraphData | null;
  graphError: string | null;
  createSession: (title?: string) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  sendMessage: (text: string, model?: string) => Promise<void>;
  interrupt: () => Promise<void>;
  respondPermission: (
    reqId: string,
    result: { decision: "allow"; input?: unknown } | { decision: "deny"; reason?: string },
  ) => Promise<void>;
  refreshSession: () => Promise<void>;
  refreshGraph: () => Promise<void>;
  rollback: (nodeId?: string, reason?: string) => Promise<void>;
  /** 回退到目标节点并自动重答（SSE 流；图面板「回退并重答」闭环） */
  rollbackRetry: (nodeId?: string, reason?: string) => Promise<void>;
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
  const [sessionTokenStats, setSessionTokenStats] = useState<TokenStats | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);

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
      setGraph(null);
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

  // 加载活跃会话的对话图（Phase 3/4 分支可视化）
  const refreshGraph = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      setGraph(null);
      return;
    }
    try {
      const data = await client.getGraph(sessionId);
      setGraph(data);
      setGraphError(null);
    } catch (err) {
      setGraph(null);
      setGraphError(
        err instanceof Error ? err.message : "Failed to load graph",
      );
    }
  }, [client]);

  useEffect(() => {
    void refreshGraph();
  }, [refreshGraph, activeSessionId]);

  // 重新拉取活跃会话详情（回退后刷新消息列表）
  const refreshSession = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    try {
      const session = await client.getSession(sessionId);
      setActiveSession(session);
      setDisplayMessages(sessionToDisplayMessages(session));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reload session");
    }
  }, [client]);

  // 回退到目标节点（旧分支保留可溯源），随后刷新会话与图
  const rollback = useCallback(
    async (nodeId?: string, reason = "用户回退") => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return;
      try {
        const result = await client.rollbackSession(sessionId, nodeId, reason);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        await refreshSession();
        await refreshGraph();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Rollback failed");
      }
    },
    [client, refreshSession, refreshGraph],
  );

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
    setSessionTokenStats(null);
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

  // 重命名会话：同步更新列表与活跃会话标题（侧边栏双击 / 顶栏编辑）
  const renameSession = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      try {
        const updated = await client.renameSession(id, trimmed);
        setSessions((prev) =>
          prev.map((s) =>
            s.id === id ? { ...s, title: updated.title, updatedAt: updated.updatedAt } : s,
          ),
        );
        setActiveSession((prev) =>
          prev && prev.id === id ? { ...prev, title: updated.title, updatedAt: updated.updatedAt } : prev,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to rename session");
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
        thinking: "",
        toolCalls: [],
        streaming: false,
        createdAt: Date.now(),
      };
      setDisplayMessages((prev) => [...prev, userMsg]);

      // 流式状态（闭包内追踪；与 rollbackRetry 共用同一套 handleTurnEvent 渲染逻辑）
      const streamingText = new Map<string, string>();
      const streamingThinking = new Map<string, string>();
      const messageToolCalls = new Map<string, ToolCallInfo[]>();
      // toolUseId → 所属 assistant 消息 id。
      // 关键：loop 的事件顺序是 message-end 之后才执行工具并发出 tool-call-result，
      // 届时 currentMessageId 已被 message-end 置空；必须用独立映射关联工具结果，
      // 否则 tool-call-result 永远匹配不到消息，工具卡片停留在 "running"（转圈）不消失。
      const toolUseToMessageId = new Map<string, string>();
      const streamCtx: TurnStreamCtx = {
        streamingText,
        streamingThinking,
        messageToolCalls,
        toolUseToMessageId,
        currentMessageId: { value: null },
        setDisplayMessages,
        setError,
        setSessionTokenStats,
      };

      try {
        for await (const event of client.sendMessage({
          sessionId,
          content: text,
          ...(model ? { model } : {}),
          signal: controller.signal,
        })) {
          firstEventReceived = true; // 收到任意事件，取消超时
          handleTurnEvent(event, streamCtx);
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : "Streaming failed");
        }
      } finally {
        clearTimeout(timeoutTimer);
        setIsStreaming(false);
        abortRef.current = null;
        toolUseToMessageId.clear();
        // 安全清理：标记所有消息为非流式 + 复位仍 running 的工具调用
        // （覆盖中断/超时/流异常终止：未收到 tool-call-result 的子项不再转圈）
        setDisplayMessages((prev) => {
          const nonStreaming = prev.map((m) =>
            m.streaming ? { ...m, streaming: false } : m,
          );
          return markRunningToolCallsFailed(nonStreaming);
        });
        void refreshSessions();
      }
    },
    [client, refreshSessions],
  );

  /**
   * 回退到目标节点并自动重答（WebUI 图面板「回退并重答」闭环）。
   *
   * 与 CLI /rollback <节点id> 语义一致：服务端回退（旧分支作废保留、会话截断）后
   * 立即自动重新回答；SSE 流首帧 session-start 携带回退后的会话，客户端据此重建
   * 消息列表，随后按常规轮次流式渲染新回答。
   */
  const rollbackRetry = useCallback(
    async (nodeId?: string, reason = "用户回退并重答") => {
      const sessionId = activeSessionIdRef.current;
      // 已有流式任务在跑（sendMessage / 上一次 rollbackRetry）时拒绝重复操作
      if (!sessionId || abortRef.current) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);
      setError(null);

      // 超时兜底：30s 无任何 SSE 事件 → abort（回退/重答服务不可用时防止永久挂起）
      let firstEventReceived = false;
      const timeoutTimer = setTimeout(() => {
        if (!firstEventReceived) {
          controller.abort();
          setError("回退重答超时（30s 无响应），请检查后端服务是否正常启动。");
        }
      }, 30_000);

      const streamingText = new Map<string, string>();
      const streamingThinking = new Map<string, string>();
      const messageToolCalls = new Map<string, ToolCallInfo[]>();
      const toolUseToMessageId = new Map<string, string>();
      const streamCtx: TurnStreamCtx = {
        streamingText,
        streamingThinking,
        messageToolCalls,
        toolUseToMessageId,
        currentMessageId: { value: null },
        setDisplayMessages,
        setError,
        setSessionTokenStats,
        // 回退后的首帧 session-start：用截断后的会话重建消息列表（被回退的旧轮次消失）
        onSessionStart: (sess) => {
          setActiveSession(sess);
          setDisplayMessages(sessionToDisplayMessages(sess));
        },
      };

      try {
        for await (const event of client.rollbackRetry(
          sessionId,
          nodeId,
          reason,
          controller.signal,
        )) {
          firstEventReceived = true;
          handleTurnEvent(event, streamCtx);
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : "Rollback retry failed");
        }
      } finally {
        clearTimeout(timeoutTimer);
        setIsStreaming(false);
        abortRef.current = null;
        toolUseToMessageId.clear();
        setDisplayMessages((prev) => {
          const nonStreaming = prev.map((m) =>
            m.streaming ? { ...m, streaming: false } : m,
          );
          return markRunningToolCallsFailed(nonStreaming);
        });
        void refreshSessions();
        void refreshGraph();
      }
    },
    [client, refreshSessions, refreshGraph],
  );

  const interrupt = useCallback(async () => {
    // 始终清除 streaming 状态，不依赖 abort 副作用
    abortRef.current?.abort();
    setIsStreaming(false);
    // 安全清理：标记所有消息为非流式 + 复位 running 工具调用（中断后不再转圈）
    setDisplayMessages((prev) => {
      const nonStreaming = prev.map((m) =>
        m.streaming ? { ...m, streaming: false } : m,
      );
      return markRunningToolCallsFailed(nonStreaming);
    });
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
      result:
        | { decision: "allow"; input?: unknown }
        | { decision: "deny"; reason?: string },
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

  // 权限审批轮询：流式执行期间（工具 ask / 入参校验失败会阻塞 loop 等待人工决策）
  // 周期拉取待处理权限请求，让人工审批卡片（含可编辑入参）实时出现在检查器面板。
  useEffect(() => {
    if (!activeSessionId || !isStreaming) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const pending = await client.getPendingPermissions(activeSessionId);
        if (cancelled) return;
        setPendingPermissions((prev) => {
          const known = new Set(prev.map((p) => p.reqId));
          const merged = [...prev];
          for (const req of pending) {
            if (!known.has(req.reqId)) merged.push(req);
          }
          return merged;
        });
      } catch {
        // 轮询失败静默（下次周期重试）
      }
    };
    void poll();
    const timer = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, activeSessionId, isStreaming]);

  return {
    sessions,
    activeSession,
    activeMessages: displayMessages,
    pendingPermissions,
    isStreaming,
    error,
    creatingSession,
    sessionTokenStats,
    graph,
    graphError,
    createSession,
    selectSession,
    deleteSession,
    renameSession,
    sendMessage,
    interrupt,
    respondPermission,
    refreshSession,
    refreshGraph,
    rollback,
    rollbackRetry,
  };
}

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

/**
 * 单次 SSE 轮次（sendMessage / rollbackRetry 共用）的流式渲染上下文。
 *
 * 流式状态与消息列表更新被抽成 handleTurnEvent，两条链路（发送新消息 /
 * 回退后自动重答）共用同一套「message-start → text-delta → tool-call → result →
 * message-end」渲染逻辑，避免行为分叉。
 */
interface TurnStreamCtx {
  streamingText: Map<string, string>;
  streamingThinking: Map<string, string>;
  messageToolCalls: Map<string, ToolCallInfo[]>;
  toolUseToMessageId: Map<string, string>;
  /** message-end 会把当前消息 id 置空；工具结果在 message-end 之后到达，须用独立映射关联 */
  currentMessageId: { value: string | null };
  /** session-start 处理（默认无操作；rollbackRetry 用它重建回退截断后的消息列表） */
  onSessionStart?: (session: Session) => void;
  setDisplayMessages: React.Dispatch<React.SetStateAction<DisplayMessage[]>>;
  setError: (message: string | null) => void;
  setSessionTokenStats: React.Dispatch<React.SetStateAction<TokenStats | null>>;
}

/** 处理单个 AgentEvent — 流式渲染（sendMessage / rollbackRetry 共用） */
function handleTurnEvent(event: AgentEvent, ctx: TurnStreamCtx): void {
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

  switch (event.type) {
    case "session-start": {
      // rollbackRetry：首帧 session-start 携带回退截断后的会话 → 重建消息列表
      ctx.onSessionStart?.(event.session);
      break;
    }

    case "message-start": {
      currentMessageId.value = event.messageId;
      // 创建 assistant 消息占位
      setDisplayMessages((prev) => {
        if (prev.some((m) => m.id === event.messageId)) return prev;
        return [
          ...prev,
          {
            id: event.messageId,
            role: event.role,
            text: "",
            thinking: "",
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
        prev.map((m) => (m.id === id ? { ...m, text: accumulated } : m)),
      );
      break;
    }

    case "thinking-delta": {
      // 思考过程内容 — 流式累积，前端可实时展示（展开/折叠）
      const id = event.messageId;
      const accumulated =
        (streamingThinking.get(id) ?? "") + event.text;
      streamingThinking.set(id, accumulated);
      setDisplayMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, thinking: accumulated } : m)),
      );
      break;
    }

    case "tool-call-start": {
      // 工具调用归属于当前正在生成的 assistant 消息
      const msgId = currentMessageId.value;
      if (!msgId) break;
      toolUseToMessageId.set(event.toolUseId, msgId);
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
      // 按 toolUseId → 消息 映射定位归属（message-end 已把 currentMessageId 置空，
      // 工具结果在其后到达，不能再用 currentMessageId 关联）
      const msgId =
        toolUseToMessageId.get(event.toolUseId) ?? currentMessageId.value;
      toolUseToMessageId.delete(event.toolUseId);
      if (!msgId) break;
      const calls = messageToolCalls.get(msgId) ?? [];
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
          m.id === event.messageId ? { ...m, streaming: false } : m,
        ),
      );
      streamingText.delete(event.messageId);
      streamingThinking.delete(event.messageId);
      currentMessageId.value = null;
      break;
    }

    case "error": {
      setError(event.error.message);
      break;
    }

    // turn-end / session-end — 兜底清理：确保所有消息标记为非流式
    // （防止 message-end 未到达时 streaming: true 永不消除）；
    // 同时复位仍处于 running 的工具调用（loop 终止/出错时不再转圈）
    case "turn-end":
    case "session-end": {
      if (currentMessageId.value) {
        setDisplayMessages((prev) =>
          prev.map((m) =>
            m.id === currentMessageId.value ? { ...m, streaming: false } : m,
          ),
        );
        streamingText.delete(currentMessageId.value);
        streamingThinking.delete(currentMessageId.value);
        currentMessageId.value = null;
      }
      // 安全清理：标记所有消息为非流式 + 复位 running 工具调用
      setDisplayMessages((prev) => {
        const nonStreaming = prev.map((m) =>
          m.streaming ? { ...m, streaming: false } : m,
        );
        return markRunningToolCallsFailed(nonStreaming);
      });
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
      // 附加到当前 assistant 消息
      if (currentMessageId.value) {
        setDisplayMessages((prev) =>
          prev.map((m) =>
            m.id === currentMessageId.value
              ? { ...m, tokenStats: usageStats }
              : m,
          ),
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
 * 将仍处于 running 的工具调用复位为 failed。
 *
 * loop 正常收尾时每个 tool-call-start 都有对应的 tool-call-result（completed/failed），
 * 不会有 running 残留；running 残留只出现在异常终止路径（死循环防护/LLM 错误/中断/
 * 超时/连接断开），此时把子项从「转圈」复位为明确的失败态。
 */
function markRunningToolCallsFailed(messages: DisplayMessage[]): DisplayMessage[] {
  return messages.map((m) => {
    if (!m.toolCalls.some((tc) => tc.status === "running")) return m;
    return {
      ...m,
      toolCalls: m.toolCalls.map((tc) =>
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
      ),
    };
  });
}

/** 将 Session 转换为 DisplayMessage 列表 */
function sessionToDisplayMessages(session: Session): DisplayMessage[] {
  // 工具结果块位于独立的 user 消息中（loop 将工具结果作为 user 消息加入历史），
  // 先全量收集 toolUseId → 结果 映射，再在助手消息里关联 tool-use 块，
  // 否则重载历史时工具卡片永远拿不到结果（也无法区分成功/失败）。
  const toolResults = new Map<string, { content: string; isError?: boolean }>();
  for (const msg of session.messages) {
    for (const block of msg.content) {
      if (block.type === "tool-result") {
        toolResults.set(block.toolUseId, {
          content: block.content,
          isError: block.isError,
        });
      }
    }
  }

  return session.messages.map((msg) => {
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
      id: msg.id,
      role: msg.role,
      text,
      thinking,
      toolCalls,
      streaming: false,
      createdAt: msg.createdAt,
    };
  });
}
