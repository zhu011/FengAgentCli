/**
 * @fengagent/agent — 审批（负责人确认）仓测试（P2）
 *
 * 覆盖验收点「每笔批准记审计（谁批、批哪次、once/session/permanent）」：
 * 1. 请求 → 裁决 → 授权 → 消费，审计四类动作齐全且顺序正确；
 * 2. once 用一次就失效；session 只对同一子任务有效；permanent 长期有效；
 * 3. 队长上抛（escalate）后由人类裁决，审计记录两个人的身份；
 * 4. 同一 (成员, 工具, 子任务) 的重复请求不刷屏。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore, ApprovalStoreError } from "../approval-store.ts";

function makeStore(): { store: ApprovalStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "feng-approval-"));
  let seq = 0;
  const store = new ApprovalStore(join(dir, "sessions.db"), { idFactory: () => `${++seq}` });
  return { store, dir };
}

describe("ApprovalStore — 负责人确认与审计", () => {
  test("请求 → 批准(once) → 放行一次 → 失效，审计含 request/approve/consume", () => {
    const { store, dir } = makeStore();
    const request = store.request({
      squadId: "sq_1",
      squadTaskId: "sqt_1",
      agentId: "worker",
      toolName: "bash",
      toolInput: '{"command":"rm -rf dist"}',
      reason: "破坏性命令",
      targetId: "coder",
    });
    expect(request.status).toBe("pending");
    expect(request.targetType).toBe("leader");
    expect(store.allows("worker", "bash", { sessionRef: "sqt_1" })).toBe(false);

    const resolved = store.resolve(request.id, {
      decision: "approve",
      scope: "once",
      actor: { type: "agent", id: "coder" },
      note: "只批这次",
    });
    expect(resolved.status).toBe("approved");
    expect(resolved.resolvedByType).toBe("agent");
    expect(resolved.resolvedById).toBe("coder");

    expect(store.allows("worker", "bash", { sessionRef: "sqt_1" })).toBe(true);
    // once 已消费 → 第二次不再放行
    expect(store.allows("worker", "bash", { sessionRef: "sqt_1" })).toBe(false);

    const audit = store.auditFor(request.id);
    expect(audit.map((entry) => entry.action)).toEqual(["request", "approve", "consume"]);
    expect(audit[0]?.actorId).toBe("worker");
    expect(audit[1]?.actorId).toBe("coder");
    expect(audit[1]?.scope).toBe("once");
    expect(audit[2]?.actorType).toBe("system");
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("session 授权只对同一子任务有效；permanent 长期有效", () => {
    const { store, dir } = makeStore();
    const denied = store.request({ agentId: "worker", toolName: "edit", squadTaskId: "sqt_A" });
    expect(
      store.resolve(denied.id, { decision: "deny", actor: { type: "agent", id: "coder" } }).status,
    ).toBe("denied");
    expect(store.allows("worker", "edit", { sessionRef: "sqt_A" })).toBe(false);

    const session = store.request({ agentId: "worker", toolName: "write", squadTaskId: "sqt_A" });
    store.resolve(session.id, {
      decision: "approve",
      scope: "session",
      actor: { type: "agent", id: "coder" },
    });
    expect(store.allows("worker", "write", { sessionRef: "sqt_A" })).toBe(true);
    expect(store.allows("worker", "write", { sessionRef: "sqt_A" })).toBe(true);
    expect(store.allows("worker", "write", { sessionRef: "sqt_B" })).toBe(false);

    const permanent = store.request({ agentId: "worker", toolName: "read" });
    store.resolve(permanent.id, {
      decision: "approve",
      scope: "permanent",
      actor: { type: "agent", id: "coder" },
    });
    expect(store.allows("worker", "read")).toBe(true);
    expect(store.allows("worker", "read", { sessionRef: "any" })).toBe(true);

    // 收回 permanent：放行变拒绝，并记在审计里
    expect(store.revoke("worker", "read")).toBe(1);
    expect(store.allows("worker", "read")).toBe(false);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("上抛人类 → 人类裁决：状态流转与两位裁决人都进审计", () => {
    const { store, dir } = makeStore();
    const request = store.request({ agentId: "worker", toolName: "bash", targetId: "coder" });
    const escalated = store.escalate(request.id, {
      actor: { type: "agent", id: "coder" },
      note: "这个我不确定，交给 owner",
      humanId: "owner",
    });
    expect(escalated.status).toBe("escalated");
    expect(escalated.targetType).toBe("human");
    expect(escalated.targetId).toBe("owner");

    const resolved = store.resolve(request.id, {
      decision: "approve",
      scope: "session",
      actor: { type: "member", id: "owner" },
      note: "这次放行",
    });
    expect(resolved.status).toBe("approved");
    const audit = store.auditFor(request.id);
    expect(audit.map((entry) => `${entry.action}:${entry.actorId}`)).toEqual([
      "request:worker",
      "escalate:coder",
      "approve:owner",
    ]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("同一 (成员, 工具, 子任务) 的重复请求复用同一条，不刷屏", () => {
    const { store, dir } = makeStore();
    const first = store.request({ agentId: "worker", toolName: "bash", squadTaskId: "sqt_1" });
    const second = store.request({ agentId: "worker", toolName: "bash", squadTaskId: "sqt_1" });
    expect(second.id).toBe(first.id);
    expect(store.list({ status: "pending", agentId: "worker" })).toHaveLength(1);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("已终态请求不能重复裁决 / 上抛", () => {
    const { store, dir } = makeStore();
    const request = store.request({ agentId: "worker", toolName: "bash" });
    store.resolve(request.id, { decision: "deny", actor: { type: "agent", id: "coder" } });
    expect(() =>
      store.resolve(request.id, { decision: "approve", actor: { type: "agent", id: "coder" } }),
    ).toThrow(ApprovalStoreError);
    expect(() => store.escalate(request.id, { actor: { type: "agent", id: "coder" } })).toThrow(
      ApprovalStoreError,
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("最近审计按时间倒序（治理页）", () => {
    const { store, dir } = makeStore();
    const a = store.request({ agentId: "w1", toolName: "bash" });
    const b = store.request({ agentId: "w2", toolName: "write" });
    store.resolve(b.id, { decision: "deny", actor: { type: "agent", id: "coder" } });
    const recent = store.recentAudit(10);
    expect(recent[0]?.action).toBe("deny");
    expect(recent.length).toBeGreaterThanOrEqual(3);
    expect(recent.some((entry) => entry.approvalId === a.id)).toBe(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
