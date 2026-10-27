/**
 * @fengagent/web-ui — Agents 外派面板（AGE-35 P3）
 *
 * 三个视图（参照 anet Dashboard 裁剪为单机自用形态）：
 * - Agents 总览：运行时注册表卡片（能力/探测状态/凭据由各 runtime 自管）
 * - 任务列表：外派任务表格（7 态状态机）+ 状态筛选 + 发起/取消/重试
 * - 任务详情：内容与结果 + 流式输出（SSE）+ 事件日志时间线（task_events）
 *
 * P2 后端（/api/runtimes、/api/agent-tasks*）落地前自动回退 mock 数据源
 * （agent-tasks-mock.ts），页面顶部显示「演示数据」徽标；后端就绪后同一
 * 页面无需改动。URL：?view=agents。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  CircleCheck,
  CircleX,
  Clock,
  Cpu,
  Loader2,
  RefreshCw,
  Send,
  Terminal,
} from "lucide-react";
import type { ApiClient } from "../api/client.ts";
import { AgentTasksMock } from "../api/agent-tasks-mock.ts";
import type {
  AgentTask,
  AgentTaskEvent,
  AgentTaskStatus,
  AgentTaskStreamEvent,
  RuntimeInfo,
} from "../api/types.ts";
import type { DeepLinkTarget } from "../app.tsx";
import { formatDuration } from "../lib/format.ts";

interface AgentsPageProps {
  client: ApiClient;
  /** deep-link 目标（群任务卡跳入：?view=agents&task=<id> 打开即进该任务详情） */
  deepLink?: DeepLinkTarget;
}

type StatusFilter = "all" | AgentTaskStatus;

const STATUS_ORDER: AgentTaskStatus[] = [
  "created",
  "dispatched",
  "running",
  "replied",
  "failed",
  "cancelled",
  "expired",
];

const STATUS_LABEL: Record<AgentTaskStatus, string> = {
  created: "已创建",
  dispatched: "已派发",
  running: "运行中",
  replied: "已完成",
  failed: "失败",
  cancelled: "已取消",
  expired: "已过期",
};

const TERMINAL: AgentTaskStatus[] = ["replied", "failed", "cancelled", "expired"];

function isTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL.includes(status);
}

function statusBadgeClass(status: AgentTaskStatus): string {
  switch (status) {
    case "running":
      return "ag-badge ag-badge--running";
    case "replied":
      return "ag-badge ag-badge--ok";
    case "failed":
      return "ag-badge ag-badge--error";
    case "cancelled":
    case "expired":
      return "ag-badge ag-badge--muted";
    default:
      return "ag-badge ag-badge--pending";
  }
}

function formatTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}`;
}

/** 任务数据源：真实 API 优先，失败回退 mock（P2 未落地阶段） */
function useAgentTaskSource(client: ApiClient, forceMock: boolean) {
  const mockRef = useRef<AgentTasksMock | null>(null);
  const [mockMode, setMockMode] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  /** 探测是否已完成（无论真实/mock）——首屏加载的触发信号 */
  const [probed, setProbed] = useState(false);

  const source = useMemo(() => {
    if (mockMode) {
      mockRef.current ??= new AgentTasksMock();
      return mockRef.current;
    }
    return client;
  }, [mockMode, client]);

  const probe = useCallback(async () => {
    if (forceMock) {
      setMockMode(true);
      setProbed(true);
      return;
    }
    try {
      await client.listRuntimes();
      setMockMode(false);
      setProbeError(null);
    } catch (err) {
      // P2 后端未就绪（404 / 网络错误）→ 回退 mock 演示数据
      setMockMode(true);
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbed(true);
    }
  }, [client, forceMock]);

  return { source, mockMode, probeError, probe, probed };
}

export function AgentsPage({ client, deepLink }: AgentsPageProps) {
  const forceMock = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("mock") === "1";
  }, []);
  const { source, mockMode, probeError, probe, probed } = useAgentTaskSource(client, forceMock);

  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(deepLink?.taskId ?? null);

  // 发任务表单
  const [formOpen, setFormOpen] = useState(false);
  const [formRuntime, setFormRuntime] = useState("");
  const [formContent, setFormContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await source.listAgentTasks();
      setTasks(list.tasks);
      setRuntimes(list.runtimes);
      setFormRuntime((prev) => prev || (list.runtimes.find((r) => r.enabled)?.name ?? ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    void probe();
  }, [probe]);

  useEffect(() => {
    if (mockMode) void reload();
  }, [mockMode, reload]);

  // 探测完成后加载首屏数据（真实模式此前只在 mockMode 翻转时 reload，真实首屏空白——F 段 P0）
  useEffect(() => {
    if (probed) void reload();
  }, [probed, reload]);

  // 周期刷新：mock 模式 1s（驱动演示生命周期）；真实模式 5s 轮询列表
  // （真实列表此前无自动刷新，跨页状态只能靠详情页 SSE 回写——F 段 P1）
  useEffect(() => {
    if (!probed) return;
    const interval = mockMode ? 1_000 : 5_000;
    const timer = setInterval(() => void reload(), interval);
    return () => clearInterval(timer);
  }, [mockMode, probed, reload]);

  // 详情打开时列表同步该任务状态（真实模式：SSE 收到的 status 更新合并进列表）
  const mergeTask = useCallback((task: AgentTask) => {
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === task.id);
      if (idx === -1) return [task, ...prev];
      const next = [...prev];
      next[idx] = task;
      return next;
    });
  }, []);

  const filteredTasks = useMemo(() => {
    if (statusFilter === "all") return tasks;
    return tasks.filter((t) => t.status === statusFilter);
  }, [tasks, statusFilter]);

  const counts = useMemo(() => {
    const map = new Map<AgentTaskStatus, number>();
    for (const t of tasks) map.set(t.status, (map.get(t.status) ?? 0) + 1);
    return map;
  }, [tasks]);

  const submitTask = useCallback(async () => {
    if (!formRuntime.trim() || !formContent.trim()) {
      setFormError("请选择 runtime 并填写任务内容");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const task = await source.createAgentTask({ runtime: formRuntime, content: formContent });
      mergeTask(task);
      setFormContent("");
      setFormOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [source, formRuntime, formContent, mergeTask]);

  const cancelTask = useCallback(
    async (taskId: string) => {
      try {
        mergeTask(await source.cancelAgentTask(taskId));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [source, mergeTask],
  );

  const retryTask = useCallback(
    async (taskId: string) => {
      try {
        mergeTask(await source.retryAgentTask(taskId));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [source, mergeTask],
  );

  // ── 详情视图 ──────────────────────────────────────────────
  if (selectedTaskId) {
    return (
      <section className="ag-page">
        <AgentTaskDetailView
          source={source}
          taskId={selectedTaskId}
          onBack={() => setSelectedTaskId(null)}
          onTaskUpdate={mergeTask}
        />
      </section>
    );
  }

  // ── 总览 + 列表视图 ──────────────────────────────────────
  return (
    <section className="ag-page">
      <header className="ag-page__header">
        <div>
          <h1 className="ag-page__title">
            <Bot className="ag-page__title-icon" aria-hidden="true" />
            Agents
          </h1>
          <p className="ag-page__subtitle">
            外派任务面板 — 把任务派给本机其他 agent（ACP 直连），7 态状态机 + 流式输出
            {mockMode ? "（当前为演示数据：P2 后端未就绪）" : ""}
          </p>
        </div>
        <div className="ag-page__actions">
          {mockMode ? <span className="ag-mock-badge">MOCK</span> : null}
          <button
            type="button"
            className="ag-btn ag-btn--ghost"
            onClick={() => {
              void probe();
              void reload();
            }}
          >
            <RefreshCw size={14} aria-hidden="true" /> 刷新
          </button>
          <button
            type="button"
            className="ag-btn ag-btn--primary"
            onClick={() => setFormOpen((v) => !v)}
          >
            <Send size={14} aria-hidden="true" /> 发任务
          </button>
        </div>
      </header>

      {mockMode && probeError ? <div className="ag-page__hint">后端探测失败：{probeError}，已回退演示数据</div> : null}
      {error ? <div className="ag-page__hint ag-page__hint--error">{error}</div> : null}
      {loading ? (
        <div className="ag-page__empty">
          <Loader2 className="ag-page__spin" size={18} aria-hidden="true" /> 加载中…
        </div>
      ) : null}

      <div className="ag-section">
        <h2 className="ag-section__title">
          <Cpu size={14} aria-hidden="true" /> Agents 总览
        </h2>
        {runtimes.length === 0 && !loading ? (
          <div className="ag-page__empty">暂无已注册 runtime — 后端就绪后此处展示运行时注册表</div>
        ) : (
          <div className="ag-runtime-grid">
            {runtimes.map((r) => (
              <div key={r.name} className="ag-runtime-card">
                <div className="ag-runtime-card__head">
                  <span className="ag-runtime-card__name">{r.name}</span>
                  <span
                    className={`ag-dot ag-dot--${r.probeStatus === "ok" ? "ok" : r.probeStatus === "unreachable" ? "error" : "muted"}`}
                    title={r.probeError ?? r.probeStatus}
                  />
                </div>
                <div className="ag-runtime-card__meta">
                  {r.agentName} · {r.agentVersion}
                </div>
                <code className="ag-runtime-card__cmd">{r.command}</code>
                <div className="ag-runtime-card__chips">
                  {r.capabilities.resume ? <span className="ag-chip">resume</span> : null}
                  {r.capabilities.loadSession ? <span className="ag-chip">load</span> : null}
                  {r.capabilities.image ? <span className="ag-chip">image</span> : null}
                  <span className="ag-chip ag-chip--muted">24h 任务 {r.recentTaskCount}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="ag-section">
        <h2 className="ag-section__title">
          <Terminal size={14} aria-hidden="true" /> 任务列表
        </h2>
        <div className="ag-filter" role="tablist">
          <button
            type="button"
            className={`ag-filter__chip ${statusFilter === "all" ? "ag-filter__chip--active" : ""}`}
            onClick={() => setStatusFilter("all")}
          >
            全部 {tasks.length}
          </button>
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              type="button"
              className={`ag-filter__chip ${statusFilter === s ? "ag-filter__chip--active" : ""}`}
              onClick={() => setStatusFilter(s)}
            >
              {STATUS_LABEL[s]} {counts.get(s) ?? 0}
            </button>
          ))}
        </div>

        {formOpen ? (
          <div className="ag-form">
            <div className="ag-form__row">
              <label className="ag-form__label" htmlFor="ag-form-runtime">
                Runtime
              </label>
              <select
                id="ag-form-runtime"
                className="ag-form__select"
                value={formRuntime}
                onChange={(e) => setFormRuntime(e.target.value)}
              >
                {runtimes
                  .filter((r) => r.enabled)
                  .map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name} — {r.agentName}
                    </option>
                  ))}
              </select>
            </div>
            <div className="ag-form__row">
              <label className="ag-form__label" htmlFor="ag-form-content">
                任务内容
              </label>
              <textarea
                id="ag-form-content"
                className="ag-form__textarea"
                rows={3}
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                placeholder="要派给目标 agent 的任务描述…"
              />
            </div>
            {formError ? <div className="ag-form__error">{formError}</div> : null}
            <div className="ag-form__actions">
              <button type="button" className="ag-btn ag-btn--ghost" onClick={() => setFormOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="ag-btn ag-btn--primary"
                disabled={submitting}
                onClick={() => void submitTask()}
              >
                {submitting ? <Loader2 className="ag-page__spin" size={14} aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
                派发
              </button>
            </div>
          </div>
        ) : null}

        {filteredTasks.length === 0 && !loading ? (
          <div className="ag-page__empty">该筛选下暂无任务</div>
        ) : (
          <div className="ag-page__table-wrap">
            <table className="ag-page__table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>From</th>
                  <th>Runtime</th>
                  <th>状态</th>
                  <th>内容</th>
                  <th>创建</th>
                  <th>耗时</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.map((t) => (
                  <tr key={t.id} className="ag-row" onClick={() => setSelectedTaskId(t.id)}>
                    <td className="ag-row__id" title={t.id}>{t.id}</td>
                    <td>{t.fromSession}</td>
                    <td>{t.runtime}</td>
                    <td>
                      <span className={statusBadgeClass(t.status)}>
                        {isTerminal(t.status) ? null : <Loader2 className="ag-badge__spin" size={10} aria-hidden="true" />}
                        {STATUS_LABEL[t.status]}
                      </span>
                    </td>
                    <td className="ag-row__content" title={t.content}>
                      {t.content.length > 40 ? `${t.content.slice(0, 40)}…` : t.content}
                    </td>
                    <td>{formatTime(t.createdAt)}</td>
                    <td>{t.durationMs != null ? formatDuration(t.durationMs) : "—"}</td>
                    <td className="ag-row__actions" onClick={(e) => e.stopPropagation()}>
                      {!isTerminal(t.status) ? (
                        <button type="button" className="ag-btn ag-btn--mini" onClick={() => void cancelTask(t.id)}>
                          取消
                        </button>
                      ) : null}
                      {["failed", "cancelled", "expired"].includes(t.status) ? (
                        <button type="button" className="ag-btn ag-btn--mini" onClick={() => void retryTask(t.id)}>
                          重试
                        </button>
                      ) : null}
                      <button type="button" className="ag-btn ag-btn--mini ag-btn--ghost" onClick={() => setSelectedTaskId(t.id)}>
                        详情
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/** 任务数据源的最小接口（client 与 mock 共同满足） */
interface AgentTaskSource {
  getAgentTask(taskId: string): Promise<{ task: AgentTask; events: AgentTaskEvent[] }>;
  streamAgentTask(req: { taskId: string; signal?: AbortSignal }): AsyncGenerator<AgentTaskStreamEvent>;
  cancelAgentTask(taskId: string): Promise<AgentTask>;
  retryAgentTask(taskId: string): Promise<AgentTask>;
}

interface AgentTaskDetailViewProps {
  source: AgentTaskSource;
  taskId: string;
  onBack: () => void;
  onTaskUpdate: (task: AgentTask) => void;
}

function AgentTaskDetailView({ source, taskId, onBack, onTaskUpdate }: AgentTaskDetailViewProps) {
  const [task, setTask] = useState<AgentTask | null>(null);
  const [events, setEvents] = useState<AgentTaskEvent[]>([]);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  /**
   * 订阅轮次：详情内重试后递增，强制 SSE 效应重跑——重置本地 task/events/
   * 流式文本并重新订阅（此前重试只回写列表，详情停留旧终态——F 段 P1）。
   */
  const [streamEpoch, setStreamEpoch] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setStreamText("");
    setEvents([]);
    setError(null);

    void (async () => {
      try {
        const detail = await source.getAgentTask(taskId);
        if (!alive) return;
        setTask(detail.task);
        onTaskUpdate(detail.task);
        setEvents(detail.events);

        for await (const ev of source.streamAgentTask({ taskId, signal: controller.signal })) {
          if (!alive) return;
          if (ev.type === "status") {
            setTask(ev.task);
            onTaskUpdate(ev.task);
          } else if (ev.type === "chunk") {
            setStreamText((prev) => (ev.text.startsWith(prev) ? ev.text : prev + ev.text));
          } else if (ev.type === "event") {
            setEvents((prev) => (prev.some((e) => e.seq === ev.event.seq) ? prev : [...prev, ev.event]));
          }
        }
      } catch (err) {
        if (alive && !(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [source, taskId, streamEpoch, onTaskUpdate]);

  // 流式输出自动滚动到底
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streamText]);

  if (error && !task) {
    return (
      <div className="ag-detail">
        <button type="button" className="ag-btn ag-btn--ghost" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> 返回
        </button>
        <div className="ag-page__empty ag-page__empty--error">{error}</div>
      </div>
    );
  }
  if (!task) {
    return (
      <div className="ag-detail ag-detail--loading">
        <Loader2 className="ag-page__spin" size={18} aria-hidden="true" /> 加载任务…
      </div>
    );
  }

  const output = task.result ?? streamText;

  return (
    <div className="ag-detail">
      <div className="ag-detail__header">
        <button type="button" className="ag-btn ag-btn--ghost" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> 返回列表
        </button>
        <div className="ag-detail__title">
          <span className="ag-row__id">{task.id}</span>
          <span className="ag-detail__meta">
            → {task.runtime} · 来自 {task.fromSession} · acpSession {task.acpSessionId ?? "—"}
          </span>
        </div>
        <span className={statusBadgeClass(task.status)}>
          {!isTerminal(task.status) ? <Loader2 className="ag-badge__spin" size={10} aria-hidden="true" /> : null}
          {STATUS_LABEL[task.status]}
        </span>
        <div className="ag-detail__actions">
          {!isTerminal(task.status) ? (
            <button
              type="button"
              className="ag-btn"
              onClick={() => {
                void source.cancelAgentTask(taskId).then(onTaskUpdate).catch((e) => setError(String(e)));
              }}
            >
              <CircleX size={14} aria-hidden="true" /> 取消
            </button>
          ) : null}
          {["failed", "cancelled", "expired"].includes(task.status) ? (
            <button
              type="button"
              className="ag-btn"
              onClick={() => {
                void source
                  .retryAgentTask(taskId)
                  .then((t) => {
                    onTaskUpdate(t);
                    // 重置本地视图并重订 SSE（新一轮 attempt 的事件与流式输出）
                    setStreamEpoch((e) => e + 1);
                  })
                  .catch((e) => setError(String(e)));
              }}
            >
              <RefreshCw size={14} aria-hidden="true" /> 重试
            </button>
          ) : null}
        </div>
      </div>

      <div className="ag-detail__grid">
        <div className="ag-detail__col">
          <div className="ag-card">
            <h3 className="ag-card__title">
              <Send size={13} aria-hidden="true" /> 任务内容
            </h3>
            <pre className="ag-card__pre">{task.content}</pre>
          </div>
          <div className="ag-card">
            <h3 className="ag-card__title">
              {task.status === "replied" ? (
                <CircleCheck size={13} aria-hidden="true" />
              ) : (
                <Loader2 className="ag-badge__spin" size={13} aria-hidden="true" />
              )}
              {task.status === "replied" ? "回复结果" : "流式输出"}
            </h3>
            <div className="ag-card__pre ag-card__pre--stream" ref={streamRef}>
              {output || (task.error ? `⚠ ${task.error}` : "等待目标 agent 输出…")}
            </div>
          </div>
        </div>
        <div className="ag-detail__col">
          <div className="ag-card">
            <h3 className="ag-card__title">
              <Clock size={13} aria-hidden="true" /> 事件日志
            </h3>
            <ol className="ag-timeline">
              {events.map((e) => (
                <li key={e.seq} className={`ag-timeline__item ag-timeline__item--${e.type.replace("task/", "")}`}>
                  <span className="ag-timeline__time">{formatTime(e.at)}</span>
                  <span className="ag-timeline__type">{e.type}</span>
                  {e.detail ? <span className="ag-timeline__detail">{e.detail}</span> : null}
                </li>
              ))}
              {events.length === 0 ? <li className="ag-timeline__item">暂无事件</li> : null}
            </ol>
          </div>
        </div>
      </div>
      {error ? <div className="ag-page__hint ag-page__hint--error">{error}</div> : null}
    </div>
  );
}
