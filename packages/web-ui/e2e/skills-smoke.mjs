// 技能库（团队级共享 skill）e2e — 真后端（DSH 4c67aca 起 /api/skills）。
// 用法：node packages/web-ui/e2e/skills-smoke.mjs
// 前置：bun run build:web-ui
//
// 隔离：spawn 真 server（bun packages/server/src/entry.ts），cwd 指向临时
// workdir（预置 .fengagent/skills/debug.md 演示「本目录覆盖」），FENG_TEAM_HOME
// 指临时团队根（团队层 .md 与 skills.json 停用索引都落这里），FENG_DATA_DIR
// 指临时数据根——不碰本机 ~/.fengagent-cordis 与仓库目录。
//
// 覆盖（真端到端）：
//   ① 深链 sub=skills → 三层合并列表（内置 4 + 本目录 debug 覆盖 + 被覆盖标记）
//   ② 添加 → 团队卡片 + teamDir/*.md 真落盘（frontmatter + body 校验）
//   ③ 重名 409 原样展示；④ 编辑锁名 + 落盘同步
//   ⑤ 编辑内置 = 团队级覆盖 + 恢复默认（文件删、内置回来）
//   ⑥ 停用 → skills.json 停用索引 + 卡片标记；启用恢复
//   ⑦ 删除（两步确认）→ 卡片消失 + 文件清除
//   ⑧ 搜索过滤；⑨ 填入输入框 → ?prefill-skill 预填 composer（真后端取内置 prompt）
//
// 注意：用 Node 跑（Bun/Windows 与 playwright CDP 管道不兼容，见 teams-smoke.mjs 头注）。

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const PORT = 4223;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_SHOT_DIR ?? join(REPO, ".verify-skills");

// ── 隔离环境：临时 workdir（预置本目录技能）+ 临时团队根 + 临时数据根 ──
const workdir = mkdtempSync(join(tmpdir(), "feng-skills-e2e-wd-"));
const teamRoot = mkdtempSync(join(tmpdir(), "feng-skills-e2e-team-"));
const dataRoot = mkdtempSync(join(tmpdir(), "feng-skills-e2e-data-"));
const teamDir = join(teamRoot, "skills");

// 本目录（workdir）层：debug.md 覆盖内置 debug —— 演示「已被本目录覆盖」
mkdirSync(join(workdir, ".fengagent", "skills"), { recursive: true });
writeFileSync(
  join(workdir, ".fengagent", "skills", "debug.md"),
  "---\nname: debug\ndescription: 本目录定制版调试技能 — 先跑测试再定位\ntrigger: 遇到 bug 时（本目录版）\n---\n\n先跑一遍现有测试确认基线，再按复现→定位→分析→修复→验证定位问题。\n",
  "utf-8",
);

// server 的静态目录按 cwd 解析（entry.ts: resolve(cwd, "packages/web-ui/dist")），
// 而技能 project 层也用同一个 cwd —— 用 junction 把真实 dist 挂进临时 workdir，
// 既隔离技能层、又能伺服 web-ui（junction 在 Windows 免管理员权限）。
mkdirSync(join(workdir, "packages", "web-ui"), { recursive: true });
symlinkSync(join(REPO, "packages", "web-ui", "dist"), join(workdir, "packages", "web-ui", "dist"), "junction");

