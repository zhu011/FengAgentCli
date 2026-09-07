/**
 * @fengagent/web-ui — use-session hook
 *
 * 会话管理：创建、切换、列表、消息发送、中断、权限响应。
 * 内部组合 ApiClient 的 SSE 流消费。
 *
 * 并发模型（AGE-29 真后台重做）：**会话间真并发 + 消息隔离**。
 * - 每个会话拥有独立的展示状态（消息列表 / streaming 标志 / 计时锚点 /
 *   权限请求 / 流 AbortController），互不覆盖；
 * - 会话 A 生成中切换/新建会话 B：A 的后台运行**不中止**，其 SSE 流在 App 层
 *   继续消费并写入 A 自己的状态 —— 切回 A 即可看到最新进度；
 * - SSE 事件按会话路由：A 的事件只进 A 的状态，绝不写入 B（隔离）；
 * - 中止只发生在用户显式中断（Esc / 停止按钮）：仅中止「当前会话」的流并
 *   通知服务端中断该会话的后台任务；
 * - 服务端运行与连接解耦：本页刷新 / 断线后，重新进入仍在运行的会话会自动
 *   订阅其事件流（GET /:id/events，含回放），继续看到进度。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type TokenStats,
} from "../lib/turn-messages.ts";
// 流式渲染状态机（纯函数层，可单测）— 兼容导出见文件底部
import {
  closeOpenTurns,
  createTurnStreamCtx,
  handleTurnEvent,
  markRunningToolCallsFailed,
} from "../lib/turn-stream.ts";

// 兼容导出：展示类型统一定义在 lib/turn-messages.ts（纯函数层，可单测）
export type {
  DisplayMessage,
  DisplayStep,
  TokenStats,
  ToolCallInfo,
} from "../lib/turn-messages.ts";
export type {
  SetDisplayMessages,
  TurnStreamCtx,
} from "../lib/turn-stream.ts";

/** 单个会话的独立展示状态（会话间并发 + 隔离的核心数据结构） */
interface SessionViewData {
  /** 最新会话快照（含持久化消息） */
  session: Session | null;
  /** 该会话的展示消息（流式渲染 / 持久化消息均可） */
  messages: DisplayMessage[];
  /** 该会话是否正在生成（后台会话同样为 true） */
  isStreaming: boolean;
  /** 该会话当前这轮生成的开始时间戳（App 级锚点，跨 view/切换存活） */
  runStartedAt: number | null;
  /** 该会话的 token 用量统计 */
  sessionTokenStats: TokenStats | null;
  /** 该会话的待处理权限请求 */
  pendingPermissions: PermissionRequest[];
  /** 该会话当前流的 AbortController（null = 无活跃流） */
  controller: AbortController | null;
  /** 后台运行期间产生的错误（切回该会话时展示） */
  lastError: string | null;
}

const EMPTY_VIEW: SessionViewData = {
  session: null,
  messages: [],
  isStreaming: false,
  runStartedAt: null,
  sessionTokenStats: null,
  pendingPermissions: [],
  controller: null,
  lastError: null,
};

/** 内部 run-end 帧（服务端后台泵送结束标记；非 AgentEvent 成员） */
const isRunEnd = (ev: AgentEvent): boolean =>
  (ev as { type?: string }).type === "run-end";

