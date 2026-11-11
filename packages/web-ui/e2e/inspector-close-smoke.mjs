// 检查器面板「可收起」e2e — 修 owner 反馈「Permissions 面板无法最小化、盖住顶栏按钮」。
// 用法：node packages/web-ui/e2e/inspector-close-smoke.mjs
// 前置：bun run build:web-ui
//
// 覆盖：
//   ① 顶栏切换按钮打开面板 → 面板头部有「收起检查器」关闭按钮；
//   ② 面板打开时顶栏设置按钮仍可点（z-index：顶栏 60 > 面板 50）；
//   ③ 面板几何：top 不小于本页顶栏 bottom（不再撞进顶栏区域）；
//   ④ 面板内关闭按钮 → 面板收起。
//
// 注意：用 Node 跑（Bun/Windows 与 playwright CDP 管道不兼容）。

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const PORT = 4225;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_SHOT_DIR ?? join(REPO, ".verify-inspector");

const dataRoot = mkdtempSync(join(tmpdir(), "feng-inspector-e2e-"));
const serverProc = spawn("bun", [join(REPO, "packages/server/src/entry.ts")], {
  cwd: REPO,
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let passed = 0, failed = 0;
const check = (name, ok) => { console.log((ok ? "PASS " : "FAIL ") + name); ok ? passed++ : failed++; };

try {
  await waitReady();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[aria-label="Show inspector"]', { timeout: 15_000 });

  // ① 打开面板 → 面板内有关闭按钮
  await page.click('button[aria-label="Show inspector"]');
  await page.waitForSelector("aside.chat-page__inspector", { timeout: 5000 });
  const closeBtn = await page.locator('button[aria-label="收起检查器"]').count();
  check("打开面板 → 面板头部出现「收起检查器」按钮", closeBtn === 1);

  // ② 面板打开时顶栏设置按钮仍可点（z-index 顶栏 > 面板）
  await page.click('button[aria-label="Settings"]');
  const menuVisible = await page.locator('.settings-menu[role="menu"]').isVisible().catch(() => false);
  check("面板打开时顶栏设置按钮可点（菜单弹出）", menuVisible);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // ③ 几何：面板 top ≥ 本页顶栏 bottom（不盖顶栏）
  const geo = await page.evaluate(() => {
    const panel = document.querySelector("aside.chat-page__inspector");
    const header = document.querySelector(".chat-page__header");
    if (!panel || !header) return null;
    const p = panel.getBoundingClientRect();
    const h = header.getBoundingClientRect();
    return { panelTop: p.top, headerBottom: h.bottom, overlap: p.top < h.bottom - 1 };
  });
  check("面板几何：top 在顶栏 bottom 之下（不遮挡顶栏）", geo !== null && !geo.overlap);

  // 截图：面板打开态（含关闭按钮 + 顶栏按钮）
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, "inspector-open-closeable.png"), fullPage: false });

  // ④ 面板内关闭按钮 → 收起
  await page.click('button[aria-label="收起检查器"]');
  await page.waitForFunction(() => !document.querySelector("aside.chat-page__inspector"), null, { timeout: 5000 });
  check("点击「收起检查器」→ 面板消失", true);

  // 复开一次确认顶栏切换按钮仍正常（双向可用）
  await page.click('button[aria-label="Show inspector"]');
  await page.waitForSelector("aside.chat-page__inspector", { timeout: 5000 });
  await page.click('button[aria-label="Hide inspector"]');
  await page.waitForFunction(() => !document.querySelector("aside.chat-page__inspector"), null, { timeout: 5000 });
  check("顶栏切换按钮开/关面板仍正常", true);
} finally {
  await browser.close();
  try { process.kill(-serverProc.pid); } catch { /* already gone */ }
  try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}
console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED / ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
