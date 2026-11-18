// 智能体（AI 团队平台 P0）e2e — stub 后端实现 spec §5.1 契约。
// 用法：node packages/web-ui/e2e/agents-smoke.mjs
// 前置：bun run build:web-ui
//
// stub 后端实现本前端定义的契约（DSH 后端落地前的前置验证；落地后无需改前端）：
//   GET    /api/agents                → AgentCard[]
//   POST   /api/agents                → 201 AgentDetail（template 预填指令；重名 409）
//   GET    /api/agents/templates      → AgentTemplate[]
//   GET    /api/agents/:id            → AgentDetail（404）
//   PATCH  /api/agents/:id            → AgentDetail（runtime null=解绑；名称锁定）
//   DELETE /api/agents/:id            → 归档（软删）
//   GET    /api/agents/:id/overview   → 概览指标 + 最近运行
//   GET    /api/agents/:id/runs       → {runs}（kind 过滤）
//   其余 /api/* → 最小响应
//
// 覆盖：① 深链 sub=agents 列表（卡片 + runtime 徽标 + 7d 计数）
//   ② 模板一键创建（选模板 → 创建 → 卡片出现）
//   ③ 手填创建（非法 id 400 原样展示 + 重名 409）
//   ④ 详情概览（指标卡 + 最近运行表）
//   ⑤ 配置页：绑定/解绑 runtime、指令保存
//   ⑥ 运行历史 + kind 过滤
//   ⑦ 设置页：env/args 保存；⑧ 归档两步确认 → 列表消失。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { statSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const DIST = join(REPO, "packages/web-ui/dist");
const PORT = 4215;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_SHOT_DIR ?? join(REPO, ".verify-agents");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

