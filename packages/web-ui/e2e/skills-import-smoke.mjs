// Skill 导入 + agent 挂载（P1）e2e — 真后端（DSH 3feae9a/ff590e5/223bd6d 起）。
// 用法：node packages/web-ui/e2e/skills-import-smoke.mjs
// 前置：bun run build:web-ui
//
// 隔离：spawn 真 server（bun packages/server/src/entry.ts），临时 FENG_DATA_DIR +
// FENG_TEAM_HOME + HOME（runtime_copy 走 ~/.claude/skills，预置离线 SKILL.md）；
// 本地导入预置一个 .md 到临时 workdir；dist junction 挂静态目录。
//
// 覆盖（真端到端，spec §5.3 验收）：
//   ① URL 导入：github raw 真拉取 → 团队库落盘 + sha256 提示
//   ② URL 错误分支：非 https / 非白名单域名 → 400 原样展示（无需外网）
//   ③ 本地导入（允许根内 .md）→ 落库
//   ④ runtime_copy：预置 ~/.claude/skills → 落库
//   ⑤ agent 挂载：创建 agent → 挂载技能 → 启停 → 卸载（关系删除、库内容保留）
//   ⑥ 版本快照与 restore：导入两版 → revisions 列表 → restore 回 v1（内容校验）
//   ⑦ prompt 注入闭环：挂载技能出现在 agent 详情 skills 数组（config.json 冗余）
//
// 注意：用 Node 跑（Bun/Windows 与 playwright CDP 管道不兼容）。

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const PORT = 4231;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_SHOT_DIR ?? join(REPO, ".verify-agents");

// ── 隔离环境 ──
const workdir = mkdtempSync(join(tmpdir(), "feng-skimport-wd-"));
const home = mkdtempSync(join(tmpdir(), "feng-skimport-home-"));
const teamRoot = mkdtempSync(join(tmpdir(), "feng-skimport-team-"));
const dataRoot = mkdtempSync(join(tmpdir(), "feng-skimport-data-"));
const teamDir = join(teamRoot, "skills");

// 本地导入源（允许根 = server 的 workdir = dataRoot）
const LOCAL_SKILL = join(dataRoot, "port-helper.md");
writeFileSync(LOCAL_SKILL, "---\nname: port-helper\ndescription: 端口排障技能（e2e 本地导入）\n---\n按端口查进程并给出处置建议。\n", "utf-8");

// runtime_copy 源：HOME 指临时目录 → ~/.claude/skills/net-tool/SKILL.md
const claudeSkillDir = join(home, ".claude", "skills", "net-tool");
mkdirSync(claudeSkillDir, { recursive: true });
writeFileSync(
  join(claudeSkillDir, "SKILL.md"),
  "---\nname: net-tool\ndescription: 网络排障技能（e2e 运行时复制）\n---\n先 ping 再 traceroute，分层定位丢包点。\n",
  "utf-8",
);

// dist junction
mkdirSync(join(dataRoot, "packages", "web-ui"), { recursive: true });
symlinkSync(join(REPO, "packages", "web-ui", "dist"), join(dataRoot, "packages", "web-ui", "dist"), "junction");

