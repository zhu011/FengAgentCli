// 技能库（团队级共享 skill）e2e — stub 后端实现 KG 侧契约。
// 用法：node packages/web-ui/e2e/skills-smoke.mjs
// 前置：bun run build:web-ui
//
// stub 后端实现本前端定义的契约（DSH 后端落地前的前置验证）：
//   GET    /api/skills?merge=1        → 合并视图（所有层定义，被覆盖的带 overriddenBy）
//   GET    /api/skills/:name?merge=1  → 胜出层详情（含 prompt，「填入输入框」用）
//   POST   /api/skills                → 201（团队级重名 409）
//   PATCH  /api/skills/:name          → 200（不存在 404；编辑内置 = 团队级覆盖）
//   DELETE /api/skills/:name          → 200（内置 409 提示 reset；不存在 404）
//   POST   /api/skills/:name/reset    → 200（非内置 404）
//   GET    /api/runtimes|agent-tasks|groups|sessions|models|health → 最小响应
//
// 覆盖：① 深链+三层列表/来源徽章/被覆盖标记 ② 添加 ③ 重名 409 ④ 编辑锁名
//   ⑤ 编辑内置=团队覆盖+恢复默认 ⑥ 停用/启用（agent 侧不可见）⑦ 删除（两步）
//   ⑧ 搜索过滤 ⑨ 填入输入框（?prefill-skill → composer 预填）。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { statSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const DIST = join(REPO, "packages/web-ui/dist");
const PORT = 4213;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_SHOT_DIR ?? join(REPO, ".verify-skills");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

// ── stub 技能库（三层 + 名字级启停，语义与 web-ui SkillsMock 一致） ──
const LAYER_ORDER = { builtin: 0, team: 1, workdir: 2 };
const layers = new Map(); // name -> Map<layer, skill>
const disabledNames = new Set();

function seed(name, layer, skill) {
  const byLayer = layers.get(name) ?? new Map();
  byLayer.set(layer, { name, source: layer, enabled: true, ...skill });
  layers.set(name, byLayer);
}
seed("code-review", "builtin", { description: "代码审查技能", trigger: "请求代码审查时", prompt: "你是代码审查专家。按正确性/安全性/性能/可读性/一致性审查。" });
seed("debug", "builtin", { description: "调试辅助技能", trigger: "遇到 bug 时", prompt: "你是调试专家。按复现→定位→分析→修复→验证定位问题。" });
seed("refactor", "builtin", { description: "重构建议技能", trigger: "请求重构时", prompt: "你是重构专家。识别异味，给出分步方案。" });
seed("test", "builtin", { description: "测试编写技能", trigger: "请求编写测试时", prompt: "你是测试专家。遵循 Arrange-Act-Assert。" });
seed("release-notes", "team", { description: "发版说明技能 — 按团队模板生成 CHANGELOG", trigger: "请求发版说明时", prompt: "按团队模板生成发版说明：归类变更，按用户视角重写。" });
seed("debug", "workdir", { description: "本目录定制版调试技能", trigger: "遇到 bug 时（本目录版）", prompt: "先跑测试确认基线，再定位问题。" });

