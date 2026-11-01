/**
 * @fengagent/web-ui — 「agent 团队」统一模块（M1）
 *
 * 团队 = 群 = 聊天 + 派单 + 任务卡：合并原 Agents 页（运行时/任务台账）与群聊页。
 * 三个子视图（顶部分段控件）：
 * - 团队：左团队列表（=群）+ 右团队详情（聊天流 + 任务卡就地展开 + 派单 + 收口状态条）
 * - 任务库：跨团队任务台账（7 态筛选 + 发起/取消/重试 + 详情），无群任务也在此
 * - 成员库：运行时注册表卡片（与建团队的成员选择器同源）
 *
 * 深链：?view=teams（团队）、&group=<id>（团队详情）、&sub=tasks|members（子视图）、
 * &task=<id>（有 groupId 的任务在对应团队内展开任务卡；无群的进任务库详情）。
 * 旧路由 ?view=agents / ?view=groups 由 app.tsx 别名映射重定向到本页（不断链）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Gavel,
  Loader2,
  MessageSquarePlus,
  OctagonX,
  RefreshCw,
  Send,
  Users,
} from "lucide-react";
import type { ApiClient } from "../api/client.ts";
import { GroupsMock } from "../api/groups-mock.ts";
import type {
  GroupInfo,
  GroupMessage,
  GroupStreamEvent,
} from "../api/types.ts";
import type { AppView, DeepLinkTarget } from "../app.tsx";
import {
  AgentTaskDetailView,
  RuntimeLibraryView,
  TaskLibraryView,
  useAgentTaskLibrary,
  useAgentTaskSource,
} from "./agent-views.tsx";

/** 团队页子视图 */
type TeamsSubView = "teams" | "tasks" | "members";

interface TeamsPageProps {
  client: ApiClient;
  /** deep-link 目标（group / sub / task 由 app.tsx 解析传入） */
  deepLink?: DeepLinkTarget;
  /** 视图导航（跨页跳转用；页内切换走自身状态 + replaceState） */
  onNavigate?: (view: AppView, target?: DeepLinkTarget) => void;
}

/* ------------------------------ 团队数据源 ------------------------------ */

/** 群数据源最小接口（client 与 mock 共同满足） */
interface GroupSource {
  listGroups(): Promise<{
    groups: GroupInfo[];
    runtimes: Array<{ name: string; enabled: boolean; agentName: string }>;
  }>;
  createGroup(req: {
    name: string;
    description?: string;
    members: string[];
    maxRounds?: number;
    idleTimeoutMs?: number;
  }): Promise<GroupInfo>;
  getGroup(groupId: string): Promise<{ group: GroupInfo; messages: GroupMessage[] }>;
  sendGroupMessage(groupId: string, req: { content: string; kind?: "chat" | "decision" }): Promise<GroupMessage>;
  concludeGroup(groupId: string): Promise<GroupInfo>;
  stopGroup(groupId: string): Promise<{ group: GroupInfo; cancelledTasks: string[] }>;
  streamGroup(groupId: string, after: number, signal?: AbortSignal): AsyncGenerator<GroupStreamEvent>;
}

/** 团队数据源：真实 API 优先，失败回退 mock */
function useGroupSource(client: ApiClient, forceMock: boolean) {
  const mockRef = useRef<GroupsMock | null>(null);
  const [mockMode, setMockMode] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probed, setProbed] = useState(false);

  const source = useMemo<GroupSource>(() => {
    if (mockMode) {
      mockRef.current ??= new GroupsMock();
      return mockRef.current satisfies GroupSource;
    }
    return client as GroupSource;
  }, [mockMode, client]);

  const probe = useCallback(async () => {
    if (forceMock) {
      setMockMode(true);
      setProbed(true);
      return;
    }
    try {
      await client.listGroups();
      setMockMode(false);
      setProbeError(null);
    } catch (err) {
      // 后端未就绪 → 回退演示数据
      setMockMode(true);
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbed(true);
    }
  }, [client, forceMock]);

  return { source, mockMode, probeError, probe, probed };
}