const serverProc = spawn("bun", [join(REPO, "packages/server/src/entry.ts")], {
  cwd: dataRoot,
  env: {
    ...process.env,
    // runtime_copy 走 ~/.claude/skills → HOME 指临时目录（离线可测）
    HOME: home,
    USERPROFILE: home,
    // HOME 被换后读不到本机全局凭据 → 占位 key 让 server 起得来（本 e2e 不走 LLM）
    OPENAI_COMPATIBLE_API_KEY: "e2e-placeholder",
    OPENAI_COMPATIBLE_BASE_URL: "https://127.0.0.1.invalid",
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

function teamMd(name) {
  try {
    return readFileSync(join(teamDir, `${name}.md`), "utf-8");
  } catch {
    return null;
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let passed = 0, failed = 0;
const check = (n, ok) => { console.log((ok ? "PASS " : "FAIL ") + n); ok ? passed++ : failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await waitReady();

  // ① URL 导入（github raw 真拉取）
  await page.goto(`${BASE}/?view=teams&sub=skills`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="skill-card"]', { timeout: 15_000 });
  await page.locator("button", { hasText: "导入" }).click();
  await page.waitForSelector('[data-testid="skill-import-form"]', { timeout: 5000 });
  await page.locator("#sk-import-src").fill("https://raw.githubusercontent.com/zhu011/FengAgentCli/main/.fengagent/skills/debug.md");
  await page.selectOption("#sk-import-conflict", "rename");
  await page.locator("button", { hasText: "导入" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="skill-import-form"] .ag-page__hint')?.textContent?.includes("已导入「"),
    null, { timeout: 30_000 },
  );
  const urlNotice = await page.locator('[data-testid="skill-import-form"] .ag-page__hint').textContent();
  check("URL 导入（github raw 真拉取）→ 落库提示带 sha256", (urlNotice ?? "").includes("sha256") && teamMd("debug") !== null && teamMd("debug").includes("调试专家"));

  // ② URL 错误分支（离线可验）
  await page.locator("#sk-import-src").fill("http://raw.githubusercontent.com/x.md");
  await page.locator("button", { hasText: "导入" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="skill-import-form"] .ag-page__hint--error')?.textContent?.includes("https"),
    null, { timeout: 8000 },
  );
  check("非 https → 400 原样展示", true);
  await page.locator("#sk-import-src").fill("https://evil.com/x.md");
  await page.locator("button", { hasText: "导入" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="skill-import-form"] .ag-page__hint--error')?.textContent?.includes("白名单") ||
      document.querySelector('[data-testid="skill-import-form"] .ag-page__hint--error')?.textContent?.includes("只允许"),
    null, { timeout: 8000 },
  );
  check("非白名单域名 → 400 原样展示", true);

  // ③ 本地导入
  await page.locator('[data-testid="import-type-picker"] button', { hasText: "本地文件" }).click();
  await page.locator("#sk-import-src").fill(LOCAL_SKILL);
  await page.selectOption("#sk-import-conflict", "rename");
  await page.locator("button", { hasText: "导入" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="skill-import-form"] .ag-page__hint')?.textContent?.includes("已导入「port-helper」"),
    null, { timeout: 8000 },
  );
  check("本地导入 → 团队库落盘（frontmatter 保留）", (teamMd("port-helper") ?? "").includes("端口排障技能"));

  // ④ runtime_copy（临时 HOME 下的 ~/.claude/skills）
  await page.locator('[data-testid="import-type-picker"] button', { hasText: "从运行时复制" }).click();
  await page.locator("#sk-import-rt").fill("claude");
  await page.locator("#sk-import-name").fill("net-tool");
  await page.locator("button", { hasText: "导入" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="skill-import-form"] .ag-page__hint')?.textContent?.includes("已导入「net-tool」"),
    null, { timeout: 8000 },
  );
  check("runtime_copy（claude skills 根）→ 落库", (teamMd("net-tool") ?? "").includes("网络排障技能"));

  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, "skills-import-real.png"), fullPage: true });
  await page.locator("button", { hasText: "关闭" }).click();
  await sleep(300);

  // ⑤+⑦ agent 挂载闭环：创建 agent → 挂载 → config.json skills 冗余 → 启停 → 卸载
  await page.goto(`${BASE}/?view=teams&sub=agents`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button:has-text("创建智能体")', { timeout: 15_000 });
  await page.locator("button", { hasText: "创建智能体" }).click();
  await page.locator("#ag-id").fill("skill-user");
  await page.locator("button", { hasText: "创建" }).last().click();
  await page.waitForSelector('[data-agent-id="skill-user"]', { timeout: 8000 });
  await page.locator('[data-agent-id="skill-user"]').click();
  await page.locator('.tm-subnav__chip', { hasText: "配置" }).click();
  await page.waitForSelector('[data-testid="agent-skills-mount"]', { timeout: 8000 });

  await page.locator('[data-testid="agent-skills-mount"] select').selectOption("port-helper");
  await page.locator('[data-testid="agent-skills-mount"] button', { hasText: "挂载" }).click();
  await page.waitForSelector('[data-mounted-skill="port-helper"]', { timeout: 8000 });
  const agentCfg = JSON.parse(readFileSync(join(dataRoot, "agents", "skill-user", "config.json"), "utf-8"));
  check("挂载 port-helper → 列表出现 + config.json skills 冗余（prompt 注入数据源）",
    Array.isArray(agentCfg.skills) && agentCfg.skills.includes("port-helper"));

  await page.locator('[data-mounted-skill="port-helper"] button', { hasText: "停用" }).click();
  await sleep(400);
  const badge = await page.locator('[data-mounted-skill="port-helper"] .permission-grants__badge').textContent();
  check("停用挂载 → 徽标「停用」", (badge ?? "").includes("停用"));

  await page.locator('[data-mounted-skill="port-helper"] button', { hasText: "卸载" }).click();
  await page.waitForFunction(() => !document.querySelector('[data-mounted-skill="port-helper"]'), null, { timeout: 8000 });
  check("卸载挂载 → 列表消失、技能库内容保留", teamMd("port-helper") !== null);

  await page.screenshot({ path: join(OUT, "agent-skills-real.png"), fullPage: true });

  // ⑥ 版本快照 + restore（API 级：导入同技能两次不同内容 → revisions → restore v1）
  const imp = await fetch(`${BASE}/api/skills/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "manual",
      name: "versioned-skill",
      description: "版本测试 v1",
      prompt: "第一版内容",
    }),
  });
  if (!imp.ok) throw new Error("manual import v1 failed: " + await imp.text());
  const imp2 = await fetch(`${BASE}/api/skills/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "manual",
      name: "versioned-skill",
      description: "版本测试 v2",
      prompt: "第二版内容",
      onConflict: "overwrite",
    }),
  });
  if (!imp2.ok) throw new Error("manual import v2 failed: " + await imp2.text());
  const revs = (await (await fetch(`${BASE}/api/skills/versioned-skill/revisions`)).json()).revisions;
  check("版本快照：两次写入 → 2 条 revision", Array.isArray(revs) && revs.length === 2);
  const v1Version = revs.find((r) => r.content?.includes?.("第一版") || r.version === 1)?.version ?? revs[0].version;
  const restored = await fetch(`${BASE}/api/skills/versioned-skill/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: v1Version }),
  });
  const afterRestore = await fetch(`${BASE}/api/skills/versioned-skill`).then((r) => r.json());
  check("restore 回滚 → 内容回到第一版", restored.ok && String(afterRestore.prompt ?? "").includes("第一版"));
} finally {
  await browser.close();
  try { process.kill(-serverProc.pid); } catch { /* already gone */ }
  for (const d of [workdir, home, teamRoot, dataRoot]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
  }
}
console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED / ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
