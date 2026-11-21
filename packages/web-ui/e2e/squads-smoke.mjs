// 小队（AI 团队平台 P2）e2e — stub 后端实现 spec §5.2 契约。
// 用法：node packages/web-ui/e2e/squads-smoke.mjs
// 前置：bun run build:web-ui
//
// stub 契约（DSH P2 后端落地前的前置验证；落地后前端零改动）：
//   GET/POST /api/squads；GET/PATCH/DELETE /api/squads/:id
//   POST /api/squads/:id/members；DELETE .../members/:type/:id（现任队长 → 409）
//   POST /api/squads/:id/leader；POST /api/squads/:id/tasks；GET .../runs
//
// 覆盖（spec §5.2 验收）：① 建队（队长自动入成员）② 绑成员（自由 role）
//   ③ 设队长/换队长 ④ 移除现任队长被拒（409 原样展示）⑤ 移除普通成员
//   ⑥ 小队指令保存 ⑦ mode 切换 ⑧ 派任务 → 运行树（leader 父 + 成员子）
//   ⑨ 归档两步确认 → 列表消失。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const DIST = join(REPO, "packages/web-ui/dist");
const PORT = 4219;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_SHOT_DIR ?? join(REPO, ".verify-squads");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

// ── stub 仓 ──
const agents = new Map();
for (const [id, displayName] of [["coder", "代码工程师"], ["reviewer", "评审员"], ["researcher", "调研员"]]) {
  agents.set(id, { id, displayName, description: "", runtime: "dsh", runtimeStatus: "online", runs7d: 1, lastRunStatus: "replied", archived: false });
}
const squads = new Map();
const runs = new Map();
let taskSeq = 1;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  let body = {};
  if (req.method !== "GET" && req.method !== "DELETE") {
    body = await new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { r(JSON.parse(d)); } catch { r({}); } }); });
  }
  if (url.pathname === "/api/health") return json(200, { status: "ok" });
  if (url.pathname === "/api/runtimes" && req.method === "GET") return json(200, []);
  if (url.pathname === "/api/agent-tasks") return json(200, { tasks: [], runtimes: [] });
  if (url.pathname === "/api/groups") return json(200, { groups: [], runtimes: [] });
  if (url.pathname === "/api/sessions") return json(200, []);
  if (url.pathname === "/api/models") return json(200, { models: [] });
  if (url.pathname === "/api/agents" && req.method === "GET") {
    return json(200, [...agents.values()].map(({ id, displayName, description, runtime, runtimeStatus, runs7d, lastRunStatus, archived }) => ({ id, displayName, description, runtime, runtimeStatus, runs7d, lastRunStatus, archived })));
  }

  const found = (id) => {
    const s = squads.get(id);
    if (!s) throw Object.assign(new Error(`小队不存在: ${id}`), { status: 404, code: "not_found" });
    return s;
  };
  const respondSquad = (s) => json(200, { ...s, members: [...s.members] });

  if (url.pathname === "/api/squads" && req.method === "GET") {
    console.log("[stub] list squads:", [...squads.keys()]);
    return json(200, [...squads.values()].filter((s) => !s.archived).map((s) => ({ ...s, members: [...s.members] })));
  }
  if (url.pathname === "/api/squads" && req.method === "POST") {
    // id 生成规则：显式 id 优先；否则名字 slugify（仅 [a-z0-9-]，其余剔除），空则序号兜底
    const rawId = String(body.id ?? "").trim().toLowerCase();
    const slug =
      rawId === ""
        ? String(body.name ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
        : rawId;
    const id = slug === "" ? `squad-${Date.now() % 100000}` : slug;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return json(400, { error: { message: "小队 id 必须是 kebab-case", code: "bad_request" } });
    if (squads.has(id)) return json(409, { error: { message: `小队已存在: ${id}`, code: "conflict" } });
    const leaderId = String(body.leaderId ?? "").trim();
    if (!leaderId) return json(400, { error: { message: "leaderId 必填", code: "bad_request" } });
    const s = {
      id, name: String(body.name ?? id), description: String(body.description ?? ""),
      leaderId, mode: body.mode ?? "leader", instructions: String(body.instructions ?? ""),
      members: [{ memberType: "agent", memberId: leaderId, role: "leader" }],
      archived: false,
    };
    squads.set(id, s);
    console.log("[stub] created squad:", id, "leader:", leaderId);
    return json(201, { ...s, members: [...s.members] });
  }

  let m = url.pathname.match(/^\/api\/squads\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const s = squads.get(id);
    if (!s) return json(404, { error: { message: `小队不存在: ${id}`, code: "not_found" } });
    if (req.method === "GET") return respondSquad(s);
    if (req.method === "PATCH") {
      for (const k of ["name", "description", "instructions"]) if (body[k] !== undefined) s[k] = body[k];
      if (body.mode !== undefined) s.mode = body.mode;
      return respondSquad(s);
    }
    if (req.method === "DELETE") { s.archived = true; return json(200, { ok: true }); }
  }

  m = url.pathname.match(/^\/api\/squads\/([^/]+)\/members(\/([^/]+)\/([^/]+))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const s = squads.get(id);
    if (!s) return json(404, { error: { message: `小队不存在: ${id}`, code: "not_found" } });
    if (!m[2] && req.method === "POST") {
      const memberId = String(body.memberId ?? "").trim();
      if (!memberId) return json(400, { error: { message: "memberId 必填", code: "bad_request" } });
      if (s.members.some((x) => x.memberId === memberId)) return json(409, { error: { message: `成员已在小队: ${memberId}`, code: "conflict" } });
      s.members.push({ memberType: body.memberType ?? "agent", memberId, role: String(body.role ?? "") });
      return respondSquad(s);
    }
    if (m[2] && req.method === "DELETE") {
      const target = decodeURIComponent(m[4]);
      if (target === s.leaderId) {
        return json(409, {
          error: {
            message: `不能移除现任队长「${target}」——先换队长（POST /leader）再移除`,
            code: "cannot_remove_squad_leader",
          },
        });
      }
      const idx = s.members.findIndex((x) => x.memberType === decodeURIComponent(m[3]) && x.memberId === target);
      if (idx === -1) return json(404, { error: { message: `成员不在小队: ${target}`, code: "not_found" } });
      s.members.splice(idx, 1);
      return respondSquad(s);
    }
  }

  m = url.pathname.match(/^\/api\/squads\/([^/]+)\/leader$/);
  if (m && req.method === "POST") {
    const id = decodeURIComponent(m[1]);
    const s = squads.get(id);
    if (!s) return json(404, { error: { message: `小队不存在: ${id}`, code: "not_found" } });
    const target = String(body.leaderId ?? "").trim();
    if (!s.members.some((x) => x.memberId === target)) {
      return json(400, { error: { message: `新队长「${target}」必须已是小队成员（agent）`, code: "bad_request" } });
    }
    s.leaderId = target;
    return respondSquad(s);
  }

  m = url.pathname.match(/^\/api\/squads\/([^/]+)\/tasks$/);
  if (m && req.method === "POST") {
    const id = decodeURIComponent(m[1]);
    const s = squads.get(id);
    if (!s) return json(404, { error: { message: `小队不存在: ${id}`, code: "not_found" } });
    if (s.archived) return json(409, { error: { message: "小队已归档", code: "conflict" } });
    const taskId = `sq-task-${taskSeq++}`;
    const now = new Date().toISOString();
    const list = runs.get(id) ?? [];
    const worker = s.members.find((x) => x.memberId !== s.leaderId)?.memberId ?? s.leaderId;
    list.push(
      { id: `${taskId}-leader`, assignee: s.leaderId, status: "running", title: String(body.content ?? "").slice(0, 30), parentRunId: null, startedAt: now },
      { id: `${taskId}-w1`, assignee: worker, status: "queued", title: `子任务：${String(body.content ?? "").slice(0, 20)}`, parentRunId: `${taskId}-leader`, startedAt: now },
    );
    runs.set(id, list);
    return json(201, { taskId });
  }

  m = url.pathname.match(/^\/api\/squads\/([^/]+)\/runs$/);
  if (m && req.method === "GET") {
    const id = decodeURIComponent(m[1]);
    if (!squads.has(id)) return json(404, { error: { message: `小队不存在: ${id}`, code: "not_found" } });
    return json(200, runs.get(id) ?? []);
  }

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
page.on("console", (m) => { if (m.type() === "error") console.log("[page.error]", m.text().slice(0, 200)); });
page.on("requestfailed", (r) => console.log("[req.fail]", r.method(), r.url(), r.failure()?.errorText));
let passed = 0, failed = 0;
const check = (n, ok) => { console.log((ok ? "PASS " : "FAIL ") + n); ok ? passed++ : failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ① 建队（队长自动入成员）
  await page.goto(`${BASE}/?view=teams&sub=squads`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button:has-text("建小队")', { timeout: 15_000 });
  await page.locator("button", { hasText: "建小队" }).click();
  await page.waitForSelector('[data-testid="squad-create-form"]', { timeout: 5000 });
  await page.locator("#sq-name").fill("前端小队");
  await page.locator("#sq-leader").selectOption("coder");
  await page.locator("button", { hasText: "创建" }).click();
  await page.waitForSelector('[data-testid="squad-card"]', { timeout: 8000 });
  // 记下 squad id（进详情后列表卸载，卡片选择器不可用）
  const squadId = await page.locator('[data-testid="squad-card"]').first().getAttribute("data-squad-id");
  check("建小队（coder 任队长）→ 卡片出现", squadId !== null);

  // ② 绑成员（自由 role）
  await page.locator('[data-testid="squad-card"]').first().click();
  await page.waitForSelector('[data-testid="squad-members"]', { timeout: 8000 });
  await page.locator('[data-testid="squad-members"] select').selectOption("reviewer");
  await page.locator('[data-testid="squad-members"] input[placeholder*="角色"]').fill("评审");
  await page.locator("button", { hasText: "添加成员" }).click();
  await page.waitForSelector('[data-member-id="reviewer"]', { timeout: 8000 });
  await page.locator('[data-testid="squad-members"] select').selectOption("researcher");
  await page.locator('[data-testid="squad-members"] input[placeholder*="角色"]').fill("调研");
  await page.locator("button", { hasText: "添加成员" }).click();
  await page.waitForSelector('[data-member-id="researcher"]', { timeout: 8000 });
  check("绑定 reviewer（评审）+ researcher（调研）", true);

  // ③ 换队长
  await page.locator('[data-member-id="reviewer"] button', { hasText: "设为队长" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-member-id="reviewer"] .permission-grants__badge')?.textContent?.includes("队长"),
    null, { timeout: 8000 },
  );
  check("换队长 reviewer → 徽标「队长」", true);

  // ④ 现任队长行不显示「移除」按钮（前端约束）；API 级验证 409 语义
  const leaderRemoveBtn = await page.locator('[data-member-id="reviewer"] button', { hasText: "移除" }).count();
  check("现任队长行无「移除」按钮（前端约束）", leaderRemoveBtn === 0);
  const leader409 = await page.evaluate(async (sid) => {
    const res = await fetch(`/api/squads/${sid}/members/agent/reviewer`, { method: "DELETE" });
    const body = await res.json();
    return { status: res.status, code: body?.error?.code };
  }, squadId);
  check(
    "API 移除现任队长 → 409 cannot_remove_squad_leader",
    leader409.status === 409 && leader409.code === "cannot_remove_squad_leader",
  );

  // ⑤ 换回队长 coder → 移除 reviewer（普通成员可移除）
  await page.locator('[data-member-id="coder"] button', { hasText: "设为队长" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-member-id="coder"] .permission-grants__badge')?.textContent?.includes("队长"),
    null, { timeout: 8000 },
  );
  await page.locator('[data-member-id="reviewer"] button', { hasText: "移除" }).click();
  await page.waitForFunction(() => !document.querySelector('[data-member-id="reviewer"]'), null, { timeout: 8000 });
  check("换回队长后移除 reviewer → 列表消失", true);

  // ⑥ 小队指令保存
  await page.locator('[data-testid="squad-instructions"] textarea').fill("改动必须先跑 typecheck。");
  await page.locator("button", { hasText: "保存指令" }).click();
  await page.waitForFunction(
    () => document.querySelector(".ag-page__hint")?.textContent?.includes("小队指令已保存"),
    null, { timeout: 8000 },
  );
  check("小队指令保存", true);

  // ⑦ mode 切换
  await page.locator('select[aria-label="执行模式"]').selectOption("auto");
  await page.waitForFunction(
    () => document.querySelector(".ag-page__hint")?.textContent?.includes("自动模式"),
    null, { timeout: 8000 },
  );
  await page.locator('select[aria-label="执行模式"]').selectOption("leader");
  await sleep(400);

  // ⑧ 派任务 → 运行树
  await page.locator('[data-testid="squad-dispatch"] textarea').fill("重构登录页组件");
  await page.locator("button", { hasText: "派发" }).click();
  await page.waitForSelector('[data-testid="squad-runs"] [data-run-id]', { timeout: 8000 });
  const leaderRun = await page.locator('[data-testid="squad-runs"] [data-run-id$="-leader"]').count();
  const childRun = await page.locator('[data-testid="squad-runs"] [data-run-id$="-w1"]').count();
  check("派任务 → 运行树（leader 父 + 成员子）", leaderRun === 1 && childRun === 1);

  const { mkdirSync } = await import("node:fs");
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, "squad-detail.png"), fullPage: true });

  // ⑨ 归档两步确认 → 列表消失
  await page.locator("button", { hasText: "归档小队" }).click();
  await page.locator("button", { hasText: "确认归档" }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="squad-card"]'), null, { timeout: 8000 });
  check("归档小队 → 列表消失", true);
} finally {
  await browser.close();
  server.close();
}
console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED / ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
