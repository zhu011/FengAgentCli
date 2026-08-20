/**
 * Round-3 设计验证：WebUI 截图脚本（raw CDP，不依赖 Playwright 连接器）
 *
 * 1. 启动 mock OpenAI-compatible LLM（本地 SSE 流式应答，首帧延迟 2200ms 以捕获「生成中」动画 + 已用时长 + Esc 提示）
 * 2. 以该 mock 启动真实 FengAgent server（生产模式托管 web-ui dist）
 * 3. 手动拉起 Chromium（--remote-debugging-port），用 Bun WebSocket 直连 CDP：
 *    欢迎页（深空）→ 设置下拉 → 空会话引导 → 会话搜索 → 生成中指示器 → 代码块复制 →
 *    对话流（深空）→ 对话流（日光）→ 欢迎页（赛博）
 *
 * 用法：bun scripts/shoot-webui.ts
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = "D:\\AgentCode\\FengAgentCli";
const MOCK_PORT = 19999;
const SERVER_PORT = 3000;
const CDP_PORT = 9444;
const DATA_DIR = join(ROOT, ".multica", "tmp", "shot-data");
const PROFILE_DIR = join(ROOT, ".multica", "tmp", "shot-browser");
const OUT_DIR = join(ROOT, "screenshots");
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;

// 助手回复（含 Markdown：标题 / 列表 / 代码块 / 加粗）
const REPLY =
  "你好！我是 **FengAgentCli**，一个开源本地 AI Agent 对话平台。\n\n" +
  "### 我能做什么\n\n" +
  "- 💬 多轮智能对话（SSE 流式输出）\n" +
  "- 🔧 工具调用（文件 / Bash / 搜索 / MCP）\n" +
  "- 🧠 记忆系统与上下文压缩\n\n" +
  "### 快速上手\n\n" +
  "```bash\nfengagent        # 启动终端 TUI\nfengagent acp    # ACP 服务（Multica 运行时）\n```\n\n" +
  "输入 `/help` 查看全部命令，`/model` 切换模型。";

function sseChunk(delta: string, finish: string | null, usage?: unknown) {
  return JSON.stringify({
    id: "chatcmpl-mock-1",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "mock-chat",
    choices: [{ index: 0, delta: delta ? { role: "assistant", content: delta } : {}, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });
}

// ── 1. mock LLM（首帧延迟 2200ms：截「生成中」指示器 + 已用时长 + Esc 提示）──
const mockServer = Bun.serve({
  port: MOCK_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models" && req.method === "GET") {
      return Response.json({
        object: "list",
        data: [{ id: "mock-chat", object: "model", owned_by: "fengagent-mock" }],
      });
    }
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      await Bun.sleep(2200); // 首帧延迟：让「正在生成…」指示器 + 计时 + Esc 提示可见
      const chunks: string[] = [];
      let acc = "";
      for (const ch of REPLY) {
        acc += ch;
        if (acc.length % 18 === 0) {
          chunks.push(`data: ${sseChunk(acc, null)}\n\n`);
          acc = "";
        }
      }
      if (acc) chunks.push(`data: ${sseChunk(acc, null)}\n\n`);
      chunks.push(
        `data: ${sseChunk("", "stop", { prompt_tokens: 128, completion_tokens: 96, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 128 })}\n\n`,
      );
      chunks.push("data: [DONE]\n\n");
      return new Response(chunks.join(""), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

async function waitForHealth(timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE_URL}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(400);
  }
  throw new Error("server health check timed out");
}

// ── CDP 最小客户端 ──
class CdpSession {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handlers: ((method: string, params: unknown) => void)[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg.method, msg.params);
      }
    };
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("cdp ws error"));
      this.ws.onclose = () => reject(new Error("cdp ws closed"));
    });
  }

  send(method: string, params: unknown = {}): Promise<unknown> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  onEvent(h: (method: string, params: unknown) => void): void {
    this.handlers.push(h);
  }
}

// ── 2. 启动真实 server ──
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const server = spawn("bun", ["run", "packages/server/src/entry.ts"], {
  cwd: ROOT,
  env: {
    ...process.env,
    FENG_PROVIDER: "openai-compatible",
    OPENAI_COMPATIBLE_API_KEY: "mock-key",
    OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    OPENAI_COMPATIBLE_MODEL: "mock-chat",
    FENG_MODEL: "mock-chat",
    FENG_DATA_DIR: DATA_DIR,
    FENG_SERVER_PORT: String(SERVER_PORT),
    FENG_SERVER_HOST: "127.0.0.1",
  },
  stdio: "ignore",
});

// ── 3. Chromium + CDP ──
rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(PROFILE_DIR, { recursive: true });
const browserLog = join(ROOT, ".multica", "tmp", "shot-browser.log");
const browserProc = spawn(
  chromium.executablePath(),
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
browserProc.stderr?.on("data", (d) => {
  appendFileSync(browserLog, d.toString());
});
browserProc.on("exit", (code, signal) => {
  appendFileSync(browserLog, `\n[browser exit] code=${code} signal=${signal}\n`);
});

async function cdpReady(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return;
    } catch {
      /* not up */
    }
    await Bun.sleep(500);
  }
  throw new Error("chromium CDP not ready");
}

