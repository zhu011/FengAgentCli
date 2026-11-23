/**
 * @fengagent/web-ui — 任务池视图（P3-1：opt-in 任务池认领）
 *
 * 挂小队详情页「任务池」页签。契约对齐 spec P3-1 / claude大哥 调研 6 点：
 * - claimable 列表（GET /api/agent-tasks?claimable=1&squad=…，池范围过滤）；
 * - 原子认领（POST /:id/claim {agent}——输家 409 原样展示，不静默）；
 * - 已认领/租约态展示（claimed 徽标 + 租约到期提示；过期 requeue 回池）；
 * - 认领策略说明：assigned（点名，默认）vs pool（开放池，成员按需抢单）。
 *
 * 后端未落地时回退演示数据（claim-mock），页面有提示。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Hand, Loader2, RefreshCw } from "lucide-react";
import type { ApiClient } from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import type { ClaimableTask } from "../api/types.ts";

/** 演示回退：claimable 任务 + 内存认领 */
class ClaimPoolMock {
  private tasks = new Map<string, ClaimableTask & { claimedBy?: string; leaseExpiresAt?: number }>();

  seed(squadId: string): void {
    if (this.tasks.size > 0) return;
    this.tasks.set("pool-task-1", {
      id: "pool-task-1",
      content: "梳理登录页错误提示文案",
      poolScope: squadId,
      claimPolicy: "pool",
      skillTags: ["frontend"],
      createdAt: new Date().toISOString(),
    });
    this.tasks.set("pool-task-2", {
      id: "pool-task-2",
      content: "排查 CI 偶发红的 claude-client 用例",
      poolScope: squadId,
      claimPolicy: "pool",
      skillTags: ["test"],
      createdAt: new Date().toISOString(),
    });
  }

  async list(squadId?: string): Promise<ClaimableTask[]> {
    return [...this.tasks.values()]
      .filter((t) => !t.claimedBy)
      .filter((t) => !squadId || t.poolScope === squadId)
      .map(({ id, content, poolScope, claimPolicy, skillTags, createdAt }) => ({
        id, content, poolScope, claimPolicy, skillTags, createdAt,
      }));
  }

  async claim(taskId: string, agentId: string): Promise<{ ok: boolean; status: string; leaseExpiresAt: number }> {
    const task = this.tasks.get(taskId);
    if (!task) throw new ApiError(`任务不存在: ${taskId}`, 404, "not_found");
    if (task.claimedBy) throw new ApiError(`任务已被「${task.claimedBy}」认领`, 409, "conflict");
    task.claimedBy = agentId;
    task.leaseExpiresAt = Date.now() + 10 * 60_000;
    return { ok: true, status: "claimed", leaseExpiresAt: task.leaseExpiresAt };
  }
}

/** 任务池（小队详情页签） */
export function TaskPoolPane({ client, squadId }: { client: ApiClient; squadId: string }) {
  const forceMock = useMemo(
    () => new URLSearchParams(window.location.search).get("mock") === "1",
    [],
  );
  const mockRef = useRef<ClaimPoolMock | null>(null);
  const [mockMode, setMockMode] = useState(false);
  const [tasks, setTasks] = useState<ClaimableTask[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; displayName: string }>>([]);
  const [claimAgent, setClaimAgent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const useSource = useCallback(() => {
    if (mockMode) {
      mockRef.current ??= new ClaimPoolMock();
      mockRef.current.seed(squadId);
      return mockRef.current;
    }
    return {
      list: () => client.listClaimableTasks(squadId),
      claim: (id: string, agent: string) => client.claimTask(id, agent),
    };
  }, [mockMode, client, squadId]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await useSource().list());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [useSource]);

  useEffect(() => {
    void (async () => {
      if (forceMock) {
        setMockMode(true);
        return;
      }
      try {
        await client.listClaimableTasks(squadId);
        setMockMode(false);
      } catch {
        setMockMode(true);
      }
    })();
  }, [client, squadId, forceMock]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void (async () => {
      try {
        const list = await client.listAgents();
        setAgents(list.map((a) => ({ id: a.id, displayName: a.displayName })));
      } catch {
        setAgents([]);
      }
    })();
  }, [client]);

  async function claim(taskId: string) {
    const agentId = claimAgent.trim();
    if (!agentId) {
      setError("请先选择认领的智能体");
      return;
    }
    if (busy) return;
    setBusy(taskId);
    setError(null);
    setNotice(null);
    try {
      const result = await useSource().claim(taskId, agentId);
      setNotice(`已认领「${taskId}」（租约至 ${new Date(result.leaseExpiresAt).toLocaleTimeString()}；过期自动回池）`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "认领失败（可能已被抢走）");
      await reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ag-form" data-testid="squad-task-pool">
      <div className="tm-libhead">
        <h3 className="ag-section__title">
          <Hand size={14} aria-hidden="true" /> 任务池（开放抢单 · opt-in）
        </h3>
        <button type="button" className="ag-btn" onClick={() => void reload()}>
          <RefreshCw size={14} aria-hidden="true" /> 刷新
        </button>
      </div>
      {mockMode && (
        <div className="ag-page__hint">任务池后端未就绪，已回退演示数据（真实 claimable/claim API 落地后自动切换）</div>
      )}
      {error && <div className="ag-page__hint ag-page__hint--error">{error}</div>}
      {notice && <div className="ag-page__hint">{notice}</div>}

      <div className="ag-form__row">
        <label className="ag-form__label">
          说明：claim_policy=pool 的任务进池（默认 assigned 点名派发不变）；池内成员先到先得——
          原子认领，输家 409 原样展示；认领后持租约（过期自动 requeue 回池，不判死）。
        </label>
      </div>

      {/* 认领人选择 */}
      <div className="permission-add" style={{ marginBottom: 8 }}>
        <select
          className="permission-add__select"
          aria-label="认领智能体"
          value={claimAgent}
          onChange={(e) => setClaimAgent(e.target.value)}
        >
          <option value="">谁去认领？选择智能体…</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.displayName}（{a.id}）</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="ag-page__empty">
          <Loader2 className="ag-page__spin" size={16} aria-hidden="true" /> 加载中…
        </div>
      ) : tasks.length === 0 ? (
        <div className="ag-page__empty" data-testid="pool-empty">池内暂无可认领任务</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {tasks.map((t) => (
            <div key={t.id} className="permission-grants__item" data-claimable-id={t.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="permission-grants__tool">{t.content.slice(0, 60)}</span>
                {t.skillTags?.map((tag) => (
                  <span key={tag} className="permission-grants__badge permission-grants__badge--muted">{tag}</span>
                ))}
              </div>
              <div className="ag-runtime-card__meta" style={{ opacity: 0.6 }}>
                {t.id} · 池范围 {t.poolScope || "全局"}
              </div>
              <div className="permission-add" style={{ marginTop: 0 }}>
                <button
                  type="button"
                  className="permission-add__btn"
                  disabled={busy === t.id || claimAgent === ""}
                  title="原子认领（条件 UPDATE；已被抢走则 409）"
                  onClick={() => void claim(t.id)}
                >
                  <Hand size={12} aria-hidden="true" /> {busy === t.id ? "认领中…" : "认领"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
