/**
 * @fengagent/agent — 运行时驱动（协议无关的外派执行面）
 *
 * 「把任务派给本机某个 agent 二进制」这件事，不同 CLI 的**启动协议**不一样：
 *
 * | runtime | 协议 | 一句话 |
 * |---|---|---|
 * | dsh / kimi / fengagent | ACP（NDJSON JSON-RPC） | 长驻进程，`session/new` + `session/prompt` |
 * | claude | `stream-json`（一次性 `-p`） | 每个任务一个进程，事件流到 `result` 即结束 |
 *
 * 任务仓 / 7 态状态机 / 事件流 / 幂等台账都与协议无关，因此这里抽一层
 * {@link RuntimeDriver}：服务层只跟驱动打交道，新增一种协议 = 新增一个客户端实现
 * （`createRuntimeDriver()` 按注册表的 `protocol` 选）。
 *
 * 两种客户端（`AcpClient` / `ClaudeStreamJsonClient`）刻意保持**同构的
 * AcpClient-like 表面**（initialize / newSession / resumeSession / prompt / cancel /
 * close），所以这里只需要一个适配器 {@link ClientRuntimeDriver}，把
 * 「会话打开策略（能 resume 就 resume）」与「文本增量提取」收在一处。
 */

import { AcpClient, textOfUpdate } from "./acp-client.ts";
import type {
  AcpClientOptions,
  AcpHandshake,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpPromptResult,
  AcpSessionUpdate,
} from "./acp-client.ts";
import { ClaudeStreamJsonClient } from "./claude-client.ts";
import type { ClaudeStreamJsonClientOptions } from "./claude-client.ts";

/** 支持的启动协议 */
export type RuntimeProtocol = "acp" | "claude-stream-json";

/** 握手信息（对外扁平化：注册表与任务事件都用这一份） */
export interface RuntimeHandshakeInfo {
  agentName: string;
  agentVersion: string;
  capabilities: { resume: boolean; loadSession: boolean; image: boolean };
}

/** 会话打开结果 */
export interface RuntimeSessionHandle {
  sessionId: string;
  mode: "new" | "resume";
  fallbackReason?: string;
}

/** 一次 prompt 的选项 */
export interface RuntimePromptOptions {
  /** 文本增量回调（服务层据此推 SSE chunk） */
  onChunk?: (text: string) => void;
  /** 逐次权限请求（ACP 会多次触发；claude 只在 prompt 开始时合成一次） */
  onPermission?: (request: AcpPermissionRequest) => AcpPermissionDecision;
  /** 覆盖默认 prompt 超时 */
  timeoutMs?: number;
}

/** prompt 结果 */
export interface RuntimePromptResult {
  text: string;
  stopReason: string;
  sessionId: string;
}

/**
 * 运行时驱动接口 —— 服务层只依赖它。
 */
export interface RuntimeDriver {
  /** 握手（拿目标身份与能力） */
  initialize(): Promise<RuntimeHandshakeInfo>;
  /**
   * 打开会话：有 `previousSessionId` 且目标支持 resume 就续聊，否则新建。
   *
   * @param previousSessionId - 上一 attempt 留下的目标会话 id
   */
  openSession(previousSessionId?: string): Promise<RuntimeSessionHandle>;
  /** 跑一轮 */
  prompt(text: string, options?: RuntimePromptOptions): Promise<RuntimePromptResult>;
  /** 取消在飞的一轮 */
  cancel(): void;
  /** 回收进程 */
  close(graceMs?: number): Promise<void>;
  /** 最近 stderr（错误诊断） */
  stderrTail(): string;
  /** 是否已不可用 */
  readonly unavailable: boolean;
  /** 最近一次会话 id（「跑完才知道 id」的协议用） */
  readonly lastSessionId: string | undefined;
}

/**
 * 两种客户端共有的表面（`AcpClient` 与 `ClaudeStreamJsonClient` 都满足）。
 */
export interface AcpClientLike {
  initialize(): Promise<AcpHandshake>;
  newSession(cwd: string, mcpServers?: unknown[]): Promise<string>;
  resumeSession(sessionId: string, cwd: string, mcpServers?: unknown[]): Promise<string>;
  prompt(
    sessionId: string,
    text: string,
    options?: {
      onUpdate?: (update: AcpSessionUpdate) => void;
      onPermission?: (request: AcpPermissionRequest) => AcpPermissionDecision;
      timeoutMs?: number;
    },
  ): Promise<AcpPromptResult>;
  cancel(sessionId: string): void;
  close(graceMs?: number): Promise<void>;
  /** 可选：部分实现提供 stderr 尾巴 */
  stderrTail?(): string;
}

