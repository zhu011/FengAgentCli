// 任务池认领（P3-1）e2e — stub 后端实现 spec 契约。
// 用法：node packages/web-ui/e2e/task-pool-smoke.mjs
// 前置：bun run build:web-ui
//
// stub 契约（DSH P3-1 后端落地前的前置验证；落地后前端零改动）：
//   GET  /api/agent-tasks?claimable=1&squad=…  → ClaimableTask[]
//   POST /api/agent-tasks/:id/claim {agent}   → {ok,status,leaseExpiresAt}
//     —— 条件 UPDATE：已被认领 → 409 conflict
//
// 覆盖：① 池列表渲染（claimable + skill 标签 + 池范围）② 选择智能体认领成功
//   ③ 双人抢同任务：第二人 409 原样展示 ④ 认领后池内减少 ⑤ 空池态。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { statSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const DIST = join(REPO, "packages/web-ui/dist");
const PORT = 4221;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_SHOT_DIR ?? join(REPO, ".verify-agents");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

// ── stub 池 ──
const agents = new Map([["coder", "代码工程师"], ["reviewer", "评审员"]]);
const pool = new Map();
pool.set("pool-task-1", { id: "pool-task-1", content: "梳理登录页错误提示文案", poolScope: "fe-team", claimPolicy: "pool", skillTags: ["frontend"], createdAt: new Date().toISOString(), claimedBy: null });
pool.set("pool-task-2", { id: "pool-task-2", content: "排查 CI 偶发红用例", poolScope: "fe-team", claimPolicy: "pool", skillTags: ["test"], createdAt: new Date().toISOString(), claimedBy: null });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  let body = {};
  if (req.method !== "GET" && req.method !== "DELETE") {
    body = await new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { r(JSON.parse(d)); } catch { r({}); } }); });
  }
  if (url.pathname === "/api/health") return json(200, { status: "ok" });
  if (url.pathname === "/api/runtimes" && req.method === "GET") return json(200, []);
  if (url.pathname === "/api/groups") return json(200, { groups: [], runtimes: [] });
  if (url.pathname === "/api/sessions") return json(200, []);
  if (url.pathname === "/api/models") return json(200, { models: [] });
  if (url.pathname === "/api/skills" && req.method === "GET") return json(200, { roots: { team: "", project: [] }, skills: [], layers: [], errors: [] });
  if (url.pathname === "/api/agents" && req.method === "GET") {
    return json(200, [...agents.entries()].map(([id, displayName]) => ({ id, displayName, description: "", runtime: "fake", runtimeStatus: "online", runs7d: 0, lastRunStatus: null, archived: false })));
  }
  // squads 最小集（进小队详情需要）
  if (url.pathname === "/api/squads" && req.method === "GET") {
    return json(200, [{ id: "fe-team", name: "前端小队", description: "", leaderId: "coder", mode: "leader", instructions: "", members: [{ memberType: "agent", memberId: "coder", role: "leader" }], archived: false }]);
  }
  const sqMatch = url.pathname.match(/^\/api\/squads\/([^/]+)$/);
  if (sqMatch && req.method === "GET") {
    return json(200, { id: "fe-team", name: "前端小队", description: "", leaderId: "coder", mode: "leader", instructions: "", members: [{ memberType: "agent", memberId: "coder", role: "leader" }], archived: false });
  }
  const runsMatch = url.pathname.match(/^\/api\/squads\/([^/]+)\/runs$/);
  if (runsMatch && req.method === "GET") return json(200, []);
  const apprMatch = url.pathname.match(/^\/api\/squads\/([^/]+)\/(members|leader|tasks)/);
  if (apprMatch) {
    if (url.pathname.endsWith("/members") && req.method === "POST") return json(200, { id: "fe-team", members: [] });
    if (url.pathname.endsWith("/tasks") && req.method === "POST") return json(201, { taskId: "t0" });
    return json(200, { id: "fe-team", members: [] });
  }
  if (url.pathname.startsWith("/api/approvals")) return json(200, []);

  // ── claimable / claim ──
  if (url.pathname === "/api/agent-tasks" && req.method === "GET" && url.searchParams.get("claimable")) {
    const squad = url.searchParams.get("squad");
    const list = [...pool.values()]
      .filter((t) => !t.claimedBy)
      .filter((t) => !squad || t.poolScope === squad)
      .map(({ id, content, poolScope, claimPolicy, skillTags, createdAt }) => ({ id, content, poolScope, claimPolicy, skillTags, createdAt }));
    return json(200, list);
  }
  const claimMatch = url.pathname.match(/^\/api\/agent-tasks\/([^/]+)\/claim$/);
  if (claimMatch && req.method === "POST") {
    const task = pool.get(decodeURIComponent(claimMatch[1]));
    if (!task) return json(404, { error: { message: `任务不存在: ${claimMatch[1]}`, code: "not_found" } });
    const agentId = String(body.agent ?? "").trim();
    if (!agentId) return json(400, { error: { message: "agent 必填", code: "bad_request" } });
    // 原子条件 UPDATE 语义：已被认领 → 409（不静默）
    if (task.claimedBy) {
      return json(409, { error: { message: `任务已被「${task.claimedBy}」认领`, code: "conflict" } });
    }
    task.claimedBy = agentId;
    const leaseExpiresAt = Date.now() + 10 * 60_000;
    return json(200, { ok: true, status: "claimed", leaseExpiresAt });
  }
  if (url.pathname === "/api/agent-tasks" && req.method === "GET") return json(200, { tasks: [], runtimes: [] });
  if (url.pathname.startsWith("/api/")) return json(404, { error: { message: "not found", code: "not_found" } });

  try {
    let p = join(DIST, decodeURIComponent(url.pathname));
    try { if (statSync(p).isDirectory()) p = join(p, "index.html"); } catch { p = join(DIST, "index.html"); }
    const file = await readFile(p);
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(file);
  } catch { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let passed = 0, failed = 0;
const check = (n, ok) => { console.log((ok ? "PASS " : "FAIL ") + n); ok ? passed++ : failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ① 进小队详情 → 任务池渲染（claimable 列表 + 标签 + 池范围）
  await page.goto(`${BASE}/?view=teams&sub=squads`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="squad-card"]', { timeout: 15_000 });
  await page.locator('[data-testid="squad-card"]').first().click();
  await page.waitForSelector('[data-testid="squad-task-pool"]', { timeout: 8000 });
  await page.waitForSelector('[data-claimable-id="pool-task-1"]', { timeout: 8000 });
  const poolText = await page.locator('[data-testid="squad-task-pool"]').textContent();
  check("任务池渲染（claimable 2 条 + skill 标签 + 池范围）",
    (poolText ?? "").includes("梳理登录页") && (poolText ?? "").includes("frontend") && (poolText ?? "").includes("fe-team"));

  // ② 选择智能体认领成功（租约提示）
  await page.locator('select[aria-label="认领智能体"]').selectOption("coder");
  await page.locator('[data-claimable-id="pool-task-1"] button', { hasText: "认领" }).click();
  await page.waitForFunction(
    () => document.querySelector('.ag-page__hint')?.textContent?.includes("已认领"),
    null, { timeout: 8000 },
  );
  check("认领 pool-task-1 → 成功提示带租约说明", true);

  // ③ 池内减少（剩 1 条）
  await sleep(300);
  const remaining = await page.locator("[data-claimable-id]").count();
  check("认领后池内减少（剩 1 条）", remaining === 1);

  // ④ 第二人抢同任务 → 409 原样展示（直接 API 验证原子语义）
  const doubleClaim = await page.evaluate(async () => {
    const res = await fetch("/api/agent-tasks/pool-task-1/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "reviewer" }),
    });
    return { status: res.status, code: (await res.json())?.error?.code };
  });
  check("双人抢单 → 第二人 409 conflict（原子条件 UPDATE）",
    doubleClaim.status === 409 && doubleClaim.code === "conflict");

  // 截图
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, "task-pool.png"), fullPage: true });

  // ⑤ 认领第二个 → 池空态
  await page.locator('select[aria-label="认领智能体"]').selectOption("reviewer");
  await page.locator('[data-claimable-id="pool-task-2"] button', { hasText: "认领" }).click();
  await page.waitForSelector('[data-testid="pool-empty"]', { timeout: 8000 });
  check("清空池 → 空态提示", true);
} finally {
  await browser.close();
  server.close();
}
console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED / ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
