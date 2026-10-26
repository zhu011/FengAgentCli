/**
 * @fengagent/agent — Claude Code `stream-json` 协议客户端（P4 首块）
 *
 * 与 `acp-client.ts` 并列的第二个运行时协议适配器：把 Claude Code CLI 的
 * `--print --output-format stream-json` 一次性运行包成 AcpClient 同构的
 * 「握手 / 建会话 / 跑一轮 / 取消」表面，`agent-task-service` 的派发闭环
 * （7 态任务仓 / 事件流 / operation_ledger 台账）因此零改动复用。
 *
 * ## 与 ACP 的模型差异
 *
 * | 维度 | ACP（dsh / kimi / fengagent） | Claude stream-json |
 * | --- | --- | --- |
 * | 进程模型 | 长驻子进程，多轮 JSON-RPC | **进程-per-prompt**：每轮一次 `claude -p` |
 * | 握手 | `initialize` 请求 | `claude --version` 短命探测 |
 * | 会话 | 服务端 `session/new` / `session/resume` | `--session-id <uuid>`（新建）/ `-r <id>`（续聊） |
 * | 流式 | `session/update` 通知（增量块） | `assistant` 事件里的 text 块（整块） |
 * | 终止 | `session/prompt` 响应 | `result` 事件（`is_error` / `stop_reason` / `result`） |
 *
 * ## 权限桥（v1 约定）
 *
 * Claude 在 `-p` 模式下没有可编程的逐请求审批面（`--permission-prompt-tool`
 * 需要挂 MCP 服务器，后续增强）。v1 的映射：prompt 开始时向服务的
 * `onPermission` 合成一次「本运行内全部工具」的审批——沿用注册表
 * `permissionPolicy` 的判定（allow 才放行）；allow → 追加
 * `--dangerously-skip-permissions`，deny → 原样运行（Claude 对需要审批的
 * 工具自动拒绝并记入 `result.permission_denials`）。决策本身经服务侧
 * `onPermission` 走，事件流里照常留 `[permission]` 记录。
 *
 * ## 环境与 cwd
 *
 * 复用 `buildAcpChildEnv` 最小白名单（不透传 `MULTICA_*`）；cwd 由调用方给
 * （服务的派发 cwd 已是仓库外中立目录，Claude 不会读到本仓库的
 * AGENTS.md / CLAUDE.md 自报身份）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  AcpHandshake,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpPromptResult,
  AcpSessionUpdate,
} from "./acp-client.ts";
import {
  AcpProtocolError,
  AcpTimeoutError,
  AcpUnavailableError,
  buildAcpChildEnv,
} from "./acp-client.ts";

/** 日志回调（与 AcpClientOptions 一致） */
export type ClaudeClientLog = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
) => void;

export interface ClaudeStreamJsonClientOptions {
  /** 可执行文件（默认 `claude`；Windows 上是 .cmd，内部用 shell 解析） */
  command?: string;
  /** 基础参数（默认 `-p --output-format stream-json --verbose`） */
  args?: string[];
  /** 子进程工作目录（默认 `process.cwd()`） */
  cwd?: string;
  /** 追加/覆盖的环境变量（白名单之外的仅此来源） */
  env?: Record<string, string | undefined>;
  /** 握手（`--version` 探测）超时（毫秒，默认 30000） */
  requestTimeoutMs?: number;
  /** prompt 超时（毫秒，默认 600000，与 AcpClient 对齐） */
  promptTimeoutMs?: number;
  /** 日志回调 */
  onLog?: ClaudeClientLog;
}

/** `claude --version` 输出形如 `2.1.119 (Claude Code)` */
const VERSION_PATTERN = /^(\S+)\s+\((.+)\)\s*$/;

/**
 * Claude Code stream-json 客户端。
 *
 * 用法（与 AcpClient 同构，`agent-task-service` 按 `entry.protocol` 选择）：
 * ```ts
 * const client = new ClaudeStreamJsonClient({ command: "claude" });
 * const handshake = await client.initialize();
 * const sessionId = await client.newSession(workdir);
 * const { text } = await client.prompt(sessionId, "你好");
 * await client.close();
 * ```
 */
export class ClaudeStreamJsonClient {
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly cwd: string | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly onLog: ClaudeClientLog;

  /** 在飞的 prompt 子进程（进程-per-prompt，同一时刻至多一个） */
  private child: ChildProcess | undefined;
  /** 被取消的会话（prompt 以 stopReason="cancelled" 结算而非报错） */
  private readonly cancelledSessions = new Set<string>();
  private closed = false;

  constructor(options: ClaudeStreamJsonClientOptions = {}) {
    this.command = options.command ?? "claude";
    this.baseArgs = options.args ?? ["-p", "--output-format", "stream-json", "--verbose"];
    this.cwd = options.cwd;
    this.env = options.env ?? {};
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 600_000;
    this.onLog = options.onLog ?? (() => {});
  }

