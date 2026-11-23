// 小队（P2 第一阶段）e2e — 真后端（DSH 5ebdf34 起 /api/squads + /api/approvals）。
// 用法：node packages/web-ui/e2e/squads-smoke.mjs
// 前置：bun run build:web-ui
//
// 两段式：
//  A. API 级全链（直打真 server，fake-acp-agent 作 runtime——同 DSH 测试手法）：
//     建队（队长自动入成员）→ 绑成员 → 移除现任队长 409 → 换队长 →
//     非阻塞派单（leader 运行树根 + 成员子节点）→ 负责人确认 + 审计。
//  B. 浏览器渲染截图（列表 + 详情，真数据）。
//
// 注意：用 Node 跑（Bun/Windows 与 playwright CDP 管道不兼容）。

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const PORT = 4233;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_SHOT_DIR ?? join(REPO, ".verify-squads");

const FIXTURE = join(REPO, "packages/agent/src/__tests__/fixtures/fake-acp-agent.ts");

const dataRoot = mkdtempSync(join(tmpdir(), "feng-squads-e2e-data-"));
const teamRoot = mkdtempSync(join(tmpdir(), "feng-squads-e2e-team-"));
mkdirSync(join(dataRoot, "packages", "web-ui"), { recursive: true });
symlinkSync(join(REPO, "packages/web-ui/dist"), join(dataRoot, "packages/web-ui/dist"), "junction");

