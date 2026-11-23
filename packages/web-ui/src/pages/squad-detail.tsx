/**
 * @fengagent/web-ui — 小队详情（AI 团队平台 P2）
 *
 * 契约对齐 spec §5.2：成员管理（agent 成员 + 自由 role）、队长约束
 * （换队长必须选成员；移除现任队长 409）、小队指令（briefing 追加不覆盖）、
 * mode 切换（leader/auto）、派单（POST /tasks）、运行树（leader 父 + worker 子）、
 * 归档（软删，历史保留）。
 */

import { useCallback, useEffect, useState } from "react";
import { Archive, ChevronLeft, Loader2, Plus, RefreshCw, Users } from "lucide-react";
import { ApprovalsPane } from "./approvals-pane.tsx";
import type { ApiClient } from "../api/client.ts";
import type { SquadSource } from "../api/squads-mock.ts";
import type { AgentCard, SquadInfo, SquadMember, SquadRunNode } from "../api/types.ts";

/** 运行状态文案（waiting_approval 等待审批 = DSH P2-2 等待态；blocked 留给 issue 语义） */
const RUN_STATUS: Record<string, string> = {
  running: "运行中",
  queued: "排队中",
  replied: "已完成",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  expired: "已过期",
  waiting_approval: "等待审批",
};

