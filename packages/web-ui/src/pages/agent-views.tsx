/**
 * @fengagent/web-ui — agent 任务/运行时共享视图（「agent 团队」统一模块 M1）
 *
 * 从原 Agents 页拆出的可复用件，供「团队」页的三个子视图（团队 / 任务库 /
 * 成员库）与群聊内的任务卡就地展开共用：
 * - `useAgentTaskSource`：任务数据源（真实 API 优先，失败回退 mock）
 * - `useAgentTaskLibrary`：任务/运行时列表状态（加载 + 轮询 + 状态合并）
 * - `TaskLibraryView`：任务库（7 态筛选 + 发起/取消/重试 + 详情 SSE/事件时间线）
 * - `RuntimeLibraryView`：成员库（运行时注册表卡片）
 * - `AgentTaskDetailView`：任务详情（流式输出 + 事件日志），任务卡就地展开复用
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
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
  AgentTaskCreateRequest,
  AgentTaskEvent,
  AgentTaskStatus,
  AgentTaskStreamEvent,
  RuntimeInfo,
} from "../api/types.ts";
import { formatDuration } from "../lib/format.ts";
import { EMPTY_RUNTIME_FORM, formToEntry, validateRuntimeForm, type RuntimeFormValue } from "./runtime-form.ts";

export type StatusFilter = "all" | AgentTaskStatus;

export const STATUS_ORDER: AgentTaskStatus[] = [
  "created",
  "dispatched",
  "running",
  "replied",
  "failed",
  "cancelled",
  "expired",
];

export const STATUS_LABEL: Record<AgentTaskStatus, string> = {
  created: "已创建",
  dispatched: "已派发",
  running: "运行中",
  replied: "已完成",
  failed: "失败",
  cancelled: "已取消",
  expired: "已过期",
};

const TERMINAL: AgentTaskStatus[] = ["replied", "failed", "cancelled", "expired"];

export function isTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL.includes(status);
}

export function statusBadgeClass(status: AgentTaskStatus): string {
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

export function formatTaskTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}`;
}

/** 任务数据源（client 与 mock 共同满足） */
export interface AgentTaskSource {
  listAgentTasks(): Promise<{ tasks: AgentTask[]; runtimes: RuntimeInfo[] }>;
  createAgentTask(req: AgentTaskCreateRequest): Promise<AgentTask>;
  getAgentTask(taskId: string): Promise<{ task: AgentTask; events: AgentTaskEvent[] }>;
  streamAgentTask(req: { taskId: string; signal?: AbortSignal }): AsyncGenerator<AgentTaskStreamEvent>;
  cancelAgentTask(taskId: string): Promise<AgentTask>;
  retryAgentTask(taskId: string): Promise<AgentTask>;
}

/** 任务数据源：真实 API 优先，失败回退 mock（P2 未落地阶段） */
export function useAgentTaskSource(client: ApiClient, forceMock: boolean) {
  const mockRef = useRef<AgentTasksMock | null>(null);
  const [mockMode, setMockMode] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  /** 探测是否已完成（无论真实/mock）——首屏加载的触发信号 */
  const [probed, setProbed] = useState(false);

  const source = useMemo<AgentTaskSource>(() => {
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
      // 后端未就绪（404 / 网络错误）→ 回退 mock 演示数据
      setMockMode(true);
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbed(true);
    }
  }, [client, forceMock]);

  return { source, mockMode, probeError, probe, probed };
}

