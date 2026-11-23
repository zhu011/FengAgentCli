/**
 * @fengagent/web-ui — 智能体视图（AI 团队平台 P0：agent 实体化）
 *
 * 团队页第五个子视图：智能体列表 + 详情四页签（概览 / 运行历史 / 配置 / 设置）。
 * 契约对齐 spec §5.1：列表（runtime 徽标 + 7d 计数）、创建（含内置模板一键创建）、
 * runtime 绑定（1:1，null=解绑）、归档（软删）、概览指标卡、三类历史（session/dispatch/group）。
 *
 * 数据源：真实 API 优先，探测失败回退 AgentsMock（与技能库/成员库同模式）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Bot,
  ChevronLeft,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { ApiClient } from "../api/client.ts";
import { AgentsMock, type AgentSource } from "../api/agents-mock.ts";
import type {
  AgentCard,
  AgentDetail,
  AgentRun,
  AgentSkillMount,
  AgentTemplate,
} from "../api/types.ts";

/** runtime 徽标样式 */
function runtimeBadgeClass(status: AgentCard["runtimeStatus"]): string {
  switch (status) {
    case "online":
      return "ag-badge ag-badge--ok";
    case "offline":
      return "ag-badge ag-badge--error";
    case "unprobed":
      return "ag-badge ag-badge--pending";
    default:
      return "ag-badge ag-badge--muted";
  }
}

const RUNTIME_STATUS_LABEL: Record<AgentCard["runtimeStatus"], string> = {
  online: "在线",
  offline: "离线",
  unprobed: "未探测",
  unbound: "未绑定",
};

const KIND_LABEL: Record<AgentRun["kind"], string> = {
  session: "会话",
  dispatch: "派单",
  group: "群聊",
  squad: "小队",
};

/** 运行状态 → 中文（后端归一状态：created/dispatched/running/replied/completed/failed/cancelled/expired…） */
const RUN_STATUS_LABEL: Record<string, string> = {
  created: "已创建",
  dispatched: "已派发",
  running: "运行中",
  replied: "已完成",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  expired: "已过期",
  queued: "排队中",
  /** P2-2 等待态：等负责人/队长审批时非终态停留，裁决后续跑 */
  waiting_approval: "等待审批",
};

