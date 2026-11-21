/**
 * @fengagent/web-ui — 小队视图（AI 团队平台 P2：小队与队长）
 *
 * 团队页「小队」子视图：列表 + 建队；详情见 squad-detail.tsx。
 * 契约对齐 spec §5.2：leader 必须是成员（建队自动入成员）、
 * 移除现任队长 409（先换）、mode leader/auto、归档软删。
 *
 * 数据源：真实 API 优先，探测失败回退 SquadsMock（同智能体/技能库模式）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw, Users } from "lucide-react";
import type { ApiClient } from "../api/client.ts";
import { SquadsMock, type SquadSource } from "../api/squads-mock.ts";
import type { AgentCard, SquadInfo } from "../api/types.ts";
import { SquadDetailView } from "./squad-detail.tsx";

/** 小队子视图（团队页）：列表 ⇄ 详情 */
export function SquadsView({ client }: { client: ApiClient }) {
  const forceMock = useMemo(
    () => new URLSearchParams(window.location.search).get("mock") === "1",
    [],
  );
  const mockRef = useRef<SquadsMock | null>(null);
  const [mockMode, setMockMode] = useState(false);

  const source = useCallback((): SquadSource => {
    if (mockMode) {
      mockRef.current ??= new SquadsMock();
      return mockRef.current;
    }
    return client;
  }, [mockMode, client]);

  const [squads, setSquads] = useState<SquadInfo[]>([]);
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 建队表单
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLeader, setNewLeader] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSquads(await source().listSquads());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [source]);

  // 探测：真实 API 失败回退 mock（后端未落地阶段）
  useEffect(() => {
    void (async () => {
      if (forceMock) {
        setMockMode(true);
        return;
      }
      try {
        await client.listSquads();
        setMockMode(false);
      } catch {
        setMockMode(true);
      }
    })();
  }, [client, forceMock]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 智能体列表（建队选队长用；失败不阻塞——手填也行）
  useEffect(() => {
    void (async () => {
      try {
        setAgents(await client.listAgents());
      } catch {
        setAgents([]);
      }
    })();
  }, [client]);

  async function createSquad() {
    if (creating) return;
    const name = newName.trim();
    const leader = newLeader.trim();
    if (!name || !leader) {
      setCreateError("小队名与队长 agent 必填");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await source().createSquad({ name, leaderId: leader, mode: "leader" });
      setCreateOpen(false);
      setNewName("");
      setNewLeader("");
      await reload();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setCreating(false);
    }
  }

  if (selectedId) {
    return (
      <SquadDetailView
        source={source()}
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
          <Users size={14} aria-hidden="true" /> 小队
        </h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="ag-btn"
            onClick={() => {
              setCreateOpen((v) => !v);
              setCreateError(null);
            }}
          >
            <Plus size={14} aria-hidden="true" /> 建小队
          </button>
          <button type="button" className="ag-btn" onClick={() => void reload()}>
            <RefreshCw size={14} aria-hidden="true" /> 刷新
          </button>
        </div>
      </div>

      {mockMode && (
        <div className="ag-page__hint">小队后端未就绪，已回退演示数据（真实 /api/squads 落地后自动切换）</div>
      )}
      {error && <div className="ag-page__hint ag-page__hint--error">{error}</div>}

      {/* 建队表单 */}
      {createOpen && (
        <div className="ag-form" data-testid="squad-create-form">
          <div className="tm-libhead">
            <h3 className="ag-section__title">建小队</h3>
          </div>
          {createError && <div className="ag-page__hint ag-page__hint--error">{createError}</div>}
          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="sq-name">小队名</label>
            <input
              id="sq-name"
              className="ag-form__select"
              value={newName}
              placeholder="如 前端小队"
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="sq-leader">队长（必须是已有智能体；自动成为成员）</label>
            {agents.length > 0 ? (
              <select
                id="sq-leader"
                className="ag-form__select"
                value={newLeader}
                onChange={(e) => setNewLeader(e.target.value)}
              >
                <option value="">选择队长…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}（{a.id}{a.runtime ? ` · ${a.runtime}` : " · 未绑"}）
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="sq-leader"
                className="ag-form__select"
                value={newLeader}
                placeholder="智能体 id（可先在「智能体」页创建）"
                onChange={(e) => setNewLeader(e.target.value)}
              />
            )}
          </div>
          <div className="ag-form__actions">
            <button type="button" className="ag-btn ag-btn--primary" disabled={creating} onClick={() => void createSquad()}>
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

      {squads.length === 0 && !loading ? (
        <div className="ag-page__empty">暂无小队 — 用上方「建小队」拉一支队伍（队长自动入成员）</div>
      ) : (
        <div className="ag-runtime-grid">
          {squads.map((s) => (
            <div
              key={s.id}
              className="ag-runtime-card"
              data-testid="squad-card"
              data-squad-id={s.id}
              role="button"
              tabIndex={0}
              style={{ cursor: "pointer" }}
              onClick={() => setSelectedId(s.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setSelectedId(s.id);
              }}
            >
              <div className="ag-runtime-card__head">
                <span className="ag-runtime-card__name">{s.name}</span>
                <span className="ag-badge ag-badge--ok">{s.mode === "leader" ? "队长模式" : "自动模式"}</span>
              </div>
              <div className="ag-runtime-card__meta">{s.id}</div>
              <div className="ag-runtime-card__meta" style={{ opacity: 0.7 }}>
                {s.description || "（无描述）"}
              </div>
              <div className="ag-runtime-card__chips">
                <span className="ag-chip">队长 {s.leaderId}</span>
                <span className="ag-chip ag-chip--muted">成员 {s.members.length}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
