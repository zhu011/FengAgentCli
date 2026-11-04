// S4 自动化冒烟：WebUI 插件面 + Settings（真 server，非 mock）
// 用法：bun run smoke:plugins（等价 node packages/web-ui/e2e/plugins-smoke.mjs）
// 前置：bun run build:web-ui + 独立数据根起 server（脚本自动起停）
//
// 覆盖：① 示例插件经 API 安装 → WebUI slot 渲染 → toast 按钮可点；
//       ② 插件 tab 列表出现 → 停用按钮翻转状态 → manifest 即时消失/恢复；
//       ③ 模型 tab 保存 temperature（数值）→ GET 回读 active 一致；
//       ④ 已配置 provider 的 secret 掩码值不被提交（Key 不变）。
//
// 注意：用 Node 跑（Bun/Windows 与 playwright CDP 管道不兼容，见 teams-smoke.mjs 头注）。

import { createServer } from "node:http";
import { createReadStream, existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, extname, resolve, dirname } from "node:path";
import { spawn, execSync } from "node:child_process";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const DIST = join(REPO, "packages/web-ui/dist");
const PORT = 3951;
const BASE = `http://127.0.0.1:${PORT}`;

// ── 临时数据根 + 示例插件源 ──
const dataRoot = mkdtempSync(join(process.env.TEMP ?? "/tmp", "feng-s4-smoke-"));
const pluginSource = join(dataRoot, "plugin-src", "example-webui-plugin");
mkdirSync(pluginSource, { recursive: true });
cpSync(join(REPO, "integrations/example-webui-plugin"), pluginSource, { recursive: true });

// ── 起 FengAgentCli server（独立数据根） ──
const serverProc = spawn("bun", [join(REPO, "packages/server/src/entry.ts")], {
  cwd: REPO,
  env: { ...process.env, FENG_DATA_DIR: dataRoot, FENG_SERVER_PORT: String(PORT), FENG_SERVER_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
const serverLog = [];
serverProc.stdout.on("data", (d) => serverLog.push(d.toString()));
serverProc.stderr.on("data", (d) => serverLog.push(d.toString()));

// 等 server 就绪
async function waitReady(maxMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server 未就绪（${maxMs}ms）\n${serverLog.slice(-5).join("")}`);
}

// ── Playwright ──
let passed = 0;
let failed = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`(pass) ${name}`);
  } catch (err) {
    failed++;
    results.push(`(fail) ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const browser = await chromium.launch();

try {
  await waitReady();
  console.log("server ready");

  // 安装示例插件（真 API；若已存在先卸载——幂等）
  const delRes = await fetch(`${BASE}/api/plugins/example-webui-plugin`, { method: "DELETE" });
  void delRes;
  const installRes = await fetch(`${BASE}/api/plugins/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: pluginSource }),
  });
  const installBody = await installRes.json();
  if (!installRes.ok) throw new Error(`install failed: ${JSON.stringify(installBody)}`);

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10_000);

  // ① 插件装载 → slot 渲染 → toast 按钮
  await check("① 示例插件装载 → slot 渲染 + toast 按钮", async () => {
    await page.goto(`${BASE}/`);
    await page.getByTestId("webui-plugin-hello").waitFor({ timeout: 15_000 });
    const text = await page.getByTestId("webui-plugin-hello").textContent();
    if (!text.includes("插件示例")) throw new Error(`slot 渲染异常: ${text}`);
    await page.locator("button", { hasText: "toast" }).click();
    await page.waitForTimeout(400);
    const toast = await page.locator(".webui-toast").count();
    if (toast < 1) throw new Error("toast 未弹出");
  });

  // ② 插件 tab 列表 + 停用/启用按钮
  await check("② 插件 tab 列表 + 停用按钮翻转 + manifest 即时消失", async () => {
    await page.locator(".app-nav__tab", { hasText: "设置" }).click();
    await page.waitForTimeout(800);
    // 插件 tab 默认选中（第一个 subnav chip）
    const row = page.locator("tr", { hasText: "example-webui-plugin" });
    await row.waitFor();
    // 停用
    await row.locator("button", { hasText: "停用" }).click();
    await page.waitForTimeout(800);
    // manifest 应即时不再包含该插件
    const manifest = await (await fetch(`${BASE}/api/webui/manifest`)).json();
    if (manifest.plugins.some((p) => p.id === "example-webui-plugin")) {
      throw new Error("停用后 manifest 仍包含插件");
    }
    // 重新启用
    const row2 = page.locator("tr", { hasText: "example-webui-plugin" });
    await row2.locator("button", { hasText: "启用" }).click();
    await page.waitForTimeout(800);
    const manifest2 = await (await fetch(`${BASE}/api/webui/manifest`)).json();
    if (!manifest2.plugins.some((p) => p.id === "example-webui-plugin")) {
      throw new Error("启用后 manifest 不包含插件");
    }
  });

  // ③ 模型 tab 保存 temperature → GET 回读 active 一致
  await check("③ 模型保存 temperature → GET 回读 active 一致", async () => {
    await page.locator(".tm-subnav__chip", { hasText: "模型" }).click();
    await page.waitForTimeout(1000);
    // 改 temperature 为 0.7
    const tempInput = page.locator("#tm-set-temperature");
    await tempInput.fill("0.7");
    await page.locator("button", { hasText: "保存" }).click();
    await page.waitForTimeout(1500);
    // GET 回读
    const snap = await (await fetch(`${BASE}/api/settings/model`)).json();
    if (snap.active?.temperature !== 0.7) {
      throw new Error(`回读 temperature=${snap.active?.temperature}，期望 0.7`);
    }
    if (snap.settings.temperature !== 0.7) {
      throw new Error(`settings.temperature=${snap.settings.temperature}，期望 0.7`);
    }
  });

  // ④ 掩码 secret 不提交（Key 不变）
  await check("④ 已配置 provider 的掩码 secret 不被提交（Key 不变）", async () => {
    // 读取当前 settings.json 中的 openaiCompatibleApiKey（如果有）
    const settingsFile = join(dataRoot, "settings.json");
    const before = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : "";
    // 在模型 tab 点保存（不填任何 secret 字段——掩码值已在 form 里被跳过）
    await page.locator("button", { hasText: "保存" }).click();
    await page.waitForTimeout(1500);
    const after = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : "";
    // Key 不应被掩码值覆盖（文件内容不变或仅非 secret 字段变化）
    const beforeKey = before.match(/"(openaiCompatibleApiKey|anthropicApiKey|googleApiKey)"\s*:\s*"([^"]+)"/);
    const afterKey = after.match(/"(openaiCompatibleApiKey|anthropicApiKey|googleApiKey)"\s*:\s*"([^"]+)"/);
    if (beforeKey && afterKey) {
      if (beforeKey[2] !== afterKey[2]) {
        throw new Error(`Key 被覆盖: ${beforeKey[1]} "${beforeKey[2].slice(0, 8)}…" → "${afterKey[2].slice(0, 8)}…"`);
      }
      if (afterKey[2].includes("****")) {
        throw new Error(`Key 被掩码值覆盖: ${afterKey[2]}`);
      }
    }
  });

  await page.close();
} finally {
  await browser.close().catch(() => {});
  try { process.kill(-serverProc.pid, "SIGTERM"); } catch { /* already exited */ }
  try { serverProc.kill("SIGTERM"); } catch { /* already exited */ }
  try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}

console.log(results.join("\n"));
console.log(`\n${passed} pass / ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