function runStatusLabel(status: string): string {
  return RUN_STATUS_LABEL[status] ?? status;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function formatTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hhmm : `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

/** 智能体子视图（团队页）：列表 ⇄ 详情 */
export function AgentsView({ client }: { client: ApiClient }) {
  const forceMock = useMemo(
    () => new URLSearchParams(window.location.search).get("mock") === "1",
    [],
  );
  const mockRef = useRef<AgentsMock | null>(null);
  const [mockMode, setMockMode] = useState(false);

  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 创建表单
  const [createOpen, setCreateOpen] = useState(false);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [pickedTemplate, setPickedTemplate] = useState<string>("");
  const [newId, setNewId] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRuntime, setNewRuntime] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const useSource = useCallback((): AgentSource => {
    if (mockMode) {
      mockRef.current ??= new AgentsMock();
      return mockRef.current;
    }
    return client;
  }, [mockMode, client]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAgents(await useSource().listAgents());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [useSource]);

  // 探测：真实 API 失败回退 mock（后端未落地阶段）
  useEffect(() => {
    void (async () => {
      if (forceMock) {
        setMockMode(true);
        return;
      }
      try {
        await client.listAgents();
        setMockMode(false);
      } catch {
        setMockMode(true);
      }
    })();
  }, [client, forceMock]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 模板加载（创建表单打开时拉一次）
  useEffect(() => {
    if (!createOpen) return;
    void (async () => {
      try {
        setTemplates(await useSource().listAgentTemplates());
      } catch {
        setTemplates([]);
      }
    })();
  }, [createOpen, useSource]);

  async function createAgent() {
    if (creating) return;
    const id = newId.trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      setCreateError("id 必填：小写字母/数字/连字符（kebab-case，作目录名）");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await useSource().createAgent({
        id,
        displayName: newDisplayName.trim() || undefined,
        ...(pickedTemplate ? { template: pickedTemplate } : {}),
        ...(newRuntime.trim() ? { runtime: newRuntime.trim() } : {}),
      });
      setCreateOpen(false);
      setNewId("");
      setNewDisplayName("");
      setNewRuntime("");
      setPickedTemplate("");
      await reload();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setCreating(false);
    }
  }

  if (selectedId) {
    return (
      <AgentDetailView
        source={useSource()}
        client={client}
        id={selectedId}
        onBack={() => {
          setSelectedId(null);
          void reload();
        }}
      />
    );
  }

  return (
    <div className="ag-section">
      <div className="tm-libhead">
        <h2 className="ag-section__title">
          <Bot size={14} aria-hidden="true" /> 智能体
        </h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="ag-btn ag-btn--primary"
            onClick={() => {
              setCreateOpen((v) => !v);
              setCreateError(null);
            }}
          >
            <Plus size={14} aria-hidden="true" /> 创建智能体
          </button>
          <button type="button" className="ag-btn" onClick={() => void reload()}>
            <RefreshCw size={14} aria-hidden="true" /> 刷新
          </button>
        </div>
      </div>

      {mockMode && (
        <div className="ag-page__hint">智能体后端未就绪，已回退演示数据（真实 /api/agents 落地后自动切换）</div>
      )}
      {error && <div className="ag-page__hint ag-page__hint--error">{error}</div>}

      {/* 创建表单：手填 或 内置模板一键创建（模板预填指令） */}
      {createOpen && (
        <div className="ag-form" data-testid="agent-create-form">
          <div className="tm-libhead">
            <h3 className="ag-section__title">创建智能体</h3>
          </div>
          {createError && <div className="ag-page__hint ag-page__hint--error">{createError}</div>}

          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="ag-id">id（目录名）</label>
            <input
              id="ag-id"
              className="ag-form__select"
              value={newId}
              placeholder="如 coder-reviewer（kebab-case）"
              onChange={(e) => setNewId(e.target.value)}
            />
          </div>
          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="ag-name">展示名</label>
            <input
              id="ag-name"
              className="ag-form__select"
              value={newDisplayName}
              placeholder="可留空（模板/后端给默认）"
              onChange={(e) => setNewDisplayName(e.target.value)}
            />
          </div>
          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="ag-runtime">绑定 runtime</label>
            <input
              id="ag-runtime"
              className="ag-form__select"
              value={newRuntime}
              placeholder="注册名（如 dsh / kimi / claude），可留空稍后绑"
              onChange={(e) => setNewRuntime(e.target.value)}
            />
          </div>
          <div className="ag-form__row">
            <label className="ag-form__label">内置模板（一键创建，预填指令）</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} data-testid="agent-template-list">
              {templates.length === 0 ? (
                <span className="ag-runtime-card__meta">（暂无模板）</span>
              ) : (
                templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`ag-btn ag-btn--mini ${pickedTemplate === t.id ? "ag-btn--primary" : ""}`}
                    title={t.instructions.slice(0, 120)}
                    onClick={() => setPickedTemplate((p) => (p === t.id ? "" : t.id))}
                  >
                    {pickedTemplate === t.id ? "✓ " : ""}
                    {t.displayName}
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="ag-form__actions">
            <button
              type="button"
              className="ag-btn ag-btn--primary"
              disabled={creating}
              onClick={() => void createAgent()}
            >
              {creating ? <Loader2 className="ag-page__spin" size={14} aria-hidden="true" /> : null}
              创建
            </button>
            <button
              type="button"
              className="ag-btn ag-btn--ghost"
              onClick={() => {
                setCreateOpen(false);
                setCreateError(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {agents.length === 0 && !loading ? (
        <div className="ag-page__empty">暂无智能体 — 用上方「创建智能体」或从内置模板一键创建</div>
      ) : (
        <div className="ag-runtime-grid">
          {agents.map((a) => (
            <div
              key={a.id}
              className="ag-runtime-card"
              data-testid="agent-card"
              data-agent-id={a.id}
              role="button"
              tabIndex={0}
              style={{ cursor: "pointer" }}
              onClick={() => setSelectedId(a.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setSelectedId(a.id);
              }}
            >
              <div className="ag-runtime-card__head">
                <span className="ag-runtime-card__name">{a.displayName}</span>
                <span className={runtimeBadgeClass(a.runtimeStatus)}>
                  {a.runtime ? `${a.runtime} · ${RUNTIME_STATUS_LABEL[a.runtimeStatus]}` : "未绑定"}
                </span>
              </div>
              <div className="ag-runtime-card__meta">{a.id}</div>
              <div className="ag-runtime-card__meta" style={{ opacity: 0.7 }}>
                {a.description || "（无描述）"}
              </div>
              <div className="ag-runtime-card__chips">
                <span className="ag-chip ag-chip--muted">7d 运行 {a.runs7d}</span>
                {a.lastRunStatus && (
                  <span className={`ag-chip ${a.lastRunStatus === "replied" ? "" : "ag-chip--muted"}`}>
                    最近 {a.lastRunStatus ? runStatusLabel(a.lastRunStatus) : ""}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────── 详情 ────────────────────────────── */

type DetailTab = "overview" | "runs" | "config" | "settings";

function AgentDetailView({
  source,
  client,
  id,
  onBack,
}: {
  source: AgentSource;
  client: ApiClient;
  id: string;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await source.getAgent(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [source, id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading && !detail) {
    return (
      <div className="ag-page__empty">
        <Loader2 className="ag-page__spin" size={16} aria-hidden="true" /> 加载中…
      </div>
    );
  }
  if (error && !detail) {
    return (
      <div className="ag-section">
        <div className="ag-page__hint ag-page__hint--error">{error}</div>
        <button type="button" className="ag-btn" onClick={onBack}>
          <ChevronLeft size={14} aria-hidden="true" /> 返回列表
        </button>
      </div>
    );
  }
  if (!detail) return null;

  return (
    <div className="ag-section">
      <div className="tm-libhead">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" className="ag-btn ag-btn--ghost" onClick={onBack} aria-label="返回列表">
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <h2 className="ag-section__title" style={{ margin: 0 }}>
            <Bot size={14} aria-hidden="true" /> {detail.displayName}
            <span className="ag-runtime-card__meta" style={{ marginLeft: 8 }}>/ {detail.id}</span>
          </h2>
        </div>
        <span className={runtimeBadgeClass(detail.runtimeStatus)}>
          {detail.runtime ? `${detail.runtime} · ${RUNTIME_STATUS_LABEL[detail.runtimeStatus]}` : "未绑定"}
        </span>
      </div>

      {/* 详情页签 */}
      <div className="ag-filter tm-subnav" role="tablist">
        {(
          [
            ["overview", "概览"],
            ["runs", "运行历史"],
            ["config", "配置"],
            ["settings", "设置"],
          ] as Array<[DetailTab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`ag-filter__chip tm-subnav__chip ${tab === key ? "ag-filter__chip--active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="ag-page__hint ag-page__hint--error">{error}</div>}

      {tab === "overview" ? <AgentOverviewPane source={source} id={id} /> : null}
      {tab === "runs" ? <AgentRunsPane source={source} id={id} /> : null}
      {tab === "config" ? (
        <AgentConfigPane
          detail={detail}
          source={source}
          client={client}
          onChanged={() => void reload()}
        />
      ) : null}
      {tab === "settings" ? (
        <AgentSettingsPane
          detail={detail}
          source={source}
          onChanged={() => void reload()}
        />
      ) : null}
    </div>
  );
}