/** 任务/运行时列表状态（加载 + 轮询 + 详情回写合并），供各子视图共用一份 */
export function useAgentTaskLibrary(
  source: AgentTaskSource,
  options: { mockMode: boolean; probed: boolean },
) {
  const { mockMode, probed } = options;
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await source.listAgentTasks();
      setTasks(list.tasks);
      setRuntimes(list.runtimes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    if (probed) void reload();
  }, [probed, reload]);

  // 周期刷新：mock 1s（驱动演示生命周期）；真实 5s 轮询列表
  useEffect(() => {
    if (!probed) return;
    const interval = mockMode ? 1_000 : 5_000;
    const timer = setInterval(() => void reload(), interval);
    return () => clearInterval(timer);
  }, [mockMode, probed, reload]);

  /** 详情 SSE 收到的任务状态合并进列表（保持跨视图一致） */
  const mergeTask = useCallback((task: AgentTask) => {
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === task.id);
      if (idx === -1) return [task, ...prev];
      const next = [...prev];
      next[idx] = task;
      return next;
    });
  }, []);

  return { runtimes, tasks, loading, error, reload, mergeTask, setError };
}

/** 成员库（原 Agents 总览）：运行时注册表卡片 + 添加/编辑/删除/探测验证 */
export function RuntimeLibraryView({
  runtimes,
  loading,
  client,
  onChanged,
}: {
  runtimes: RuntimeInfo[];
  loading: boolean;
  /** API 客户端（CRUD/探测验证；mock 模式下调用会报错并原样展示） */
  client: ApiClient;
  /** 增删改后刷新列表（团队页的 library.reload） */
  onChanged: () => void;
}) {
  /** 表单开/关 + 当前编辑对象（null = 添加模式） */
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RuntimeInfo | null>(null);
  const [form, setForm] = useState<RuntimeFormValue>(EMPTY_RUNTIME_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);
  /** 探测验证进行中 */
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_RUNTIME_FORM);
    setFormError(null);
    setFormNotice(null);
    setFormOpen(true);
  }

  function openEdit(r: RuntimeInfo) {
    setEditing(r);
    setForm({
      name: r.name,
      command: r.command,
      args: (r.args ?? []).join(" "),
      protocol: r.protocol === "claude-stream-json" ? "claude-stream-json" : "acp",
      env: Object.entries(r.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    });
    setFormError(null);
    setFormNotice(null);
    setFormOpen(true);
  }

  /** 探测验证：探测表单当前值（不落盘），失败原因原样显示 */
  async function probeCandidate() {
    if (probing || form.command.trim() === "") return;
    setProbing(true);
    setFormError(null);
    setFormNotice(null);
    try {
      const entry = formToEntry(form);
      const result = await client.probeRuntimeCandidate({
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        protocol: entry.protocol,
        ...(entry.env ? { env: entry.env } : {}),
      });
      if (result.probeStatus === "ok") {
        setFormNotice(
          `探测通过：${result.agentName ?? "?"} ${result.agentVersion ?? ""}`.trim(),
        );
      } else {
        setFormError(`探测失败：${result.probeError ?? "未知原因"}`);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  }

  /** 保存（添加或编辑） */
  async function save() {
    if (saving) return;
    const errors = validateRuntimeForm(form, editing !== null);
    if (errors.length > 0) {
      setFormError(errors.join("；"));
      return;
    }
    setSaving(true);
    setFormError(null);
    setFormNotice(null);
    try {
      const entry = formToEntry(form);
      if (editing) {
        await client.updateRuntime(editing.name, {
          command: entry.command,
          ...(entry.args ? { args: entry.args } : {}),
          protocol: entry.protocol,
          ...(entry.env ? { env: entry.env } : {}),
        });
      } else {
        await client.createRuntime(entry);
      }
      setFormOpen(false);
      onChanged();
    } catch (err) {
      // 后端返回什么错就原样显示（命令不存在/协议不支持/重名/凭据缺失…）
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  /** 删除（两步确认） */
  async function doDelete() {
    const name = deleteTarget;
    if (saving || name === null) return;
    setSaving(true);
    try {
      await client.deleteRuntime(name);
      setDeleteTarget(null);
      onChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ag-section">
      <div className="tm-libhead">
        <h2 className="ag-section__title">
          <Cpu size={14} aria-hidden="true" /> 成员库
        </h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="ag-btn ag-btn--primary" onClick={openCreate}>
            <Cpu size={14} aria-hidden="true" /> 添加 runtime
          </button>
        </div>
      </div>

      {formError && !formOpen ? <div className="ag-page__hint ag-page__hint--error">{formError}</div> : null}

      {/* 添加 / 编辑表单 */}
      {formOpen && (
        <div className="ag-form" data-testid="runtime-form">
          <div className="tm-libhead">
            <h3 className="ag-section__title">{editing ? `编辑 ${editing.name}` : "添加 runtime"}</h3>
          </div>
          {formError ? <div className="ag-page__hint ag-page__hint--error">{formError}</div> : null}
          {formNotice ? <div className="ag-page__hint">{formNotice}</div> : null}

          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="rt-name">名称</label>
            <input
              id="rt-name"
              className="ag-form__select"
              value={form.name}
              disabled={editing !== null}
              placeholder="如 opencode"
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="rt-command">command</label>
            <input
              id="rt-command"
              className="ag-form__select"
              value={form.command}
              placeholder="如 opencode / claude / kimi"
              onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
            />
          </div>
          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="rt-args">args（空格分隔）</label>
            <input
              id="rt-args"
              className="ag-form__select"
              value={form.args}
              placeholder="如 acp（可留空）"
              onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
            />
          </div>
          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="rt-protocol">协议</label>
            <select
              id="rt-protocol"
              className="ag-form__select"
              value={form.protocol}
              onChange={(e) =>
                setForm((f) => ({ ...f, protocol: e.target.value as RuntimeFormValue["protocol"] }))
              }
            >
              <option value="acp">acp（NDJSON JSON-RPC，dsh/kimi/fengagent）</option>
              <option value="claude-stream-json">claude-stream-json（claude 一次性进程）</option>
            </select>
          </div>
          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="rt-env">凭据 / 环境变量（逐行 KEY=VALUE）</label>
            <textarea
              id="rt-env"
              className="ag-form__select"
              rows={3}
              value={form.env}
              placeholder={"API_KEY=sk-...\nHTTP_PROXY=http://..."}
              onChange={(e) => setForm((f) => ({ ...f, env: e.target.value }))}
            />
          </div>

          <div className="ag-form__actions">
            <button type="button" className="ag-btn" disabled={probing} onClick={() => void probeCandidate()}>
              {probing ? <Loader2 className="ag-page__spin" size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
              探测验证
            </button>
            <button type="button" className="ag-btn ag-btn--primary" disabled={saving} onClick={() => void save()}>
              {saving ? <Loader2 className="ag-page__spin" size={14} aria-hidden="true" /> : null}
              {editing ? "保存修改" : "添加"}
            </button>
            <button type="button" className="ag-btn ag-btn--ghost" onClick={() => setFormOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      {deleteTarget !== null && (
        <div className="ag-page__hint ag-page__hint--error">
          确认删除 runtime「{deleteTarget}」？历史任务保留，但无法再向它派发新任务。
          <button type="button" className="ag-btn ag-btn--mini ag-btn--ghost" style={{ marginLeft: 12 }} onClick={() => void doDelete()}>
            确认删除
          </button>
          <button type="button" className="ag-btn ag-btn--mini ag-btn--ghost" style={{ marginLeft: 6 }} onClick={() => setDeleteTarget(null)}>
            取消
          </button>
        </div>
      )}

      {runtimes.length === 0 && !loading ? (
        <div className="ag-page__empty">暂无已注册 runtime — 用上方「添加 runtime」录入外部 agent</div>
      ) : (
        <div className="ag-runtime-grid">
          {runtimes.map((r) => (
            <div key={r.name} className="ag-runtime-card" data-testid="runtime-card" data-runtime-name={r.name}>
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
              {r.probeStatus === "unreachable" && r.probeError ? (
                <div className="ag-runtime-card__meta" style={{ color: "var(--error, #e06c75)" }} title={r.probeError}>
                  {r.probeError.length > 60 ? `${r.probeError.slice(0, 60)}…` : r.probeError}
                </div>
              ) : null}
              <div className="ag-runtime-card__chips">
                {r.capabilities.resume ? <span className="ag-chip">resume</span> : null}
                {r.capabilities.loadSession ? <span className="ag-chip">load</span> : null}
                {r.capabilities.image ? <span className="ag-chip">image</span> : null}
                <span className="ag-chip ag-chip--muted">24h 任务 {r.recentTaskCount}</span>
              </div>
              <div className="ag-runtime-card__actions" style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button type="button" className="ag-btn ag-btn--mini" onClick={() => openEdit(r)}>
                  编辑
                </button>
                <button type="button" className="ag-btn ag-btn--mini ag-btn--ghost" onClick={() => setDeleteTarget(r.name)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface TaskLibraryViewProps {
  source: AgentTaskSource;
  tasks: AgentTask[];
  runtimes: RuntimeInfo[];
  loading: boolean;
  error: string | null;
  /** 当前选中的任务（受控：由团队页统一持有，任务卡/深链也会切换它） */
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  mergeTask: (task: AgentTask) => void;
}

/** 任务库：跨团队任务台账（7 态筛选 + 发起/取消/重试 + 详情），无群任务也在此 */
export function TaskLibraryView({
  source,
  tasks,
  runtimes,
  loading,
  error,
  selectedTaskId,
  onSelectTask,
  mergeTask,
}: TaskLibraryViewProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [formOpen, setFormOpen] = useState(false);
  const [formRuntime, setFormRuntime] = useState("");
  const [formContent, setFormContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setFormRuntime((prev) => prev || (runtimes.find((r) => r.enabled)?.name ?? ""));
  }, [runtimes]);

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
      // 与团队内派单一致：派出即打开详情（流式输出可见）
      onSelectTask(task.id);
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
        setFormError(err instanceof Error ? err.message : String(err));
      }
    },
    [source, mergeTask],
  );

  const retryTask = useCallback(
    async (taskId: string) => {
      try {
        mergeTask(await source.retryAgentTask(taskId));
      } catch (err) {
        setFormError(err instanceof Error ? err.message : String(err));
      }
    },
    [source, mergeTask],
  );

  // ── 详情视图 ──────────────────────────────────────────────
  if (selectedTaskId) {
    return (
      <AgentTaskDetailView
        source={source}
        taskId={selectedTaskId}
        onBack={() => onSelectTask(null)}
        onTaskUpdate={mergeTask}
      />
    );
  }

  // ── 列表视图 ──────────────────────────────────────────────
  return (
    <div className="ag-section">
      <div className="tm-libhead">
        <h2 className="ag-section__title">
          <Terminal size={14} aria-hidden="true" /> 任务列表
        </h2>
        <button
          type="button"
          className="ag-btn ag-btn--primary"
          onClick={() => setFormOpen((v) => !v)}
        >
          <Send size={14} aria-hidden="true" /> 发任务
        </button>
      </div>
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

      {error ? <div className="ag-page__hint ag-page__hint--error">{error}</div> : null}
      {loading ? (
        <div className="ag-page__empty">
          <Loader2 className="ag-page__spin" size={18} aria-hidden="true" /> 加载中…
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
                <tr key={t.id} className="ag-row" onClick={() => onSelectTask(t.id)}>
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
                  <td>{formatTaskTime(t.createdAt)}</td>
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
                    <button type="button" className="ag-btn ag-btn--mini ag-btn--ghost" onClick={() => onSelectTask(t.id)}>
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
  );
}

export interface AgentTaskDetailViewProps {
  source: AgentTaskSource;
  taskId: string;
  onBack: () => void;
  onTaskUpdate: (task: AgentTask) => void;
}

/** 任务详情：内容/结果 + 流式输出（SSE）+ 事件日志时间线（任务卡就地展开复用） */
export function AgentTaskDetailView({ source, taskId, onBack, onTaskUpdate }: AgentTaskDetailViewProps) {
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
            {task.groupId ? ` · 群 ${task.groupId}` : ""}
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
                  <span className="ag-timeline__time">{formatTaskTime(e.at)}</span>
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
