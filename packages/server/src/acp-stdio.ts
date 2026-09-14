/**
 * @fengagent/server — ACP (Agent Client Protocol) stdio JSON-RPC 适配层
 *
 * Multica 桌面守护进程把「本地运行时」当作 `protocol_family=hermes` 的子进程拉起：
 * 它 spawn `<command> acp`，用 **stdin/stdout 管道**跑 ACP JSON-RPC（换行分隔 JSON，
 * NDJSON），stdout 是协议专用通道，任何非协议字节都会破坏握手。
 *
 * 本模块实现守护进程实际调用的最小闭环：
 *
 * | 方法 | 方向 | 行为 |
 * | --- | --- | --- |
 * | `initialize` | client → agent | 协商协议版本，只声明 baseline prompt 能力 |
 * | `authenticate` | client → agent | 空实现（不声明任何 auth method） |
 * | `session/new` | client → agent | 用 `cwd` 建新 Agent + 会话，返回 `sessionId` |
 * | `session/prompt` | client → agent | 跑一轮 Agent Loop，流式推 `session/update`，返回 `stopReason` |
 * | `session/cancel` | client → agent（notification） | 取消该会话在飞的 prompt，结算为 `cancelled` |
 * | `session/set_model` | client → agent | 容错扩展：把 `modelId` 应用到会话模型 |
 *
 * 消息格式严格对标同族 `@deepseek-ai/dsh-acp`（`dsh-acp.exe`）：NDJSON 分帧、
 * JSON-RPC 2.0 的 id/error 语义、`session/update` 通知的字段名与嵌套形状、
 * 以及 prompt 级 stop reason 的取值。
 *
 * 与 `acp-server.ts`（HTTP + SSE，供 WebUI / 人工调试）并存，两者共用 ACP 语义，
 * 但传输层完全不同：守护进程只认 stdio。
 */

import { StringDecoder } from "node:string_decoder";
import { isAbsolute, resolve } from "node:path";
import { format } from "node:util";
import type { AgentEvent, Config, FinishReason, Session } from "@fengagent/core";
import type { Agent } from "@fengagent/agent";

/**
 * 模块加载时捕获的原始 stdout 写函数。
 *
 * `redirectConsoleToStderr()` 会把 `process.stdout.write` 改道到 stderr（协议通道
 * 必须零污染）。协议帧不能走被改道后的函数，因此在**任何改道发生之前**把原始
 * writer 抓住（模块顶层求值早于 `main()`）。
 */
const RAW_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

/**
 * 协议帧输出端（最小接口，便于测试注入）。
 *
 * 契约：`write` **必须**在帧落到目标后回调 `callback` —— 写队列靠它保证
 * 「先通知、后响应」的顺序，并在进程退出前排空 stdout。
 * 真实的 `process.stdout.write` 天然满足该契约。
 */
export interface AcpFrameWriter {
  write(chunk: string, callback?: (error?: Error | null) => void): unknown;
}

/**
 * 协议帧输入端（最小接口）。
 *
 * 只用到 `on`，因此不要求完整的 Readable 实现 —— 测试可以直接喂一个
 * EventEmitter。监听器签名用 `any[]`：Bun 与 Node 的 `Readable.on` 重载签名
 * 互不兼容（联合类型不可调用），结构化最小接口反而更稳。
 */
