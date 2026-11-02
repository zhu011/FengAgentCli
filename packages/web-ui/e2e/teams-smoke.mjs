// 「agent 团队」统一模块 — Playwright 冒烟（构建产物 + mock 模式，无后端依赖）
// 用法：bun run smoke:teams   （等价 node packages/web-ui/e2e/teams-smoke.mjs；先 bun run build:web-ui）
// 注意：用 Node 跑——Bun 在 Windows 下的 stdio pipe 与 playwright CDP 握手不兼容。
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const HERE = import.meta.dirname ?? new URL(".", import.meta.url).pathname;
const DIST = join(HERE, "..", "dist");
const PORT = 4173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

// ── 极简静态服务（SPA 回退到 index.html）──
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  let file = join(DIST, path);
  if (!existsSync(file) || statSync(file).isDirectory()) {
    file = join(DIST, "index.html"); // SPA 回退
    path = "/index.html";
  }
  res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const BASE = `http://127.0.0.1:${PORT}`;
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

async function newPage() {
  const page = await browser.newPage();
  page.setDefaultTimeout(8_000);
  return page;
}

// ① 四页导航 + 团队视图默认态（子视图分段控件 + mock 团队列表）
await check("四页导航 + 团队子视图控件 + mock 团队列表", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/?mock=1`);
  await page.getByRole("tab", { name: "团队" }).click();
  await page.locator(".tm-subnav__chip", { hasText: "团队" }).waitFor();
  const tabs = await page.locator(".app-nav__tab").allTextContents();
  if (tabs.length !== 5) throw new Error(`导航 tab 数 = ${tabs.length}，期望 5（含设置）`);
  if (!tabs.some((t) => t.includes("团队")) || tabs.some((t) => t.includes("Agents") || t.includes("群聊"))) {
    throw new Error(`导航内容异常: ${tabs.join("|")}`);
  }
  await page.locator(".gr-list__item", { hasText: "项目周报群" }).waitFor();
  await page.close();
});

// ② 旧路由 ?view=groups → 重定向 ?view=teams（URL 重写 + 渲染不空）
await check("旧深链 ?view=groups 重定向到 teams", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/?view=groups&mock=1`);
  await page.locator(".gr-list__item", { hasText: "项目周报群" }).waitFor();
  if (!page.url().includes("view=teams")) throw new Error(`URL 未重写: ${page.url()}`);
  await page.close();
});

// ③ 旧路由 ?view=agents&task= → 重定向 + 任务库内打开详情（无群任务）
await check("旧深链 ?view=agents&task=t_mock_002 → teams + 任务详情", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/?view=agents&task=t_mock_002&mock=1`);
  await page.locator(".ag-detail", { hasText: "t_mock_002" }).waitFor();
  if (!page.url().includes("view=teams")) throw new Error(`URL 未重写: ${page.url()}`);
  if (!page.url().includes("sub=tasks")) throw new Error(`未进任务库: ${page.url()}`);
  await page.close();
});

// ④ 团队详情：聊天流 + 任务卡就地展开 + 「在任务库打开」
await check("团队详情 + 任务卡就地展开 + 跳任务库", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/?view=teams&mock=1`);
  await page.locator(".gr-list__item", { hasText: "项目周报群" }).click();
  await page.locator(".gr-chat__name", { hasText: "项目周报群" }).waitFor();
  // 任务卡（mock 种子：t_mock_002 已完成）就地展开
  await page.locator(".gr-taskcard", { hasText: "t_mock_002" }).click();
  await page.locator(".tm-taskcard-detail .ag-detail", { hasText: "总结今天的日报" }).waitFor();
  // 在任务库打开
  await page.locator(".tm-taskcard-detail__bar button", { hasText: "在任务库打开" }).click();
  await page.locator(".ag-detail", { hasText: "t_mock_002" }).waitFor();
  if (!page.url().includes("sub=tasks")) throw new Error(`URL 未带 sub=tasks: ${page.url()}`);
  await page.close();
});

// ⑤ 团队内派单：表单 → 派发 → 任务库打开新任务详情（mock createAgentTask 带 groupId）
await check("团队内派单（带 groupId）→ 任务库打开新任务详情", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/?view=teams&mock=1`);
  await page.locator(".gr-list__item", { hasText: "项目周报群" }).click();
  await page.locator(".gr-chat__name", { hasText: "项目周报群" }).waitFor();
  await page.locator(".gr-composer__btns button", { hasText: "派任务" }).click();
  await page.locator("#tm-dispatch-content").fill("冒烟测试：帮我核对一份周报数据");
  await page.locator(".tm-dispatch button", { hasText: "派发" }).click();
  await page.locator(".ag-detail", { hasText: "冒烟测试：帮我核对一份周报数据" }).waitFor();
  if (!page.url().includes("sub=tasks")) throw new Error(`未跳任务库: ${page.url()}`);
  await page.close();
});

// ⑥ 成员库子视图：运行时卡片
await check("成员库子视图（运行时注册表）", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/?view=teams&mock=1`);
  await page.locator(".tm-subnav__chip", { hasText: "成员库" }).click();
  await page.locator(".ag-runtime-card__name", { hasText: "kimi" }).waitFor();
  await page.close();
});

// ⑦ 聊天发言（mock SSE 回流）
await check("团队聊天发言回流", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/?view=teams&mock=1`);
  await page.locator(".gr-list__item", { hasText: "项目周报群" }).click();
  await page.locator(".gr-chat__name", { hasText: "项目周报群" }).waitFor();
  await page.locator(".gr-composer__input").fill("冒烟测试：大家好");
  await page.locator(".gr-composer__btns button", { hasText: "发送" }).click();
  await page.locator(".gr-msg__content", { hasText: "冒烟测试：大家好" }).waitFor();
  await page.close();
});

// ⑧ 任务库「发任务」入口（M1 拆分回归项：表单必须能从列表页打开）
await check("任务库发任务入口（回归项）", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/?view=teams&mock=1`);
  await page.locator(".tm-subnav__chip", { hasText: "任务库" }).click();
  await page.locator(".tm-libhead button", { hasText: "发任务" }).click();
  await page.locator("#ag-form-content").waitFor();
  await page.locator("#ag-form-runtime").selectOption("kimi");
  await page.locator("#ag-form-content").fill("冒烟测试：任务库发任务");
  await page.locator(".ag-form button", { hasText: "派发" }).click();
  await page.locator(".ag-detail", { hasText: "冒烟测试：任务库发任务" }).waitFor();
  await page.close();
});

await browser.close();
server.close();

console.log(results.join("\n"));
console.log(`\n${passed} pass / ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