export interface UseSessionResult {
  sessions: SessionMeta[];
  activeSession: Session | null;
  activeMessages: DisplayMessage[];
  pendingPermissions: PermissionRequest[];
  isStreaming: boolean;
  error: string | null;
  /**
   * 当前（活跃）会话这轮生成的开始时间戳（App 级锚点）。
   *
   * 锚点存在每个会话自己的状态里：切换会话 / 切到评测观测页再回来不会归零；
   * 新的一轮生成（sendMessage / rollbackRetry）开始才重置。
   */
  runStartedAt: number | null;
  /** 后台继续提示（切换/新建会话时告知原会话仍在后台运行，数秒后消失） */
  interruptNotice: string | null;
  /** 正在后台运行的会话 id 集合（侧边栏显示运行指示） */
  runningSessionIds: ReadonlySet<string>;
  creatingSession: boolean;
  /** 活跃会话的 token 用量统计 */
  sessionTokenStats: TokenStats | null;
  /** 活跃会话的对话图数据（Phase 3/4 分支可视化） */
  graph: GraphData | null;
  graphError: string | null;
  createSession: (title?: string) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  /** 向当前活跃会话发送消息（不影响其它会话的后台运行） */
  sendMessage: (text: string, model?: string) => Promise<void>;
  /** 中止当前活跃会话的生成（Esc / 停止按钮） */
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
  /** sessionId → 会话独立状态（并发运行的核心：各会话互不覆盖） */
  const [views, setViews] = useState<Record<string, SessionViewData>>({});
  const [error, setError] = useState<string | null>(null);
  const [interruptNotice, setInterruptNotice] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);

  // views 的同步镜像（事件回调在渲染外读写，需立即可见的当前值）
  const viewsRef = useRef<Record<string, SessionViewData>>({});
  // 用 ref 存储最新 activeSessionId，避免闭包陈旧问题
  const activeSessionIdRef = useRef<string | null>(null);

  const activeView: SessionViewData = activeSessionId
    ? (views[activeSessionId] ?? EMPTY_VIEW)
    : EMPTY_VIEW;
  const activeSession = activeView.session;
  const activeMessages = activeView.messages;
  const isStreaming = activeView.isStreaming;
  const runStartedAt = activeView.runStartedAt;
  const sessionTokenStats = activeView.sessionTokenStats;
  const pendingPermissions = activeView.pendingPermissions;

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  /** 更新某会话的独立状态（同步更新 ref 镜像，供无渲染上下文读取） */
  const patchView = useCallback(
    (
      sessionId: string,
      patch:
        | Partial<SessionViewData>
        | ((prev: SessionViewData) => SessionViewData),
    ) => {
      const cur = viewsRef.current[sessionId] ?? EMPTY_VIEW;
      const next =
        typeof patch === "function" ? patch(cur) : { ...cur, ...patch };
      if (cur === next) return;
      const out = { ...viewsRef.current, [sessionId]: next };
      viewsRef.current = out;
      setViews(out);
    },
    [],
  );

  /** 更新某会话的消息列表（SetStateAction 风格，兼容 handleTurnEvent） */
  const patchViewMessages = useCallback(
    (
      sessionId: string,
      updater:
        | DisplayMessage[]
        | ((prev: DisplayMessage[]) => DisplayMessage[]),
    ) => {
      patchView(sessionId, (v) => ({
        ...v,
        messages:
          typeof updater === "function"
            ? updater(v.messages)
            : updater,
      }));
    },
    [patchView],
  );

  // 并发中断提示数秒后自动消失（不打扰后续阅读）
  useEffect(() => {
    if (!interruptNotice) return;
    const timer = setTimeout(() => setInterruptNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [interruptNotice]);

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

  /** 正在后台运行的会话 id 集合（本端活跃流 + 服务端运行态并集） */
  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, v] of Object.entries(views)) {
      if (v.isStreaming) ids.add(id);
    }
    for (const s of sessions) {
      if (s.status === "running") ids.add(s.id);
    }
    return ids;
  }, [views, sessions]);

  /** 用服务端快照初始化/更新某会话的展示状态 */
  const applyLoadedSession = useCallback(
    (sessionId: string, session: Session) => {
      patchView(sessionId, {
        session,
        messages: sessionToTurnMessages(session.messages),
      });
    },
    [patchView],
  );

  /**
   * 订阅某会话的事件流（GET /:id/events，含回放）—— 页面刷新 / 断线重连后
   * 重新进入仍在后台运行的会话时，用它在后台继续接收该会话的进度。
   *
   * 事件全部写入该会话自己的状态（按会话路由，不污染其它会话）。
   */
  const attachToRunningSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const cur = viewsRef.current[sessionId];
      if (!cur?.session) return;
      // 已有活跃流（本地 sendMessage / 已附加）时不再重复附加
      if (cur.controller || cur.isStreaming) return;

      const controller = new AbortController();
      patchView(sessionId, {
        controller,
        isStreaming: true,
        runStartedAt: Date.now(),
      });

      // 附加用独立的流式上下文（与 sendMessage/rollbackRetry 的渲染逻辑一致）
      const streamCtx = createTurnStreamCtx({
        setDisplayMessages: (updater) =>
          patchViewMessages(sessionId, updater),
        // 回放去重：读取该会话当前展示列表，定位既有行/步骤（R1）
        readMessages: () => viewsRef.current[sessionId]?.messages ?? [],
        setError: (message) => {
          if (sessionId === activeSessionIdRef.current) setError(message);
          else patchView(sessionId, { lastError: message });
        },
        setSessionTokenStats: (updater) =>
          patchView(sessionId, (v) => ({
            ...v,
            sessionTokenStats:
              typeof updater === "function"
                ? updater(v.sessionTokenStats)
                : updater,
          })),
      });

      let naturalEnd = false;
      try {
        for await (const event of client.sessionEvents(
          sessionId,
          controller.signal,
        )) {
          if (isRunEnd(event)) {
            naturalEnd = true;
            break;
          }
          handleTurnEvent(event, streamCtx);
        }
      } catch (err) {
        // AbortError（用户显式中断）不视为错误
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          if (sessionId === activeSessionIdRef.current) {
            setError(
              err instanceof Error ? err.message : "Session events failed",
            );
          } else {
            patchView(sessionId, {
              lastError:
                err instanceof Error ? err.message : "Session events failed",
            });
          }
        }
      } finally {
        patchView(sessionId, (v) => {
          if (v.controller !== controller) return v;
          return {
            ...v,
            controller: null,
            isStreaming: false,
            runStartedAt: null,
            // 安全清理：关闭所有流式行/步骤 + 复位 running 工具调用
            messages: markRunningToolCallsFailed(closeOpenTurns(v.messages)),
          };
        });
        if (naturalEnd) {
          // 运行自然结束：拉取最终会话快照与服务端持久化对齐
          void refreshSessionView(sessionId);
        }
        void refreshSessions();
      }
    },
    [client, patchView, patchViewMessages],
  );

  /** 重新拉取某会话详情（运行结束后对齐持久化状态；流式期间跳过） */
  const refreshSessionView = useCallback(
    async (sessionId: string): Promise<void> => {
      const cur = viewsRef.current[sessionId];
      if (!cur?.session) return;
      if (cur.isStreaming || cur.controller) return; // 流式进行中不覆盖
      try {
        const session = await client.getSession(sessionId);
        patchView(sessionId, {
          session,
          messages: sessionToTurnMessages(session.messages),
        });
      } catch {
        // 静默：下次进入会话时会重新加载
      }
    },
    [client, patchView],
  );

  // ──────────────────────────────────────────────
  // 加载活跃会话详情（切换会话 / 页面刷新后首次进入）
  // ──────────────────────────────────────────────
  useEffect(() => {
    if (!activeSessionId) {
      setGraph(null);
      return;
    }
    const sessionId = activeSessionId;
    let cancelled = false;

    const cur = viewsRef.current[sessionId];
    if (!cur?.session) {
      client
        .getSession(sessionId)
        .then((session) => {
          if (cancelled) return;
          applyLoadedSession(sessionId, session);
          // 该会话在服务端仍处于运行中 → 订阅其事件流（回放 + 实时进度）
          if (session.status === "running") {
            void attachToRunningSession(sessionId);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setError(
            err instanceof Error ? err.message : "Failed to load session",
          );
        });
    } else if (cur.session.status === "running" && !cur.controller) {
      void attachToRunningSession(sessionId);
    }

    return () => {
      cancelled = true;
    };
  }, [client, activeSessionId, applyLoadedSession, attachToRunningSession]);

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
    await refreshSessionView(sessionId);
  }, [refreshSessionView]);

  // 回退到目标节点（旧分支保留可溯源），随后刷新会话与图
  const rollback = useCallback(
    async (nodeId?: string, reason = "用户回退") => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return;
      const cur = viewsRef.current[sessionId];
      if (cur?.isStreaming || cur?.controller) {
        setError("该会话正在生成中，请先中断后再回退。");
        return;
      }
      try {
        const result = await client.rollbackSession(sessionId, nodeId, reason);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        await refreshSessionView(sessionId);
        await refreshGraph();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Rollback failed");
      }
    },
    [client, refreshSessionView, refreshGraph],
  );

  // ──────────────────────────────────────────────
  // 创建会话（不中止任何后台运行）
  // ──────────────────────────────────────────────
  const createSession = useCallback(
    async (title?: string) => {
      // 真后台语义：新建对话不中止其它会话的后台生成，仅提示其仍在运行
      const prevId = activeSessionIdRef.current;
      const prevStreaming = prevId
        ? viewsRef.current[prevId]?.isStreaming
        : false;

      setCreatingSession(true);
      setError(null);
      try {
        const session = await client.createSession({ title });
        patchView(session.id, {
          session,
          messages: [],
          isStreaming: false,
          runStartedAt: null,
          sessionTokenStats: null,
          pendingPermissions: [],
          controller: null,
          lastError: null,
        });
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
        if (prevStreaming) {
          setInterruptNotice("已新建对话 —— 原对话的生成已在后台继续运行。");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create session");
      } finally {
        setCreatingSession(false);
      }
    },
    [client, patchView],
  );

  const selectSession = useCallback(
    async (id: string) => {
      if (id === activeSessionIdRef.current) return;

      // 真后台语义：切换会话不中止原会话的后台生成
      const prevId = activeSessionIdRef.current;
      if (prevId && viewsRef.current[prevId]?.isStreaming) {
        setInterruptNotice(
          "已切换到其他会话 —— 原会话的生成已在后台继续运行，可随时切回查看最新进度。",
        );
      }

      setError(null);
      setActiveSessionId(id);

      // 该会话后台运行期间产生的错误，切回时展示
      const target = viewsRef.current[id];
      if (target?.lastError) {
        setError(target.lastError);
        patchView(id, { lastError: null });
      }
    },
    [patchView],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      // 删除运行中的会话：先中断其后台任务再删除
      const cur = viewsRef.current[id];
      if (cur?.controller) {
        cur.controller.abort();
        try {
          await client.interrupt(id);
        } catch {
          // ignore
        }
      }
      try {
        await client.deleteSession(id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
        const out = { ...viewsRef.current };
        delete out[id];
        viewsRef.current = out;
        setViews(out);
        if (activeSessionIdRef.current === id) {
          setActiveSessionId(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete session");
      }
    },
    [client, patchView],
  );

  // 重命名会话：同步更新列表与会话标题（侧边栏双击 / 顶栏编辑）
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
        patchView(id, (v) =>
          v.session && v.session.id === id
            ? {
                ...v,
                session: {
                  ...v.session,
                  title: updated.title,
                  updatedAt: updated.updatedAt,
                },
              }
            : v,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to rename session");
      }
    },
    [client, patchView],
  );

  // ──────────────────────────────────────────────
  // 发送消息（SSE 流消费；目标 = 当前活跃会话）
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
          patchView(newSession.id, {
            session: newSession,
            messages: [],
            isStreaming: false,
            runStartedAt: null,
            sessionTokenStats: null,
            pendingPermissions: [],
            controller: null,
            lastError: null,
          });
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
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to create session");
          setCreatingSession(false);
          return;
        }
        setCreatingSession(false);
      }

      if (!sessionId || !text.trim()) return;

      // 同会话并发防护：该会话已有进行中的生成时拒绝重复发送。
      // 其它会话的后台运行不受影响（会话间真并发）。
      const current = viewsRef.current[sessionId];
      if (current?.controller || current?.isStreaming) {
        setError("该会话已有正在进行的生成，请等待完成或按 Esc 中断后再发送。");
        return;
      }

      const controller = new AbortController();
      patchView(sessionId, {
        controller,
        isStreaming: true,
        runStartedAt: Date.now(),
      });
      setError(null);

      // 超时兜底：30s 无任何 SSE 事件 → abort（防止后端未启动时永久挂起）
      let firstEventReceived = false;
      const timeoutTimer = setTimeout(() => {
        if (!firstEventReceived && viewsRef.current[sessionId]?.controller === controller) {
          controller.abort();
          if (sessionId === activeSessionIdRef.current) {
            setError("请求超时（30s 无响应），请检查后端服务是否正常启动。");
          }
        }
      }, 30_000);

      // 立即添加用户消息到该会话 UI
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
      patchView(sessionId, (v) => ({ ...v, messages: [...v.messages, userMsg] }));

      // 该会话本次运行的流式渲染上下文
      const streamCtx = createTurnStreamCtx({
        setDisplayMessages: (updater) =>
          patchViewMessages(sessionId, updater),
        // 回放去重：读取该会话当前展示列表，定位既有行/步骤（R1）
        readMessages: () => viewsRef.current[sessionId]?.messages ?? [],
        setError: (message) => {
          if (sessionId === activeSessionIdRef.current) setError(message);
          else patchView(sessionId, { lastError: message });
        },
        setSessionTokenStats: (updater) =>
          patchView(sessionId, (v) => ({
            ...v,
            sessionTokenStats:
              typeof updater === "function"
                ? updater(v.sessionTokenStats)
                : updater,
          })),
      });

      try {
        for await (const event of client.sendMessage({
          sessionId,
          content: text,
          ...(model ? { model } : {}),
          signal: controller.signal,
        })) {
          firstEventReceived = true; // 收到任意事件，取消超时
          if (isRunEnd(event)) break;
          handleTurnEvent(event, streamCtx);
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          if (sessionId === activeSessionIdRef.current) {
            setError(err instanceof Error ? err.message : "Streaming failed");
          } else {
            patchView(sessionId, {
              lastError: err instanceof Error ? err.message : "Streaming failed",
            });
          }
        }
      } finally {
        clearTimeout(timeoutTimer);
        patchView(sessionId, (v) => {
          // 只清理自己这条流（避免覆盖用户在中断后立即发起的新流）
          if (v.controller !== controller) return v;
          return {
            ...v,
            controller: null,
            isStreaming: false,
            runStartedAt: null,
            // 安全清理：关闭所有流式行/步骤 + 复位仍 running 的工具调用
            // （覆盖中断/超时/流异常终止：未收到 tool-call-result 的子项不再转圈）
            messages: markRunningToolCallsFailed(closeOpenTurns(v.messages)),
          };
        });
        void refreshSessions();
      }
    },
    [client, patchView, patchViewMessages, refreshSessions],
  );

  /**
   * 回退到目标节点并自动重答（WebUI 图面板「回退并重答」闭环；目标 = 活跃会话）。
   *
   * 与 CLI /rollback <节点id> 语义一致：服务端回退（旧分支作废保留、会话截断）后
   * 立即自动重新回答；SSE 流首帧 session-start 携带回退后的会话，客户端据此重建
   * 消息列表，随后按常规轮次流式渲染新回答。
   */
  const rollbackRetry = useCallback(
    async (nodeId?: string, reason = "用户回退并重答") => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return;
      // 该会话已有流式任务在跑时拒绝重复操作（其它会话后台运行不受影响）
      const current = viewsRef.current[sessionId];
      if (current?.controller || current?.isStreaming) {
        setError("该会话已有正在进行的生成，请先中断后再回退重答。");
        return;
      }

      const controller = new AbortController();
      patchView(sessionId, {
        controller,
        isStreaming: true,
        runStartedAt: Date.now(),
      });
      setError(null);

      // 超时兜底：30s 无任何 SSE 事件 → abort
      let firstEventReceived = false;
      const timeoutTimer = setTimeout(() => {
        if (!firstEventReceived && viewsRef.current[sessionId]?.controller === controller) {
          controller.abort();
          if (sessionId === activeSessionIdRef.current) {
            setError("回退重答超时（30s 无响应），请检查后端服务是否正常启动。");
          }
        }
      }, 30_000);

      const streamCtx = createTurnStreamCtx({
        setDisplayMessages: (updater) =>
          patchViewMessages(sessionId, updater),
        // 回放去重：读取该会话当前展示列表，定位既有行/步骤（R1）
        readMessages: () => viewsRef.current[sessionId]?.messages ?? [],
        setError: (message) => {
          if (sessionId === activeSessionIdRef.current) setError(message);
          else patchView(sessionId, { lastError: message });
        },
        setSessionTokenStats: (updater) =>
          patchView(sessionId, (v) => ({
            ...v,
            sessionTokenStats:
              typeof updater === "function"
                ? updater(v.sessionTokenStats)
                : updater,
          })),
        // 回退后的首帧 session-start：用截断后的会话重建该会话消息列表
        onSessionStart: (sess) => {
          patchView(sessionId, {
            session: sess,
            messages: sessionToTurnMessages(sess.messages),
          });
        },
      });

      try {
        for await (const event of client.rollbackRetry(
          sessionId,
          nodeId,
          reason,
          controller.signal,
        )) {
          firstEventReceived = true;
          if (isRunEnd(event)) break;
          handleTurnEvent(event, streamCtx);
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          if (sessionId === activeSessionIdRef.current) {
            setError(err instanceof Error ? err.message : "Rollback retry failed");
          } else {
            patchView(sessionId, {
              lastError:
                err instanceof Error ? err.message : "Rollback retry failed",
            });
          }
        }
      } finally {
        clearTimeout(timeoutTimer);
        patchView(sessionId, (v) => {
          if (v.controller !== controller) return v;
          return {
            ...v,
            controller: null,
            isStreaming: false,
            runStartedAt: null,
            messages: markRunningToolCallsFailed(closeOpenTurns(v.messages)),
          };
        });
        void refreshSessions();
        void refreshGraph();
      }
    },
    [client, patchView, patchViewMessages, refreshSessions, refreshGraph],
  );

  const interrupt = useCallback(async () => {
    // 中止「当前活跃会话」的生成（Esc / 停止按钮；其它会话后台运行不受影响）
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    const cur = viewsRef.current[sessionId];
    if (!cur?.controller && !cur?.isStreaming) return;
    cur.controller?.abort();
    patchView(sessionId, (v) => ({
      ...v,
      isStreaming: false,
      runStartedAt: null,
      // 服务端中断处理后会话将回落 idle：先同步本端会话副本，避免陈旧的
      // status="running" 在切回该会话时误触发 attach（服务端已无运行任务、
      // run-end 早已广播 → 订阅永不结束）（AGE-29 R2 客户端侧）
      session: v.session ? { ...v.session, status: "idle" } : v.session,
      // 安全清理：关闭所有流式行/步骤 + 复位 running 工具调用（中断后不再转圈）
      messages: markRunningToolCallsFailed(closeOpenTurns(v.messages)),
    }));
    try {
      await client.interrupt(sessionId);
    } catch {
      // 忽略中断错误
    }
  }, [client, patchView]);

  const respondPermission = useCallback(
    async (
      reqId: string,
      result:
        | { decision: "allow"; input?: unknown }
        | { decision: "deny"; reason?: string },
    ) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return;
      patchView(sessionId, (v) => ({
        ...v,
        pendingPermissions: v.pendingPermissions.filter(
          (p) => p.reqId !== reqId,
        ),
      }));
      try {
        await client.respondPermission(sessionId, reqId, result);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to respond permission",
        );
      }
    },
    [client, patchView],
  );

  // 权限审批轮询：对所有正在生成的会话轮询待处理权限请求
  // （后台会话的请求挂起时同样会被发现；切回该会话即可审批）
  const runningKey = Object.entries(views)
    .filter(([, v]) => v.isStreaming)
    .map(([id]) => id)
    .sort()
    .join(",");
  useEffect(() => {
    if (!runningKey) return;
    const runningIds = runningKey.split(",").filter(Boolean);
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      for (const sid of runningIds) {
        try {
          const pending = await client.getPendingPermissions(sid);
          if (cancelled) return;
          patchView(sid, (v) => {
            if (!v.isStreaming) return v;
            const known = new Set(v.pendingPermissions.map((p) => p.reqId));
            const merged = [...v.pendingPermissions];
            for (const req of pending) {
              if (!known.has(req.reqId)) merged.push(req);
            }
            return { ...v, pendingPermissions: merged };
          });
        } catch {
          // 轮询失败静默（下次周期重试）
        }
      }
    };
    void poll();
    const timer = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, patchView, runningKey]);

  return {
    sessions,
    activeSession,
    activeMessages,
    pendingPermissions,
    isStreaming,
    error,
    runStartedAt,
    interruptNotice,
    runningSessionIds,
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