export interface AcpFrameReader {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** 默认协议帧输出端：绕过 console 改道的原始 stdout */
function rawStdoutWriter(): AcpFrameWriter {
  return {
    write: (chunk, callback) => {
      RAW_STDOUT_WRITE(chunk, callback as never);
      return true;
    },
  };
}

/**
 * ACP 协议版本。
 *
 * 必须与 `@agentclientprotocol/sdk` 的 `PROTOCOL_VERSION` 一致；守护进程在
 * `initialize` 响应里读该字段，不匹配时报 `protocol version not supported`。
 */
export const ACP_PROTOCOL_VERSION = 1;

/** ACP prompt 级终止原因（对标 ACP `StopReason`） */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

/** ACP `session/update` 通知里的 update 负载 */
export type AcpSessionUpdate = Record<string, unknown> & {
  sessionUpdate: string;
};

/** 日志回调（默认写 stderr —— stdout 被协议独占） */
export type AcpLogFn = (level: "debug" | "info" | "warn" | "error", message: string) => void;

/** ACP stdio 服务构造选项 */
export interface AcpStdioOptions {
  /**
   * Agent 工厂。`session/new` 会带上宿主给的绝对 `cwd`，
   * 每个 ACP 会话一份独立 Agent（与 HTTP ACP 的 per-session Agent 语义一致）。
   */
  createAgent: (workdir: string) => Agent;
  /** 运行时配置（仅用于 `usage_update` 的上下文窗口大小，可选） */
  config?: Pick<Config, "contextWindow">;
  /** `initialize` 响应里回给宿主的 agentInfo */
  agentInfo?: { name: string; version: string };
  /** 日志回调，默认写 stderr */
  log?: AcpLogFn;
  /** 输入流，默认 `process.stdin`（测试可注入） */
  input?: AcpFrameReader;
  /**
   * 协议帧输出端，默认**原始** stdout。
   *
   * 注意：默认值绕过 `redirectConsoleToStderr()` 对 `process.stdout.write` 的改道，
   * 因此日志改道不会吞掉协议帧。只有显式传入才使用自定义输出端。
   */
  output?: AcpFrameWriter;
  /**
   * stdin EOF 后是否直接退出进程。
   *
   * 默认「输入流就是 process.stdin 时退出」：守护进程靠进程退出回收运行时，
   * 句柄不释放会把会话吊死；测试注入自定义流时默认不退出。
   */
  exitOnClose?: boolean;
}

/** 连接句柄 */
export interface AcpStdioConnection {
  /** stdin EOF 或 dispose 之后 resolve */
  closed: Promise<void>;
  /** 主动关闭（不退出进程） */
  dispose(): void;
  /** 当前已建立会话数（诊断/测试用） */
  sessionCount(): number;
}

/** JSON-RPC 错误对象 */
interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 请求错误（会被翻译成 error 响应） */
class AcpRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRequestError";
  }
}

/** `-32601` 方法不存在（措辞对标 SDK 的 `RequestError.methodNotFound`） */
function methodNotFound(method: string): AcpRequestError {
  return new AcpRequestError(-32601, `"Method not found": ${method}`, { method });
}

/** `-32602` 参数非法（措辞对标 SDK 的 `RequestError.invalidParams`） */
function invalidParams(additionalMessage?: string): AcpRequestError {
  return new AcpRequestError(
    -32602,
    `Invalid params${additionalMessage ? `: ${additionalMessage}` : ""}`,
    undefined,
  );
}

/** `-32603` 内部错误（措辞对标 SDK 的 `RequestError.internalError`） */
function internalError(additionalMessage?: string): AcpRequestError {
  return new AcpRequestError(
    -32603,
    `Internal error${additionalMessage ? `: ${additionalMessage}` : ""}`,
    undefined,
  );
}

/** 会话记录 */
interface SessionRecord {
  agent: Agent;
  session: Session;
  inflight?: InflightPrompt;
}

/** 在飞的 prompt */
interface InflightPrompt {
  cancelled: boolean;
  settled: boolean;
  /** 已观察到的 `error` 事件（决定 prompt 拒绝还是正常结算） */
  failure?: string;
  /** `turn-end` 给出的终止原因 */
  endReason?: FinishReason;
  resolve(reason: AcpStopReason): void;
  reject(error: unknown): void;
}

/**
 * 把 ACP prompt 的 baseline 内容块拍平成文本。
 *
 * 与 `@deepseek-ai/dsh-acp` 的 `acpPromptToText` 行为一致：text 块原样拼接，
 * resource_link 渲染成方括号文本引用（baseline 客户端用它指文件，不能静默丢弃）。
 *
 * @param prompt - ACP prompt 内容块
 * @returns 拼接后的文本
 */