  /**
   * 握手：短命 `--version` 探测。Claude 的续聊（`-r`）与固定会话 id
   * （`--session-id`）都是 CLI 原生能力，capabilities 按此上报。
   */
  async initialize(): Promise<AcpHandshake> {
    const stdout = await this.runShortLived(
      ["--version"],
      this.requestTimeoutMs,
      "initialize",
    );
    const line = stdout.trim().split("\n").pop() ?? "";
    const match = VERSION_PATTERN.exec(line);
    const version = match?.[1] ?? line;
    const name = match?.[2] ?? "Claude Code";
    return {
      protocolVersion: 1,
      agentInfo: { name, version },
      capabilities: { resume: true, loadSession: true, image: false },
    };
  }

  /**
   * 建会话：生成 UUID（Claude 用 `--session-id` 原生接受任意合法 UUID）。
   * 与 AcpClient 不同，这里不 spawn——真正的进程在 `prompt()` 里按会话参数拉起。
   */
  newSession(_cwd: string, _mcpServers: unknown[] = []): Promise<string> {
    this.assertOpen();
    return Promise.resolve(randomUUID());
  }

  /**
   * 续聊：返回原 sessionId（下一轮 prompt 以 `-r <id>` 续上）。
   * 会话不存在时 Claude 会在该轮报错，由服务侧回退到 `newSession`。
   */
  resumeSession(sessionId: string, _cwd: string, _mcpServers: unknown[] = []): Promise<string> {
    this.assertOpen();
    // 标记续聊：本客户端是每次派发新建的实例，「上一轮是否跑过」只能由
    // 服务的 openTargetSession 语义（调了 resumeSession）告知，不能自记。
    this.resumeMarkedSessions.add(sessionId);
    return Promise.resolve(sessionId);
  }

  /**
   * 跑一轮：`claude -p --output-format stream-json [--session-id <uuid> | -r <id>]`
   * （allow 策略时追加 `--dangerously-skip-permissions`），输入文本走 stdin，
   * 流式解析 stdout 的 JSONL 事件并翻译成 AcpSessionUpdate。
   */
  async prompt(
    sessionId: string,
    text: string,
    options: {
      onUpdate?: (update: AcpSessionUpdate) => void;
      onPermission?: (request: AcpPermissionRequest) => AcpPermissionDecision;
      timeoutMs?: number;
    } = {},
  ): Promise<AcpPromptResult> {
    this.assertOpen();
    if (this.child !== undefined) {
      throw new AcpProtocolError("Claude 客户端同一时刻只支持一个在飞 prompt（进程-per-prompt）");
    }
    this.cancelledSessions.delete(sessionId);

    // 权限桥（v1）：合成一次「本运行内全部工具」审批，沿用注册表策略判定。
    const decision: AcpPermissionDecision = options.onPermission?.({
      title: `claude 一次性运行（会话 ${sessionId.slice(0, 8)}，本运行内全部工具）`,
      options: [
        { optionId: "allow", kind: "allow_once", label: "允许本次运行" },
        { optionId: "deny", kind: "deny", label: "拒绝" },
      ],
    }) ?? "deny";

    const args = [...this.baseArgs];
    if (decision === "allow") {
      args.push("--dangerously-skip-permissions");
    } else {
      // deny：不加旗标。Claude 在 -p 模式下对需要审批的工具自动拒绝，
      // 拒绝清单出现在 result 事件的 permission_denials 里。
      this.onLog("info", `prompt ${sessionId.slice(0, 8)}: 权限策略 deny，需审批工具将被目标侧拒绝`);
    }
    // 会话参数：服务侧 openTargetSession 调过 resumeSession → `-r` 续聊；
    // 否则是 newSession 的新 UUID → `--session-id`（Claude 原生接受任意合法 UUID）。
    if (this.resumeMarkedSessions.has(sessionId)) {
      args.push("--resume", sessionId);
    } else {
      args.push("--session-id", sessionId);
    }

    return await this.runPromptProcess(sessionId, text, args, options);
  }

  /** 服务侧标记为续聊的会话（prompt 走 `-r`） */
  private readonly resumeMarkedSessions = new Set<string>();

  /** 取消在飞 prompt：杀子进程，prompt 以 cancelled 结算。 */
  cancel(sessionId: string): void {
    if (this.closed) return;
    this.cancelledSessions.add(sessionId);
    if (this.child !== undefined && this.child.exitCode === null) {
      this.killChild();
    }
  }