/* ------------------------------ 工具 ------------------------------ */

function formatTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hh : `${d.getMonth() + 1}/${d.getDate()} ${hh}`;
}

/** 发言者徽标配色（human=靛蓝、coordinator=紫、runtime=青、system=灰） */
function speakerClass(msg: GroupMessage): string {
  switch (msg.fromKind) {
    case "human":
      return "gr-msg__avatar--human";
    case "coordinator":
      return "gr-msg__avatar--coordinator";
    case "runtime":
      return "gr-msg__avatar--runtime";
    default:
      return "gr-msg__avatar--system";
  }
}

function speakerLabel(msg: GroupMessage): string {
  switch (msg.fromKind) {
    case "human":
      return "我";
    case "coordinator":
      return `${msg.fromName}（协调者）`;
    case "runtime":
      return msg.fromName;
    default:
      return "系统";
  }
}

function initials(name: string): string {
  return name.slice(0, 1).toUpperCase();
}

/** 任务卡状态徽标（按内容关键字推断，与服务端 task_card 文案约定一致） */
function taskCardBadge(content: string): { label: string; cls: string } {
  if (content.includes("已完成")) return { label: "已完成", cls: "gr-taskcard__badge--ok" };
  if (content.includes("失败")) return { label: "失败", cls: "gr-taskcard__badge--error" };
  if (content.includes("已取消")) return { label: "已取消", cls: "" };
  return { label: "任务", cls: "" };
}

/* ------------------------------ 页面 ------------------------------ */

