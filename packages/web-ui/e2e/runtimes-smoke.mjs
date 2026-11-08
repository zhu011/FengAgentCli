// 外部 agent 管理界面 e2e（stub 后端实现 KG 侧契约 + opencode「协议不支持」用例）。
// 用法：node packages/web-ui/e2e/runtimes-smoke.mjs
// 前置：bun run build:web-ui
//
// stub 后端实现本前端定义的 CRUD 契约（DSH 后端落地前的前置验证）：
//   GET    /api/runtimes                 → RuntimeInfo[]
//   POST   /api/runtimes                 → 201 RuntimeInfo[]（重名 409）
//   PATCH  /api/runtimes/:name           → RuntimeInfo[]（不存在 404）
//   DELETE /api/runtimes/:name           → RuntimeInfo[]
//   POST   /api/runtimes/probe-candidate → RuntimeProbeResult（opencode 报协议不支持）
//   GET    /api/agent-tasks | /api/groups | /api/health → 最小响应

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { statSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const DIST = join(REPO, "packages/web-ui/dist");
const PORT = 4211;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_SHOT_DIR ?? join(REPO, ".verify-runtimes");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

// ── 内存 runtime 注册表（stub） ──
let runtimes = [
  { name: "fengagent", command: "fengagent", args: ["acp"], protocol: "acp", enabled: true, agentName: "FengAgent", agentVersion: "0.2.0", capabilities: { resume: true, loadSession: true, image: false }, probeStatus: "ok", recentTaskCount: 2 },
  { name: "dsh", command: "dsh-acp", args: ["acp"], protocol: "acp", enabled: true, agentName: "DeepSeek Harness", agentVersion: "0.1.0-rc.6", capabilities: { resume: true, loadSession: false, image: true }, probeStatus: "ok", recentTaskCount: 5 },
];
let nextId = 100;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  // 读 body
  let body = {};
  if (req.method !== "GET" && req.method !== "DELETE") {
    body = await new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
  }

  if (url.pathname === "/api/health") return json(200, { status: "ok", version: "stub" });
  if (url.pathname === "/api/agent-tasks") return json(200, { tasks: [], runtimes });
  if (url.pathname === "/api/groups") return json(200, { groups: [], runtimes: [] });

  if (url.pathname === "/api/runtimes" && req.method === "GET") return json(200, runtimes);
  if (url.pathname === "/api/runtimes" && req.method === "POST") {
    if (!body.name || !body.command) return json(400, { error: { message: "名称与 command 必填", code: "bad_request" } });
    if (runtimes.some((r) => r.name === body.name)) return json(409, { error: { message: `runtime「${body.name}」已存在`, code: "conflict" } });
    runtimes.push({ name: body.name, command: body.command, args: body.args ?? [], protocol: body.protocol ?? "acp", enabled: body.enabled ?? true, agentName: body.name, agentVersion: "—", capabilities: { resume: false, loadSession: false, image: false }, probeStatus: "unprobed", recentTaskCount: 0 });
    return json(201, runtimes);
  }
  const patch = url.pathname.match(/^\/api\/runtimes\/([^/]+)$/);
  if (patch && req.method === "PATCH") {
    const name = decodeURIComponent(patch[1]);
    const r = runtimes.find((x) => x.name === name);
    if (!r) return json(404, { error: { message: `runtime「${name}」不存在`, code: "not_found" } });
    Object.assign(r, body.command ? { command: body.command } : {}, body.args ? { args: body.args } : {}, body.protocol ? { protocol: body.protocol } : {}, body.env ? { env: body.env } : {});
    return json(200, runtimes);
  }
  const del = url.pathname.match(/^\/api\/runtimes\/([^/]+)$/);
  if (del && req.method === "DELETE") {
    const name = decodeURIComponent(del[1]);
    if (!runtimes.some((x) => x.name === name)) return json(404, { error: { message: `runtime「${name}」不存在`, code: "not_found" } });
    runtimes = runtimes.filter((x) => x.name !== name);
    return json(200, runtimes);
  }
  if (url.pathname === "/api/runtimes/probe-candidate" && req.method === "POST") {
    // opencode 用例：run --json 协议不在支持列表 → 明确「协议不支持」，不静默
    if (body.command === "opencode") {
      return json(200, {
        probeStatus: "unreachable",
        probeError: "协议不支持：opencode 使用 run --json 协议，当前仅支持 acp / claude-stream-json",
      });
    }
    return json(200, { probeStatus: "ok", agentName: body.command ?? "?", agentVersion: "stub" });
  }
  if (url.pathname.startsWith("/api/")) return json(404, { error: { message: "not found", code: "not_found" } });

  // 静态文件（SPA 回退）
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
const check = (name, ok) => { console.log((ok ? "PASS " : "FAIL ") + name); ok ? passed++ : failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto(`${BASE}/?view=teams&sub=members`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="runtime-card"]', { timeout: 15000 });
  await sleep(500);

  // ① 添加表单打开 + opencode 探测「协议不支持」
  await page.locator("button", { hasText: "添加 runtime" }).click();
  await page.waitForSelector('[data-testid="runtime-form"]', { timeout: 5000 });
  await page.locator("#rt-name").fill("opencode");
  await page.locator("#rt-command").fill("opencode");
  await page.locator("button", { hasText: "探测验证" }).click();
  await page.waitForSelector(".ag-page__hint--error", { timeout: 8000 });
  const probeErr = await page.locator('[data-testid="runtime-form"] .ag-page__hint--error').first().textContent();
  check("opencode 探测 → 失败原因原样展示（协议不支持）", (probeErr ?? "").includes("协议不支持") && (probeErr ?? "").includes("run --json"));

  // ② 保存 → 卡片出现
  await page.locator("button", { hasText: "添加" }).last().click();
  await page.waitForSelector('[data-runtime-name="opencode"]', { timeout: 8000 });
  check("添加 opencode → 成员库出现卡片", true);

  // ③ 编辑改 command
  await page.locator('[data-runtime-name="opencode"] button', { hasText: "编辑" }).click();
  await page.waitForSelector('[data-testid="runtime-form"]', { timeout: 5000 });
  const nameDisabled = await page.locator("#rt-name").isDisabled();
  check("编辑模式名称锁定", nameDisabled);
  await page.locator("#rt-command").fill("opencode-edit");
  await page.locator("button", { hasText: "保存修改" }).click();
  await page.waitForFunction(() => document.querySelector('[data-runtime-name="opencode"] code')?.textContent?.includes("opencode-edit"), null, { timeout: 8000 });
  check("编辑 command → 卡片更新", true);

  // ④ 删除（两步确认）
  await page.locator('[data-runtime-name="opencode"] button', { hasText: "删除" }).click();
  await page.locator("button", { hasText: "确认删除" }).click();
  await page.waitForFunction(() => !document.querySelector('[data-runtime-name="opencode"]'), null, { timeout: 8000 });
  check("删除 opencode → 卡片消失", true);

  // ⑤ 重名 409 原样显示
  await page.locator("button", { hasText: "添加 runtime" }).click();
  await page.locator("#rt-name").fill("dsh");
  await page.locator("#rt-command").fill("dsh-acp");
  await page.locator("button", { hasText: "添加" }).last().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-form"] .ag-page__hint--error')?.textContent?.includes("已存在"), null, { timeout: 8000 });
  check("重名 409 → 错误原样展示", true);

  // 截图（表单带探测失败原因的状态）
  mkdirSync(OUT, { recursive: true });
  await page.locator("#rt-command").fill("opencode");
  await page.locator("button", { hasText: "探测验证" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-form"] .ag-page__hint--error')?.textContent?.includes("协议不支持"), null, { timeout: 8000 });
  await page.screenshot({ path: join(OUT, "runtimes-form-probe-error.png"), fullPage: true });
  await page.locator("button", { hasText: "取消" }).click();
  await sleep(400);
  await page.screenshot({ path: join(OUT, "runtimes-library.png"), fullPage: true });
} finally {
  await browser.close();
  server.close();
}
console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED / ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