export function acpPromptToText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .flatMap((raw): string[] => {
      const block = raw as { type?: unknown; text?: unknown; name?: unknown; uri?: unknown };
      switch (block?.type) {
        case "text":
          return typeof block.text === "string" ? [block.text] : [];
        case "resource_link":
          return [
            `\n[resource_link name=${JSON.stringify(block.name ?? "")} uri=${JSON.stringify(block.uri ?? "")}]\n`,
          ];
        default:
          return [];
      }
    })
    .join("");
}

/**
 * 判断 prompt 是否携带超出 ACP baseline 的内容。
 *
 * baseline 只有 `text` / `resource_link`；image/audio/embedded resource 属于可选能力，
 * 本桥不声明，因此显式拒绝而不是静默丢弃。
 *
 * @param prompt - ACP prompt 内容块
 * @returns 是否含不支持的内容
 */
export function promptHasUnsupportedContent(prompt: unknown): boolean {
  if (!Array.isArray(prompt)) return false;
  return prompt.some((raw) => {
    const type = (raw as { type?: unknown })?.type;
    return type !== "text" && type !== "resource_link";
  });
}

/**
 * 把工具名映射为 ACP `ToolKind`（仅用于客户端图标/分组）。
 *
 * @param name - 工具名
 * @returns ACP ToolKind
 */
function toolKind(name: string): string {
  const lower = name.toLowerCase();
  if (/(bash|shell|exec|terminal|command|run)/.test(lower)) return "execute";
  if (/(read|view|cat|open)/.test(lower)) return "read";
  if (/(write|edit|patch|apply)/.test(lower)) return "edit";
  if (/(glob|grep|search|find)/.test(lower)) return "search";
  if (/(fetch|http|web)/.test(lower)) return "fetch";
  if (/(think|plan)/.test(lower)) return "think";
  return "other";
}

/**
 * 把工具结果内容裁剪为可上线的文本（协议通道不搬运超大输出）。
 *
 * @param content - 工具结果内容
 * @returns 文本
 */
function toolResultText(content: unknown): string {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  const limit = 4000;
  return text.length > limit ? `${text.slice(0, limit)}\n…(truncated)` : text;
}

/**
 * 把 harness 的 turn 结束原因映射为 ACP prompt 级 stop reason。
 *
 * 与 `@deepseek-ai/dsh-acp` 的 `turnEndToStopReason` 对齐：token 截断不上升为
 * prompt 级 stop reason（统一 `end_turn`），真正的失败走 `error` 事件 → JSON-RPC error。
 *
 * @param reason - harness turn 结束原因
 * @returns ACP stop reason
 */
export function turnEndToStopReason(reason: FinishReason | undefined): AcpStopReason {
  switch (reason) {
    case "max_tokens":
      return "end_turn";
    default:
      return "end_turn";
  }
}

/**
 * 启动 ACP stdio 服务（守护进程面向的唯一传输）。
 *
 * @param options - 服务选项
 * @returns 连接句柄
 */