export function TeamsPage({ client, deepLink }: TeamsPageProps) {
  const forceMock = useMemo(() => {
    return new URLSearchParams(window.location.search).get("mock") === "1";
  }, []);

  // 任务面（任务库 / 成员库 / 派单 / 任务卡展开共用一份）
  const { source: taskSource, mockMode: taskMockMode, probeError: taskProbeError, probe: probeTasks, probed: tasksProbed } =
    useAgentTaskSource(client, forceMock);
  const library = useAgentTaskLibrary(taskSource, { mockMode: taskMockMode, probed: tasksProbed });

  // 团队面（团队列表 + 聊天）
  const { source: groupSource, mockMode: groupMockMode, probeError: groupProbeError, probe: probeGroups, probed: groupsProbed } =
    useGroupSource(client, forceMock);

  // 子视图 + 选中态（URL 参数初始化；页内切换用 replaceState 同步，避免历史堆叠）
  const [subView, setSubView] = useState<TeamsSubView>(() => {
    const s = new URLSearchParams(window.location.search).get("sub");
    return s === "tasks" || s === "members" ? s : "teams";
  });
  const [libTaskId, setLibTaskId] = useState<string | null>(null);

  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [groupRuntimes, setGroupRuntimes] = useState<Array<{ name: string; enabled: boolean; agentName: string }>>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("group"),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 团队详情（聊天）
  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const streamEndRef = useRef<HTMLDivElement | null>(null);

  // 任务卡就地展开（团队详情内）
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  // 建团队对话框
  const [createOpen, setCreateOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formMembers, setFormMembers] = useState<string[]>([]);
  const [formRounds, setFormRounds] = useState(3);
  const [formIdleMinutes, setFormIdleMinutes] = useState(10);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 团队内派单表单
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatchRuntime, setDispatchRuntime] = useState("");
  const [dispatchContent, setDispatchContent] = useState("");
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  // 关停结果提示
  const [stopNotice, setStopNotice] = useState<string | null>(null);

  /** 页内 URL 同步（replaceState：可分享、不堆历史） */
  const syncUrl = useCallback((next: { sub?: TeamsSubView; group?: string | null; task?: string | null }) => {
    const params = new URLSearchParams(window.location.search);
    params.set("view", "teams");
    if (next.sub && next.sub !== "teams") params.set("sub", next.sub);
    else params.delete("sub");
    if (next.group) params.set("group", next.group);
    else params.delete("group");
    if (next.task) params.set("task", next.task);
    else params.delete("task");
    window.history.replaceState(null, "", `?${params.toString()}`);
  }, []);

  const changeSubView = useCallback(
    (next: TeamsSubView) => {
      setSubView(next);
      syncUrl({ sub: next, group: selectedGroupId, task: next === "tasks" ? libTaskId : null });
    },
    [selectedGroupId, libTaskId, syncUrl],
  );

  const selectGroup = useCallback(
    (id: string | null) => {
      setSelectedGroupId(id);
      setExpandedTaskId(null);
      syncUrl({ sub: subView, group: id });
    },
    [subView, syncUrl],
  );

  const selectLibTask = useCallback(
    (id: string | null) => {
      setLibTaskId(id);
      syncUrl({ sub: subView, group: selectedGroupId, task: id });
    },
    [subView, selectedGroupId, syncUrl],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await groupSource.listGroups();
      setGroups(list.groups);
      setGroupRuntimes(list.runtimes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [groupSource]);

  useEffect(() => {
    void probeGroups();
  }, [probeGroups]);

  useEffect(() => {
    void probeTasks();
  }, [probeTasks]);

  useEffect(() => {
    if (groupsProbed) void reload();
  }, [groupsProbed, reload]);

  // 列表轮询（mock 1s 演进、真实 5s 刷新最近消息时间）
  useEffect(() => {
    if (!groupsProbed) return;
    const timer = setInterval(() => void reload(), groupMockMode ? 1_500 : 5_000);
    return () => clearInterval(timer);
  }, [groupMockMode, groupsProbed, reload]);

  // 任务深链：有 groupId 的任务 → 定位到对应团队并展开任务卡；无群 → 任务库详情
  useEffect(() => {
    if (!deepLink?.taskId || !tasksProbed) return;
    const taskId = deepLink.taskId;
    void (async () => {
      try {
        const detail = await taskSource.getAgentTask(taskId);
        library.mergeTask(detail.task);
        if (detail.task.groupId) {
          setSubView("teams");
          setSelectedGroupId(detail.task.groupId);
          setExpandedTaskId(taskId);
          syncUrl({ sub: "teams", group: detail.task.groupId, task: taskId });
        } else {
          setSubView("tasks");
          setLibTaskId(taskId);
          syncUrl({ sub: "tasks", task: taskId });
        }
      } catch {
        // 任务不存在/后端不可达：退到任务库（详情会给出错误面）
        setSubView("tasks");
        setLibTaskId(taskId);
        syncUrl({ sub: "tasks", task: taskId });
      }
    })();
    // 仅在深链任务变化时执行一次（library.mergeTask 为稳定引用）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLink?.taskId, tasksProbed]);

  // 打开团队：详情 + SSE 订阅（重进/切换时重订）
  useEffect(() => {
    if (!selectedGroupId) {
      setGroup(null);
      setMessages([]);
      return;
    }
    const controller = new AbortController();
    let alive = true;
    setError(null);

    void (async () => {
      try {
        const detail = await groupSource.getGroup(selectedGroupId);
        if (!alive) return;
        setGroup(detail.group);
        setMessages(detail.messages);
        const last = detail.messages[detail.messages.length - 1];
        const lastSeq = last?.seq ?? 0;
        for await (const ev of groupSource.streamGroup(selectedGroupId, lastSeq, controller.signal)) {
          if (!alive) return;
          if (ev.type === "snapshot") {
            setGroup(ev.group);
            setMessages((prev) => {
              const seen = new Set(prev.map((m) => m.seq));
              return [...prev, ...ev.messages.filter((m) => !seen.has(m.seq))];
            });
          } else if (ev.type === "message") {
            setMessages((prev) =>
              prev.some((m) => m.seq === ev.message.seq) ? prev : [...prev, ev.message],
            );
            if (ev.message.groupId === selectedGroupId) {
              setGroup((g) => (g ? { ...g, lastMessageAt: ev.message.createdAt } : g));
            }
          } else if (ev.type === "group") {
            setGroup(ev.group);
            setGroups((prev) => prev.map((g) => (g.id === ev.group.id ? ev.group : g)));
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
  }, [groupSource, selectedGroupId]);

  // 消息流自动滚底（任务卡展开时不抢滚动）
  useEffect(() => {
    if (expandedTaskId) return;
    streamEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, expandedTaskId]);

  const mergeGroupIntoList = useCallback((g: GroupInfo) => {
    setGroups((prev) => {
      const idx = prev.findIndex((x) => x.id === g.id);
      if (idx === -1) return [g, ...prev];
      const next = [...prev];
      next[idx] = g;
      return next;
    });
  }, []);

  const submitCreate = useCallback(async () => {
    if (!formName.trim() || formMembers.length === 0) {
      setFormError("请填写团队名并至少选择一个成员");
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const created = await groupSource.createGroup({
        name: formName.trim(),
        description: formDesc.trim() || undefined,
        members: formMembers,
        maxRounds: formRounds,
        idleTimeoutMs: Math.max(1, formIdleMinutes) * 60_000,
      });
      mergeGroupIntoList(created);
      setCreateOpen(false);
      setFormName("");
      setFormDesc("");
      setFormMembers([]);
      setFormRounds(3);
      setFormIdleMinutes(10);
      setSelectedGroupId(created.id);
      syncUrl({ sub: "teams", group: created.id });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [groupSource, formName, formDesc, formMembers, formRounds, formIdleMinutes, mergeGroupIntoList, syncUrl]);

  const send = useCallback(async () => {
    if (!selectedGroupId || !input.trim() || sending) return;
    setSending(true);
    try {
      await groupSource.sendGroupMessage(selectedGroupId, { content: input.trim() });
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [groupSource, selectedGroupId, input, sending]);

  /** 拍板（G3）：以 decision 消息发言并立即收口 */
  const decide = useCallback(async () => {
    if (!selectedGroupId || !input.trim() || sending) return;
    setSending(true);
    try {
      await groupSource.sendGroupMessage(selectedGroupId, { content: input.trim(), kind: "decision" });
      setInput("");
      const updated = await groupSource.getGroup(selectedGroupId);
      setGroup(updated.group);
      mergeGroupIntoList(updated.group);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [groupSource, selectedGroupId, input, sending, mergeGroupIntoList]);

  const conclude = useCallback(async () => {
    if (!selectedGroupId) return;
    try {
      const updated = await groupSource.concludeGroup(selectedGroupId);
      setGroup(updated);
      mergeGroupIntoList(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [groupSource, selectedGroupId, mergeGroupIntoList]);

  /** 关停（G3）：收口 + 取消该群未终态任务，显示取消数 */
  const stop = useCallback(async () => {
    if (!selectedGroupId) return;
    setStopNotice(null);
    try {
      const result = await groupSource.stopGroup(selectedGroupId);
      setGroup(result.group);
      mergeGroupIntoList(result.group);
      setStopNotice(
        result.cancelledTasks.length > 0
          ? `已关停：取消 ${result.cancelledTasks.length} 个在途任务（${result.cancelledTasks.map((t) => t.slice(0, 8)).join("、")}）`
          : "已关停：无在途任务需要取消",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [groupSource, selectedGroupId, mergeGroupIntoList]);

  /** 收口原因（G3）：最后一条带【收口】前缀的 system 消息 */
  const concludeReason = useMemo(() => {
    if (group?.status !== "concluded") return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m !== undefined && m.kind === "system" && m.content.startsWith("【收口】")) {
        return m.content.slice("【收口】".length);
      }
    }
    return "讨论已收口";
  }, [group?.status, messages]);

  /** 团队内派单（G2）：选成员 + 任务内容 → POST /api/agent-tasks（带 groupId，结果回群） */
  const dispatchableMembers = useMemo(() => {
    const enabled = new Set(library.runtimes.filter((r) => r.enabled).map((r) => r.name));
    const members = group?.members.filter((m) => enabled.has(m)) ?? [];
    return members.length > 0 ? members : [...enabled];
  }, [library.runtimes, group?.members]);

  useEffect(() => {
    setDispatchRuntime((prev) => prev || (dispatchableMembers[0] ?? ""));
  }, [dispatchableMembers]);

  const submitDispatch = useCallback(async () => {
    if (!selectedGroupId || !group || group.status === "concluded") return;
    if (!dispatchRuntime.trim() || !dispatchContent.trim()) {
      setDispatchError("请选择成员并填写任务内容");
      return;
    }
    setDispatching(true);
    setDispatchError(null);
    try {
      const task = await taskSource.createAgentTask({
        runtime: dispatchRuntime,
        content: dispatchContent,
        groupId: selectedGroupId,
        fromSession: "web-ui",
      });
      library.mergeTask(task);
      setDispatchContent("");
      setDispatchOpen(false);
      // 派出后跳任务库看新任务详情（真实后端下任务卡随后也会回到群里）
      setSubView("tasks");
      setLibTaskId(task.id);
      syncUrl({ sub: "tasks", group: selectedGroupId, task: task.id });
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : String(err));
    } finally {
      setDispatching(false);
    }
  }, [selectedGroupId, group, dispatchRuntime, dispatchContent, taskSource, library]);

  const refreshAll = useCallback(() => {
    void probeGroups();
    void probeTasks();
    void reload();
    void library.reload();
  }, [probeGroups, probeTasks, reload, library]);

  const anyMock = groupMockMode || taskMockMode;

  /* ------------------------------ 渲染 ------------------------------ */

  return (
    <section className="gr-page">
      <header className="gr-page__header">
        <div>
          <h1 className="gr-page__title">
            <Users className="gr-page__title-icon" aria-hidden="true" />
            agent 团队
          </h1>
          <p className="gr-page__subtitle">
            团队 = 群：聊天、派单、任务卡一个入口{anyMock ? "（演示数据：后端未就绪）" : ""}
          </p>
        </div>
        <div className="gr-page__actions">
          {anyMock ? <span className="ag-mock-badge">MOCK</span> : null}
          <button type="button" className="ag-btn ag-btn--ghost" onClick={refreshAll}>
            <RefreshCw size={14} aria-hidden="true" /> 刷新
          </button>
          <button
            type="button"
            className="ag-btn ag-btn--primary"
            onClick={() => {
              setSubView("teams");
              setCreateOpen(true);
            }}
          >
            <MessageSquarePlus size={14} aria-hidden="true" /> 新建团队
          </button>
        </div>
      </header>

      {/* 子视图分段控件 */}
      <div className="ag-filter tm-subnav" role="tablist">
        {(
          [
            ["teams", "团队"],
            ["tasks", `任务库 ${library.tasks.length || ""}`],
            ["members", "成员库"],
          ] as Array<[TeamsSubView, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={subView === key}
            className={`ag-filter__chip tm-subnav__chip ${subView === key ? "ag-filter__chip--active" : ""}`}
            onClick={() => changeSubView(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {groupMockMode && groupProbeError ? (
        <div className="ag-page__hint">团队后端探测失败：{groupProbeError}，已回退演示数据</div>
      ) : null}
      {taskMockMode && taskProbeError ? (
        <div className="ag-page__hint">任务后端探测失败：{taskProbeError}，已回退演示数据</div>
      ) : null}
      {error ? <div className="ag-page__hint ag-page__hint--error">{error}</div> : null}

      {/* ── 子视图：任务库 / 成员库 ─────────────────────────── */}
      {subView === "tasks" ? (
        <TaskLibraryView
          source={taskSource}
          tasks={library.tasks}
          runtimes={library.runtimes}
          loading={library.loading}
          error={library.error}
          selectedTaskId={libTaskId}
          onSelectTask={selectLibTask}
          mergeTask={library.mergeTask}
        />
      ) : subView === "members" ? (
        <RuntimeLibraryView runtimes={library.runtimes} loading={library.loading} />
      ) : (
        /* ── 子视图：团队（列表 + 详情）────────────────────── */
        <div className="gr-layout">
          <aside className="gr-list">
            {loading && groups.length === 0 ? (
              <div className="gr-list__empty">
                <Loader2 className="ag-page__spin" size={16} aria-hidden="true" /> 加载中…
              </div>
            ) : groups.length === 0 ? (
              <div className="gr-list__empty">还没有团队——点「新建团队」拉一支队伍</div>
            ) : (
              groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={`gr-list__item ${g.id === selectedGroupId ? "gr-list__item--active" : ""}`}
                  onClick={() => selectGroup(g.id)}
                >
                  <div className="gr-list__name">
                    {g.name}
                    {g.status === "concluded" ? (
                      <span className="ag-badge ag-badge--muted">已结束</span>
                    ) : (
                      <span className="ag-badge ag-badge--ok">进行中</span>
                    )}
                  </div>
                  <div className="gr-list__members">{g.members.join(" · ")}</div>
                  <div className="gr-list__time">{formatTime(g.lastMessageAt)}</div>
                </button>
              ))
            )}
          </aside>

          <div className="gr-chat">
            {!group ? (
              <div className="gr-chat__empty">
                <Users size={28} aria-hidden="true" />
                选择一个团队，或新建一个
              </div>
            ) : (
              <>
                <header className="gr-chat__header">
                  <div className="gr-chat__title">
                    <span className="gr-chat__name">{group.name}</span>
                    <span className="gr-chat__meta">
                      {group.members.join(" · ")} · 上限 {group.maxRounds} 轮 · 静默 {Math.round(group.idleTimeoutMs / 60_000)} 分钟
                    </span>
                  </div>
                  <div className="gr-chat__actions">
                    {group.status === "open" ? (
                      <>
                        <button type="button" className="ag-btn" onClick={() => void conclude()}>
                          <CheckCircle2 size={14} aria-hidden="true" /> 结束讨论
                        </button>
                        <button type="button" className="ag-btn ag-btn--danger" onClick={() => void stop()}>
                          <OctagonX size={14} aria-hidden="true" /> 关停
                        </button>
                      </>
                    ) : null}
                  </div>
                </header>

                {group.status === "concluded" ? (
                  <div className="gr-concluded-bar">
                    <CheckCircle2 size={13} aria-hidden="true" /> 已收口 — {concludeReason ?? "讨论已收口"}
                  </div>
                ) : null}
                {stopNotice ? <div className="gr-concluded-bar gr-concluded-bar--stop">{stopNotice}</div> : null}

                <div className="gr-msgs">
                  {messages.map((m) => (
                    <div key={m.id} className={`gr-msg ${m.kind === "system" ? "gr-msg--system" : ""}`}>
                      {m.kind === "system" ? (
                        <div className="gr-msg__sysline">{m.content}</div>
                      ) : m.kind === "task_card" && m.agentTaskId ? (
                        <>
                          <button
                            type="button"
                            className="gr-taskcard"
                            title={`展开任务详情：${m.agentTaskId}`}
                            aria-expanded={expandedTaskId === m.agentTaskId}
                            onClick={() =>
                              setExpandedTaskId((prev) => (prev === m.agentTaskId ? null : (m.agentTaskId ?? null)))
                            }
                          >
                            {(() => {
                              const badge = taskCardBadge(m.content);
                              return (
                                <>
                                  <span className={`gr-taskcard__badge ${badge.cls}`}>{badge.label}</span>
                                  <span className="gr-taskcard__content">{m.content}</span>
                                  <span className="gr-taskcard__link">
                                    {expandedTaskId === m.agentTaskId ? "收起 ↑" : "查看详情 →"}
                                  </span>
                                </>
                              );
                            })()}
                          </button>
                          {expandedTaskId === m.agentTaskId ? (
                            <div className="tm-taskcard-detail">
                              <div className="tm-taskcard-detail__bar">
                                <span>任务卡就地展开</span>
                                <button
                                  type="button"
                                  className="ag-btn ag-btn--mini ag-btn--ghost"
                                  onClick={() => {
                                    setSubView("tasks");
                                    setLibTaskId(m.agentTaskId ?? null);
                                    setExpandedTaskId(null);
                                    syncUrl({ sub: "tasks", group: selectedGroupId, task: m.agentTaskId });
                                  }}
                                >
                                  在任务库打开
                                </button>
                              </div>
                              <AgentTaskDetailView
                                source={taskSource}
                                taskId={m.agentTaskId}
                                onBack={() => setExpandedTaskId(null)}
                                onTaskUpdate={library.mergeTask}
                              />
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <div className={`gr-msg__avatar ${speakerClass(m)}`}>{initials(m.fromName)}</div>
                          <div className="gr-msg__body">
                            <div className="gr-msg__head">
                              <span className="gr-msg__speaker">{speakerLabel(m)}</span>
                              {m.kind === "decision" ? (
                                <span className="gr-msg__decision-tag">
                                  <Gavel size={9} aria-hidden="true" /> 拍板
                                </span>
                              ) : null}
                              <span className="gr-msg__time">{formatTime(m.createdAt)}</span>
                            </div>
                            <div className={`gr-msg__content ${m.kind === "decision" ? "gr-msg__content--decision" : ""}`}>
                              {m.content}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                  <div ref={streamEndRef} />
                </div>

                {/* 团队内派单表单（G2：带 groupId，结果以 task_card 回群） */}
                {dispatchOpen && group.status === "open" ? (
                  <div className="ag-form tm-dispatch">
                    <div className="ag-form__row">
                      <label className="ag-form__label" htmlFor="tm-dispatch-runtime">
                        派给成员
                      </label>
                      <select
                        id="tm-dispatch-runtime"
                        className="ag-form__select"
                        value={dispatchRuntime}
                        onChange={(e) => setDispatchRuntime(e.target.value)}
                      >
                        {dispatchableMembers.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="ag-form__row">
                      <label className="ag-form__label" htmlFor="tm-dispatch-content">
                        任务内容（结果会自动回到群里）
                      </label>
                      <textarea
                        id="tm-dispatch-content"
                        className="ag-form__textarea"
                        rows={3}
                        value={dispatchContent}
                        onChange={(e) => setDispatchContent(e.target.value)}
                        placeholder={`要派给 ${dispatchRuntime || "成员"} 的任务描述…`}
                      />
                    </div>
                    {dispatchError ? <div className="ag-form__error">{dispatchError}</div> : null}
                    <div className="ag-form__actions">
                      <button type="button" className="ag-btn ag-btn--ghost" onClick={() => setDispatchOpen(false)}>
                        取消
                      </button>
                      <button
                        type="button"
                        className="ag-btn ag-btn--primary"
                        disabled={dispatching}
                        onClick={() => void submitDispatch()}
                      >
                        {dispatching ? <Loader2 className="ag-page__spin" size={14} aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
                        派发
                      </button>
                    </div>
                  </div>
                ) : null}

                <footer className="gr-composer">
                  <textarea
                    className="gr-composer__input"
                    rows={2}
                    placeholder={group.status === "concluded" ? "讨论已结束，仅可回看" : "说点什么，或把任务丢进来…"}
                    disabled={group.status === "concluded" || sending}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="gr-composer__btns">
                    {group.status === "open" ? (
                      <>
                        <button
                          type="button"
                          className="ag-btn"
                          disabled={dispatching || dispatchableMembers.length === 0}
                          title="给团队成员派任务（结果自动回群）"
                          onClick={() => setDispatchOpen((v) => !v)}
                        >
                          <Send size={14} aria-hidden="true" /> 派任务
                        </button>
                        <button
                          type="button"
                          className="ag-btn"
                          disabled={sending || input.trim() === ""}
                          title="以此内容拍板并收口讨论"
                          onClick={() => void decide()}
                        >
                          <Gavel size={14} aria-hidden="true" /> 拍板
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="ag-btn ag-btn--primary"
                      disabled={group.status === "concluded" || sending || input.trim() === ""}
                      onClick={() => void send()}
                    >
                      {sending ? (
                        <Loader2 className="ag-page__spin" size={14} aria-hidden="true" />
                      ) : (
                        <Send size={14} aria-hidden="true" />
                      )}
                      发送
                    </button>
                  </div>
                </footer>
              </>
            )}
          </div>
        </div>
      )}

      {/* 新建团队对话框 */}
      {createOpen ? (
        <div className="gr-modal">
          <div className="gr-modal__panel">
            <h2 className="gr-modal__title">新建团队</h2>
            <div className="ag-form__row">
              <label className="ag-form__label" htmlFor="gr-form-name">团队名</label>
              <input
                id="gr-form-name"
                className="ag-form__select"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="如：周报攻坚组"
              />
            </div>
            <div className="ag-form__row">
              <label className="ag-form__label" htmlFor="gr-form-desc">说明（可选）</label>
              <input
                id="gr-form-desc"
                className="ag-form__select"
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                placeholder="这个团队要解决什么"
              />
            </div>
            <div className="ag-form__row">
              <span className="ag-form__label">成员（多选）</span>
              <div className="gr-modal__members">
                {groupRuntimes
                  .filter((r) => r.enabled)
                  .map((r) => (
                    <button
                      key={r.name}
                      type="button"
                      className={`gr-member-chip ${formMembers.includes(r.name) ? "gr-member-chip--on" : ""}`}
                      onClick={() =>
                        setFormMembers((prev) =>
                          prev.includes(r.name) ? prev.filter((x) => x !== r.name) : [...prev, r.name],
                        )
                      }
                    >
                      {r.name}
                    </button>
                  ))}
              </div>
            </div>
            <div className="ag-form__row">
              <label className="ag-form__label" htmlFor="gr-form-rounds">编排轮上限</label>
              <input
                id="gr-form-rounds"
                className="ag-form__select"
                type="number"
                min={1}
                max={10}
                value={formRounds}
                onChange={(e) => setFormRounds(Number(e.target.value) || 3)}
              />
            </div>
            <div className="ag-form__row">
              <label className="ag-form__label" htmlFor="gr-form-idle">静默超时（分钟，超过自动收口）</label>
              <input
                id="gr-form-idle"
                className="ag-form__select"
                type="number"
                min={1}
                max={120}
                value={formIdleMinutes}
                onChange={(e) => setFormIdleMinutes(Number(e.target.value) || 10)}
              />
            </div>
            {formError ? <div className="ag-form__error">{formError}</div> : null}
            <div className="ag-form__actions">
              <button type="button" className="ag-btn ag-btn--ghost" onClick={() => setCreateOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="ag-btn ag-btn--primary"
                disabled={creating}
                onClick={() => void submitCreate()}
              >
                {creating ? <Loader2 className="ag-page__spin" size={14} aria-hidden="true" /> : null}
                创建
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
