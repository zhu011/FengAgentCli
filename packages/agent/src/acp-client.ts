/**
 * @fengagent/agent — ACP 客户端（把任务派给本机其他 agent 二进制）
 *
 * 与 `packages/server/src/acp-stdio.ts`（服务端那半条）对称：这里实现 **client** 那半条，
 * 用来 spawn 别的 agent（kimi / dsh / fengagent 自身，实测同方言）并按 ACP 跑一轮。
 *
 * 协议面（JSON-RPC 2.0 over NDJSON，一行一帧）：
 *
 * | 方向 | 方法 | 作用 |
 * |---|---|---|
 * | client → agent | `initialize` | 握手，拿 agentInfo / 能力（`loadSession`、`sessionCapabilities.resume`） |
 * | client → agent | `session/new` | 用 `cwd` 建会话，返回 `sessionId` |
 * | client → agent | `session/prompt` | 跑一轮，边跑边收 `session/update`，返回 `{stopReason}` |
 * | client → agent | `session/cancel`（notification） | 取消在飞的 prompt |
 * | agent → client | `session/update`（notification） | 增量：`agent_message_chunk` / `tool_call` / … |
 * | agent → client | `session/request_permission`（request） | 工具审批，客户端回 `outcome.optionId` |
 *
 * 三条实现约束（都是踩过的坑）：
 *
 * 1. **先 per-task spawn**：每个外派任务一个进程，任务结束即回收；常驻池化留给后续阶段
 *    （冷启代价实测：dsh ≈ 13s，kimi ≈ 0.7s）。
 * 2. **超时分两档**：握手/建会话用 `requestTimeoutMs`（默认 120s，容 dsh 冷启），
 *    `session/prompt` 用 `promptTimeoutMs`（默认 10 分钟，容长任务）。
 * 3. **权限请求绝不静默挂起**：拿不到策略时按「拒绝」回（外派任务默认无人在场审批），
 *    并把决策交给调用方留痕。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "@fengagent/shared";

const log = createLogger("acp-client");

/** ACP 协议版本（与 `acp-stdio.ts` 的 `ACP_PROTOCOL_VERSION` 对齐） */
export const ACP_CLIENT_PROTOCOL_VERSION = 1;

/** 握手结果 */
export interface AcpHandshake {
  protocolVersion: number;
  agentInfo: { name: string; version: string };
  capabilities: {
    /** 是否支持带老 sessionId 续聊（`sessionCapabilities.resume` 或 `loadSession`） */
    resume: boolean;
    loadSession: boolean;
    image: boolean;
  };
}

/** 目标侧发来的权限请求 */
export interface AcpPermissionRequest {
  toolCallId?: string;
  title?: string;
  rawInput?: unknown;
  options?: Array<{ optionId?: string; kind?: string; label?: string }>;
}

/** 权限决策（外派场景默认 deny：无人在场审批） */
export type AcpPermissionDecision = "allow" | "deny";

/** `session/update` 里的增量负载（只声明我们用到的字段，其余透传） */
export interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}

/** 一次 prompt 的结果 */
export interface AcpPromptResult {
  /** 累计文本（`agent_message_chunk` 拼接） */
  text: string;
  /** 终止原因（`end_turn` / `max_tokens` / `cancelled` / …） */
  stopReason: string;
  /** 目标侧声明的 ACP sessionId */
  sessionId: string;
}

/** ACP 客户端选项 */
export interface AcpClientOptions {
  /** 可执行文件（如 `kimi` / `dsh-acp`） */
  command: string;
  /** 参数（默认 `["acp"]`） */
  args?: string[];
  /** 子进程工作目录（默认 `process.cwd()`） */
  cwd?: string;
  /** 追加/覆盖的环境变量 */
  env?: Record<string, string | undefined>;
  /** 握手 / 建会话超时（毫秒，默认 120000） */
  requestTimeoutMs?: number;
  /** prompt 超时（毫秒，默认 600000） */
  promptTimeoutMs?: number;
  /** 日志回调（默认走 shared logger） */
  onLog?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

/** 请求超时错误（带方法名，便于路由层给出可读错误） */
export class AcpTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`ACP ${method} 超时（${timeoutMs}ms）`);
    this.name = "AcpTimeoutError";
  }
}

/** 目标进程不可用（spawn 失败 / 提前退出） */
export class AcpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpUnavailableError";
  }
}

/** 协议层错误（对端回 JSON-RPC error） */
export class AcpProtocolError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = "AcpProtocolError";
  }
}