export function startAcpStdioServer(options: AcpStdioOptions): AcpStdioConnection {
  const input = options.input ?? process.stdin;
  const output = options.output ?? rawStdoutWriter();
  const shouldExit = options.exitOnClose ?? (input === process.stdin);
  const agentInfo = options.agentInfo ?? { name: "fengagent-acp", version: "0.0.0" };
  const contextWindow = options.config?.contextWindow ?? 0;
  const log: AcpLogFn =
    options.log ??
    ((level, message) => {
      process.stderr.write(`[fengagent-acp] [${level}] ${message}\n`);
    });

  const sessions = new Map<string, SessionRecord>();
  let closed = false;
  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });

  // ---------------------------------------------------------------- 输出通道
  // 串行写队列：保证同一时刻只有一个 JSON 帧在写，帧之间不会交错。
  let writeQueue: Promise<void> = Promise.resolve();

  function send(message: Record<string, unknown>): Promise<void> {
    const frame = `${JSON.stringify(message)}\n`;
    writeQueue = writeQueue
      .then(
        () =>
          new Promise<void>((resolvePromise) => {
            try {
              output.write(frame, () => resolvePromise());
            } catch (error) {
              log("warn", `写入协议帧失败: ${String(error)}`);
              resolvePromise();
            }
          }),
      )
      .catch((error) => {
        log("warn", `写入协议帧失败: ${String(error)}`);
      });
    return writeQueue;
  }

  /** 发送 `session/update` 通知（失败只记日志，不影响 Agent 轮次） */
  function notify(sessionId: string, update: AcpSessionUpdate): void {
    if (closed) return;
    void send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  // ---------------------------------------------------------------- 会话管理
  function requireSession(sessionId: unknown): SessionRecord {
    if (typeof sessionId !== "string") {
      throw invalidParams("sessionId must be a string");
    }
    const record = sessions.get(sessionId);
    if (!record) {
      throw invalidParams(`unknown session: ${sessionId}`);
    }
    return record;
  }

  function createSession(params: Record<string, unknown>): { sessionId: string } {
    const rawCwd = typeof params.cwd === "string" ? params.cwd : "";
    // 宽容处理：dsh-acp 要求绝对路径，但守护进程若给了相对路径，与其失败不如
    // 相对本进程解析后继续（能握手、能对话优先级更高），并留痕到 stderr。
    const workdir = rawCwd ? resolve(rawCwd) : process.cwd();
    if (rawCwd && !isAbsolute(rawCwd)) {
      log("warn", `session/new 的 cwd 不是绝对路径（${rawCwd}），已解析为 ${workdir}`);
    }

    const mcpServers = params.mcpServers;
    if (Array.isArray(mcpServers) && mcpServers.length > 0) {
      // dsh-acp 对非空 mcpServers 直接拒绝；这里改为接受但忽略并留痕，
      // 因为拒绝会让整个会话建立失败，而「握手成功 + 纯内置工具」明显更好。
      log(
        "warn",
        `session/new 携带 ${mcpServers.length} 个 mcpServers，当前 ACP 桥未接入 MCP，已忽略`,
      );
    }

    const agent = options.createAgent(workdir);
    const session = agent.createSession();
    const record: SessionRecord = { agent, session };
    sessions.set(session.id, record);
    log("info", `session/new sessionId=${session.id} cwd=${workdir}`);
    return { sessionId: session.id };
  }

  /** 结算在飞的 prompt（幂等） */
  function settlePrompt(record: SessionRecord, reason: AcpStopReason): void {
    const inflight = record.inflight;
    if (!inflight || inflight.settled) return;
    inflight.settled = true;
    record.inflight = undefined;
    inflight.resolve(reason);
  }

  /** 把 AgentEvent 翻译成 ACP 更新 / 结算信号 */
  function handleAgentEvent(record: SessionRecord, event: AgentEvent, inflight: InflightPrompt): void {
    const sessionId = record.session.id;
    switch (event.type) {
      case "text-delta":
        if (event.text.length > 0) {
          notify(sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: event.text },
          });
        }
        break;

      case "thinking-delta":
        if (event.text.length > 0) {
          notify(sessionId, {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: event.text },
          });
        }
        break;

      case "tool-call-start":
        notify(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: event.toolUseId,
          title: event.name,
          kind: toolKind(event.name),
          status: "in_progress",
          rawInput: event.input,
        });
        break;

      case "tool-call-result":
        notify(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolUseId,
          status: event.result.isError ? "failed" : "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: toolResultText(event.result.content) },
            },
          ],
          rawOutput: toolResultText(event.result.content),
        });
        break;

      case "usage":
        if (contextWindow > 0) {
          notify(sessionId, {
            sessionUpdate: "usage_update",
            used: event.inputTokens + event.outputTokens,
            size: contextWindow,
          });
        }
        break;

      case "turn-end":
        inflight.endReason = event.reason;
        break;

      case "error":
        inflight.failure = event.error.message;
        break;

      default:
        // session-start / message-start / message-end / compaction-* /
        // session-end 属于本桥不对外暴露的内部事件（对标 dsh-acp：
        // 只有 committed 的助手文本与工具活动上线）。
        break;
    }
  }

  /** 跑一轮 prompt，返回 ACP stop reason */
  function runPrompt(record: SessionRecord, text: string): Promise<AcpStopReason> {
    return new Promise<AcpStopReason>((resolvePromise, rejectPromise) => {
      const inflight: InflightPrompt = {
        cancelled: false,
        settled: false,
        resolve: resolvePromise,
        reject: rejectPromise,
      };
      record.inflight = inflight;

      void (async () => {
        try {
          for await (const event of record.agent.prompt(text, record.session)) {
            if (inflight.cancelled) break;
            handleAgentEvent(record, event, inflight);
          }
        } catch (error) {
          if (inflight.failure === undefined) {
            inflight.failure = error instanceof Error ? error.message : String(error);
          }
        } finally {
          if (inflight.settled) return;
          inflight.settled = true;
          if (record.inflight === inflight) record.inflight = undefined;
          if (inflight.failure !== undefined) {
            rejectPromise(internalError(`turn failed: ${inflight.failure}`));
          } else {
            resolvePromise(turnEndToStopReason(inflight.endReason));
          }
        }
      })();
    });
  }

  /** 取消在飞的 prompt（`session/cancel` 通知） */
  function cancelSession(params: Record<string, unknown>): void {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string") return;
    const record = sessions.get(sessionId);
    if (!record) return; // 未知会话是 no-op（对标 dsh-acp）
    const inflight = record.inflight;
    if (inflight) {
      inflight.cancelled = true;
      settlePrompt(record, "cancelled");
      log("info", `session/cancel sessionId=${sessionId}`);
      return;
    }
    log("debug", `session/cancel sessionId=${sessionId}（无在飞 prompt）`);
  }

  /** 容错扩展：把宿主选的模型应用到会话 */
  function setSessionModel(params: Record<string, unknown>): Record<string, unknown> {
    const record = requireSession(params.sessionId);
    const modelId = params.modelId ?? params.model;
    if (typeof modelId === "string" && modelId.length > 0) {
      record.session.model = modelId;
      log("info", `session/set_model sessionId=${record.session.id} model=${modelId}`);
    }
    return {};
  }

  // ---------------------------------------------------------------- 请求分发
  async function handleRequest(method: string, params: unknown): Promise<unknown> {
    const args = (params ?? {}) as Record<string, unknown>;
    log("debug", `← ${method}`);
    switch (method) {
      case "initialize":
        // 只声明 baseline 能力 —— 不声明 image / audio / embeddedContext，
        // 也不声明 session / editor / terminal / filesystem / MCP 能力。
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentInfo: { name: agentInfo.name, version: agentInfo.version },
          agentCapabilities: {
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          authMethods: [],
        };

      case "authenticate":
        // 未声明任何 auth method，因此是 no-op。
        return {};

      case "session/new":
        return createSession(args);

      case "session/prompt": {
        const record = requireSession(args.sessionId);
        if (record.inflight) {
          throw invalidParams("a prompt is already in flight for this session");
        }
        if (promptHasUnsupportedContent(args.prompt)) {
          throw invalidParams("only text and resource_link prompt content is supported");
        }
        const text = acpPromptToText(args.prompt);
        if (text.trim().length === 0) {
          throw invalidParams("empty prompt");
        }
        return { stopReason: await runPrompt(record, text) };
      }

      case "session/set_model":
        return setSessionModel(args);

      default:
        throw methodNotFound(method);
    }
  }

  function handleNotification(method: string, params: unknown): void {
    const args = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "session/cancel":
        cancelSession(args);
        break;
      case "notifications/cancelled":
      case "notifications/initialized":
        break;
      default:
        log("debug", `忽略未处理的通知: ${method}`);
        break;
    }
  }

  /** 处理一行 NDJSON */
  function handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log("warn", `无法解析的协议帧（已忽略）: ${line.slice(0, 200)}`);
      return;
    }

    const method = message.method;
    const id = message.id;

    if (typeof method === "string" && id !== undefined && id !== null) {
      void (async () => {
        try {
          const result = await handleRequest(method, message.params);
          await send({ jsonrpc: "2.0", id, result: result ?? null });
        } catch (error) {
          const body: JsonRpcErrorBody =
            error instanceof AcpRequestError
              ? { code: error.code, message: error.message, data: error.data }
              : { code: -32603, message: `Internal error: ${String(error)}` };
          log("warn", `${method} 失败: ${body.message}`);
          await send({ jsonrpc: "2.0", id, error: body });
        }
      })();
      return;
    }

    if (typeof method === "string") {
      handleNotification(method, message.params);
      return;
    }

    if (id !== undefined) {
      // 本桥不向客户端发请求，收到响应说明对端行为异常 —— 记录即可。
      log("debug", `收到未知响应 id=${String(id)}`);
      return;
    }

    log("warn", "收到既无 method 也无 id 的协议帧（已忽略）");
  }

  // ---------------------------------------------------------------- 输入通道
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  function onData(chunk: Buffer | string): void {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) handleLine(trimmed);
    }
  }

  function onEnd(): void {
    const tail = buffer + decoder.end();
    buffer = "";
    const trimmed = tail.trim();
    if (trimmed) handleLine(trimmed);
    close();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    // 先拒绝新会话/新 prompt，再结算在飞 prompt，最后等待写队列排空。
    for (const record of sessions.values()) {
      const inflight = record.inflight;
      if (inflight) {
        inflight.cancelled = true;
        settlePrompt(record, "cancelled");
      }
    }
    sessions.clear();
    void writeQueue.finally(() => {
      resolveClosed();
      if (shouldExit) {
        // 守护进程靠进程退出回收运行时；stdin 关闭即视为会话结束。
        process.exit(0);
      }
    });
  }

  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onEnd);
  input.on("error", (error: unknown) => {
    log("warn", `stdin 读取失败: ${String(error)}`);
    close();
  });

  log("info", `ACP stdio 服务已就绪（protocolVersion=${ACP_PROTOCOL_VERSION}）`);

  return {
    closed: closedPromise,
    dispose: close,
    sessionCount: () => sessions.size,
  };
}