/* ────────────────────────────── 概览 ────────────────────────────── */

function AgentOverviewPane({ source, id }: { source: AgentSource; id: string }) {
  const [overview, setOverview] = useState<Awaited<ReturnType<AgentSource["getAgentOverview"]>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setOverview(await source.getAgentOverview(id));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [source, id]);

  if (error) return <div className="ag-page__hint ag-page__hint--error">{error}</div>;
  if (!overview) {
    return (
      <div className="ag-page__empty">
        <Loader2 className="ag-page__spin" size={16} aria-hidden="true" /> 加载中…
      </div>
    );
  }

  const successRate =
    overview.counters.runs7d > 0
      ? Math.round((overview.counters.success7d / overview.counters.runs7d) * 100)
      : 0;

  return (
    <div data-testid="agent-overview">
      {/* 指标卡 */}
      <div className="ag-runtime-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
        {(
          [
            ["7d 运行", String(overview.counters.runs7d)],
            ["成功率", `${successRate}%`],
            ["失败", String(overview.counters.failed7d)],
            ["平均耗时", formatDuration(overview.counters.avgDurationMs || null)],
            ["7d tokens", overview.counters.tokens7d.toLocaleString()],
          ] as Array<[string, string]>
        ).map(([label, value]) => (
          <div key={label} className="ag-runtime-card" style={{ padding: "10px 12px" }}>
            <div className="ag-runtime-card__meta" style={{ opacity: 0.7 }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>{value}</div>
          </div>
        ))}
      </div>

      {/* 资产计数 */}
      <div className="ag-runtime-card__chips" style={{ marginTop: 10 }}>
        <span className="ag-chip">skills {overview.assets.skills}</span>
        <span className="ag-chip">mcp {overview.assets.mcps}</span>
        <span className="ag-chip ag-chip--muted">env {overview.assets.envKeys}</span>
      </div>

      {overview.lastError && (
        <div className="ag-page__hint ag-page__hint--error" style={{ marginTop: 10 }}>
          最近错误：{overview.lastError.message}
        </div>
      )}

      {/* 最近 10 次运行 */}
      <h3 className="ag-section__title" style={{ marginTop: 16 }}>最近运行</h3>
      {overview.recentRuns.length === 0 ? (
        <div className="ag-page__empty">暂无运行记录</div>
      ) : (
        <div className="ag-page__table-wrap" style={{ maxHeight: 320 }}>
          <table className="ag-page__table">
            <thead>
              <tr>
                <th>类型</th>
                <th>标题</th>
                <th>状态</th>
                <th>开始</th>
                <th>耗时</th>
              </tr>
            </thead>
            <tbody>
              {overview.recentRuns.map((r) => (
                <tr key={r.id}>
                  <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td>{r.title}</td>
                  <td>{runStatusLabel(r.status)}</td>
                  <td>{formatTime(r.startedAt)}</td>
                  <td>{formatDuration(r.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────── 运行历史 ────────────────────────────── */

function AgentRunsPane({ source, id }: { source: AgentSource; id: string }) {
  const [kind, setKind] = useState<"" | AgentRun["kind"]>("");
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await source.listAgentRuns(id, kind ? { kind, limit: 50 } : { limit: 50 });
      setRuns(res.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [source, id, kind]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div data-testid="agent-runs">
      <div className="ag-filter tm-subnav" role="tablist">
        {(
          [
            ["", "全部"],
            ["session", "会话"],
            ["dispatch", "派单"],
            ["group", "群聊"],
          ] as Array<["" | AgentRun["kind"], string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={kind === key}
            className={`ag-filter__chip tm-subnav__chip ${kind === key ? "ag-filter__chip--active" : ""}`}
            onClick={() => setKind(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <div className="ag-page__hint ag-page__hint--error">{error}</div>}
      {loading ? (
        <div className="ag-page__empty">
          <Loader2 className="ag-page__spin" size={16} aria-hidden="true" /> 加载中…
        </div>
      ) : runs.length === 0 ? (
        <div className="ag-page__empty">该过滤条件下暂无运行记录</div>
      ) : (
        <div className="ag-page__table-wrap" style={{ maxHeight: 480 }}>
          <table className="ag-page__table">
            <thead>
              <tr>
                <th>类型</th>
                <th>标题</th>
                <th>状态</th>
                <th>开始</th>
                <th>耗时</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td>{r.title}</td>
                  <td>{runStatusLabel(r.status)}</td>
                  <td>{formatTime(r.startedAt)}</td>
                  <td>{formatDuration(r.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────── 配置（指令编辑 + runtime 绑定） ────────────────────────────── */

function AgentConfigPane({
  detail,
  source,
  client,
  onChanged,
}: {
  detail: AgentDetail;
  source: AgentSource;
  client: ApiClient;
  onChanged: () => void;
}) {
  const [instructions, setInstructions] = useState(detail.instructions);
  const [runtime, setRuntime] = useState(detail.runtime ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setInstructions(detail.instructions);
    setRuntime(detail.runtime ?? "");
  }, [detail]);

  async function save(patch: Parameters<AgentSource["updateAgent"]>[1]) {
    if (saving) return;
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      await source.updateAgent(detail.id, patch);
      setMsg("已保存（立即生效）");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ag-form" data-testid="agent-config">
      {err && <div className="ag-page__hint ag-page__hint--error">{err}</div>}
      {msg && <div className="ag-page__hint">{msg}</div>}

      {/* runtime 绑定（1:1；空 = 解绑，历史保留） */}
      <div className="ag-form__row">
        <label className="ag-form__label" htmlFor="ag-rt">绑定 runtime（1:1；清空 = 解绑，历史保留）</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="ag-rt"
            className="ag-form__select"
            value={runtime}
            placeholder="runtime 注册名（对应成员库）"
            onChange={(e) => setRuntime(e.target.value)}
          />
          <button
            type="button"
            className="ag-btn"
            disabled={saving}
            onClick={() => void save({ runtime: runtime.trim() || null })}
          >
            {saving ? <Loader2 className="ag-page__spin" size={14} aria-hidden="true" /> : null}
            保存绑定
          </button>
        </div>
      </div>

      {/* 指令（= agent.md 正文 / system prompt） */}
      <div className="ag-form__row">
        <label className="ag-form__label" htmlFor="ag-ins">指令（system prompt，markdown）</label>
        <textarea
          id="ag-ins"
          className="ag-form__select"
          rows={10}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </div>
      <div className="ag-form__actions">
        <button
          type="button"
          className="ag-btn ag-btn--primary"
          disabled={saving}
          onClick={() => void save({ instructions })}
        >
          保存指令
        </button>
      </div>

      {/* skill 挂载管理（P1：添加/启停/卸载；卸载只删关系不删内容） */}
      <AgentSkillMountsPane agentId={detail.id} client={client} />

      {/* mcp 挂载（只读；MCP 集成在 P3 开放） */}
      <div className="ag-form__row">
        <label className="ag-form__label">MCP（挂载管理在 P3 开放）</label>
        <div className="ag-runtime-card__chips">
          {detail.mcp.map((m) => (
            <span key={m} className="ag-chip">mcp · {m}</span>
          ))}
          {detail.mcp.length === 0 && <span className="ag-chip ag-chip--muted">（无）</span>}
        </div>
      </div>
    </div>
  );
}

/* ────────────── skill 挂载（P1：列表 + 添加 + 启停 + 卸载） ────────────── */

function AgentSkillMountsPane({ agentId, client }: { agentId: string; client: ApiClient }) {
  const [mounts, setMounts] = useState<AgentSkillMount[]>([]);
  const [libraryNames, setLibraryNames] = useState<string[]>([]);
  const [addName, setAddName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 后端 /api/agents/:id/skills 未就绪时（P1 后端在制）回退详情里的 skills 只读展示 */
  const [fallback, setFallback] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [m, view] = await Promise.all([
        client.listAgentSkills(agentId),
        client.listSkills(true),
      ]);
      setMounts(m);
      // 库里未挂载的技能（候选）——三层合并视图取胜出名
      setLibraryNames(view.skills.map((s) => s.name).filter((n) => !m.some((x) => x.name === n)));
      setFallback(false);
      setErr(null);
    } catch {
      setFallback(true);
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function mutate(fn: () => Promise<AgentSkillMount[]>) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      setMounts(await fn());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  if (fallback) {
    return (
      <div className="ag-form__row">
        <label className="ag-form__label">Skill 挂载（管理接口未就绪 — 后端 P1 落地后开放）</label>
        <div className="ag-runtime-card__chips">
          <span className="ag-chip ag-chip--muted">等待 /api/agents/:id/skills</span>
        </div>
      </div>
    );
  }

  return (
    <div className="ag-form__row" data-testid="agent-skills-mount">
      <label className="ag-form__label">Skill 挂载（卸载只删关系，不删技能库内容）</label>
      {err && <div className="ag-page__hint ag-page__hint--error">{err}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {mounts.map((m) => (
          <div key={m.name} className="permission-grants__item" data-mounted-skill={m.name}>
            <span className="permission-grants__tool" title={m.shadowed ? "被本目录同名文件覆盖" : undefined}>
              {m.name}
            </span>
            <span className={`permission-grants__badge ${m.enabled ? "permission-grants__badge--allow" : "permission-grants__badge--muted"}`}>
              {m.enabled ? "启用" : "停用"}
            </span>
            <button
              type="button"
              className="permission-grants__revoke"
              disabled={busy}
              onClick={() => void mutate(() => client.setAgentSkillEnabled(agentId, m.name, !m.enabled))}
            >
              {m.enabled ? "停用" : "启用"}
            </button>
            <button
              type="button"
              className="permission-grants__revoke"
              disabled={busy}
              title="卸载挂载（技能库内容保留）"
              onClick={() => void mutate(() => client.removeAgentSkill(agentId, m.name))}
            >
              卸载
            </button>
          </div>
        ))}
        {mounts.length === 0 && (
          <span className="ag-runtime-card__meta" style={{ opacity: 0.7 }}>（未挂载任何技能）</span>
        )}
      </div>
      {/* 添加挂载：下拉选库中未挂载的技能 */}
      <div className="permission-add" style={{ marginTop: 8 }}>
        <select
          className="permission-add__select"
          aria-label="选择技能"
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
        >
          <option value="">选择技能库中的技能…</option>
          {libraryNames.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <button
          type="button"
          className="permission-add__btn"
          disabled={busy || addName === ""}
          onClick={() => {
            void mutate(() => client.addAgentSkill(agentId, addName));
            setAddName("");
          }}
        >
          <Plus size={12} aria-hidden="true" /> 挂载
        </button>
      </div>
    </div>
  );
}

/* ────────────────────────────── 设置（env/args + 归档） ────────────────────────────── */

function AgentSettingsPane({
  detail,
  source,
  onChanged,
}: {
  detail: AgentDetail;
  source: AgentSource;
  onChanged: () => void;
}) {
  const [envText, setEnvText] = useState(
    Object.entries(detail.env).map(([k, v]) => `${k}=${v}`).join("\n"),
  );
  const [argsText, setArgsText] = useState(detail.args.join(" "));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  useEffect(() => {
    setEnvText(Object.entries(detail.env).map(([k, v]) => `${k}=${v}`).join("\n"));
    setArgsText(detail.args.join(" "));
  }, [detail]);

  function parseEnv(raw: string): { env: Record<string, string>; errors: string[] } {
    const env: Record<string, string> = {};
    const errors: string[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) {
        errors.push(`环境变量行缺少 KEY=VALUE 格式：${t.slice(0, 40)}`);
        continue;
      }
      env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return { env, errors };
  }

  async function saveSettings() {
    if (saving) return;
    const { env, errors } = parseEnv(envText);
    const args = argsText.trim() === "" ? [] : argsText.trim().split(/\s+/);
    if (errors.length > 0) {
      setErr(errors.join("；"));
      return;
    }
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      await source.updateAgent(detail.id, { env, args });
      setMsg("设置已保存");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    try {
      await source.archiveAgent(detail.id);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "归档失败");
    } finally {
      setConfirmArchive(false);
    }
  }

  return (
    <div className="ag-form" data-testid="agent-settings">
      {err && <div className="ag-page__hint ag-page__hint--error">{err}</div>}
      {msg && <div className="ag-page__hint">{msg}</div>}

      {/* 敏感值只显掩码（后端契约：GET 不回显明文） */}
      {detail.envSecrets.length > 0 && (
        <div className="ag-form__row">
          <label className="ag-form__label">敏感变量（只存引用，不回显明文）</label>
          <div className="ag-runtime-card__chips">
            {detail.envSecrets.map((s) => (
              <span key={s.key} className="ag-chip ag-chip--muted" title="值存于 secrets 引用，界面不可见">
                {s.key} = {s.masked}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="ag-form__row">
        <label className="ag-form__label" htmlFor="ag-env">环境变量（逐行 KEY=VALUE）</label>
        <textarea
          id="ag-env"
          className="ag-form__select"
          rows={5}
          value={envText}
          placeholder={"NODE_ENV=development\nHTTP_PROXY=http://…"}
          onChange={(e) => setEnvText(e.target.value)}
        />
      </div>
      <div className="ag-form__row">
        <label className="ag-form__label" htmlFor="ag-args">自定义参数（空格分隔，追加到 runtime CLI）</label>
        <input
          id="ag-args"
          className="ag-form__select"
          value={argsText}
          placeholder="如 --max-output 64000"
          onChange={(e) => setArgsText(e.target.value)}
        />
      </div>
      <div className="ag-form__actions">
        <button
          type="button"
          className="ag-btn ag-btn--primary"
          disabled={saving}
          onClick={() => void saveSettings()}
        >
          保存设置
        </button>
      </div>

      {/* 危险区：归档（软删，历史保留） */}
      <div className="ag-form__row" style={{ borderTop: "1px solid var(--border-color)", paddingTop: 12 }}>
        <label className="ag-form__label" style={{ color: "var(--error, #e06c75)" }}>危险区</label>
        {confirmArchive ? (
          <div className="ag-page__hint ag-page__hint--error">
            确认归档「{detail.displayName}」？归档后不可执行任务，但配置与历史记录全部保留。
            <button
              type="button"
              className="ag-btn ag-btn--mini ag-btn--ghost"
              style={{ marginLeft: 12 }}
              onClick={() => void archive()}
            >
              确认归档
            </button>
            <button
              type="button"
              className="ag-btn ag-btn--mini ag-btn--ghost"
              style={{ marginLeft: 6 }}
              onClick={() => setConfirmArchive(false)}
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="ag-btn ag-btn--ghost"
            disabled={detail.archived}
            onClick={() => setConfirmArchive(true)}
          >
            <Archive size={14} aria-hidden="true" /> 归档智能体
          </button>
        )}
      </div>
    </div>
  );
}