function sortedLayers(name) {
  return [...(layers.get(name) ?? new Map()).entries()].sort((a, b) => LAYER_ORDER[b[0]] - LAYER_ORDER[a[0]]);
}
function merged() {
  const out = [];
  for (const name of layers.keys()) {
    const entries = sortedLayers(name);
    const winner = entries[0][0];
    const enabled = !disabledNames.has(name);
    for (const [layer, skill] of entries) {
      out.push({ ...skill, enabled, ...(layer === winner ? {} : { overriddenBy: winner }) });
    }
  }
  return out;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
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
  if (url.pathname === "/api/runtimes" && req.method === "GET") return json(200, []);
  if (url.pathname === "/api/agent-tasks") return json(200, { tasks: [], runtimes: [] });
  if (url.pathname === "/api/groups") return json(200, { groups: [], runtimes: [] });
  if (url.pathname === "/api/sessions") return json(200, []);
  if (url.pathname === "/api/models") return json(200, { models: [] });

  if (url.pathname === "/api/skills" && req.method === "GET") {
    return json(200, merged());
  }
  if (url.pathname === "/api/skills" && req.method === "POST") {
    if (!body.name || !body.prompt) return json(400, { error: { message: "名称与 prompt 必填", code: "bad_request" } });
    if (layers.get(body.name)?.has("team")) {
      return json(409, { error: { message: `技能「${body.name}」已存在（团队级）`, code: "conflict" } });
    }
    const byLayer = layers.get(body.name) ?? new Map();
    byLayer.set("team", { name: body.name, description: body.description ?? "", trigger: body.trigger ?? "", prompt: body.prompt, source: "team", enabled: true });
    layers.set(body.name, byLayer);
    if (body.enabled === false) disabledNames.add(body.name);
    return json(201, merged());
  }
  const skillOp = url.pathname.match(/^\/api\/skills\/([^/]+)(\/reset)?$/);
  if (skillOp) {
    const name = decodeURIComponent(skillOp[1]);
    const isReset = Boolean(skillOp[2]);
    const byLayer = layers.get(name);
    if (req.method === "GET") {
      const entries = sortedLayers(name);
      if (entries.length === 0) return json(404, { error: { message: `技能「${name}」不存在`, code: "not_found" } });
      return json(200, { ...entries[0][1], enabled: !disabledNames.has(name) });
    }
    if (req.method === "PATCH") {
      if (!byLayer) return json(404, { error: { message: `技能「${name}」不存在`, code: "not_found" } });
      if (body.enabled !== undefined) {
        if (body.enabled) disabledNames.delete(name);
        else disabledNames.add(name);
      }
      const hasContent = body.description !== undefined || body.trigger !== undefined || body.prompt !== undefined;
      if (hasContent) {
        const current = byLayer.get("team") ?? { name, description: "", trigger: "", prompt: "", source: "team", enabled: true };
        byLayer.set("team", {
          ...current,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
          ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        });
      }
      return json(200, merged());
    }
    if (req.method === "DELETE") {
      if (!byLayer) return json(404, { error: { message: `技能「${name}」不存在`, code: "not_found" } });
      if (!byLayer.has("team")) {
        const isBuiltin = byLayer.has("builtin");
        return json(409, {
          error: {
            message: isBuiltin
              ? `内置技能「${name}」不能删除，只能恢复默认（reset）或用团队级同名覆盖`
              : `本目录技能「${name}」是 workdir 下的 .md 文件，请直接编辑该文件`,
            code: "conflict",
          },
        });
      }
      byLayer.delete("team");
      if (byLayer.size === 0) layers.delete(name);
      return json(200, merged());
    }
    if (req.method === "POST" && isReset) {
      if (!byLayer?.has("builtin")) {
        return json(404, { error: { message: `技能「${name}」不是内置技能，没有可恢复的默认版本`, code: "not_found" } });
      }
      byLayer.delete("team");
      return json(200, merged());
    }
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

const card = (name, source) => `[data-skill-name="${name}"][data-skill-source="${source}"]`;

try {
  // ① 深链 + 三层合并列表（来源徽章 + 被覆盖标记）
  await page.goto(`${BASE}/?view=teams&sub=skills`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="skill-card"]', { timeout: 15_000 });
  await sleep(500);
  const cardCount = await page.locator('[data-testid="skill-card"]').count();
  const debugWorkdir = await page.locator(card("debug", "workdir")).count();
  const debugBuiltinShadowed = await page.locator(card("debug", "builtin")).count();
  const shadowText = await page.locator(card("debug", "builtin")).textContent();
  check(
    "深链 sub=skills → 三层合并列表（内置 4 + 团队 1 + 本目录覆盖 debug）",
    cardCount === 6 && debugWorkdir === 1 && debugBuiltinShadowed === 1,
  );
  check("被覆盖标记：内置 debug 显示「已被本目录覆盖」", (shadowText ?? "").includes("已被本目录覆盖"));

  // ② 添加技能（团队级）
  await page.locator("button", { hasText: "添加技能" }).click();
  await page.waitForSelector('[data-testid="skill-form"]', { timeout: 5000 });
  await page.locator("#sk-name").fill("perf-audit");
  await page.locator("#sk-desc").fill("性能审查技能");
  await page.locator("#sk-prompt").fill("你是性能审查专家。关注 N+1、重复计算与内存泄漏。");
  await page.locator("button", { hasText: "添加" }).last().click();
  await page.waitForSelector(card("perf-audit", "team"), { timeout: 8000 });
  check("添加 perf-audit → 团队卡片出现", true);

  // ③ 重名 409 原样显示
  await page.locator("button", { hasText: "添加技能" }).click();
  await page.waitForSelector('[data-testid="skill-form"]', { timeout: 5000 });
  await page.locator("#sk-name").fill("release-notes");
  await page.locator("#sk-desc").fill("重复");
  await page.locator("#sk-prompt").fill("x");
  await page.locator("button", { hasText: "添加" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="skill-form"] .ag-page__hint--error')?.textContent?.includes("已存在"),
    null,
    { timeout: 8000 },
  );
  check("重名 409 → 错误原样展示", true);
  await page.locator("button", { hasText: "取消" }).click();
  await sleep(300);

  // ④ 编辑锁名 + 保存
  await page.locator(`${card("release-notes", "team")} button`, { hasText: "编辑" }).click();
  await page.waitForSelector('[data-testid="skill-form"]', { timeout: 5000 });
  check("编辑模式名称锁定", await page.locator("#sk-name").isDisabled());
  await page.locator("#sk-desc").fill("发版说明技能 — 团队模板 v2");
  await page.locator("button", { hasText: "保存修改" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-skill-name="release-notes"][data-skill-source="team"]')?.textContent?.includes("团队模板 v2"),
    null,
    { timeout: 8000 },
  );
  check("编辑描述 → 卡片更新", true);

  // ⑤ 编辑内置 = 团队级覆盖 + 恢复默认
  await page.locator(`${card("code-review", "builtin")} button`, { hasText: "编辑" }).click();
  await page.waitForSelector('[data-testid="skill-form"]', { timeout: 5000 });
  await page.locator("#sk-prompt").fill("你是代码审查专家（团队定制版）。");
  await page.locator("button", { hasText: "保存修改" }).click();
  await page.waitForSelector(card("code-review", "team"), { timeout: 8000 });
  const resetBtn = await page.locator(`${card("code-review", "team")} button`, { hasText: "恢复默认" }).count();
  check("编辑内置 code-review → 团队覆盖卡片 + 恢复默认按钮", resetBtn === 1);
  await page.locator(`${card("code-review", "team")} button`, { hasText: "恢复默认" }).click();
  await page.locator("button", { hasText: "确认恢复" }).click();
  await page.waitForFunction(
    () => !document.querySelector('[data-skill-name="code-review"][data-skill-source="team"]')
      && Boolean(document.querySelector('[data-skill-name="code-review"][data-skill-source="builtin"]')),
    null,
    { timeout: 8000 },
  );
  check("恢复默认 → 团队覆盖移除，内置回来", true);

  // ⑥ 停用 → agent 侧不可见标记；再启用
  await page.locator(`${card("release-notes", "team")} button`, { hasText: "停用" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-skill-name="release-notes"][data-skill-source="team"]')?.textContent?.includes("已停用"),
    null,
    { timeout: 8000 },
  );
  check("停用 → 卡片显示「已停用（agent 侧不可见）」", true);
  await page.locator(`${card("release-notes", "team")} button`, { hasText: "启用" }).click();
  await page.waitForFunction(
    () => !document.querySelector('[data-skill-name="release-notes"][data-skill-source="team"]')?.textContent?.includes("已停用"),
    null,
    { timeout: 8000 },
  );
  check("启用 → 停用标记消失", true);

  // ⑦ 删除（两步确认）
  await page.locator(`${card("perf-audit", "team")} button`, { hasText: "删除" }).click();
  await page.locator("button", { hasText: "确认删除" }).click();
  await page.waitForFunction(() => !document.querySelector('[data-skill-name="perf-audit"]'), null, { timeout: 8000 });
  check("删除 perf-audit → 卡片消失", true);

  // ⑧ 搜索过滤
  await page.locator('input[aria-label="搜索技能"]').fill("debug");
  await sleep(400);
  const visibleNames = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="skill-card"]')].map((c) => c.getAttribute("data-skill-name")),
  );
  check("搜索 debug → 只剩 debug 相关卡片", visibleNames.length > 0 && visibleNames.every((n) => n === "debug"));
  await page.locator('input[aria-label="搜索技能"]').fill("");
  await sleep(400);

  // 截图：技能库
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, "skills-library.png"), fullPage: true });

  // ⑨ 填入输入框 → 聊天页 composer 预填（等价 TUI /skill <name>）
  await page.locator(`${card("code-review", "builtin")} button`, { hasText: "填入输入框" }).click();
  await page.waitForSelector(".composer__textarea", { timeout: 8000 });
  await page.waitForFunction(
    () => (document.querySelector(".composer__textarea")?.value ?? "").includes("代码审查专家"),
    null,
    { timeout: 8000 },
  );
  check("填入输入框 → ?prefill-skill=code-review 预填 composer", true);
  const urlNow = new URL(page.url()).searchParams.get("prefill-skill");
  check("预填后 URL 参数已摘除（刷新不重触发）", urlNow === null);
  await page.screenshot({ path: join(OUT, "skills-prefill-chat.png"), fullPage: true });
} finally {
  await browser.close();
  server.close();
}
console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED / ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
