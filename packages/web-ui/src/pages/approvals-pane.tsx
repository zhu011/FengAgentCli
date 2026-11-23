/**
 * @fengagent/web-ui — 负责人确认：审批裁决面板（P2 第二阶段）
 *
 * 挂在小队详情页「审批」区。契约对齐 DSH 的 /api/approvals：
 * - 待裁决清单（pending，targetType=human 的人类入口；队长侧走工具，同写审计）；
 * - 三档授权（once 本次 / session 本子任务 / permanent 永久）+ deny；
 * - 上抛（escalate：队长拿不准 → 人类发起人）；
 * - 审计时间线（request / approve / deny / escalate / consume / expire——谁、批哪次、scope）；
 * - 收回（revoke：permanent 授权收回）。
 */

import { useCallback, useEffect, useState } from "react";
import { Gavel, Loader2, ShieldCheck } from "lucide-react";
import type { ApiClient } from "../api/client.ts";
import type {
  ApprovalAuditEntry,
  ApprovalRequest,
  ApprovalScope,
} from "../api/types.ts";

const STATUS_LABEL: Record<ApprovalRequest["status"], string> = {
  pending: "待裁决",
  approved: "已批准",
  denied: "已拒绝",
  escalated: "已上抛",
  expired: "已过期",
};

const STATUS_BADGE: Record<ApprovalRequest["status"], string> = {
  pending: "permission-grants__badge--ask",
  approved: "permission-grants__badge--allow",
  denied: "permission-grants__badge--deny",
  escalated: "permission-grants__badge--running",
  expired: "permission-grants__badge--muted",
};

const SCOPE_LABEL: Record<ApprovalScope, string> = {
  once: "本次",
  session: "本子任务",
  permanent: "永久",
};

const AUDIT_LABEL: Record<string, string> = {
  request: "发起",
  approve: "批准",
  deny: "拒绝",
  escalate: "上抛",
  consume: "消费",
  expire: "过期",
};

