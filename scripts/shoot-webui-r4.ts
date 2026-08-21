/**
 * Round-4 设计验证：WebUI 思考可视化截图脚本（raw CDP，不依赖 Playwright 连接器）
 *
 * 1. 启动 mock OpenAI-compatible LLM（本地 SSE 流式应答）：
 *    - 先流式输出 reasoning_content（DeepSeek reasoner 风格思考内容，带首帧延迟）
 *    - 再输出正式回答 content
 * 2. 以该 mock 启动真实 FengAgent server（生产模式托管 web-ui dist）
 * 3. 手动拉起 Chromium（--remote-debugging-port），用 Bun WebSocket 直连 CDP：
 *    欢迎页（深空）→ 发送消息 → 思考流式展开（中）→ 回答完成（思考面板+正文）→ 点击折叠
 *
 * 用法：bun scripts/shoot-webui-r4.ts
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = "D:\\AgentCode\\FengAgentCli";
const MOCK_PORT = 19998;
const SERVER_PORT = 3100;
const CDP_PORT = 9445;
const DATA_DIR = join(ROOT, ".multica", "tmp", "shot-r4-data");
const PROFILE_DIR = join(ROOT, ".multica", "tmp", "shot-r4-browser");
const OUT_DIR = join(ROOT, "screenshots");
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;

// 思考内容（模拟 DeepSeek reasoner 的 reasoning_content）
const THINKING =
  "用户想让我介绍 FengAgentCli。先梳理它的核心能力：这是一个本地 AI Agent CLI，\n" +
  "支持 TUI 与 WebUI 两种界面，具备工具调用、多 Agent 协作、上下文压缩、记忆系统。\n" +
  "回答时应该突出这些特性，并给出快速上手命令，语气保持简洁清晰。";

const REPLY =
  "你好！我是 **FengAgentCli**，一个开源本地 AI Agent 对话平台。\n\n" +
  "### 我能做什么\n\n" +
  "- 💬 多轮智能对话（SSE 流式输出）\n" +
  "- 🔧 工具调用（文件 / Bash / 搜索 / MCP）\n" +
  "- 🧠 记忆系统与上下文压缩\n\n" +
  "### 快速上手\n\n" +
  "```bash\nfengagent        # 启动终端 TUI\nfengagent acp    # ACP 服务（Multica 运行时）\n```";

function sseChunk(delta: Record<string, unknown>, finish: string | null, usage?: unknown) {
  return JSON.stringify({
    id: "chatcmpl-mock-r4",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "mock-chat",
    choices: [{ index: 0, delta: Object.keys(delta).length ? delta : {}, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });
}

// ── 1. mock LLM：先 reasoning_content（含首帧延迟），后 content ──
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
      // 构造带逐块延迟的 SSE 流（模拟真实网络流式传输：
      // 若一次性发送全部块，浏览器会合并为单次渲染，无法体现「流式展开」）
      const chunks: string[] = [];
      let acc = "";
      for (const ch of THINKING) {
        acc += ch;
        if (acc.length % 16 === 0) {
          chunks.push(`data: ${sseChunk({ reasoning_content: acc }, null)}\n\n`);
          acc = "";
        }
      }
      if (acc) chunks.push(`data: ${sseChunk({ reasoning_content: acc }, null)}\n\n`);
      acc = "";
      for (const ch of REPLY) {
        acc += ch;
        if (acc.length % 18 === 0) {
          chunks.push(`data: ${sseChunk({ content: acc }, null)}\n\n`);
          acc = "";
        }
      }
      if (acc) chunks.push(`data: ${sseChunk({ content: acc }, null)}\n\n`);
      chunks.push(
        `data: ${sseChunk({}, "stop", { prompt_tokens: 128, completion_tokens: 96, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 128 })}\n\n`,
      );
      chunks.push("data: [DONE]\n\n");

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await Bun.sleep(1200); // 首帧延迟：让「思考中...」占位可见
          for (const c of chunks) {
            controller.enqueue(encoder.encode(c));
            await Bun.sleep(90); // 逐块延迟：模拟真实流式（思考内容逐段到达）
          }
          controller.close();
        },
      });
      return new Response(stream, {
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

// ── CDP 最小客户端（与 shoot-webui.ts 同构） ──
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
const browserLog = join(ROOT, ".multica", "tmp", "shot-r4-browser.log");
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
  console.log("[shoot-r4] server healthy");
  await cdpReady();

  const wsUrl = await newPageTab();
  const cdp = new CdpSession(wsUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  cdp.onEvent((method, params) => {
    if (method === "Runtime.consoleAPICalled") {
      const args = (params as { args?: Array<{ value?: unknown }> }).args ?? [];
      const line = args.map((a) => String(a.value ?? "")).join(" ");
      console.log("[console]", line.slice(0, 300));
    }
  });
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
    console.log("[shoot-r4] saved", name);
  }

  // ── 欢迎页（深空）──
  await cdp.send("Page.navigate", { url: BASE_URL });
  await sleep(2500);
  await shot("r4-webui-welcome-dark.png");

  // ── 发送消息 → 思考流式阶段（思考面板自动展开 + streaming dots + 字数）──
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
  // 思考内容流式输出中（正文尚未开始）
  await sleep(4000);
  const dbg = await evaluate(`(() => {
    const panel = document.querySelector('.thinking-panel');
    const msgs = [...document.querySelectorAll('.message-bubble')].map(m => m.innerText.slice(0, 120));
    const err = document.querySelector('.chat-page__error-bar')?.innerText || '';
    return JSON.stringify({ hasPanel: !!panel, panelClass: panel ? panel.className : '', msgs, err, body: document.body.innerText.slice(0, 500) });
  })()`);
  console.log("[debug] DOM:", dbg);
  await waitForSelector(".thinking-panel--expanded .thinking-panel__body", 15000);
  await sleep(900);
  await shot("r4-webui-thinking-streaming.png");

  // ── 回答完成：思考面板 + 正式正文 ──
  await waitForSelector(".message-bubble--assistant .markdown-body");
  await sleep(2200);
  await shot("r4-webui-thinking-complete.png");

  // ── 点击折叠思考面板 ──
  await evaluate(`document.querySelector('.thinking-panel__header').click(); true`);
  await sleep(600);
  await shot("r4-webui-thinking-collapsed.png");
  await evaluate(`document.querySelector('.thinking-panel__header').click(); true`); // 复原

  // ── 日光主题下思考面板 ──
  await evaluate(`document.querySelector('.chat-page__settings-btn').click()`);
  await sleep(300);
  await evaluate(`(() => {
    const items = [...document.querySelectorAll('.settings-menu__item')];
    const target = items.find(el => el.textContent.includes('日光'));
    if (target) target.click();
    return !!target;
  })()`);
  await sleep(600);
  await shot("r4-webui-thinking-light.png");

  // ── 文档站：点击小节 → 被点击标题高亮（Round 4 修复验证）──
  const docsUrl = "file:///D:/AgentCode/FengAgentCli/docs/site/index.html";
  await cdp.send("Page.navigate", { url: docsUrl });
  await sleep(2500);
  // 点击「配置 API Key」小节（nav-sub-item）
  await evaluate(`(() => {
    const items = [...document.querySelectorAll('.nav-sub-item')];
    const target = items.find(el => el.dataset.target === 'qs-config');
    if (target) { target.click(); return true; }
    return false;
  })()`);
  await sleep(2500); // 等待平滑滚动到位 + scroll spy 生效
  await shot("r4-docs-sidebar-highlight.png");

  // 再点击「思考过程可视化」小节（Round 4 新增导航项）
  await evaluate(`(() => {
    const items = [...document.querySelectorAll('.nav-sub-item')];
    const target = items.find(el => el.dataset.target === 'feat-thinking');
    if (target) { target.click(); return true; }
    return false;
  })()`);
  await sleep(2500);
  await shot("r4-docs-sidebar-feat-thinking.png");

  console.log("[shoot-r4] all screenshots saved to screenshots/");
}

try {
  await main();
} finally {
  server.kill();
  browserProc.kill();
  mockServer.stop(true);
}