/**
 * 允许透传给目标子进程的环境变量（小写匹配；Windows 上变量名大小写不敏感）。
 *
 * 只放「进程能正常启动」所需的系统变量。**刻意不含**调用方的平台凭据
 * （`MULTICA_*`，含 task token）与 provider key：派发出去的目标进程不该继承
 * 我们这侧的身份。目标真需要凭据，就在 `<数据根>/runtimes.json` 的 `env` 里显式给
 * （或让它读自己的配置文件）。
 */
const CHILD_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "path",
  "pathext",
  "psmodulepath",
  "systemroot",
  "systemdrive",
  "windir",
  "comspec",
  "temp",
  "tmp",
  "tmpdir",
  "home",
  "userprofile",
  "homedrive",
  "homepath",
  "appdata",
  "localappdata",
  "programdata",
  "programfiles",
  "programfiles(x86)",
  "commonprogramfiles",
  "commonprogramfiles(x86)",
  "allusersprofile",
  "number_of_processors",
  "processor_architecture",
  "processor_identifier",
  "processor_level",
  "processor_revision",
  "os",
  "lang",
  "lc_all",
  "lc_messages",
  "tz",
  "username",
  "userdomain",
  "sessionname",
  "shell",
  "term",
  "user",
  "logname",
]);

/**
 * 构造目标子进程的环境变量：系统白名单 + 注册表里显式配置的 `env`。
 *
 * @param extra - 显式注入的变量（`runtimes.json` 的 `env`），优先级最高
 * @returns 精简后的环境变量表
 */
export function buildAcpChildEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (CHILD_ENV_ALLOWLIST.has(key.toLowerCase())) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    env[key] = value;
  }
  return env;
}

interface PendingRequest {
  method: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** prompt 期间的监听器（按 sessionId 路由 `session/update`） */
interface PromptListener {
  onUpdate?: (update: AcpSessionUpdate) => void;
  onPermission?: (request: AcpPermissionRequest) => AcpPermissionDecision;
}

/**
 * ACP 客户端。
 *
 * 用法：
 * ```ts
 * const client = new AcpClient({ command: "kimi", args: ["acp"], cwd: workdir });
 * const handshake = await client.initialize();
 * const sessionId = await client.newSession(workdir);
 * const { text } = await client.prompt(sessionId, "你好");
 * await client.close();
 * ```
 */
export class AcpClient {
  private readonly child: ChildProcess;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly onLog: (level: "debug" | "info" | "warn" | "error", message: string) => void;

  private buffer = "";
  private nextRequestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<string, PromptListener>();
  private readonly stderrChunks: string[] = [];
  private closed = false;
  private exited = false;
  private exitPromise: Promise<void>;
  private handshake: AcpHandshake | null = null;

