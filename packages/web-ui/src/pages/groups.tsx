/**
 * @fengagent/web-ui — 群聊页（G1）
 *
 * 左侧群列表（名称/成员/状态/最近消息时间）+ 右侧群聊视图：
 * - 消息流（human / runtime / coordinator / system 四类发言者，chat/task_card/decision/system 四类消息）
 * - 输入框发消息（human）、「结束讨论」收口（幂等）、SSE 实时更新
 * - 建群对话框：群名 + 成员多选（runtime 卡片）+ maxRounds
 * - 后端 G1 未落地时自动回退 mock 数据源（groups-mock.ts），`?mock=1` 强制
 *
 * URL：?view=groups。设计 token 与 Agents 页同套（ag-* 变量体系 + light 默认）。
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

interface GroupsPageProps {
  client: ApiClient;
  /** 视图导航（群任务卡深链跳 Agents 页详情） */
  onNavigate?: (view: AppView, target?: DeepLinkTarget) => void;
}

/** 页面数据源最小接口（client 与 mock 共同满足） */
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
  streamGroup(groupId: string, after?: number, signal?: AbortSignal): AsyncGenerator<GroupStreamEvent>;
}

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

/** 群数据源：真实 API 优先，失败回退 mock（G1 后端未落地阶段） */
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
      // G1 后端未就绪 → 回退演示数据
      setMockMode(true);
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbed(true);
    }
  }, [client, forceMock]);

  return { source, mockMode, probeError, probe, probed };
}