// ── stub 智能体仓 ──
const templates = [
  { id: "coder", displayName: "代码工程师", description: "代码编写 Agent", instructions: "你是一个代码编写 Agent。按任务要求读改代码并验证。" },
  { id: "researcher", displayName: "调研员", description: "调研 Agent", instructions: "你是一个调研 Agent。结论先行、要点分列。" },
];
const agents = new Map();
function seed(a) { agents.set(a.id, a); }
seed({ id: "coder", displayName: "代码工程师", description: "代码编写 Agent", runtime: "dsh", runtimeStatus: "online", runs7d: 12, lastRunStatus: "replied", archived: false, instructions: templates[0].instructions, model: "", env: { NODE_ENV: "development" }, envSecrets: [{ key: "GITHUB_TOKEN", masked: "ghp_****" }], args: [], skills: ["code-review"], mcp: ["context7"], permissionMode: "inherit", visibility: "private" });

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
    return json(200, [...agents.values()].filter((a) => !a.archived).map(({ id, displayName, description, runtime, runtimeStatus, runs7d, lastRunStatus, archived }) => ({ id, displayName, description, runtime, runtimeStatus, runs7d, lastRunStatus, archived })));
  }
  if (url.pathname === "/api/agents" && req.method === "POST") {
    const id = (body.id ?? "").trim();
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return json(400, { error: { message: "id 必填：小写 kebab-case", code: "bad_request" } });
    if (agents.has(id)) return json(409, { error: { message: `智能体已存在: ${id}`, code: "conflict" } });
    const tpl = body.template ? templates.find((t) => t.id === body.template) : undefined;
    const a = { id, displayName: body.displayName?.trim() || tpl?.displayName || id, description: tpl?.description ?? "", runtime: body.runtime ?? null, runtimeStatus: body.runtime ? "unprobed" : "unbound", runs7d: 0, lastRunStatus: null, archived: false, instructions: body.instructions ?? tpl?.instructions ?? "", model: "", env: body.env ?? {}, envSecrets: [], args: body.args ?? [], skills: [], mcp: [], permissionMode: "inherit", visibility: "private" };
    agents.set(id, a);
    return json(201, a);
  }
  if (url.pathname === "/api/agents/templates") return json(200, templates);
  const m = url.pathname.match(/^\/api\/agents\/([^/]+)(\/overview|\/runs)?$/);
  if (m) {
    const a = agents.get(decodeURIComponent(m[1]));
    if (!a) return json(404, { error: { message: `智能体不存在: ${m[1]}`, code: "not_found" } });
    if (!m[2] && req.method === "GET") return json(200, a);
    if (!m[2] && req.method === "PATCH") {
      if (body.runtime !== undefined) { a.runtime = body.runtime; a.runtimeStatus = body.runtime ? "unprobed" : "unbound"; }
      for (const k of ["displayName", "description", "instructions", "model", "env", "args", "permissionMode"]) {
        if (body[k] !== undefined) a[k] = body[k];
      }
      return json(200, a);
    }
    if (!m[2] && req.method === "DELETE") { a.archived = true; return json(200, { ok: true }); }
    if (m[2] === "/overview") {
      const success = a.runs7d > 0 ? a.runs7d - 1 : 0;
      return json(200, {
        agent: { id: a.id, displayName: a.displayName, runtime: a.runtime, runtimeStatus: a.runtimeStatus, probeStatus: a.runtimeStatus === "online" ? "ok" : null, probedAt: a.runtime ? new Date().toISOString() : null },
        counters: { runs7d: a.runs7d, success7d: success, failed7d: a.runs7d - success, avgDurationMs: 18400, tokens7d: a.runs7d * 12800 },
        assets: { skills: a.skills.length, mcps: a.mcp.length, integrations: 0, envKeys: Object.keys(a.env).length + a.envSecrets.length },
        recentRuns: a.runs7d > 0 ? [{ id: "r1", kind: "dispatch", status: "replied", title: "示例任务", startedAt: new Date().toISOString(), durationMs: 12000 }] : [],
        lastError: null,
      });
    }
    if (m[2] === "/runs") {
      const kind = url.searchParams.get("kind");
      const all = a.runs7d > 0 ? [
        { id: "r1", kind: "session", status: "replied", title: "会话任务", startedAt: new Date().toISOString(), durationMs: 8000 },
        { id: "r2", kind: "dispatch", status: "replied", title: "派单任务", startedAt: new Date().toISOString(), durationMs: 15000 },
        { id: "r3", kind: "group", status: "failed", title: "群聊任务", startedAt: new Date().toISOString(), durationMs: 3000 },
      ] : [];
      return json(200, { runs: kind ? all.filter((r) => r.kind === kind) : all });
    }
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
let passed = 0, failed = 0;
const check = (n, ok) => { console.log((ok ? "PASS " : "FAIL ") + n); ok ? passed++ : failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ① 深链 + 列表
  await page.goto(`${BASE}/?view=teams&sub=agents`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="agent-card"]', { timeout: 15_000 });
  await sleep(500);
  const cardCount = await page.locator('[data-testid="agent-card"]').count();
  const coderText = await page.locator('[data-agent-id="coder"]').textContent();
  check("深链 sub=agents → 列表卡片（seed 1 个）", cardCount === 1 && (coderText ?? "").includes("代码工程师") && (coderText ?? "").includes("7d 运行 12"));

  // ② 模板一键创建
  await page.locator("button", { hasText: "创建智能体" }).click();
  await page.waitForSelector('[data-testid="agent-create-form"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="agent-template-list"] button', { timeout: 5000 });
  await page.locator('[data-testid="agent-template-list"] button', { hasText: "调研员" }).click();
  await page.locator("#ag-id").fill("review-bot");
  await page.locator("#ag-runtime").fill("kimi");
  await page.locator("button", { hasText: "创建" }).last().click();
  await page.waitForSelector('[data-agent-id="review-bot"]', { timeout: 8000 });
  check("模板一键创建 review-bot → 列表出现卡片", true);

  // ③ 手填非法 id → 400 原样展示；重名 → 409
  await page.locator("button", { hasText: "创建智能体" }).click();
  await page.locator("#ag-id").fill("Bad ID");
  await page.locator("button", { hasText: "创建" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-create-form"] .ag-page__hint--error')?.textContent?.includes("kebab-case"),
    null, { timeout: 5000 },
  );
  check("非法 id → 400 错误原样展示", true);
  await page.locator("#ag-id").fill("coder");
  await page.locator("button", { hasText: "创建" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-create-form"] .ag-page__hint--error')?.textContent?.includes("已存在"),
    null, { timeout: 5000 },
  );
  check("重名 → 409 错误原样展示", true);
  await page.locator("button", { hasText: "取消" }).click();
  await sleep(300);

  // ④ 详情概览
  await page.locator('[data-agent-id="coder"]').click();
  await page.waitForSelector('[data-testid="agent-overview"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="agent-overview"] table tbody tr', { timeout: 5000 });
  const overviewText = await page.locator('[data-testid="agent-overview"]').textContent();
  check("详情概览：指标卡 + 最近运行表", (overviewText ?? "").includes("成功率") && (overviewText ?? "").includes("示例任务"));

  // 截图：概览页
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, "agents-overview.png"), fullPage: true });

  // ⑤ 配置页：解绑 → 绑定
  await page.locator('.tm-subnav__chip', { hasText: "配置" }).click();
  await page.waitForSelector('[data-testid="agent-config"]', { timeout: 5000 });
  await page.locator("#ag-rt").fill("");
  await page.locator("button", { hasText: "保存绑定" }).click();
  await page.waitForFunction(
    () => document.querySelector(".tm-libhead .ag-badge")?.textContent?.includes("未绑定"),
    null, { timeout: 8000 },
  );
  check("解绑 runtime → 徽标变「未绑定」", true);
  await page.locator("#ag-rt").fill("dsh");
  await page.locator("button", { hasText: "保存绑定" }).click();
  await page.waitForFunction(
    () => !(document.querySelector(".tm-libhead .ag-badge")?.textContent ?? "").includes("未绑定"),
    null, { timeout: 8000 },
  );
  const insArea = page.locator("#ag-ins");
  await insArea.fill("更新后的指令内容");
  await page.locator("button", { hasText: "保存指令" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-config"] .ag-page__hint')?.textContent?.includes("已保存"),
    null, { timeout: 8000 },
  );
  check("绑定恢复 + 指令保存提示", true);

  // ⑥ 运行历史 + kind 过滤
  await page.locator('.tm-subnav__chip', { hasText: "运行历史" }).click();
  await page.waitForSelector('[data-testid="agent-runs"] table tbody tr', { timeout: 8000 });
  const allRows = await page.locator('[data-testid="agent-runs"] tbody tr').count();
  await page.locator('[data-testid="agent-runs"] .tm-subnav__chip', { hasText: "派单" }).click();
  await sleep(400);
  const dispatchRows = await page.locator('[data-testid="agent-runs"] tbody tr').count();
  const dispatchText = await page.locator('[data-testid="agent-runs"]').textContent();
  check("运行历史：全部 3 行 + kind 过滤只剩派单", allRows === 3 && dispatchRows === 1 && (dispatchText ?? "").includes("派单任务"));

  // ⑦ 设置页
  await page.locator('.tm-subnav__chip', { hasText: "设置" }).click();
  await page.waitForSelector('[data-testid="agent-settings"]', { timeout: 5000 });
  check("设置页：敏感变量掩码展示", (await page.locator('[data-testid="agent-settings"]').textContent()).includes("ghp_****"));
  await page.locator("#ag-env").fill("FOO=bar");
  await page.locator("#ag-args").fill("--max-output 64000");
  await page.locator("button", { hasText: "保存设置" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-settings"] .ag-page__hint')?.textContent?.includes("已保存"),
    null, { timeout: 8000 },
  );
  check("设置保存（env/args）", true);

  // 截图：配置页（列表可见卡片 + 表单布局）
  await page.locator('.tm-subnav__chip', { hasText: "配置" }).click();
  await sleep(300);
  await page.screenshot({ path: join(OUT, "agents-config.png"), fullPage: true });

  // ⑧ 归档（两步确认）→ 列表消失
  await page.locator('.tm-subnav__chip', { hasText: "设置" }).click();
  await sleep(200);
  await page.locator("button", { hasText: "归档智能体" }).click();
  await page.locator("button", { hasText: "确认归档" }).click();
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("归档智能体") && b.disabled),
    null, { timeout: 8000 },
  );
  check("归档 coder → 两步确认后按钮转禁用（软删生效）", true);
  await page.locator('button[aria-label="返回列表"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-agent-id="coder"]'), null, { timeout: 8000 });
  check("归档后列表不再显示该智能体", (await page.locator('[data-testid="agent-card"]').count()) === 1);
} finally {
  await browser.close();
  server.close();
}
console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED / ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