  constructor(options: AcpClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 600_000;
    this.onLog = options.onLog ?? ((level, message) => log[level]("spawn", message));

    const args = options.args ?? ["acp"];
    this.child = spawn(options.command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: buildAcpChildEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.exitPromise = new Promise<void>((resolve) => {
      const settle = (): void => {
        this.exited = true;
        this.rejectAll(new AcpUnavailableError(this.unavailableMessage("进程已退出")));
        resolve();
      };
      this.child.once("exit", settle);
      this.child.once("error", (err) => {
        this.onLog("error", `spawn 失败: ${err.message}`);
        settle();
      });
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrChunks.push(chunk);
      if (this.stderrChunks.length > 40) this.stderrChunks.shift();
      this.onLog("debug", `[stderr] ${chunk.trim().slice(0, 500)}`);
    });
  }

  /** 该客户端是否已不可用（进程退出 / 已关闭） */
  get unavailable(): boolean {
    return this.closed || this.exited;
  }

  /** 最近若干行 stderr（错误诊断用） */
  stderrTail(): string {
    return this.stderrChunks.join("").trim().slice(-2000);
  }

  /**
   * 握手：`initialize` + `notifications/initialized`。
   *
   * @returns 目标 agent 的身份与能力
   */
  async initialize(): Promise<AcpHandshake> {
    const result = (await this.request(
      "initialize",
      {
        protocolVersion: ACP_CLIENT_PROTOCOL_VERSION,
        clientCapabilities: {
          // 外派任务只需要文本；文件系统/终端能力不声明，避免目标侧期待我们提供服务。
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
      },
      this.requestTimeoutMs,
    )) as Record<string, unknown>;

    const agentInfo = (result.agentInfo ?? {}) as Record<string, unknown>;
    const caps = (result.agentCapabilities ?? {}) as Record<string, unknown>;
    const promptCaps = (caps.promptCapabilities ?? {}) as Record<string, unknown>;
    const sessionCaps = (caps.sessionCapabilities ?? {}) as Record<string, unknown>;
    const handshake: AcpHandshake = {
      protocolVersion: Number(result.protocolVersion ?? ACP_CLIENT_PROTOCOL_VERSION),
      agentInfo: {
        name: String(agentInfo.name ?? ""),
        version: String(agentInfo.version ?? ""),
      },
      capabilities: {
        resume: Boolean(sessionCaps.resume) || Boolean(caps.loadSession),
        loadSession: Boolean(caps.loadSession),
        image: Boolean(promptCaps.image),
      },
    };
    this.handshake = handshake;
    // 有些实现（dsh / opencode 系）在收到 initialized 通知后才开始接受 prompt。
    this.notify("notifications/initialized", {});
    return handshake;
  }

  /** 上一次握手的缓存（未握手时为 null） */
  get handshakeInfo(): AcpHandshake | null {
    return this.handshake;
  }

  /**
   * 建会话：`session/new`。
   *
   * @param cwd - 目标的绝对工作目录（ACP 要求绝对路径）
   * @returns 目标侧 sessionId
   */
  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<string> {
    const result = (await this.request(
      "session/new",
      { cwd, mcpServers },
      this.requestTimeoutMs,
    )) as Record<string, unknown>;
    const sessionId = typeof result.sessionId === "string" ? result.sessionId : "";
    if (sessionId === "") {
      throw new AcpProtocolError("session/new 未返回 sessionId");
    }
    return sessionId;
  }

  /**
   * 复用目标侧既有会话：`session/resume`。
   *
   * ACP 的 resume 必须带**全参** —— 实测 kimi 与原版 dsh 会强制校验 `cwd`：
   * `{ sessionId, cwd, mcpServers }`，缺 cwd 直接拒。目标侧回 `{sessionId}` 就用它，
   * 没回就沿用传入的 id（网关类实现会这么做）。
   *
   * @param sessionId - 上一轮记下的目标会话 id
   * @param cwd - 目标的绝对工作目录
   * @param mcpServers - 本桥不接 MCP，默认空数组（不能省略）
   * @returns 目标侧确认的 sessionId
   */
  async resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers: unknown[] = [],
  ): Promise<string> {
    const result = (await this.request(
      "session/resume",
      { sessionId, cwd, mcpServers },
      this.requestTimeoutMs,
    )) as Record<string, unknown>;
    const resumed = typeof result.sessionId === "string" ? result.sessionId : "";
    return resumed === "" ? sessionId : resumed;
  }

  /**
   * 跑一轮：`session/prompt`，期间把 `session/update` 交给 `onUpdate`。
   *
   * @param sessionId - 目标侧会话 id
   * @param text - 输入文本
   * @param options - 增量/权限回调与超时
   * @returns 累计文本 + 终止原因
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
    const listener: PromptListener = {
      ...(options.onUpdate ? { onUpdate: options.onUpdate } : {}),
      ...(options.onPermission ? { onPermission: options.onPermission } : {}),
    };
    this.listeners.set(sessionId, listener);
    const chunks: string[] = [];
    const wrapped: PromptListener = {
      onUpdate: (update) => {
        const chunk = textOfUpdate(update);
        if (chunk !== null) chunks.push(chunk);
        listener.onUpdate?.(update);
      },
      onPermission: (request) => {
        // 外派默认无人在场：没给策略就拒绝（绝不静默放行，也不静默挂起）
        const decision = listener.onPermission?.(request) ?? "deny";
        return decision;
      },
    };
    this.listeners.set(sessionId, wrapped);

    try {
      const result = (await this.request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text }] },
        options.timeoutMs ?? this.promptTimeoutMs,
      )) as Record<string, unknown>;
      return {
        text: chunks.join(""),
        stopReason: String(result.stopReason ?? "end_turn"),
        sessionId,
      };
    } finally {
      this.listeners.delete(sessionId);
    }
  }

  /**
   * 取消在飞的 prompt（`session/cancel` notification）。
   *
   * @param sessionId - 目标侧会话 id
   */
  cancel(sessionId: string): void {
    if (this.unavailable) return;
    this.notify("session/cancel", { sessionId });
  }

  /**
   * 关闭：EOF stdin → 等进程退出 → 超时升级为 SIGTERM/SIGKILL。
   *
   * @param graceMs - 等待友好退出的时长（默认 2000ms）
   */
  async close(graceMs = 2000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin?.end();
    } catch {
      // stdin 已关闭
    }
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (!exited) {
      this.onLog("warn", "目标进程未在宽限期内退出，发送 SIGTERM");
      try {
        this.child.kill("SIGTERM");
      } catch {
        // 已退出
      }
      const killed = await Promise.race([
        this.exitPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      if (!killed) {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      }
    }
    this.rejectAll(new AcpUnavailableError(this.unavailableMessage("客户端已关闭")));
  }

  // ──────────────────────────────────────────────
  // 协议帧
  // ──────────────────────────────────────────────

  /** 发一个请求并等响应 */
  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.unavailable) {
      return Promise.reject(new AcpUnavailableError(this.unavailableMessage(`无法发送 ${method}`)));
    }
    const id = ++this.nextRequestId;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (this.pending.delete(id)) {
                reject(new AcpTimeoutError(method, timeoutMs));
              }
            }, timeoutMs)
          : undefined;
      if (timer && typeof timer === "object" && "unref" in timer) {
        (timer as { unref?: () => void }).unref?.();
      }
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** 发一个通知（不期待响应） */
  private notify(method: string, params: unknown): void {
    if (this.unavailable) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: Record<string, unknown>): void {
    if (this.unavailable) return;
    try {
      this.child.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      this.onLog("warn", `写入协议帧失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line !== "") this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.onLog("warn", `无法解析的协议帧（已忽略）: ${line.slice(0, 200)}`);
      return;
    }
    const method = typeof message.method === "string" ? message.method : undefined;
    const id = message.id;

    // 目标 → 我们的请求（权限桥）
    if (method && id !== undefined && id !== null) {
      void this.handleInboundRequest(id as number | string, method, message.params);
      return;
    }
    // 通知
    if (method) {
      if (method === "session/update") {
        const params = (message.params ?? {}) as Record<string, unknown>;
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
        const update = (params.update ?? {}) as AcpSessionUpdate;
        if (typeof update.sessionUpdate === "string") {
          this.listeners.get(sessionId)?.onUpdate?.(update);
        }
      }
      return;
    }
    // 响应
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      const error = message.error as { code?: number; message?: string; data?: unknown } | undefined;
      if (error) {
        pending.reject(
          new AcpProtocolError(
            `${pending.method} 失败: ${error.message ?? "unknown"}${error.code === undefined ? "" : ` (code=${error.code})`}`,
            error.code,
            error.data,
          ),
        );
        return;
      }
      pending.resolve(message.result ?? {});
    }
  }

  /** 目标侧的 `session/request_permission`：按策略回 optionId */
  private async handleInboundRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (method !== "session/request_permission") {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }
    const args = (params ?? {}) as Record<string, unknown>;
    const request: AcpPermissionRequest = {
      ...(typeof args.toolCallId === "string" ? { toolCallId: args.toolCallId } : {}),
      ...(typeof args.title === "string" ? { title: args.title } : {}),
      ...(args.rawInput === undefined ? {} : { rawInput: args.rawInput }),
      ...(Array.isArray(args.options)
        ? { options: args.options as AcpPermissionRequest["options"] }
        : {}),
    };
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    const listener = this.listeners.get(sessionId);
    const decision: AcpPermissionDecision = listener?.onPermission
      ? listener.onPermission(request)
      : "deny";
    this.onLog(
      "info",
      `权限请求 tool=${request.title ?? request.toolCallId ?? "?"} → ${decision}`,
    );
    this.write({
      jsonrpc: "2.0",
      id,
      result: {
        outcome: {
          outcome: "selected",
          optionId: decision === "allow" ? "allow-once" : "reject-once",
        },
      },
    });
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private unavailableMessage(reason: string): string {
    const tail = this.stderrTail();
    const suffix = tail === "" ? "" : `；stderr: ${tail}`;
    return `ACP 目标不可用（${reason}）${suffix}`;
  }
}

/**
 * 从 `session/update` 里取文本增量。
 *
 * 兼容两套命名：`agent_message_chunk`（ACP 1.x snake_case）与
 * `agentMessageChunk`（部分实现用 camelCase）。
 *
 * @param update - update 负载
 * @returns 文本；非文本增量返回 null
 */
export function textOfUpdate(update: AcpSessionUpdate): string | null {
  const kind = update.sessionUpdate;
  const isMessage =
    kind === "agent_message_chunk" ||
    kind === "agentMessageChunk" ||
    kind === "assistant_message_chunk";
  if (!isMessage) return null;
  const content = update.content;
  if (!content || typeof content !== "object") return null;
  return typeof content.text === "string" ? content.text : null;
}
