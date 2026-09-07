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
import {
  sessionToTurnMessages,
  type DisplayMessage,
  type DisplayStep,
  type TokenStats,
  type ToolCallInfo,
} from "../lib/turn-messages.ts";

// 兼容导出：展示类型统一定义在 lib/turn-messages.ts（纯函数层，可单测）
export type { DisplayMessage, DisplayStep, TokenStats, ToolCallInfo };

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
        setDisplayMessages(sessionToTurnMessages(session.messages));
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
      setDisplayMessages(sessionToTurnMessages(session.messages));
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
    // 切换会话时中止当前 SSE 流（如有），避免旧会话的流式事件污染新会话 UI
    if (id !== activeSessionIdRef.current) {
      abortRef.current?.abort();
      abortRef.current = null;
      setIsStreaming(false);
    }
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
        // AGE-29：同一轮提问的多段助手步骤聚合进同一个回复气泡
        turnRowId: { value: null },
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
        // 安全清理：关闭所有流式行/步骤 + 复位仍 running 的工具调用
        // （覆盖中断/超时/流异常终止：未收到 tool-call-result 的子项不再转圈）
        setDisplayMessages((prev) =>
          markRunningToolCallsFailed(closeOpenTurns(prev)),
        );
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
        // AGE-29：同一轮提问的多段助手步骤聚合进同一个回复气泡
        turnRowId: { value: null },
        setDisplayMessages,
        setError,
        setSessionTokenStats,
        // 回退后的首帧 session-start：用截断后的会话重建消息列表（被回退的旧轮次消失）
        onSessionStart: (sess) => {
          setActiveSession(sess);
          setDisplayMessages(sessionToTurnMessages(sess.messages));
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
        setDisplayMessages((prev) =>
          markRunningToolCallsFailed(closeOpenTurns(prev)),
        );
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
    // 安全清理：关闭所有流式行/步骤 + 复位 running 工具调用（中断后不再转圈）
    setDisplayMessages((prev) =>
      markRunningToolCallsFailed(closeOpenTurns(prev)),
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
 *
 * AGE-29：一次提问在底层消息里会包含多段助手步骤（工具调用步骤 + 最终文字），
 * 这些步骤被聚合进同一个助手气泡（turnRowId 指向该聚合行；每步以 messageId
 * 定位更新），工具结果不产生独立气泡。
 */
interface TurnStreamCtx {
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
function markRunningToolCallsFailed(messages: DisplayMessage[]): DisplayMessage[] {
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
function closeOpenTurns(messages: DisplayMessage[]): DisplayMessage[] {
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

/** 更新指定行内指定步骤（按步骤 messageId 定位）；找不到行/步骤返回原数组 */
function updateStepInRow(
  prev: DisplayMessage[],
  rowId: string,
  stepMessageId: string,
  update: (step: DisplayStep) => DisplayStep,
): DisplayMessage[] {
  return prev.map((m) => {
    if (m.id !== rowId || !m.steps) return m;
    let touched = false;
    const steps = m.steps.map((s) => {
      if (s.messageId !== stepMessageId) return s;
      touched = true;
      return update(s);
    });
    if (!touched) return m;
    return { ...m, ...recomputeAggregates(steps, m), steps };
  });
}