const serverProc = spawn("bun", [join(REPO, "packages/server/src/entry.ts")], {
  cwd: workdir,
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

/** 团队层 .md 原文（落盘校验用；不存在返回 null） */
function teamFile(name) {
  try {
    return readFileSync(join(teamDir, `${name}.md`), "utf-8");
  } catch {
    return null;
  }
}

/** 停用索引（skills.json）里的名单 */
function disabledList() {
  try {
    return JSON.parse(readFileSync(join(teamDir, "skills.json"), "utf-8")).disabled ?? [];
  } catch {
    return [];
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let passed = 0, failed = 0;
const check = (name, ok) => { console.log((ok ? "PASS " : "FAIL ") + name); ok ? passed++ : failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const card = (name, source) => `[data-skill-name="${name}"][data-skill-source="${source}"]`;

try {
  await waitReady();

  // ① 深链 + 三层合并列表（来源徽章 + 被覆盖标记）
  await page.goto(`${BASE}/?view=teams&sub=skills`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="skill-card"]', { timeout: 15_000 });
  await sleep(500);
  const cardCount = await page.locator('[data-testid="skill-card"]').count();
  const debugWorkdir = await page.locator(card("debug", "workdir")).count();
  const debugBuiltin = await page.locator(card("debug", "builtin")).count();
  const shadowText = await page.locator(card("debug", "builtin")).textContent();
  console.log(`[cards] total=${cardCount} debugWorkdir=${debugWorkdir} debugBuiltin=${debugBuiltin}`);
  check(
    "深链 sub=skills → 三层合并列表（内置 4 + 本目录 debug 覆盖）",
    cardCount === 5 && debugWorkdir === 1 && debugBuiltin === 1,
  );
  check("被覆盖标记：内置 debug 显示「已被本目录覆盖」", (shadowText ?? "").includes("已被本目录覆盖"));

  // ② 添加技能（团队级）→ 卡片 + 真落盘
  await page.locator("button", { hasText: "添加技能" }).click();
  await page.waitForSelector('[data-testid="skill-form"]', { timeout: 5000 });
  await page.locator("#sk-name").fill("perf-audit");
  await page.locator("#sk-desc").fill("性能审查技能");
  await page.locator("#sk-prompt").fill("你是性能审查专家。关注 N+1、重复计算与内存泄漏。");
  await page.locator("button", { hasText: "添加" }).last().click();
  await page.waitForSelector(card("perf-audit", "team"), { timeout: 8000 });
  const perfFile = teamFile("perf-audit");
  check(
    "添加 perf-audit → 团队卡片 + teamDir/perf-audit.md 落盘（frontmatter + body）",
    perfFile !== null &&
      perfFile.includes("name: perf-audit") &&
      perfFile.includes("description: 性能审查技能") &&
      perfFile.includes("你是性能审查专家"),
  );

  // ③ 重名 409 原样显示
  await page.locator("button", { hasText: "添加技能" }).click();
  await page.waitForSelector('[data-testid="skill-form"]', { timeout: 5000 });
  await page.locator("#sk-name").fill("perf-audit");
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

  // ④ 编辑锁名 + 落盘同步
  await page.locator(`${card("perf-audit", "team")} button`, { hasText: "编辑" }).click();
  await page.waitForSelector('[data-testid="skill-form"]', { timeout: 5000 });
  check("编辑模式名称锁定", await page.locator("#sk-name").isDisabled());
  await page.locator("#sk-desc").fill("性能审查技能 — 团队模板 v2");
  await page.locator("button", { hasText: "保存修改" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-skill-name="perf-audit"][data-skill-source="team"]')?.textContent?.includes("团队模板 v2"),
    null,
    { timeout: 8000 },
  );
  check("编辑描述 → 卡片与落盘同步更新", (teamFile("perf-audit") ?? "").includes("团队模板 v2"));

  // ⑤ 编辑内置 = 团队级覆盖 + 恢复默认
  await page.locator(`${card("code-review", "builtin")} button`, { hasText: "编辑" }).click();
  await page.waitForSelector('[data-testid="skill-form"]', { timeout: 5000 });
  await page.locator("#sk-prompt").fill("你是代码审查专家（团队定制版）。");
  await page.locator("button", { hasText: "保存修改" }).click();
  await page.waitForSelector(card("code-review", "team"), { timeout: 8000 });
  const resetBtn = await page.locator(`${card("code-review", "team")} button`, { hasText: "恢复默认" }).count();
  check("编辑内置 code-review → 团队覆盖卡片 + 恢复默认按钮 + 落盘", resetBtn === 1 && teamFile("code-review") !== null);
  await page.locator(`${card("code-review", "team")} button`, { hasText: "恢复默认" }).click();
  await page.locator("button", { hasText: "确认恢复" }).click();
  await page.waitForFunction(
    () => !document.querySelector('[data-skill-name="code-review"][data-skill-source="team"]')
      && Boolean(document.querySelector('[data-skill-name="code-review"][data-skill-source="builtin"]')),
    null,
    { timeout: 8000 },
  );
  check("恢复默认 → 团队覆盖文件删除、内置回来", !existsSync(join(teamDir, "code-review.md")));

  // ⑥ 停用 → 名字级停用索引 + 卡片标记；启用恢复
  await page.locator(`${card("perf-audit", "team")} button`, { hasText: "停用" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-skill-name="perf-audit"][data-skill-source="team"]')?.textContent?.includes("已停用"),
    null,
    { timeout: 8000 },
  );
  check("停用 → 卡片「已停用」+ skills.json 停用索引", disabledList().includes("perf-audit"));
  await page.locator(`${card("perf-audit", "team")} button`, { hasText: "启用" }).click();
  await page.waitForFunction(
    () => !(document.querySelector('[data-skill-name="perf-audit"][data-skill-source="team"]')?.textContent ?? "").includes("已停用"),
    null,
    { timeout: 8000 },
  );
  check("启用 → 停用索引清除", !disabledList().includes("perf-audit"));

  // ⑦ 删除（两步确认）→ 卡片消失 + 文件清除
  await page.locator(`${card("perf-audit", "team")} button`, { hasText: "删除" }).click();
  await page.locator("button", { hasText: "确认删除" }).click();
  await page.waitForFunction(() => !document.querySelector('[data-skill-name="perf-audit"]'), null, { timeout: 8000 });
  check("删除 perf-audit → 卡片消失 + 团队文件清除", teamFile("perf-audit") === null);

  // ⑧ 搜索过滤
  await page.locator('input[aria-label="搜索技能"]').fill("code");
  await sleep(400);
  const visibleNames = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="skill-card"]')].map((c) => c.getAttribute("data-skill-name")),
  );
  check("搜索 code → 只剩 code-review 卡片", visibleNames.length === 1 && visibleNames[0] === "code-review");
  await page.locator('input[aria-label="搜索技能"]').fill("");
  await sleep(400);

  // 截图：技能库（真后端）
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, "skills-real-library.png"), fullPage: true });

  // ⑨ 填入输入框 → 聊天页 composer 预填（真后端取内置 prompt）
  await page.locator(`${card("code-review", "builtin")} button`, { hasText: "填入输入框" }).click();
  await page.waitForSelector(".composer__textarea", { timeout: 8000 });
  await page.waitForFunction(
    () => (document.querySelector(".composer__textarea")?.value ?? "").includes("代码审查"),
    null,
    { timeout: 8000 },
  );
  check("填入输入框 → ?prefill-skill=code-review 预填 composer（真后端内置 prompt）", true);
  const urlNow = new URL(page.url()).searchParams.get("prefill-skill");
  check("预填后 URL 参数已摘除（刷新不重触发）", urlNow === null);
  await page.screenshot({ path: join(OUT, "skills-real-prefill.png"), fullPage: true });
} finally {
  await browser.close();
  try { process.kill(-serverProc.pid); } catch { /* already gone */ }
  for (const dir of [workdir, teamRoot, dataRoot]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
  }
}
console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED / ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