/** 把同构客户端适配成 {@link RuntimeDriver} */
export class ClientRuntimeDriver implements RuntimeDriver {
  private readonly client: AcpClientLike;
  private readonly cwd: string;
  private handshake: AcpHandshake | null = null;
  private sessionId: string | undefined;
  private closed = false;

  constructor(client: AcpClientLike, cwd: string) {
    this.client = client;
    this.cwd = cwd;
  }

  get unavailable(): boolean {
    return this.closed;
  }

  get lastSessionId(): string | undefined {
    return this.sessionId;
  }

  stderrTail(): string {
    return this.client.stderrTail ? this.client.stderrTail() : "";
  }

  async initialize(): Promise<RuntimeHandshakeInfo> {
    this.handshake = await this.client.initialize();
    return {
      agentName: this.handshake.agentInfo.name,
      agentVersion: this.handshake.agentInfo.version,
      capabilities: this.handshake.capabilities,
    };
  }

  async openSession(previousSessionId?: string): Promise<RuntimeSessionHandle> {
    const canResume =
      previousSessionId !== undefined &&
      previousSessionId !== "" &&
      (this.handshake?.capabilities.resume ?? false);
    if (canResume) {
      try {
        const sessionId = await this.client.resumeSession(previousSessionId, this.cwd);
        this.sessionId = sessionId;
        return { sessionId, mode: "resume" };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const sessionId = await this.client.newSession(this.cwd);
        this.sessionId = sessionId;
        return { sessionId, mode: "new", fallbackReason: reason.slice(0, 200) };
      }
    }
    const sessionId = await this.client.newSession(this.cwd);
    this.sessionId = sessionId;
    return { sessionId, mode: "new" };
  }

  async prompt(text: string, options: RuntimePromptOptions = {}): Promise<RuntimePromptResult> {
    if (this.sessionId === undefined) {
      throw new Error("驱动尚未 openSession()");
    }
    const result = await this.client.prompt(this.sessionId, text, {
      onUpdate: (update) => {
        const chunk = textOfUpdate(update);
        if (chunk !== null) options.onChunk?.(chunk);
      },
      ...(options.onPermission ? { onPermission: options.onPermission } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (result.sessionId !== "") this.sessionId = result.sessionId;
    return { text: result.text, stopReason: result.stopReason, sessionId: result.sessionId };
  }

  cancel(): void {
    if (this.sessionId !== undefined) this.client.cancel(this.sessionId);
  }

  async close(graceMs?: number): Promise<void> {
    this.closed = true;
    await this.client.close(graceMs);
  }
}

/** 驱动工厂选项 */
export interface CreateRuntimeDriverOptions {
  cwd: string;
  requestTimeoutMs: number;
  promptTimeoutMs: number;
  env?: Record<string, string>;
  /** 额外启动参数（注册表条目里的 args；ACP 缺省 `["acp"]`） */
  extraArgs?: string[];
  onLog?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

/**
 * 按协议创建驱动。
 *
 * @param entry - 注册表条目（name / command / protocol）
 * @param options - 公共选项
 */
export function createRuntimeDriver(
  entry: { name: string; command: string; protocol?: RuntimeProtocol },
  options: CreateRuntimeDriverOptions,
): RuntimeDriver {
  const protocol = entry.protocol ?? "acp";
  if (protocol === "claude-stream-json") {
    // claude：`args` 是**基础参数**（默认 `-p --output-format stream-json --verbose`），
    // 注册表没配就让它用自己的默认值。
    const claudeOptions: ClaudeStreamJsonClientOptions = {
      command: entry.command,
      cwd: options.cwd,
      ...(options.extraArgs && options.extraArgs.length > 0 ? { args: options.extraArgs } : {}),
      ...(options.env ? { env: options.env } : {}),
      requestTimeoutMs: options.requestTimeoutMs,
      promptTimeoutMs: options.promptTimeoutMs,
      ...(options.onLog ? { onLog: options.onLog } : {}),
    };
    return new ClientRuntimeDriver(new ClaudeStreamJsonClient(claudeOptions), options.cwd);
  }
  const acpOptions: AcpClientOptions = {
    command: entry.command,
    args: options.extraArgs && options.extraArgs.length > 0 ? options.extraArgs : ["acp"],
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    requestTimeoutMs: options.requestTimeoutMs,
    promptTimeoutMs: options.promptTimeoutMs,
    ...(options.onLog ? { onLog: options.onLog } : {}),
  };
  return new ClientRuntimeDriver(new AcpClient(acpOptions), options.cwd);
}
