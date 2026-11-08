// 外部 agent 管理界面 e2e — 真后端（refactor f149c68 起 /api/runtimes CRUD + probe-candidate）。
// 用法：bun run smoke:runtimes（等价 node packages/web-ui/e2e/runtimes-smoke.mjs）
// 前置：bun run build:web-ui
//
// 覆盖（DSH 后端落地后的真端到端复验）：
//   ① opencode 探测验证 → 真后端返回「协议不支持」（run --json 不在 acp/claude-stream-json 里）；
//   ② 不存在的命令 → spawn ENOENT 类失败原因原样展示；
//   ③ 直接添加 opencode → 后端 422「协议不支持」（不留派发不出去的注册）+ 不落盘；
//   ④ 添加可派发 runtime（node）→ 卡片出现 + runtimes.json 真落盘；
//   ⑤ 编辑锁名改 command（node→git）→ 卡片与落盘更新；
//   ⑥ 删除 → 卡片消失 + 落盘清除；⑦ 重名 409 原样显示。
//
// 注意：用 Node 跑（Bun/Windows 与 playwright CDP 管道不兼容，见 teams-smoke.mjs 头注）。

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const PORT = 4221;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_SHOT_DIR ?? join(REPO, ".verify-runtimes");

const dataRoot = mkdtempSync(join(tmpdir(), "feng-runtimes-e2e-"));
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

function readRuntimesJson() {
  try {
    return JSON.parse(readFileSync(join(dataRoot, "runtimes.json"), "utf-8"));
  } catch {
    return null;
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let passed = 0, failed = 0;
const check = (name, ok) => { console.log((ok ? "PASS " : "FAIL ") + name); ok ? passed++ : failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await waitReady();

  await page.goto(`${BASE}/?view=teams&sub=members`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="runtime-card"]', { timeout: 15_000 });
  await sleep(600);

  // ① opencode 探测验证 → 真后端「协议不支持」
  await page.locator("button", { hasText: "添加 runtime" }).click();
  await page.waitForSelector('[data-testid="runtime-form"]', { timeout: 5000 });
  await page.locator("#rt-name").fill("opencode");
  await page.locator("#rt-command").fill("opencode");
  await page.locator("button", { hasText: "探测验证" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="runtime-form"] .ag-page__hint--error')?.textContent?.includes("协议不支持"),
    null,
    { timeout: 30_000 },
  );
  const probeErr = await page.locator('[data-testid="runtime-form"] .ag-page__hint--error').first().textContent();
  check("opencode 探测 → 真后端「协议不支持」+ run --json 说明", (probeErr ?? "").includes("run --json"));
  {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: join(OUT, "runtimes-real-probe-opencode.png"), fullPage: true });
  }

  // ② 不存在的命令 → 失败原因原样展示
  await page.locator("#rt-name").fill("no-such-agent-xyz");
  await page.locator("#rt-command").fill("no-such-cmd-xyz");
  await page.locator("button", { hasText: "探测验证" }).click();
  await page.waitForFunction(
    () => {
      const t = document.querySelector('[data-testid="runtime-form"] .ag-page__hint--error')?.textContent ?? "";
      return t.includes("no-such-cmd-xyz") || t.includes("ENOENT") || t.includes("命令") || t.includes("spawn");
    },
    null,
    { timeout: 30_000 },
  );
  check("不存在命令 → 具体失败原因（ENOENT/命令不存在）", true);

  // ③ 直接添加 opencode（不探测）→ 后端拒绝「协议不支持」，不留卡片不落盘
  await page.locator("#rt-name").fill("opencode");
  await page.locator("#rt-command").fill("opencode");
  await page.locator("button", { hasText: "添加" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="runtime-form"] .ag-page__hint--error')?.textContent?.includes("协议不支持"),
    null,
    { timeout: 8000 },
  );
  const blockedPersist = readRuntimesJson();
  check(
    "添加 opencode（派发不出去）→ 422 原因展示 + 不落盘",
    (await page.locator('[data-runtime-name="opencode"]').count()) === 0 &&
      !blockedPersist?.runtimes?.some((r) => r.name === "opencode"),
  );

  // ④ 添加可派发的 runtime（node，acp）→ 卡片 + 落盘
  await page.locator("#rt-name").fill("e2e-agent");
  await page.locator("#rt-command").fill("node");
  await page.locator("button", { hasText: "添加" }).last().click();
  await page.waitForSelector('[data-runtime-name="e2e-agent"]', { timeout: 8000 });
  const persisted = readRuntimesJson();
  const savedEntry = persisted?.runtimes?.find((r) => r.name === "e2e-agent");
  check("添加 e2e-agent(node) → 卡片出现 + runtimes.json 落盘", Boolean(savedEntry && savedEntry.command === "node"));

  // ⑤ 编辑锁名改 command（node → git）
  await page.locator('[data-runtime-name="e2e-agent"] button', { hasText: "编辑" }).click();
  await page.waitForSelector('[data-testid="runtime-form"]', { timeout: 5000 });
  check("编辑模式名称锁定", await page.locator("#rt-name").isDisabled());
  await page.locator("#rt-command").fill("git");
  await page.locator("button", { hasText: "保存修改" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-runtime-name="e2e-agent"] code')?.textContent?.includes("git"),
    null,
    { timeout: 8000 },
  );
  const persistedEdit = readRuntimesJson();
  const editedEntry = persistedEdit?.runtimes?.find((r) => r.name === "e2e-agent");
  check("编辑 command(node→git) → 卡片与落盘同步更新", editedEntry?.command === "git");

  // ⑥ 删除 → 卡片消失 + 落盘清除
  await page.locator('[data-runtime-name="e2e-agent"] button', { hasText: "删除" }).click();
  await page.locator("button", { hasText: "确认删除" }).click();
  await page.waitForFunction(() => !document.querySelector('[data-runtime-name="e2e-agent"]'), null, { timeout: 8000 });
  const persistedDel = readRuntimesJson();
  check("删除 e2e-agent → 卡片消失 + 落盘清除", !persistedDel?.runtimes?.some((r) => r.name === "e2e-agent"));

  // ⑦ 重名 409（默认注册表里有 dsh）
  await page.locator("button", { hasText: "添加 runtime" }).click();
  await page.locator("#rt-name").fill("dsh");
  await page.locator("#rt-command").fill("dsh-acp");
  await page.locator("button", { hasText: "添加" }).last().click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="runtime-form"] .ag-page__hint--error')?.textContent?.includes("已存在"),
    null,
    { timeout: 8000 },
  );
  check("重名 409 → 错误原样展示", true);

  // 截图
  const { mkdirSync } = await import("node:fs");
  mkdirSync(OUT, { recursive: true });
  await page.locator("button", { hasText: "取消" }).click();
  await sleep(400);
  await page.screenshot({ path: join(OUT, "runtimes-real-library.png"), fullPage: true });
} finally {
  await browser.close();
  try { process.kill(-serverProc.pid); } catch { /* already gone */ }
  try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}
console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED / ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