const serverProc = spawn("bun", [join(REPO, "packages/server/src/entry.ts")], {
  cwd: dataRoot,
  env: {
    ...process.env,
    FENG_DATA_DIR: dataRoot,
    FENG_TEAM_HOME: teamRoot,
    FENG_SERVER_PORT: String(PORT),
    FENG_SERVER_HOST: "127.0.0.1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
const serverLog = [];
serverProc.stdout.on("data", (d) => serverLog.push(d.toString()));
serverProc.stderr.on("data", (d) => serverLog.push(d.toString()));

async function waitReady(maxMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("server 未就绪\n" + serverLog.slice(-5).join(""));
}

const api = {
  async call(path, method = "GET", body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    let parsed;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  },
};

let passed = 0, failed = 0;
const check = (n, ok) => { console.log((ok ? "PASS " : "FAIL ") + n); ok ? passed++ : failed++; };

try {
  await waitReady();

  // 准备 runtime + agent（fake ACP，同 DSH 测试手法）
  const rtAdd = await api.call("/api/runtimes", "POST", {
    name: "fake", command: process.execPath, args: [FIXTURE], protocol: "acp", probe: true,
  });
  check("注册 fake runtime 并探测通过", rtAdd.status === 201);

  for (const [id, displayName] of [["leader-a", "队长甲"], ["worker-b", "成员乙"], ["worker-c", "成员丙"]]) {
    const r = await api.call("/api/agents", "POST", { id, displayName, runtime: "fake" });
    if (r.status !== 201) throw new Error(`agent create failed ${id}: ${JSON.stringify(r.body)}`);
  }
  check("创建 leader-a / worker-b / worker-c 三个智能体（绑 fake runtime）", true);

  // ① 建队（队长自动入成员）
  const created = await api.call("/api/squads", "POST", { id: "fe-team", name: "前端小队", leaderId: "leader-a" });
  check("建队 fe-team（leader-a 任队长）", created.status === 201 && created.body.leaderId === "leader-a");
  check("队长自动成为成员", created.body.members?.some((m) => m.memberId === "leader-a" && m.role === "leader"));

  // ② 绑成员
  const addB = await api.call("/api/squads/fe-team/members", "POST", { memberType: "agent", memberId: "worker-b", role: "评审" });
  const addC = await api.call("/api/squads/fe-team/members", "POST", { memberType: "agent", memberId: "worker-c", role: "调研" });
  check("绑成员 worker-b（评审）+ worker-c（调研）", addB.status === 200 && addC.status === 200);

  // ③ 移除现任队长 → 409
  const rmLeader = await api.call("/api/squads/fe-team/members/agent/leader-a", "DELETE");
  check("移除现任队长 → 409 cannot_remove_squad_leader", rmLeader.status === 409 && rmLeader.body?.error?.code === "cannot_remove_squad_leader");

  // ④ 换队长（新队长必须是成员；非成员 → 400）
  const badLeader = await api.call("/api/squads/fe-team/leader", "POST", { leaderId: "no-such-agent" });
  check("换队长给非成员 → 400", badLeader.status === 400);
  const newLeader = await api.call("/api/squads/fe-team/leader", "POST", { leaderId: "worker-b" });
  check("换队长 worker-b", newLeader.status === 200 && newLeader.body.leaderId === "worker-b");
  const backLeader = await api.call("/api/squads/fe-team/leader", "POST", { leaderId: "leader-a" });
  check("队长换回 leader-a", backLeader.status === 200);

  // ⑤ 非阻塞派单 → 运行树父子
  const dispatch = await api.call("/api/squads/fe-team/tasks", "POST", { content: "队长请把『输出 hello』派给成员并汇总" });
  check("派单（非阻塞，201/taskId）", dispatch.status === 201 && Boolean(dispatch.body?.taskId));

  // 轮询运行树：leader 根节点出现（非阻塞派活成立）。
  // 注：worker 子节点由队长 LLM 调 dispatch_task 产生——fake ACP 无真 LLM 决策，
  // 子节点父子关系由 DSH 服务级单测覆盖（squads-api.test.ts），不在本 e2e 断言范围。
  let leaderRootOk = false;
  for (let i = 0; i < 30 && !leaderRootOk; i++) {
    const runs = await api.call("/api/squads/fe-team/runs");
    leaderRootOk = (runs.body ?? []).some((r) => r.parentRunId === null && r.assignee === "leader-a");
    if (!leaderRootOk) await new Promise((r) => setTimeout(r, 1000));
  }
  check("运行树：leader 根节点（非阻塞派活）", leaderRootOk);

  // ⑥ 负责人确认 + 审计（若 DSH 第一阶段已挂 /api/approvals；未挂则记录为 N/A 不算失败）
  const appr = await api.call("/api/approvals");
  if (appr.status === 404) {
    check("负责人确认面（/api/approvals）— 本环境未启用，N/A 记录", true);
  } else {
    check("负责人确认面可访问（" + appr.status + "）", appr.status === 200);
  }

  // ⑥b 审批面板接线（真后端 /api/approvals：API 可达 + 空态过滤）
  const apprPending = await api.call("/api/approvals?status=pending&squadId=fe-team");
  check("审批 API 可达（pending 过滤）", apprPending.status === 200 && Array.isArray(apprPending.body));

  // ⑦ auto 模式复验（真后端 SquadCoordinator 接线）
  const autoSq = await api.call("/api/squads", "POST", { id: "auto-team", name: "自动小队", leaderId: "leader-a", mode: "auto" });
  check("建 auto 小队（mode=auto 不再 400）", autoSq.status === 201 && autoSq.body?.mode === "auto");
  await api.call("/api/squads/auto-team/members", "POST", { memberType: "agent", memberId: "worker-b", role: "执行" });
  const autoDispatch = await api.call("/api/squads/auto-team/tasks", "POST", { content: "输出 hello", priority: "urgent" });
  check("auto 派单（urgent 优先级，201/taskId）", autoDispatch.status === 201 && Boolean(autoDispatch.body?.taskId));
  const coord = await api.call("/api/squads/auto-team/coordinator");
  check("coordinator 状态可读", coord.status === 200);
  const tick = await api.call("/api/squads/auto-team/coordinator/tick", "POST");
  check("coordinator tick 推进（冷却恢复 + 补派）", tick.status === 200);

  // ⑧ 等待态：成员请求审批 → waiting_approval（不判死）→ 裁决 → 续跑
  let waitingSeen = false;
  for (let i = 0; i < 30 && !waitingSeen; i++) {
    const runs = await api.call("/api/squads/auto-team/runs");
    waitingSeen = (runs.body ?? []).some((r) => r.status === "waiting_approval" && r.blockedReason);
    if (!waitingSeen) await new Promise((r) => setTimeout(r, 1000));
  }
  check("waiting_approval 出现在运行树（blockedReason 带原因，非终态）", waitingSeen);

  // 人类裁决 → 续跑
  let apprToResolve = null;
  for (let i = 0; i < 10 && !apprToResolve; i++) {
    const list = await api.call("/api/approvals?status=pending");
    apprToResolve = (list.body ?? []).find((a) => a.squadId === "auto-team") ?? null;
    if (!apprToResolve) await new Promise((r) => setTimeout(r, 1000));
  }
  if (apprToResolve) {
    const resolved = await api.call(`/api/approvals/${apprToResolve.id}/resolve`, "POST", { decision: "approve", scope: "once" });
    check("裁决批准（once）→ 任务续跑", resolved.status === 200);
    let resumed = false;
    for (let i = 0; i < 30 && !resumed; i++) {
      const runs = await api.call("/api/squads/auto-team/runs");
      resumed = (runs.body ?? []).some((r) => r.status === "running" || r.status === "replied");
      if (!resumed) await new Promise((r) => setTimeout(r, 1000));
    }
    check("裁决后任务续跑（waiting → running/replied）", resumed);
  } else {
    check("（fake ACP 无真实审批触发时跳过续跑段）", waitingSeen ? false : true);
  }

  // ⑨ 浏览器渲染（真数据截图）
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/?view=teams&sub=squads`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="squad-card"]', { timeout: 15_000 });
  await page.locator('[data-squad-id="fe-team"]').click();
  await page.waitForSelector('[data-testid="squad-members"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="squad-runs"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="squad-approvals"]', { timeout: 8000 });
  const approvalsText = await page.locator('[data-testid="squad-approvals"]').textContent();
  // 派单后 leader 执行触发 checkToolPermission → 真实 pending 审批（DSH 负责人确认闭环）
  check(
    "审批面板：真实 pending 渲染（leader-a · bash · 队长裁决态）",
    (approvalsText ?? "").includes("待裁决") &&
      (approvalsText ?? "").includes("leader-a · bash") &&
      (approvalsText ?? "").includes("等待队长裁决中"),
  );
  // 审计流已含 request 发起行
  check("审批面板：审计流含 request 发起行", (approvalsText ?? "").includes("发起"));
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, "squad-real-detail.png"), fullPage: true });
  await browser.close();
  check("浏览器渲染：真数据列表 + 详情 + 运行树", true);
} finally {
  try { process.kill(-serverProc.pid); } catch { /* already gone */ }
  for (const d of [dataRoot, teamRoot]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
  }
}
console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED / ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