function formatAt(at: number): string {
  const d = new Date(at < 1e12 ? at * 1000 : at);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? hhmm : `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

export function ApprovalsPane({ client, squadId }: { client: ApiClient; squadId: string }) {
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [resolved, setResolved] = useState<ApprovalRequest[]>([]);
  const [audit, setAudit] = useState<ApprovalAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 裁决草稿：approvalId → scope（once/session/permanent） */
  const [scopeDraft, setScopeDraft] = useState<Record<string, ApprovalScope>>({});
  /** 展开的审计详情（approvalId） */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedAudit, setExpandedAudit] = useState<ApprovalAuditEntry[]>([]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [pend, done, recent] = await Promise.all([
        client.listApprovals({ status: "pending", squadId }),
        client.listApprovals({ squadId }),
        client.listRecentApprovalAudit(50),
      ]);
      setPending(pend);
      setResolved(done.filter((a) => a.status !== "pending"));
      setAudit(recent.filter((e) => pend.some((p) => p.id === e.approvalId) || done.some((d) => d.id === e.approvalId)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "审批加载失败");
    }
  }, [client, squadId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function act(approvalId: string, fn: () => Promise<unknown>, label: string) {
    if (busy) return;
    setBusy(approvalId);
    setNotice(null);
    try {
      await fn();
      setNotice(label);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  async function openDetail(approvalId: string) {
    if (expanded === approvalId) {
      setExpanded(null);
      return;
    }
    try {
      const detail = await client.getApprovalDetail(approvalId);
      setExpanded(approvalId);
      setExpandedAudit(detail.audit);
    } catch (err) {
      setError(err instanceof Error ? err.message : "详情加载失败");
    }
  }

  return (
    <div className="ag-form" data-testid="squad-approvals">
      <div className="tm-libhead">
        <h3 className="ag-section__title">
          <Gavel size={14} aria-hidden="true" /> 审批（负责人确认 + 上抛 + 审计）
        </h3>
      </div>
      {error && <div className="ag-page__hint ag-page__hint--error">{error}</div>}
      {notice && <div className="ag-page__hint">{notice}</div>}

      {/* 待裁决（人类入口；targetType=human 或 escalated 的也在此） */}
      <div className="ag-form__row">
        <label className="ag-form__label">待裁决（{pending.length}）</label>
        {pending.length === 0 ? (
          <span className="ag-runtime-card__meta" style={{ opacity: 0.7 }}>（无待裁决请求）</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pending.map((a) => (
              <div key={a.id} className="permission-grants__item" data-approval-id={a.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="permission-grants__tool">
                    {a.agentId} · {a.toolName}
                  </span>
                  <span className={`permission-grants__badge ${STATUS_BADGE[a.status] ?? ""}`}>
                    {a.targetType === "human" ? "需你裁决" : "队长裁决"}
                  </span>
                  <span className="ag-runtime-card__meta" style={{ marginLeft: "auto", opacity: 0.7 }}>
                    {formatAt(a.createdAt)}
                  </span>
                </div>
                <div className="ag-runtime-card__meta" style={{ opacity: 0.8 }}>
                  {a.reason || "（无理由）"}
                </div>
                {a.toolInput && (
                  <div className="ag-runtime-card__meta" style={{ opacity: 0.55, fontFamily: "monospace" }} title="入参摘要（截断，不含敏感正文）">
                    {a.toolInput.slice(0, 120)}
                  </div>
                )}
                <div className="permission-add" style={{ marginTop: 0 }}>
                  {a.targetType === "human" ? (
                    <>
                      <select
                        className="permission-add__select"
                        aria-label="授权范围"
                        value={scopeDraft[a.id] ?? "session"}
                        onChange={(e) => setScopeDraft((d) => ({ ...d, [a.id]: e.target.value as ApprovalScope }))}
                      >
                        <option value="once">once · 仅本次</option>
                        <option value="session">session · 本子任务</option>
                        <option value="permanent">permanent · 永久</option>
                      </select>
                      <button
                        type="button"
                        className="permission-add__btn"
                        disabled={busy === a.id}
                        title="批准该工具调用（写审计）"
                        onClick={() =>
                          void act(a.id, () => client.resolveApproval(a.id, { decision: "approve", scope: scopeDraft[a.id] ?? "session" }), "已批准（写审计）")
                        }
                      >
                        <ShieldCheck size={12} aria-hidden="true" /> 批准
                      </button>
                      <button
                        type="button"
                        className="permission-grants__revoke"
                        disabled={busy === a.id}
                        title="拒绝该工具调用（写审计）"
                        onClick={() => void act(a.id, () => client.resolveApproval(a.id, { decision: "deny" }), "已拒绝（写审计）")}
                      >
                        拒绝
                      </button>
                    </>
                  ) : (
                    <span className="ag-runtime-card__meta" style={{ opacity: 0.7 }}>
                      等待队长裁决中…（队长拿不准会自动上抛给你）
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 已裁决历史（本小队） */}
      <div className="ag-form__row">
        <label className="ag-form__label">已裁决（{resolved.length}，点击展开审计流）</label>
        {resolved.length === 0 ? (
          <span className="ag-runtime-card__meta" style={{ opacity: 0.7 }}>（暂无）</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {resolved.slice(0, 20).map((a) => (
              <div key={a.id} data-resolved-id={a.id}>
                <button
                  type="button"
                  className="permission-grants__item"
                  style={{ width: "100%", textAlign: "left", cursor: "pointer", background: "var(--bg-tertiary)" }}
                  onClick={() => void openDetail(a.id)}
                >
                  <span className="permission-grants__tool">{a.agentId} · {a.toolName}</span>
                  <span className={`permission-grants__badge ${STATUS_BADGE[a.status] ?? ""}`}>{STATUS_LABEL[a.status]}</span>
                  <span className="ag-runtime-card__meta" style={{ marginLeft: "auto", opacity: 0.7 }}>
                    {a.resolvedAt ? formatAt(a.resolvedAt) : formatAt(a.createdAt)}
                  </span>
                </button>
                {expanded === a.id && (
                  <div style={{ marginLeft: 16, marginTop: 4, display: "flex", flexDirection: "column", gap: 4 }} data-audit-timeline={a.id}>
                    {expandedAudit.length === 0 && (
                      <span className="ag-runtime-card__meta" style={{ opacity: 0.6 }}>（无审计行）</span>
                    )}
                    {expandedAudit.map((e) => (
                      <div key={e.id} className="ag-runtime-card__meta" style={{ opacity: 0.85, display: "flex", gap: 8 }}>
                        <span style={{ minWidth: 42 }}>{formatAt(e.at)}</span>
                        <span style={{ fontWeight: 600 }}>{AUDIT_LABEL[e.action] ?? e.action}</span>
                        <span>{e.actorId}{e.scope ? ` · ${SCOPE_LABEL[e.scope]}` : ""}{e.note ? ` · ${e.note}` : ""}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 最近审计摘要（全队，治理入口） */}
      <div className="ag-form__row">
        <label className="ag-form__label">
          最近审计（{audit.length} 条，全部动作 request/approve/deny/escalate/consume/expire；permanent 可收回）
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 180, overflowY: "auto" }}>
          {audit.length === 0 && (
            <span className="ag-runtime-card__meta" style={{ opacity: 0.6 }}>（暂无）</span>
          )}
          {audit.slice(0, 12).map((e) => (
            <div key={e.id} className="ag-runtime-card__meta" style={{ opacity: 0.85, display: "flex", gap: 8 }}>
              <span style={{ minWidth: 42 }}>{formatAt(e.at)}</span>
              <span style={{ fontWeight: 600 }}>{AUDIT_LABEL[e.action] ?? e.action}</span>
              <span>{e.actorId}{e.scope ? ` · ${SCOPE_LABEL[e.scope]}` : ""}</span>
            </div>
          ))}
        </div>
      </div>
      {busy && (
        <div className="ag-page__empty" style={{ padding: 0 }}>
          <Loader2 className="ag-page__spin" size={14} aria-hidden="true" /> 处理中…
        </div>
      )}
    </div>
  );
}