async function newPageTab(): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
  });
  const t = (await r.json()) as { webSocketDebuggerUrl: string };
  return t.webSocketDebuggerUrl;
}

const sleep = (ms: number) => Bun.sleep(ms);

async function main(): Promise<void> {
  await waitForHealth();
  console.log("[shoot] server healthy");
  await cdpReady();

  const wsUrl = await newPageTab();
  const cdp = new CdpSession(wsUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  async function evaluate(expression: string): Promise<unknown> {
    const res = (await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown; description?: string }; exceptionDetails?: unknown };
    if (res.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(res.exceptionDetails).slice(0, 300));
    return res.result?.value;
  }

  async function waitForSelector(selector: string, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return;
      await sleep(300);
    }
    throw new Error(`selector not found: ${selector}`);
  }

  async function shot(name: string): Promise<void> {
    await sleep(400);
    const res = (await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true })) as {
      data: string;
    };
    writeFileSync(join(OUT_DIR, name), Buffer.from(res.data, "base64"));
    console.log("[shoot] saved", name);
  }

  /** 通过设置下拉切换主题（Round 2 交互） */
  async function switchThemeViaMenu(themeName: string): Promise<void> {
    await evaluate(`document.querySelector('.chat-page__settings-btn').click()`);
    await sleep(300);
    await evaluate(`(() => {
      const items = [...document.querySelectorAll('.settings-menu__item')];
      const target = items.find(el => el.textContent.includes(${JSON.stringify(themeName)}));
      if (target) target.click();
      return !!target;
    })()`);
    await sleep(500);
  }

  /** 通过 API 创建带标题的会话（用于空会话引导 / 搜索截图） */
  async function createSessionViaApi(title: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error(`create session failed: ${res.status}`);
  }

  // ── 欢迎页（深空）──
  await cdp.send("Page.navigate", { url: BASE_URL });
  await sleep(2500);
  await shot("r3-webui-welcome-dark.png");

  // ── 设置下拉菜单（深空，展示主题选择 + 面板开关）──
  await evaluate(`document.querySelector('.chat-page__settings-btn').click()`);
  await sleep(400);
  await shot("r3-webui-settings-dark.png");
  await evaluate(`document.querySelector('.chat-page__settings-btn').click()`); // 收起

  // ── 创建 3 个带标题的会话 → 刷新 → 空会话引导 ──
  await createSessionViaApi("多 Agent 协作开发");
  await createSessionViaApi("WebUI 主题设计讨论");
  await createSessionViaApi("沙箱实验记录");
  await cdp.send("Page.navigate", { url: BASE_URL });
  await sleep(2500);
  await shot("r3-webui-empty-guide.png");

  // ── 会话搜索框：输入关键词过滤 ──
  await evaluate(`(() => {
    const el = document.querySelector('.session-sidebar__search-input');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, '多 Agent');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  await shot("r3-webui-search.png");
  await evaluate(`document.querySelector('.session-sidebar__search-clear')?.click()`); // 清空搜索

  // ── 对话流（深空）：输入并发送 ──
  await evaluate(`(() => {
    const el = document.querySelector('.composer__textarea');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, '你好，介绍一下你自己');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return true;
  })()`);
  // 首帧延迟 2200ms：此刻应显示「正在生成…」+ 已用时长 + 「按 Esc 中断」
  await sleep(1500);
  await shot("r3-webui-generating-dark.png");
  await waitForSelector(".message-bubble--assistant .markdown-body");
  await sleep(2000);

  // ── 代码块复制按钮：悬停代码块使其可见 ──
  await evaluate(`(() => {
    const pre = document.querySelector('.markdown-pre');
    if (!pre) return false;
    const r = pre.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    pre.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    return true;
  })()`);
  await sleep(600);
  await shot("r3-webui-codeblock-copy.png");
  await shot("r3-webui-chat-dark.png");

  // ── 对话流（日光）：经设置下拉切换 ──
  await switchThemeViaMenu("日光");
  await sleep(600);
  await shot("r3-webui-chat-light.png");

  // ── 欢迎页（赛博）：新标签 + localStorage ──
  const wsUrl2 = await newPageTab();
  const cdp2 = new CdpSession(wsUrl2);
  await cdp2.open();
  await cdp2.send("Page.enable");
  await cdp2.send("Runtime.enable");
  await cdp2.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const eval2 = async (expression: string) => {
    const res = (await cdp2.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
      result?: { value?: unknown };
    };
    return res.result?.value;
  };
  await cdp2.send("Page.navigate", { url: BASE_URL });
  await sleep(2500);
  await eval2(`localStorage.setItem('feng-theme','cyber'); location.reload(); true`);
  await sleep(2500);
  const res = (await cdp2.send("Page.captureScreenshot", { format: "png", fromSurface: true })) as { data: string };
  writeFileSync(join(OUT_DIR, "r3-webui-welcome-cyber.png"), Buffer.from(res.data, "base64"));
  console.log("[shoot] saved r3-webui-welcome-cyber.png");

  console.log("[shoot] all screenshots saved to screenshots/");
}

try {
  await main();
} finally {
  server.kill();
  browserProc.kill();
  mockServer.stop(true);
}
