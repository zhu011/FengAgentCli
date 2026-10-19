/**
 * AGE-29 RSI 多端验证：WebUI 截图（raw CDP，沙箱下 playwright 连接器握手会被卡）。
 * 前置：serve 已在 :3200 运行。输出 .verify-rsi/assets/ 下的 PNG。
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3200";
const CDP_PORT = 9453;
const ROOT = "D:\\AgentCode\\FengAgentCli-main";
const OUT = join(ROOT, ".verify-rsi", "assets");
mkdirSync(OUT, { recursive: true });

class CdpSession {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
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
      }
    };
  }
  async open() {
    await new Promise<void>((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error("cdp ws error")); });
  }
  send(method: string, params: unknown = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<unknown>((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
}

const sleep = (ms: number) => Bun.sleep(ms);

async function main() {
  const PROFILE = join(ROOT, ".verify-rsi", "browser-profile");
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const browserProc = spawn(
    chromium.executablePath(),
    ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
     `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
     "--window-size=1480,960", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  browserProc.stderr?.on("data", (d) => appendFileSync(join(ROOT, ".verify-rsi", "browser.log"), d.toString()));
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break; } catch {}
    await sleep(500);
  }
  const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
  const cdp = new CdpSession(tab.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1480, height: 960, deviceScaleFactor: 1, mobile: false });

  async function evaluate(expr: string): Promise<unknown> {
    const res = (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })) as {
      result?: { value?: unknown }; exceptionDetails?: unknown;
    };
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 240));
    return res.result?.value;
  }
  async function snap(name: string) {
    const r = (await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })) as { data: string };
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  }

  const SID = readFileSync(join(ROOT, ".verify-rsi", "webui-sid.txt"), "utf8").trim();

  // 1) WebUI 首页（欢迎页）
  await cdp.send("Page.navigate", { url: BASE });
  await sleep(2500);
  await snap("06-webui-home");

  // 2) 打开会话（URL hash 或直接切换）—— 通过侧栏点击该会话
  //    先在输入框输入消息发起一轮带注入的对话
  await evaluate(`(() => {
    const input = document.querySelector("textarea, input[type=text], .message-input textarea, [class*=input] textarea, [class*=input] input");
    if (!input) return "no-input";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement?.prototype ?? window.HTMLInputElement.prototype, "value")?.set
      ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (input.tagName === "TEXTAREA" && setter) setter.call(input, "请原样回复这个暗号：WebUI截图-D4-8e1f");
    else input.value = "请原样回复这个暗号：WebUI截图-D4-8e1f";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return "typed:" + input.tagName;
  })()`);
  await sleep(600);
  await snap("07-webui-typed");
  // 提交
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => /发送|send|submit/i.test(b.textContent + (b.getAttribute("aria-label") ?? "")));
    if (btn) { btn.click(); return "clicked"; }
    // fallback: Enter
    const input = document.querySelector("textarea, .message-input textarea");
    if (input) { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })); return "enter"; }
    return "no-submit";
  })()`);
  await sleep(15000); // 等回复
  await snap("08-webui-response");
  const pageText = String(await evaluate(`document.querySelector("#root, body")?.innerText?.slice(0, 3000) ?? "(empty)"`));
  writeFileSync(join(OUT, "08-webui-page-text.txt"), pageText);
  console.log("PAGE_TEXT_HEAD:", pageText.slice(0, 300).replace(/\n/g, " | "));

  browserProc.kill();
  process.exit(0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