/**
 * 把 console / process.stdout 的非协议输出全部改道到 stderr。
 *
 * 为什么必须做：`@fengagent/shared` 的 logger 用 `console.log` 输出 info 级日志，
 * 而 `console.log` 走 stdout —— 在 stdio ACP 模式下第一个字节就会污染协议帧，
 * 宿主的 JSON 解析失败后只会报「进程退出」，完全无法定位。
 *
 * 返回的 `restore` 用于测试后还原。
 *
 * @returns 还原函数
 */
export function redirectConsoleToStderr(): () => void {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;
  const originalWarn = console.warn;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${format(...args)}\n`);
  };

  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;

  // 兜底：任何绕过 console 的 process.stdout.write 也改道 stderr。
  // 协议帧由 startAcpStdioServer 通过 rawStdoutWriter()（模块加载时捕获的原始
  // writer）写出，不受本改道影响。
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error) => void),
    callback?: (err?: Error) => void,
  ) => {
    const cb = typeof encoding === "function" ? encoding : callback;
    return process.stderr.write(chunk as never, cb as never) as unknown as boolean;
  }) as typeof process.stdout.write;

  return () => {
    console.log = originalLog;
    console.info = originalInfo;
    console.debug = originalDebug;
    console.warn = originalWarn;
    process.stdout.write = originalStdoutWrite;
  };
}