export function SquadDetailView({
  source,
  client,
  id,
  onBack,
}: {
  source: SquadSource;
  client: ApiClient;
  id: string;
  onBack: () => void;
}) {
  const [squad, setSquad] = useState<SquadInfo | null>(null);
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // 成员添加
  const [addMemberId, setAddMemberId] = useState("");
  const [addMemberRole, setAddMemberRole] = useState("");
  // 指令编辑
  const [instructions, setInstructions] = useState("");
  // 派单
  const [taskContent, setTaskContent] = useState("");
  const [dispatching, setDispatching] = useState(false);
  // 运行树
  const [runs, setRuns] = useState<SquadRunNode[]>([]);
  // 归档确认
  const [confirmArchive, setConfirmArchive] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await source.getSquad(id);
      setSquad(s);
      setInstructions(s.instructions);
      setRuns(await source.listSquadRuns(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [source, id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void (async () => {
      try {
        setAgents(await client.listAgents());
      } catch {
        setAgents([]);
      }
    })();
  }, [client]);

  /** 统一操作：带 loading/错误/提示 */
  async function run(label: string, fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(label);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !squad) {
    return (
      <div className="ag-page__empty">
        <Loader2 className="ag-page__spin" size={16} aria-hidden="true" /> 加载中…
      </div>
    );
  }
  if (error && !squad) {
    return (
      <div className="ag-section">
        <div className="ag-page__hint ag-page__hint--error">{error}</div>
        <button type="button" className="ag-btn" onClick={onBack}>
          <ChevronLeft size={14} aria-hidden="true" /> 返回列表
        </button>
      </div>
    );
  }
  if (!squad) return null;

  const memberCandidates = agents.filter(
    (a) => !squad.members.some((m) => m.memberId === a.id),
  );

  return (
    <div className="ag-section" data-testid="squad-detail">
      <div className="tm-libhead">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" className="ag-btn ag-btn--ghost" onClick={onBack} aria-label="返回列表">
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <h2 className="ag-section__title" style={{ margin: 0 }}>
            <Users size={14} aria-hidden="true" /> {squad.name}
            <span className="ag-runtime-card__meta" style={{ marginLeft: 8 }}>/ {squad.id}</span>
          </h2>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            className="ag-form__select"
            style={{ width: 130 }}
            aria-label="执行模式"
            value={squad.mode}
            onChange={(e) =>
              void run(`已切换为${e.target.value === "leader" ? "队长模式" : "自动模式"}`, () =>
                source.updateSquad(id, { mode: e.target.value as SquadInfo["mode"] }),
              )
            }
          >
            <option value="leader">队长模式</option>
            <option value="auto">自动模式</option>
          </select>
          <button type="button" className="ag-btn" onClick={() => void reload()}>
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {error && <div className="ag-page__hint ag-page__hint--error">{error}</div>}
      {notice && <div className="ag-page__hint">{notice}</div>}

      {/* 成员管理 */}
      <div className="ag-form" data-testid="squad-members">
        <div className="tm-libhead">
          <h3 className="ag-section__title">成员（队长必须是成员；移除现任队长需先换）</h3>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {squad.members.map((m) => {
            const isLeader = m.memberId === squad.leaderId;
            return (
              <div
                key={`${m.memberType}:${m.memberId}`}
                className="permission-grants__item"
                data-member-id={m.memberId}
              >
                <span className="permission-grants__tool">
                  {m.memberId}
                  <span className="ag-runtime-card__meta" style={{ display: "inline", marginLeft: 8, opacity: 0.7 }}>
                    {m.memberType === "agent" ? "智能体" : "成员"}
                  </span>
                </span>
                <span
                  className={`permission-grants__badge ${isLeader ? "permission-grants__badge--allow" : "permission-grants__badge--muted"}`}
                >
                  {isLeader ? "队长" : m.role || "（无角色）"}
                </span>
                {!isLeader && (
                  <>
                    <button
                      type="button"
                      className="permission-grants__revoke"
                      disabled={busy}
                      title="设为队长"
                      onClick={() =>
                        void run(`已换队长为 ${m.memberId}`, () => source.setSquadLeader(id, m.memberId))
                      }
                    >
                      设为队长
                    </button>
                    <button
                      type="button"
                      className="permission-grants__revoke"
                      disabled={busy}
                      title="移除成员"
                      onClick={() =>
                        void run(`已移除成员 ${m.memberId}`, () =>
                          source.removeSquadMember(id, { memberType: m.memberType, memberId: m.memberId }),
                        )
                      }
                    >
                      移除
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
        {/* 添加成员 */}
        <div className="permission-add" style={{ marginTop: 8 }}>
          {memberCandidates.length > 0 ? (
            <select
              className="permission-add__select"
              aria-label="选择智能体"
              value={addMemberId}
              onChange={(e) => setAddMemberId(e.target.value)}
            >
              <option value="">选择智能体…</option>
              {memberCandidates.map((a) => (
                <option key={a.id} value={a.id}>{a.displayName}（{a.id}）</option>
              ))}
            </select>
          ) : (
            <input
              className="permission-add__input"
              placeholder="智能体 id"
              value={addMemberId}
              onChange={(e) => setAddMemberId(e.target.value)}
            />
          )}
          <input
            className="permission-add__input"
            placeholder="角色（自由文本，如 调研 / 评审）"
            value={addMemberRole}
            onChange={(e) => setAddMemberRole(e.target.value)}
          />
          <button
            type="button"
            className="permission-add__btn"
            disabled={busy || addMemberId.trim() === ""}
            onClick={() => {
              const member: SquadMember = {
                memberType: "agent",
                memberId: addMemberId.trim(),
                role: addMemberRole.trim(),
              };
              void run(`已添加成员 ${member.memberId}`, () => source.addSquadMember(id, member));
              setAddMemberId("");
              setAddMemberRole("");
            }}
          >
            <Plus size={12} aria-hidden="true" /> 添加成员
          </button>
        </div>
      </div>

      {/* 小队指令 */}
      <div className="ag-form" data-testid="squad-instructions">
        <div className="tm-libhead">
          <h3 className="ag-section__title">小队指令（派单时追加在各成员指令后，不覆盖）</h3>
        </div>
        <textarea
          className="ag-form__select"
          rows={4}
          value={instructions}
          placeholder="如：改动必须先跑 typecheck；每步产出物写回任务卡。"
          onChange={(e) => setInstructions(e.target.value)}
        />
        <div className="ag-form__actions">
          <button
            type="button"
            className="ag-btn ag-btn--primary"
            disabled={busy}
            onClick={() => void run("小队指令已保存", () => source.updateSquad(id, { instructions }))}
          >
            保存指令
          </button>
        </div>
      </div>

      {/* 派单 */}
      <div className="ag-form" data-testid="squad-dispatch">
        <div className="tm-libhead">
          <h3 className="ag-section__title">派任务（{squad.mode === "leader" ? "队长软编排：队长拆解并派给成员" : "自动分配：按算法选空闲成员"}）</h3>
        </div>
        <textarea
          className="ag-form__select"
          rows={2}
          value={taskContent}
          placeholder="任务内容…"
          onChange={(e) => setTaskContent(e.target.value)}
        />
        <div className="ag-form__actions">
          <button
            type="button"
            className="ag-btn ag-btn--primary"
            disabled={dispatching || busy || taskContent.trim() === ""}
            onClick={() => {
              setDispatching(true);
              void run("任务已派发（运行树见下方）", () => source.dispatchSquadTask(id, { content: taskContent.trim() })).finally(
                () => setDispatching(false),
              );
              setTaskContent("");
            }}
          >
            {dispatching ? <Loader2 className="ag-page__spin" size={14} aria-hidden="true" /> : null}
            派发
          </button>
        </div>
      </div>

      {/* 运行树 */}
      <div className="ag-form" data-testid="squad-runs">
        <div className="tm-libhead">
          <h3 className="ag-section__title">运行树（leader 父任务 + 成员子任务）</h3>
        </div>
        {runs.length === 0 ? (
          <div className="ag-page__empty">暂无运行 — 派一个任务试试</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {runs
              .filter((r) => r.parentRunId === null)
              .map((root) => (
                <div key={root.id}>
                  <div className="permission-grants__item" data-run-id={root.id}>
                    <span className="permission-grants__tool">{root.assignee}</span>
                    <span className="permission-grants__badge permission-grants__badge--allow">leader · {RUN_STATUS[root.status] ?? root.status}</span>
                    <span className="ag-runtime-card__meta" style={{ marginLeft: "auto", opacity: 0.8 }}>
                      {root.title}
                    </span>
                  </div>
                  {runs
                    .filter((r) => r.parentRunId === root.id)
                    .map((child) => (
                      <div
                        key={child.id}
                        className="permission-grants__item"
                        data-run-id={child.id}
                        style={{ marginLeft: 24 }}
                      >
                        <span className="permission-grants__tool">{child.assignee}</span>
                        <span className={`permission-grants__badge ${child.status === "waiting_approval" ? "permission-grants__badge--ask" : "permission-grants__badge--muted"}`}>
                          {RUN_STATUS[child.status] ?? child.status}
                        </span>
                        <span className="ag-runtime-card__meta" style={{ marginLeft: "auto", opacity: 0.8 }}>
                          {child.title}
                        </span>
                      </div>
                    ))}
                </div>
              ))}
          </div>
        )}
      </div>

      {/* 审批（负责人确认 + 上抛 + 审计） */}
      <ApprovalsPane client={client} squadId={id} />

      {/* 危险区：归档 */}
      <div className="ag-form__row" style={{ borderTop: "1px solid var(--border-color)", paddingTop: 12 }}>
        <label className="ag-form__label" style={{ color: "var(--error, #e06c75)" }}>危险区</label>
        {confirmArchive ? (
          <div className="ag-page__hint ag-page__hint--error">
            确认归档「{squad.name}」？归档后不可再派任务，配置与历史保留。
            <button
              type="button"
              className="ag-btn ag-btn--mini ag-btn--ghost"
              style={{ marginLeft: 12 }}
              onClick={() =>
                void source
                  .archiveSquad(id)
                  .then(onBack)
                  .catch((err) => setError(err instanceof Error ? err.message : "归档失败"))
              }
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
            disabled={squad.archived}
            onClick={() => setConfirmArchive(true)}
          >
            <Archive size={14} aria-hidden="true" /> 归档小队
          </button>
        )}
      </div>
    </div>
  );
}
