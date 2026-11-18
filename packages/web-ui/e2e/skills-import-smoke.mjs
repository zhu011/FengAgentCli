// Skill 导入 + agent 挂载（P1）e2e — stub 后端实现 spec §5.3 契约。
// 用法：node packages/web-ui/e2e/skills-import-smoke.mjs
// 前置：bun run build:web-ui
//
// stub 契约（DSH P1 后端落地前的前置验证；落地后前端零改动）：
//   POST /api/skills/import {type:path|url|runtime_copy, ...} → SkillImportResult
//     - url：仅 https + github 系域名白名单；同名 onConflict(fail|rename|overwrite)
//   GET/POST /api/agents/:id/skills；PATCH/DELETE /api/agents/:id/skills/:name
//   其余 /api/* → 最小响应（agents 真后端已落，这里一并 stub 求独立）
//
// 覆盖：① 技能库 URL 导入（合法 github raw → 落库 + 提示带 sha256）
//   ② 非白名单域名/非 https → 400 原样展示
//   ③ 同名 onConflict=fail → 409；rename → 自动改名落库
//   ④ 本地导入 + 运行时复制表单切换
//   ⑤ agent 配置页：挂载库中技能 → 启停 → 卸载（关系列表变化）

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { statSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const DIST = join(REPO, "packages/web-ui/dist");
const PORT = 4217;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_SHOT_DIR ?? join(REPO, ".verify-agents");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

// ── stub 技能库 + agent + 挂载 ──
const teamSkills = new Map(); // name → {name, description}
teamSkills.set("code-review", { name: "code-review", description: "代码审查技能" });
teamSkills.set("release-notes", { name: "release-notes", description: "发版说明技能" });
const agents = new Map();
agents.set("coder", { id: "coder", displayName: "代码工程师", description: "", runtime: "dsh", runtimeStatus: "online", runs7d: 1, lastRunStatus: "replied", archived: false, instructions: "", model: "", env: {}, envSecrets: [], args: [], skills: ["code-review"], mcp: [], permissionMode: "inherit", visibility: "private" });
const mounts = new Map(); // agentId → [{name, enabled, source, shadowed}]
mounts.set("coder", [{ name: "code-review", enabled: true, source: "url", shadowed: false }]);

const URL_ALLOWLIST = ["raw.githubusercontent.com", "github.com", "gist.githubusercontent.com", "www.anet.sh"];

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

  // 技能合并视图（真后端同形）
  if (url.pathname === "/api/skills" && req.method === "GET") {
    const skills = [...teamSkills.values()].map((s) => ({ ...s, trigger: "", prompt: `（${s.name} 的 prompt）`, source: "team", enabled: true, editable: true, shadowed: [] }));
    return json(200, { roots: { team: "(stub)", project: [] }, skills, layers: skills, errors: [] });
  }

  // 导入
  if (url.pathname === "/api/skills/import" && req.method === "POST") {
    const type = body.type;
    let name = "";
    let sha = "a1b2c3d4e5f6";
    if (type === "url") {
      const u = String(body.url ?? "");
      if (!/^https:\/\//.test(u)) return json(400, { error: { message: "URL 导入只允许 https://", code: "bad_request" } });
      let host;
      try { host = new URL(u).hostname; } catch { return json(400, { error: { message: "URL 不合法", code: "bad_request" } }); }
      if (!URL_ALLOWLIST.includes(host)) return json(400, { error: { message: `域名 ${host} 不在导入白名单（github 系）`, code: "bad_request" } });
      name = (u.split("/").pop() ?? "").replace(/\.md$/i, "").toLowerCase();
    } else if (type === "local") {
      const p = String(body.path ?? "");
      if (!p) return json(400, { error: { message: "path 必填", code: "bad_request" } });
      name = (p.split(/[\\/]/).pop() ?? "").replace(/\.md$/i, "").toLowerCase();
    } else if (type === "runtime_copy") {
      if (!body.runtime || !body.name) return json(400, { error: { message: "runtime 与 name 必填", code: "bad_request" } });
      name = String(body.name);
    } else {
      return json(400, { error: { message: "type 必须是 local | url | runtime_copy", code: "bad_request" } });
    }
    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return json(400, { error: { message: "导入源缺少合法的技能名（kebab-case）", code: "bad_request" } });
    }
    const conflict = teamSkills.has(name);
    const onConflict = body.onConflict ?? "fail";
    if (conflict && onConflict === "fail") {
      return json(409, { error: { message: `技能「${name}」已存在`, code: "conflict" } });
    }
    if (conflict && onConflict === "rename") name = `${name}-imported`;
    teamSkills.set(name, { name, description: `导入自 ${type}` });
    return json(201, {
      name,
      source: {
        type,
        ...(body.url ? { url: body.url } : {}),
        ...(body.path ? { path: body.path } : {}),
        ...(body.runtime ? { runtime: body.runtime } : {}),
        sha256: sha,
        importedAt: new Date().toISOString(),
      },
    });
  }

  // agents（真后端同形，够 e2e 用）
  if (url.pathname === "/api/agents" && req.method === "GET") {
    return json(200, [...agents.values()].map(({ id, displayName, description, runtime, runtimeStatus, runs7d, lastRunStatus, archived }) => ({ id, displayName, description, runtime, runtimeStatus, runs7d, lastRunStatus, archived })));
  }
  const m = url.pathname.match(/^\/api\/agents\/([^/]+)(\/skills)?(\/([^/]+))?$/);
  if (m && m[2] === "/skills") {
    const agentId = decodeURIComponent(m[1]);
    if (!agents.has(agentId)) return json(404, { error: { message: `智能体不存在: ${agentId}`, code: "not_found" } });
    const list = mounts.get(agentId) ?? [];
    if (!m[4] && req.method === "GET") return json(200, list);
    if (!m[4] && req.method === "POST") {
      if (!body.name || !teamSkills.has(body.name)) return json(400, { error: { message: `技能不存在: ${body.name}`, code: "bad_request" } });
      if (!list.some((x) => x.name === body.name)) list.push({ name: body.name, enabled: true, source: "manual", shadowed: false });
      mounts.set(agentId, list);
      return json(200, list);
    }
    if (m[4] && req.method === "PATCH") {
      const item = list.find((x) => x.name === decodeURIComponent(m[4]));
      if (!item) return json(404, { error: { message: "未挂载该技能", code: "not_found" } });
      if (typeof body.enabled === "boolean") item.enabled = body.enabled;
      return json(200, list);
    }
    if (m[4] && req.method === "DELETE") {
      const rest = list.filter((x) => x.name !== decodeURIComponent(m[4]));
      mounts.set(agentId, rest);
      return json(200, rest);
    }
  }
  const md2 = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (md2 && req.method === "GET") {
    const a = agents.get(decodeURIComponent(md2[1]));
    if (!a) return json(404, { error: { message: "not found", code: "not_found" } });
    return json(200, { ...a, skills: (mounts.get(a.id) ?? []).map((x) => x.name) });
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
  // ① URL 导入（合法 github raw）
  await page.goto(`${BASE}/?view=teams&sub=skills`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="skill-card"]', { timeout: 15_000 });
  await page.locator("button", { hasText: "导入" }).click();
  await page.waitForSelector('[data-testid="skill-import-form"]', { timeout: 5000 });
  await page.locator("#sk-import-src").fill("https://raw.githubusercontent.com/o/r/main/skills/git-helper.md");
  await page.selectOption("#sk-import-conflict", "rename");
  await page.locator("button", { hasText: "导入" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="skill-import-form"] .ag-page__hint')?.textContent?.includes("已导入「git-helper」"),
    null, { timeout: 8000 },
  );
  const importNotice = await page.locator('[data-testid="skill-import-form"] .ag-page__hint').textContent();
  check("URL 导入 → 落库提示带名称与 sha256", (importNotice ?? "").includes("sha256"));

  // ② 非白名单域名 → 400；非 https → 400
  await page.locator("#sk-import-src").fill("http://evil.com/x.md");
  await page.locator("button", { hasText: "导入" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="skill-import-form"] .ag-page__hint--error')?.textContent?.includes("https"),
    null, { timeout: 5000 },
  );
  check("非 https → 400 原样展示", true);
  await page.locator("#sk-import-src").fill("https://evil.com/x.md");
  await page.locator("button", { hasText: "导入" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="skill-import-form"] .ag-page__hint--error')?.textContent?.includes("白名单"),
    null, { timeout: 5000 },
  );
  check("非白名单域名 → 400 原样展示", true);

  // ③ 同名冲突：fail → 409
  await page.locator("#sk-import-src").fill("https://raw.githubusercontent.com/o/r/main/skills/code-review.md");
  await page.selectOption("#sk-import-conflict", "fail");
  await page.locator("button", { hasText: "导入" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="skill-import-form"] .ag-page__hint--error')?.textContent?.includes("已存在"),
    null, { timeout: 5000 },
  );
  check("同名 + onConflict=fail → 409 原样展示", true);

  // ④ 本地导入 + 运行时复制（表单切换；runtime_copy 走 agent 挂载先验证表单存在）
  await page.locator('[data-testid="import-type-picker"] button', { hasText: "本地文件" }).click();
  await page.locator("#sk-import-src").fill("D:/skills/my-local-skill.md");
  await page.locator("button", { hasText: "导入" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="skill-import-form"] .ag-page__hint')?.textContent?.includes("已导入「my-local-skill」"),
    null, { timeout: 8000 },
  );
  check("本地导入 → 落库", true);
  await page.locator('[data-testid="import-type-picker"] button', { hasText: "从运行时复制" }).click();
  await page.locator("#sk-import-rt").fill("claude");
  await page.locator("#sk-import-name").fill("runtime-skill");
  await page.locator("button", { hasText: "导入" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="skill-import-form"] .ag-page__hint')?.textContent?.includes("已导入「runtime-skill」"),
    null, { timeout: 8000 },
  );
  check("运行时复制导入 → 落库", true);

  // 截图：技能库导入表单
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, "skills-import-form.png"), fullPage: true });
  await page.locator("button", { hasText: "关闭" }).click();
  await sleep(300);

  // ⑤ agent 配置页挂载管理
  await page.goto(`${BASE}/?view=teams&sub=agents`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-agent-id="coder"]', { timeout: 15000 });
  await page.locator('[data-agent-id="coder"]').click();
  await page.locator('.tm-subnav__chip', { hasText: "配置" }).click();
  await page.waitForSelector('[data-testid="agent-skills-mount"]', { timeout: 8000 });
  await page.waitForSelector('[data-mounted-skill="code-review"]', { timeout: 5000 });

  // 挂载 release-notes
  await page.locator('[data-testid="agent-skills-mount"] select').selectOption("release-notes");
  await page.locator('[data-testid="agent-skills-mount"] button', { hasText: "挂载" }).click();
  await page.waitForSelector('[data-mounted-skill="release-notes"]', { timeout: 8000 });
  check("挂载 release-notes → 列表出现", true);

  // 启停
  await page.locator('[data-mounted-skill="release-notes"] button', { hasText: "停用" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-mounted-skill="release-notes"]')?.textContent?.includes("停用") &&
      ![...document.querySelectorAll('[data-mounted-skill="release-names"] .permission-grants__badge')].length,
    null, { timeout: 8000 },
  ).catch(() => {});
  await sleep(300);
  const badgeAfter = await page.locator('[data-mounted-skill="release-notes"] .permission-grants__badge').textContent();
  check("停用 → 徽标「停用」", (badgeAfter ?? "").includes("停用"));
  await page.locator('[data-mounted-skill="release-notes"] button', { hasText: "启用" }).click();
  await sleep(300);

  // 卸载（只删关系）
  await page.locator('[data-mounted-skill="release-notes"] button', { hasText: "卸载" }).click();
  await page.waitForFunction(() => !document.querySelector('[data-mounted-skill="release-notes"]'), null, { timeout: 8000 });
  check("卸载 release-notes → 挂载列表消失（库内容保留）", true);

  await page.screenshot({ path: join(OUT, "agent-skills-mount.png"), fullPage: true });
} finally {
  await browser.close();
  server.close();
}
console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED / ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