  /** 关闭：杀掉在飞子进程（若有）并置关闭位。 */
  async close(_graceMs = 2000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.child !== undefined && this.child.exitCode === null) {
      this.killChild();
    }
  }

  // ──────────────────────────────────────────────
  // 内部：进程管理
  // ──────────────────────────────────────────────

  private assertOpen(): void {
    if (this.closed) throw new AcpUnavailableError("Claude 客户端已关闭");
  }

  private killChild(): void {
    const child = this.child;
    if (child === undefined) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // 已退出
    }
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      }
    }, 2000).unref();
  }

  /** 短命命令（--version）：收满 stdout，超时/非零退出报错 */
  private runShortLived(args: string[], timeoutMs: number, method: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = this.spawnChild(args);
      let stdout = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出
        }
        reject(new AcpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new AcpUnavailableError(`spawn 失败: ${err.message}`));
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new AcpUnavailableError(`claude ${args.join(" ")} 退出码 ${code}`));
        }
      });
    });
  }

  /** stream-json 事件里的 assistant 消息块（只声明用到的字段） */
  private async runPromptProcess(
    sessionId: string,
    text: string,
    args: string[],
    options: { onUpdate?: (update: AcpSessionUpdate) => void; timeoutMs?: number },
  ): Promise<AcpPromptResult> {
    const timeoutMs = options.timeoutMs ?? this.promptTimeoutMs;
    const child = this.spawnChild(args);
    this.child = child;

    return await new Promise<AcpPromptResult>((resolve, reject) => {
      const chunks: string[] = [];
      let actualSessionId = sessionId;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.killChild();
        reject(new AcpTimeoutError("session/prompt", timeoutMs));
      }, timeoutMs);

      const settleCancel = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        
        resolve({
          text: chunks.join(""),
          stopReason: "cancelled",
          sessionId: actualSessionId,
        });
      };

      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new AcpUnavailableError(`spawn 失败: ${err.message}`));
      });

      child.once("exit", (code, signal) => {
        this.child = undefined;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.cancelledSessions.has(sessionId)) {
          
          resolve({ text: chunks.join(""), stopReason: "cancelled", sessionId: actualSessionId });
          return;
        }
        const reason =
          signal !== null ? `信号 ${signal}` : `退出码 ${code ?? "?"}`;
        reject(
          new AcpUnavailableError(
            `claude 进程在产出 result 前结束（${reason}）；已收 ${chunks.length} 个文本块`,
          ),
        );
      });

      const lines = createInterface({ input: child.stdout ?? process.stdin });
      lines.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed === "") return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          this.onLog("warn", `忽略无法解析的 stream-json 行: ${trimmed.slice(0, 120)}`);
          return;
        }
        const type = event.type;
        if (type === "system" && event.subtype === "init") {
          if (typeof event.session_id === "string" && event.session_id !== "") {
            actualSessionId = event.session_id;
          }
          return;
        }
        if (type === "assistant") {
          const message = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
          const blocks = message?.content ?? [];
          for (const block of blocks) {
            if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
              chunks.push(block.text);
              options.onUpdate?.({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: block.text },
              });
            }
          }
          return;
        }
        if (type === "result") {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (typeof event.session_id === "string" && event.session_id !== "") {
            actualSessionId = event.session_id;
          }
          
          if (event.is_error === true) {
            const message =
              typeof event.result === "string" && event.result !== ""
                ? event.result
                : `claude 返回错误结果（subtype=${String(event.subtype ?? "?")}）`;
            reject(new AcpProtocolError(message));
            return;
          }
          const resultText = typeof event.result === "string" ? event.result : "";
          resolve({
            text: resultText.length > 0 ? resultText : chunks.join(""),
            stopReason: typeof event.stop_reason === "string" ? event.stop_reason : "end_turn",
            sessionId: actualSessionId,
          });
          return;
        }
        // 其余事件（user/tool_result/stream_event/…）v1 不翻译
      });

      // 输入走 stdin（text 格式），写完即关——claude 处理完输出 result 后退出
      child.stdin?.write(text);
      child.stdin?.end();

      // cancel() 杀进程后由 exit 结算为 cancelled；这里兜底直接结算
      const cancelWatch = setInterval(() => {
        if (this.cancelledSessions.has(sessionId)) {
          clearInterval(cancelWatch);
          settleCancel();
        }
      }, 200);
      cancelWatch.unref();
      // 任一路径结算后都停掉轮询（防句柄泄漏）
      child.once("exit", () => clearInterval(cancelWatch));
    });
  }

  /**
   * spawn 子进程。Windows 上 `claude` 是 .cmd（无同名 .exe），node 不带 shell
   * 解析不了——参数全部是受控旗标 + UUID（用户文本走 stdin，不进命令行），
   * 因此 win32 下用 shell 解析是安全的。
   */
  private spawnChild(args: string[]): ChildProcess {
    return spawn(this.command, args, {
      cwd: this.cwd,
      env: buildAcpChildEnv(this.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
  }
}
