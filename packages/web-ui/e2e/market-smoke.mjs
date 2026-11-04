// E：插件市场 e2e 冒烟 — 多插件矩阵（真 server + 真 catalog/registry + 启动装载断言）
// 用法：bun run smoke:market（等价 node packages/web-ui/e2e/market-smoke.mjs）
// 前置：bun run build:web-ui（UI 截图阶段消费 dist；未构建时该阶段跳过并提示）
//
// 覆盖：
//   ① 市场矩阵：B 档 ×2（dsh-plugin-writing-guard 缺省 latest 真装载 +
//      dsh-better-edit 固定版：市场装得上，但 Bun 宿主无 node:sqlite →
//      装载失败隔离，宿主不挂——真实生态发现，按失败口径断言）+
//      A 档（example-webui-plugin 本地源）+ C 档对照（dshmarket 安装被 400 拒；
//      本地装的 client-only 假包 host 面不装载、宿主不挂）+ 坏插件（import 抛错）；
//      目录契约：首屏字段完备（compat A/B/C + installable 布尔 + category/version
//      非空）、categories 按筛选结果集裁剪（全集 ⊇ 搜索集、单类过滤只剩该类）；
//   ② 重启后 boot 断言：装载名单（stderr）含真装载的 B 档（dsh-compat 的工具
//      增量门保证 loaded ⇒ 注册过工具）、webui 走 manifest 不进 host 面、
//      不可装载插件进 /api/plugins 的 error 且宿主 /api/health 仍 200；
//   ③ 多插件并存互不干扰 + 卸载后重启装载名单收敛；
//   ④ UI 截图：市场页已装态（compatSource:local）+ C 档灰卡禁用按钮。
//
// 注意：用 Node 跑（Bun/Windows 与 playwright CDP 管道不兼容，见 teams-smoke.mjs 头注）。
// 数据根放仓库内（.verify-e-*）：dsh 插件的 @deepseek-ai/* peers 从仓库根
// node_modules 逐级解析（root devDependencies 已 pin 0.1.0-rc.6）。

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync, spawn } from "node:child_process";
import { chromium } from "playwright";

const REPO = process.env.FENG_REPO ?? "D:/AgentCode/FengAgentCli";
const DIST = join(REPO, "packages/web-ui/dist");
const PORT = 3971;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_SHOT_DIR ?? join(REPO, ".verify-e-shots");

// 数据根放仓库内：dsh peers 的模块解析能逐级走到仓库根 node_modules
const dataRoot = mkdtempSync(join(REPO, ".verify-e-"));

let passed = 0;
let failed = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    results.push([name, true]);
    console.log("PASS " + name);
  } catch (err) {
    failed++;
    results.push([name, false]);
    console.log("FAIL " + name + " :: " + String(err).slice(0, 200));
  }
}

/* ───────────── server 生命周期（同一 dataRoot 反复重启） ───────────── */

let serverProc = null;
let bootLog = [];

async function startServer() {
  bootLog = [];
  serverProc = spawn("bun", [join(REPO, "packages/server/src/entry.ts")], {
    cwd: REPO,
    env: { ...process.env, FENG_DATA_DIR: dataRoot, FENG_SERVER_PORT: String(PORT), FENG_SERVER_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  serverProc.stderr.on("data", (d) => bootLog.push(d.toString()));
  serverProc.stdout.on("data", (d) => bootLog.push(d.toString()));
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        // 装载日志在 listen 前后写 stderr，稍等让管道冲刷完
        await new Promise((r) => setTimeout(r, 600));
        return;
      }
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("server 未就绪\n" + bootLog.slice(-8).join(""));
}

async function stopServer() {
  if (!serverProc) return;
  const pid = serverProc.pid;
  serverProc = null;
  // Windows 上 kill(-pid)（进程组）不可用（ESRCH）：必须 taskkill 树杀，
  // 否则旧进程占着端口，下一次 spawn 会 EADDRINUSE 静默死掉
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    try {
      await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) });
      await new Promise((r) => setTimeout(r, 300));
    } catch {
      return; // 端口已释放
    }
  }
  throw new Error("server 停不下来（端口仍被占用）");
}

