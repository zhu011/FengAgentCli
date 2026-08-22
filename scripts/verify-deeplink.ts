/**
 * Round-1 验证：deep-link UI DOM 断言（CDP）
 * 校验各页面渲染出深链元素（按钮 / 横幅 / 消息选择器 / 评测卡片）。
 */

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3999";
const LOG = "D:\\AgentCode\\FengAgentCli\\verify-dl.log";
const PROFILE = "D:\\AgentCode\\FengAgentCli\\.multica\\tmp\\verify-dl-browser";
const CDP_PORT = 9456;
const SID = "75b3b4ec-6429-4f08-8a65-9f3f57f91fca";
const MSG_ID = "5b86df8a-4c43-49c1-989a-a2d410abfe36";

const log = (s: string) => appendFileSync(LOG, s + "\n");

class CdpSession {
  private ws!: WebSocket;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private id = 0;
  constructor(private url: string) {}
  async open(): Promise<void> {
    this.ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("ws error"));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    };
  }
  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

try {
  const browserProc = spawn(
    chromium.executablePath(),
    [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, "--window-size=1440,900", "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) { ready = true; break; }
    } catch { /* retry */ }
    await Bun.sleep(400);
  }
  if (!ready) throw new Error("cdp not ready");

  const tab = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string };
  const cdp = new CdpSession(tab.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const evaluate = async (expression: string): Promise<unknown> => {
    const res = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
      result?: { value?: unknown; description?: string };
      exceptionDetails?: unknown;
    };
    if (res.exceptionDetails) return "EVAL_ERROR";
    return res.result?.value;
  };
  const goto = async (url: string) => {
    await cdp.send("Page.navigate", { url });
    await Bun.sleep(4500);
  };
  const count = async (sel: string) => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

  // 1. 聊天页：消息气泡按钮
  await goto(`${BASE}/`);
  log(`chat: message-bubble__action buttons = ${await count(".message-bubble__action")}`);
  log(`chat: first button title = ${await evaluate(`document.querySelector(".message-bubble__action")?.getAttribute("title") ?? "none"`)}`);

  // 2. 观测页聚焦
  await goto(`${BASE}/?view=observability&sessionId=${SID}&messageId=${MSG_ID}`);
  log(`obs-focus: obs-banner = ${await count(".obs-banner")}`);
  log(`obs-focus: msg-picker = ${await count(".obs-msg-picker")}`);
  log(`obs-focus: trace llm steps = ${await count(".trace-step--llm")}`);
  log(`obs-focus: trace tool nodes = ${await count(".trace-tool")}`);
  log(`obs-focus: banner title = ${await evaluate(`document.querySelector(".obs-banner__title")?.textContent ?? "none"`)}`);

  // 3. 观测页会话级（消息选择器）
  await goto(`${BASE}/?view=observability&sessionId=${SID}`);
  log(`obs-picker: banner = ${await count(".obs-banner")}`);
  log(`obs-picker: msg-picker items = ${await count(".obs-msg-picker__item")}`);
  log(`obs-picker: active session tab = ${await evaluate(`document.querySelector(".trace-tree__session-tab--active")?.textContent ?? "none"`)}`);

  // 4. 评测页 deep-link
  await goto(`${BASE}/?view=eval&sessionId=${SID}&messageId=${MSG_ID}`);
  log(`eval: eval-deeplink = ${await count(".eval-deeplink")}`);
  log(`eval: msg cards = ${await count(".eval-msg-card")}`);
  log(`eval: judge pending = ${await count(".eval-judge--pending")}`);
  log(`eval: metrics = ${await count(".eval-msg-metric")}`);

  browserProc.kill();
  log("done");
} catch (err) {
  log("ERROR: " + (err instanceof Error ? err.stack ?? err.message : String(err)));
  process.exit(1);
}