export function GroupsPage({ client, onNavigate }: GroupsPageProps) {
  const forceMock = useMemo(() => {
    return new URLSearchParams(window.location.search).get("mock") === "1";
  }, []);
  const { source, mockMode, probeError, probe, probed } = useGroupSource(client, forceMock);

  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [runtimes, setRuntimes] = useState<Array<{ name: string; enabled: boolean; agentName: string }>>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 群聊视图状态
  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const streamEndRef = useRef<HTMLDivElement | null>(null);

  // 建群对话框
  const [createOpen, setCreateOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formMembers, setFormMembers] = useState<string[]>([]);
  const [formRounds, setFormRounds] = useState(3);
  const [formIdleMinutes, setFormIdleMinutes] = useState(10);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 关停结果提示
  const [stopNotice, setStopNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await source.listGroups();
      setGroups(list.groups);
      setRuntimes(list.runtimes);
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
    if (probed) void reload();
  }, [probed, reload]);

  // 列表轮询（mock 1s 演进、真实 5s 刷新最近消息时间）
  useEffect(() => {
    if (!probed) return;
    const timer = setInterval(() => void reload(), mockMode ? 1_500 : 5_000);
    return () => clearInterval(timer);
  }, [mockMode, probed, reload]);

  // 打开群：详情 + SSE 订阅（重进/切换群时重订）
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
        const detail = await source.getGroup(selectedGroupId);
        if (!alive) return;
        setGroup(detail.group);
        setMessages(detail.messages);
        const last = detail.messages[detail.messages.length - 1];
        const lastSeq = last?.seq ?? 0;
        for await (const ev of source.streamGroup(selectedGroupId, lastSeq, controller.signal)) {
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
  }, [source, selectedGroupId]);

  // 消息流自动滚底
  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

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
      setFormError("请填写群名并至少选择一个成员");
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const created = await source.createGroup({
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
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [source, formName, formDesc, formMembers, formRounds, formIdleMinutes, mergeGroupIntoList]);

  const send = useCallback(async () => {
    if (!selectedGroupId || !input.trim() || sending) return;
    setSending(true);
    try {
      await source.sendGroupMessage(selectedGroupId, { content: input.trim() });
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [source, selectedGroupId, input, sending]);

  /** 拍板（G3）：以 decision 消息发言并立即收口 */
  const decide = useCallback(async () => {
    if (!selectedGroupId || !input.trim() || sending) return;
    setSending(true);
    try {
      await source.sendGroupMessage(selectedGroupId, { content: input.trim(), kind: "decision" });
      setInput("");
      const updated = await source.getGroup(selectedGroupId);
      setGroup(updated.group);
      mergeGroupIntoList(updated.group);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [source, selectedGroupId, input, sending, mergeGroupIntoList]);

  const conclude = useCallback(async () => {
    if (!selectedGroupId) return;
    try {
      const updated = await source.concludeGroup(selectedGroupId);
      setGroup(updated);
      mergeGroupIntoList(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [source, selectedGroupId, mergeGroupIntoList]);

  /** 关停（G3）：收口 + 取消该群未终态任务，显示取消数 */
  const stop = useCallback(async () => {
    if (!selectedGroupId) return;
    setStopNotice(null);
    try {
      const result = await source.stopGroup(selectedGroupId);
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
  }, [source, selectedGroupId, mergeGroupIntoList]);

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

  return (
    <section className="gr-page">
      <header className="gr-page__header">
        <div>
          <h1 className="gr-page__title">
            <Users className="gr-page__title-icon" aria-hidden="true" />
            群聊
          </h1>
          <p className="gr-page__subtitle">
            任务丢进群，多个 agent 一起讨论解决{mockMode ? "（演示数据：G1 后端未就绪）" : ""}
          </p>
        </div>
        <div className="gr-page__actions">
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
            onClick={() => setCreateOpen(true)}
          >
            <MessageSquarePlus size={14} aria-hidden="true" /> 建群
          </button>
        </div>
      </header>

      {mockMode && probeError ? (
        <div className="ag-page__hint">后端探测失败：{probeError}，已回退演示数据</div>
      ) : null}
      {error ? <div className="ag-page__hint ag-page__hint--error">{error}</div> : null}

      <div className="gr-layout">
        {/* 群列表 */}
        <aside className="gr-list">
          {loading && groups.length === 0 ? (
            <div className="gr-list__empty">
              <Loader2 className="ag-page__spin" size={16} aria-hidden="true" /> 加载中…
            </div>
          ) : groups.length === 0 ? (
            <div className="gr-list__empty">还没有群——点「建群」拉一支队伍</div>
          ) : (
            groups.map((g) => (
              <button
                key={g.id}
                type="button"
                className={`gr-list__item ${g.id === selectedGroupId ? "gr-list__item--active" : ""}`}
                onClick={() => setSelectedGroupId(g.id)}
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

        {/* 群聊视图 */}
        <div className="gr-chat">
          {!group ? (
            <div className="gr-chat__empty">
              <Users size={28} aria-hidden="true" />
              选择一个群，或新建一个
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
                      <button
                        type="button"
                        className="gr-taskcard"
                        title={`跳转任务详情：${m.agentTaskId}`}
                        onClick={() => {
                          onNavigate?.("agents", { taskId: m.agentTaskId });
                        }}
                      >
                        <span className={`gr-taskcard__badge ${m.content.includes("已完成") ? "gr-taskcard__badge--ok" : m.content.includes("失败") ? "gr-taskcard__badge--error" : ""}`}>
                          {m.content.includes("已完成") ? "已完成" : m.content.includes("失败") ? "失败" : m.content.includes("已取消") ? "已取消" : "任务"}
                        </span>
                        <span className="gr-taskcard__content">{m.content}</span>
                        <span className="gr-taskcard__link">查看详情 →</span>
                      </button>
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
                    <button
                      type="button"
                      className="ag-btn"
                      disabled={sending || input.trim() === ""}
                      title="以此内容拍板并收口讨论"
                      onClick={() => void decide()}
                    >
                      <Gavel size={14} aria-hidden="true" /> 拍板
                    </button>
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

      {/* 建群对话框 */}
      {createOpen ? (
        <div className="gr-modal">
          <div className="gr-modal__panel">
            <h2 className="gr-modal__title">建群</h2>
            <div className="ag-form__row">
              <label className="ag-form__label" htmlFor="gr-form-name">群名</label>
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
                placeholder="这个群要解决什么"
              />
            </div>
            <div className="ag-form__row">
              <span className="ag-form__label">成员（多选）</span>
              <div className="gr-modal__members">
                {runtimes
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
