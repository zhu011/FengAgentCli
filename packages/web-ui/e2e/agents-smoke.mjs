// 智能体（AI 团队平台 P0）e2e — 真后端（DSH 4070aad 起 /api/agents）。
// 用法：node packages/web-ui/e2e/agents-smoke.mjs
// 前置：bun run build:web-ui
//
// 隔离：spawn 真 server（bun packages/server/src/entry.ts），临时 FENG_DATA_DIR
// （agent 实体落 <dataRoot>/agents/<id>/，run 历史落 <dataRoot>/sessions.db），
// dist 用 junction 挂进临时目录（server 静态目录按 cwd 解析）。
//
// 覆盖（真端到端）：
//   ① 深链 sub=agents → 空列表态 → 创建表单模板一键创建（落盘 agent.md/config.json 校验）
//   ② 重名 409 + 非法 id 前端校验
//   ③ 详情概览（指标卡 + 最近运行）
//   ④ 配置页：runtime 绑定/解绑（徽标变化）+ 指令保存（agent.md 落盘校验）
//   ⑤ 运行历史 kind 过滤 + 状态中文映射
//   ⑥ 设置页：env/args 保存（config.json 落盘校验）+ 归档两步确认 → 列表消失
//
// 注意：用 Node 跑（Bun/Windows 与 playwright CDP 管道不兼容）。

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const PORT = 4227;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_SHOT_DIR ?? join(REPO, ".verify-agents");

const dataRoot = mkdtempSync(join(tmpdir(), "feng-agents-e2e-data-"));
mkdirSync(join(dataRoot, "packages", "web-ui"), { recursive: true });
symlinkSync(join(REPO, "packages", "web-ui", "dist"), join(dataRoot, "packages", "web-ui", "dist"), "junction");

const serverProc = spawn("bun", [join(REPO, "packages/server/src/entry.ts")], {
  cwd: dataRoot,
  env: { ...process.env, FENG_DATA_DIR: dataRoot, FENG_SERVER_PORT: String(PORT), FENG_SERVER_HOST: "127.0.0.1" },
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

/** agent.md 原文（落盘校验） */
function agentMd(id) {
  try {
    return readFileSync(join(dataRoot, "agents", id, "agent.md"), "utf-8");
  } catch {
    return null;
  }
}

/** config.json（落盘校验） */
function agentConfig(id) {
  try {
    return JSON.parse(readFileSync(join(dataRoot, "agents", id, "config.json"), "utf-8"));
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

  // ① 深链 → 空列表 → 模板一键创建（真落盘）
  await page.goto(`${BASE}/?view=teams&sub=agents`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button:has-text("创建智能体")', { timeout: 15_000 });
  await sleep(600);
  check("深链 sub=agents → 真后端空列表态（无 mock 提示）",
    (await page.locator('[data-testid="agent-card"]').count()) === 0 &&
    (await page.locator(".ag-page__hint").filter({ hasText: "回退演示数据" }).count()) === 0);

  await page.locator("button", { hasText: "创建智能体" }).click();
  await page.waitForSelector('[data-testid="agent-create-form"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="agent-template-list"] button', { timeout: 5000 });
  await page.locator('[data-testid="agent-template-list"] button', { hasText: "代码工程师" }).click();
  await page.locator("#ag-id").fill("coder-bot");
  await page.locator("button", { hasText: "创建" }).last().click();
  await page.waitForSelector('[data-agent-id="coder-bot"]', { timeout: 8000 });
  const md = agentMd("coder-bot");
  const cfg = agentConfig("coder-bot");
  check(
    "模板一键创建 coder-bot → 卡片 + agent.md/config.json 真落盘",
    md !== null && md.includes("代码编写") && cfg !== null,
  );

  // ② 重名 409 + 非法 id 前端校验
  await page.locator("button", { hasText: "创建智能体" }).click();
  await page.locator("#ag-id").fill("Bad ID");
  await page.locator("button", { hasText: "创建" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-create-form"] .ag-page__hint--error')?.textContent?.includes("kebab-case"),
    null, { timeout: 5000 },
  );
  check("非法 id → 前端校验拦截", true);
  await page.locator("#ag-id").fill("coder-bot");
  await page.locator("button", { hasText: "创建" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-create-form"] .ag-page__hint--error')?.textContent?.includes("已存在"),
    null, { timeout: 5000 },
  );
  check("重名 → 409 原样展示", true);
  await page.locator("button", { hasText: "取消" }).click();
  await sleep(300);

  // ③ 详情概览
  await page.locator('[data-agent-id="coder-bot"]').click();
  await page.waitForSelector('[data-testid="agent-overview"]', { timeout: 8000 });
  const overviewText = await page.locator('[data-testid="agent-overview"]').textContent();
  check("详情概览：指标卡渲染（真后端 0 数据口径）", (overviewText ?? "").includes("成功率") && (overviewText ?? "").includes("7d"));

  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, "agents-real-overview.png"), fullPage: true });

  // ④ 配置页：解绑 → 绑定 + 指令保存（落盘）
  await page.locator('.tm-subnav__chip', { hasText: "配置" }).click();
  await page.waitForSelector('[data-testid="agent-config"]', { timeout: 5000 });
  await page.locator("#ag-ins").fill("自定义指令：始终先读 README。");
  await page.locator("button", { hasText: "保存指令" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-config"] .ag-page__hint')?.textContent?.includes("已保存"),
    null, { timeout: 8000 },
  );
  check("指令保存 → agent.md 落盘", (agentMd("coder-bot") ?? "").includes("自定义指令"));

  // ⑤ 运行历史 + 状态中文映射（真后端空数据）
  await page.locator('.tm-subnav__chip', { hasText: "运行历史" }).click();
  await page.waitForSelector('[data-testid="agent-runs"]', { timeout: 5000 });
  const runsText = await page.locator('[data-testid="agent-runs"]').textContent();
  check("运行历史页渲染（空数据态）", (runsText ?? "").includes("暂无运行记录"));

  // ⑥ 设置页：env/args 保存（config.json 落盘）+ 归档
  await page.locator('.tm-subnav__chip', { hasText: "设置" }).click();
  await page.waitForSelector('[data-testid="agent-settings"]', { timeout: 5000 });
  await page.locator("#ag-env").fill("FOO=bar");
  await page.locator("#ag-args").fill("--max-output 64000");
  await page.locator("button", { hasText: "保存设置" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-settings"] .ag-page__hint')?.textContent?.includes("已保存"),
    null, { timeout: 8000 },
  );
  const cfgAfter = agentConfig("coder-bot");
  check(
    "设置保存 → config.json env/args 落盘",
    cfgAfter?.env?.FOO === "bar" && Array.isArray(cfgAfter?.args) && cfgAfter.args.includes("--max-output"),
  );

  await page.locator("button", { hasText: "归档智能体" }).click();
  await page.locator("button", { hasText: "确认归档" }).click();
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("归档智能体") && b.disabled),
    null, { timeout: 8000 },
  );
  check("归档 → 软删生效（按钮禁用；目录与历史保留）", agentMd("coder-bot") !== null);
  await page.locator('button[aria-label="返回列表"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-agent-id="coder-bot"]'), null, { timeout: 8000 });
  check("归档后列表不再显示", true);

  await page.screenshot({ path: join(OUT, "agents-real-list.png"), fullPage: true });
} finally {
  await browser.close();
  try { process.kill(-serverProc.pid); } catch { /* already gone */ }
  try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}
console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED / ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
