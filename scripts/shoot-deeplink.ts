/**
 * Round-1 验证：deep-link（聊天 → 观测/评测）截图脚本（raw CDP 方式）
 *
 * 手动拉起 Chromium（--remote-debugging-port），用 Bun WebSocket 直连 CDP 截图。
 * 依赖运行中的 server（FENG_SERVER_PORT=3999，托管已构建的 web-ui dist）。
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3999";
const OUT = "D:\\AgentCode\\FengAgentCli\\screenshots";
const LOG = "D:\\AgentCode\\FengAgentCli\\shoot-deeplink.log";
const PROFILE = "D:\\AgentCode\\FengAgentCli\\.multica\\tmp\\shot-dl-browser";
const CDP_PORT = 9455;
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
  log("launching chromium via CDP...");
  const browserProc = spawn(
    chromium.executablePath(),
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

  const cdpReady = async (): Promise<boolean> => {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        if (r.ok) return true;
      } catch {
        /* not up yet */
      }
      await Bun.sleep(400);
    }
    return false;
  };

  if (!(await cdpReady())) {
    log("ERROR: chromium CDP not ready");
    process.exit(1);
  }
  log("cdp ready");

  const tabRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
  });
  const tab = (await tabRes.json()) as { webSocketDebuggerUrl: string };
  const cdp = new CdpSession(tab.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const sleep = (ms: number) => Bun.sleep(ms);
  const shot = async (name: string) => {
    await sleep(500);
    const res = (await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true })) as { data: string };
    writeFileSync(join(OUT, name), Buffer.from(res.data, "base64"));
    log("saved " + name);
  };

  const goto = async (url: string) => {
    await cdp.send("Page.navigate", { url });
    await sleep(4500);
  };

  await goto(`${BASE}/`);
  await shot("r1-deeplink-chat-actions.png");

  await goto(`${BASE}/?view=observability&sessionId=${SID}&messageId=${MSG_ID}`);
  await shot("r1-deeplink-obs-focus.png");

  await goto(`${BASE}/?view=observability&sessionId=${SID}`);
  await shot("r1-deeplink-obs-picker.png");

  await goto(`${BASE}/?view=eval&sessionId=${SID}&messageId=${MSG_ID}`);
  await shot("r1-deeplink-eval.png");

  browserProc.kill();
  log("done");
} catch (err) {
  log("ERROR: " + (err instanceof Error ? err.stack ?? err.message : String(err)));
  process.exit(1);
}