/* ───────────── fixture：C 档假包 + 坏插件（本地源安装） ───────────── */

const FIXTURES = join(dataRoot, "fixture-src");

function writeFixture(name, pkg, files) {
  const dir = join(FIXTURES, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
  for (const [file, body] of Object.entries(files)) {
    writeFileSync(join(dir, file), body, "utf8");
  }
  return dir;
}

// client-only（dsh.client、无 host 入口）：boot 应报「找不到插件入口文件」而非装载
const fakeClient = writeFixture(
  "fake-dsh-client",
  { name: "fake-dsh-client", version: "0.0.1", dsh: { client: { entry: "./client.js" } } },
  { "client.js": "export default {};\n" },
);

// 坏插件：host 入口存在但 import 即抛
const fakeBroken = writeFixture(
  "fake-broken",
  { name: "fake-broken", version: "0.0.1", dsh: { service: {} }, main: "index.js" },
  { "index.js": 'throw new Error("broken on purpose (e2e)");\n' },
);

/* ───────────── API helpers ───────────── */

async function api(path, init, timeoutMs = 180_000) {
  return fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function installLocal(source) {
  const res = await api("/api/plugins/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  });
  return res;
}

async function pluginsList() {
  const res = await api("/api/plugins");
  return (await res.json());
}

/* ───────────── 冒烟主体 ───────────── */

try {
  await startServer();

  /* ── ① 市场矩阵：安装 ── */
  await check("市场目录可达（真 catalog）：q=better-edit → 恰 1 条", async () => {
    const res = await api("/api/plugins/market?q=better-edit&limit=5", {}, 90_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.total !== 1 || body.plugins[0].name !== "dsh-better-edit") {
      throw new Error(`total=${body.total} first=${body.plugins[0]?.name}`);
    }
  });

  await check("首屏字段完备：compat 全 A/B/C、installable 布尔、category/version 非空", async () => {
    const res = await api("/api/plugins/market?limit=24", {}, 90_000);
    const body = await res.json();
    for (const p of body.plugins) {
      if (!["A", "B", "C"].includes(p.compat)) throw new Error(`${p.name} compat=${p.compat}`);
      if (typeof p.installable !== "boolean") throw new Error(`${p.name} installable=${p.installable}`);
      if (typeof p.category !== "string" || typeof p.version !== "string") throw new Error(`${p.name} category/version 缺失`);
    }
    const cTier = body.plugins.filter((p) => p.compat === "C");
    if (cTier.length > 0 && !cTier.every((p) => p.installable === false)) throw new Error("C 档存在 installable=true");
  });

  await check("categories 按筛选结果集裁剪（全集 ⊇ 搜索集；单类过滤只剩该类）", async () => {
    const full = await (await api("/api/plugins/market?limit=1", {}, 90_000)).json();
    const fullIds = full.categories.map((c) => c.id);
    if (fullIds.length < 20) throw new Error(`全集分类仅 ${fullIds.length}（catalog 可能已裁撤分类？）`);
    const byQ = await (await api("/api/plugins/market?q=edit&limit=1", {}, 90_000)).json();
    const qIds = byQ.categories.map((c) => c.id);
    if (qIds.length === 0 || qIds.length >= fullIds.length) throw new Error(`q=edit 分类 ${qIds.length}（全集 ${fullIds.length}）`);
    if (!qIds.every((id) => fullIds.includes(id))) throw new Error("搜索集不是全集子集");
    const byCat = await (await api("/api/plugins/market?category=tools&limit=1", {}, 90_000)).json();
    if (byCat.categories.length !== 1 || byCat.categories[0].id !== "tools") {
      throw new Error(`category=tools → ${JSON.stringify(byCat.categories.map((c) => c.id))}`);
    }
  });

  await check("C 档闸门：市场装 dshmarket → 400", async () => {
    const res = await api("/api/plugins/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marketName: "dshmarket" }),
    });
    if (res.status !== 400) throw new Error(`HTTP ${res.status}`);
  });

  await check("B 档安装 ×2（固定版 + 缺省 latest）→ 201", async () => {
    const a = await api("/api/plugins/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marketName: "dsh-better-edit", marketVersion: "1.2.0" }),
    });
    if (a.status !== 201) throw new Error(`better-edit HTTP ${a.status} ${(await a.text()).slice(0, 120)}`);
    const b = await api("/api/plugins/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marketName: "dsh-plugin-writing-guard" }),
    });
    if (b.status !== 201) throw new Error(`writing-guard HTTP ${b.status} ${(await b.text()).slice(0, 120)}`);
  });

  await check("A 档本地源安装（example-webui-plugin）→ 201", async () => {
    const res = await installLocal(join(REPO, "integrations/example-webui-plugin"));
    if (res.status !== 201) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  });

  await check("C 档 client-only 假包本地源安装 → 201（本地源无市场闸门）", async () => {
    const res = await installLocal(fakeClient);
    if (res.status !== 201) throw new Error(`HTTP ${res.status}`);
  });

  await check("坏插件本地源安装 → 201（装得上，坏在装载期）", async () => {
    const res = await installLocal(fakeBroken);
    if (res.status !== 201) throw new Error(`HTTP ${res.status}`);
  });

  /* ── ② 重启 → 启动装载断言 ── */
  await stopServer();
  await startServer();

  await check("宿主存活：/api/health 200（坏插件不阻断启动）", async () => {
    const res = await api("/api/health", {}, 10_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  await check("boot 装载名单含 writing-guard（B 档真装载 ⇒ 工具增量门通过）", () => {
    const joined = bootLog.join("");
    const loadedLine = joined.split("\n").find((l) => l.includes("插件启动装载："));
    if (!loadedLine) throw new Error("无装载日志行");
    if (!loadedLine.includes("dsh-plugin-writing-guard")) {
      throw new Error(`装载名单缺 writing-guard（实际：${loadedLine.trim()}）`);
    }
  });

  await check("dsh-better-edit 在 Bun 宿主装载失败被隔离（node:sqlite 缺失，宿主不挂）", async () => {
    const joined = bootLog.join("");
    const loadedLine = joined.split("\n").find((l) => l.includes("插件启动装载："));
    if (loadedLine?.includes("dsh-better-edit")) throw new Error("不应装载（Bun 无 node:sqlite）");
    const list = await pluginsList();
    const entry = list.plugins.find((p) => p.id === "dsh-better-edit");
    if (!entry?.error) throw new Error("dsh-better-edit 无 error（应报 node:sqlite）");
    if (!entry.error.includes("node:sqlite")) throw new Error(`error=${entry.error.slice(0, 80)}`);
  });

  await check("A 档不进 host 装载、走 webui manifest", async () => {
    if (bootLog.join("").includes("example-webui-plugin")) throw new Error("webui 插件进了 host 装载名单");
    const res = await api("/api/webui/manifest");
    const body = await res.json();
    if (!body.plugins.some((p) => p.id === "example-webui-plugin")) throw new Error("manifest 缺 example-webui-plugin");
  });

  await check("C 档 client-only 假包：host 面不装载且报入口缺失（对照）", async () => {
    const joined = bootLog.join("");
    if (joined.includes("fake-dsh-client：") && joined.includes("插件启动装载：fake-dsh-client")) {
      throw new Error("client-only 包被装载了");
    }
    const list = await pluginsList();
    const entry = list.plugins.find((p) => p.id === "fake-dsh-client");
    if (!entry) throw new Error("列表缺 fake-dsh-client");
    if (!entry.error || !entry.error.includes("找不到插件入口")) throw new Error(`error=${entry.error}`);
  });

  await check("坏插件：装载失败进 /api/plugins 的 error，宿主仍 200", async () => {
    const list = await pluginsList();
    const entry = list.plugins.find((p) => p.id === "fake-broken");
    if (!entry?.error) throw new Error("fake-broken 无 error");
    if (!bootLog.join("").includes("fake-broken")) throw new Error("stderr 无 fake-broken 失败告警");
  });

  await check("多插件并存：列表 5 个互不干扰，writing-guard 无 error", async () => {
    const list = await pluginsList();
    const ids = list.plugins.map((p) => p.id).sort();
    for (const id of ["dsh-better-edit", "dsh-plugin-writing-guard", "example-webui-plugin", "fake-dsh-client", "fake-broken"]) {
      if (!ids.includes(id)) throw new Error(`缺 ${id}（现有 ${ids.join(",")}）`);
    }
    const wg = list.plugins.find((p) => p.id === "dsh-plugin-writing-guard");
    if (wg.error) throw new Error(`writing-guard error=${wg.error}`);
    if (wg.protocol !== "dsh") throw new Error(`writing-guard protocol=${wg.protocol}`);
  });

  await check("已装条目市场档位以本地为准（compatSource:local，不重探 registry）", async () => {
    const res = await api("/api/plugins/market?q=better-edit&limit=5", {}, 90_000);
    const body = await res.json();
    const entry = body.plugins.find((p) => p.name === "dsh-better-edit");
    if (!entry) throw new Error("市场页缺已装条目");
    if (entry.compatSource !== "local") throw new Error(`compatSource=${entry.compatSource}`);
  });

  /* ── ③ 卸载后重启收敛 ── */
  await check("卸载 dsh-better-edit → 重启后装载名单收敛", async () => {
    const del = await api("/api/plugins/dsh-better-edit", { method: "DELETE" });
    if (del.status !== 200) throw new Error(`HTTP ${del.status}`);
    await stopServer();
    await startServer();
    const joined = bootLog.join("");
    const loadedLine = joined.split("\n").find((l) => l.includes("插件启动装载："));
    if (joined.includes("dsh-better-edit")) throw new Error("卸载后仍出现在任何装载日志里");
    if (!loadedLine?.includes("dsh-plugin-writing-guard")) throw new Error("writing-guard 不应受影响");
    const list = await pluginsList();
    if (list.plugins.some((p) => p.id === "dsh-better-edit")) throw new Error("列表仍含已卸载插件");
  });

  /* ── ④ UI 截图（需预构建 dist） ── */
  if (existsSync(join(DIST, "index.html"))) {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${BASE}/?view=settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".ag-page", { timeout: 8000 });
    await page.locator(".ag-filter__chip", { hasText: "市场" }).click();
    await page.waitForSelector('[data-testid="market-card"]', { timeout: 90_000 });
    await page.getByLabel("搜索市场插件").fill("writing-guard");
    await page
      .waitForSelector('[data-testid="market-card"]', { timeout: 30_000 })
      .catch(() => {});
    await page.waitForTimeout(600);
    await check("UI：已装条目显示「已安装」徽标", async () => {
      const txt = await page.locator('[data-testid="market-card"]').first().textContent();
      if (!txt.includes("已安装")) throw new Error("无已装态徽标");
    });
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: join(OUT, "e-market-installed.png"), fullPage: true });
    await page.getByLabel("搜索市场插件").fill("dshmarket");
    // 搜索命中 C 档 → 进折叠区；探测冷启动可能要几秒，等折叠条出现再展开
    await page.waitForSelector(".mk-clientfold button", { timeout: 30_000 });
    await page.waitForTimeout(400);
    await check("UI：C 档灰卡 + 禁用安装按钮", async () => {
      await page.locator(".mk-clientfold button").click();
      await page.waitForSelector(".mk-card--dim", { timeout: 10_000 });
      const card = page.locator(".mk-card--dim").first();
      if ((await card.locator("button[disabled]").count()) < 1) throw new Error("安装按钮未禁用");
    });
    await page.screenshot({ path: join(OUT, "e-market-c-gate.png"), fullPage: true });
    await browser.close();
  } else {
    console.log("SKIP UI 截图阶段（packages/web-ui/dist 未构建：先 bun run build:web-ui）");
  }
} finally {
  await stopServer();
  try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}

console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED / ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
