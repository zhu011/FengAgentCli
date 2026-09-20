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
 * | `session/resume` | client → agent | 按宿主持有的 `sessionId` 恢复会话（跨进程重建），返回 `{ sessionId }` |
 * | `session/load` | client → agent | 同 resume 的恢复语义（ACP `loadSession` 能力），返回 `{}` |
 * | `session/prompt` | client → agent | 跑一轮 Agent Loop，流式推 `session/update`，返回 `stopReason` |
 * | `session/cancel` | client → agent（notification） | 取消该会话在飞的 prompt，结算为 `cancelled` |
 * | `session/set_model` | client → agent | 容错扩展：把 `modelId` 应用到会话模型 |
 * | `session/request_permission` | agent → client | 工具审批（bash 等 ask 类工具）：宿主把请求透出到界面并回 `optionId`，缺省实现见 `mapPermissionResponse` |
 *
 * 为什么必须有 `session/resume`：Multica 桌面守护进程**每个任务 spawn 一个新的
 * `fengagent acp` 子进程**，进程结束即回收，第二轮对话不是「同一进程里的第二次
 * `session/prompt`」，而是**新进程 + 老的 sessionId**：
 * `initialize → session/resume{sessionId} → session/prompt`。若这里回
 * `-32601 Method not found`，宿主侧就是 `hermes session/resume failed: ... (code=-32601)`，
 * 表现为「首次对话正常、第二次对话必失败」。因此 resume 必须靠宿主持久化的会话
 * 数据把上下文重建出来，`resumeAgent` 选项即该重建入口（见 `acp-mode.ts` 的
 * `SessionStore` 实现）。
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
import type { PermissionResult } from "@fengagent/core/permission";
import type { Agent } from "@fengagent/agent";
import { toSingleLine } from "@fengagent/shared/utils";

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
  /**
   * 新会话工厂（`session/new`）。
   *
   * 宿主续聊靠 `session/resume` 找回上下文，因此 `session/new` 建出来的会话必须
   * 落到宿主下一轮能读到的地方（`acp-mode.ts` 用同一份 `SessionStore` 落盘）。
   * 未提供时回落到 `createAgent(workdir)` + `agent.createSession()`。
   */
  createSessionEntry?: (workdir: string) => { agent: Agent; session: Session };
  /**
   * 会话恢复工厂（`session/resume` / `session/load`）。
   *
   * 宿主（Multica 守护进程）在**新进程**里带上一轮的 `sessionId` 续聊，因此这里
   * 要按 id 把会话重建出来：命中持久化数据则恢复完整上下文，未命中则退化为
   * 「用同一个 id 建空会话」（仍要求后续 prompt 能正常跑完）。
   *
   * 未提供时回落到 `createAgent(workdir)` + `agent.createSession()`，并且
   * **保留宿主要的 sessionId** —— 会话注册表以宿主 id 为准，保证 resume 之后的
   * `session/prompt` 一定能命中同一个会话记录。
   */
  resumeAgent?: (workdir: string, sessionId: string) => { agent: Agent; session: Session };
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
  /**
   * 是否启用 ACP 权限桥（`session/request_permission` 请求 → 宿主决策）。
   *
   * 默认 `true`。宿主（Multica 守护进程）实现该 client 方法：它把审批请求
   * 转发到界面并在用户驱动会话里自动放行（守护进程日志
   * `auto-approved agent permission request method=session/request_permission`）。
   *
   * 关掉它（或宿主回 `-32601`）时 agent 拿不到 `requestPermission` 回调，此时
   * 需要宿主侧配合「预授权」策略，否则 ask 类工具（bash 等）会被判不可恢复
   * 并立即结算整轮对话。
   */
  permissionBridge?: boolean;
  /**
   * 单次权限请求等待宿主决策的上限（毫秒，默认 120000）。
   *
   * 超时按「宿主未表态」处理：放行并留痕（见 `mapPermissionResponse`），
   * 不能让宿主侧没有交互通道时把整轮对话吊死。
   */
  permissionTimeoutMs?: number;
}

/** 权限桥的拒绝选项 id（对标 ACP `PermissionOptionKind`；放行选项见 requestPermissionFromHost） */
const PERMISSION_REJECT_OPTION_IDS = ["reject-once", "reject_once", "reject-always"] as const;

/** 在飞的「出站请求 → 宿主响应」记录 */
interface PendingOutboundRequest {
  resolve(result: unknown): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * 把宿主对 `session/request_permission` 的响应翻译成我们的权限决策。
 *
 * 语义（宁放行不误杀）：
 * - `outcome: "cancelled"` → 拒绝（宿主明确取消，例如用户点了取消/停止）；
 * - 选项 id 命中拒绝集合 → 拒绝；
 * - 其余（命中放行集合 / 宿主回了没见过的 id / 响应缺字段）→ 放行并留痕。
 *   宿主已经替用户做过一次决策，我们不该因为对不齐 id 字面量就把工具调用判死
 *   （`dsh-acp` 用 `allow-once`，Multica 守护进程自己回 `approve_once`）。
 *
 * @param response - 宿主响应（JSON-RPC result）
 * @returns 权限决策
 */
export function mapPermissionResponse(response: unknown): PermissionResult {
  const outcome = (response as { outcome?: unknown } | null)?.outcome;
  if (!outcome || typeof outcome !== "object") {
    return { decision: "allow" };
  }
  const record = outcome as { outcome?: unknown; optionId?: unknown };
  if (record.outcome === "cancelled") {
    return { decision: "deny", reason: "host cancelled the permission request" };
  }
  const optionId = typeof record.optionId === "string" ? record.optionId : "";
  if (optionId.length === 0) {
    return { decision: "allow" };
  }
  if ((PERMISSION_REJECT_OPTION_IDS as readonly string[]).includes(optionId)) {
    return { decision: "deny", reason: `host chose ${optionId}` };
  }
  return { decision: "allow" };
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
    // 单行化：宿主按行采集子进程输出，多行详情（工具返回的 pretty JSON）会被
    // 按行切开，首行只剩 `[` 之类的碎片，宿主据此拼出的错误摘要完全不可定位
    // （AGE-29 的 `hermes provider error: [`）。
    toSingleLine(
      `Internal error${additionalMessage ? `: ${additionalMessage}` : ""}`,
    ),
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
  /**
   * 本轮 prompt 的权限回调：需要人工审批的工具（bash 等）走它征求宿主决策。
   *
   * 宿主（Multica 守护进程）在 `session/start` 时以 ACP 方法
   * `session/request_permission` 回来 —— 这正是 `dsh-acp` 的同款路径。
   */
  requestPermission?: (permission: {
    toolName: string;
    input: unknown;
    reason?: string;
  }) => Promise<PermissionResult>;
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
      // 单物理行：宿主按行采集 stderr，多行消息会被切碎成无意义碎片
      process.stderr.write(`[fengagent-acp] [${level}] ${toSingleLine(message)}\n`);
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

  // ------------------------------------------------------- 权限桥（出站请求）
  // ACP 里「工具审批」是 agent → client 的**请求**：agent 发
  // `session/request_permission`，宿主把审批透出到界面并回决策。这是本桥唯一
  // 的 agent→client 请求通道，也是最容易出错的一段：
  // 没有它，ask 类工具（bash）在守护进程路径下永远拿不到回调 → 被判不可恢复
  // → 整轮对话立即结算（AGE-29）。
  const permissionBridge = options.permissionBridge ?? true;
  const permissionTimeoutMs = options.permissionTimeoutMs ?? 120_000;
  const pendingPermissions = new Map<number, PendingOutboundRequest>();
  let nextOutboundRequestId = 0;

  /**
   * 向宿主发一个出站 JSON-RPC 请求并等它的响应。
   *
   * 与 `send()` 共用同一个写队列，因此不会与响应帧 / 通知帧交错。
   *
   * @param method - 方法名
   * @param params - 参数
   * @returns 宿主响应的 `result`
   */
  function sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const id = ++nextOutboundRequestId;
      const timer =
        permissionTimeoutMs > 0
          ? setTimeout(() => {
              if (pendingPermissions.delete(id)) {
                log("warn", `${method} 等待宿主决策超时（${permissionTimeoutMs}ms），按未表态处理`);
                rejectPromise(new Error(`${method} timed out after ${permissionTimeoutMs}ms`));
              }
            }, permissionTimeoutMs)
          : undefined;
      pendingPermissions.set(id, {
        resolve: (result) => {
          if (timer) clearTimeout(timer);
          resolvePromise(result);
        },
        timer,
      });
      void send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * 把工具审批推给宿主（ACP `session/request_permission`）。
   *
   * 选项 id 同时给「规范写法」（`allow-once` / `reject-once`，对标 dsh-acp）与
   * 守护进程实际会回的 `approve_once`，避免 id 字面量对不齐导致已批准的调用被
   * 判成拒绝。
   *
   * @param sessionId - 会话 id
   * @param permission - 权限请求（工具名 / 入参 / 原因）
   * @returns 宿主决策；宿主不可用或超时 → 放行并留痕（见 mapPermissionResponse）
   */
  async function requestPermissionFromHost(
    sessionId: string,
    permission: { toolName: string; input: unknown; reason?: string },
  ): Promise<PermissionResult> {
    const requestId = nextOutboundRequestId + 1;
    const toolCallId = `perm_${sessionId}_${requestId}`;
    try {
      const response = await sendRequest("session/request_permission", {
        sessionId,
        toolCall: { toolCallId, title: permission.toolName },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "approve_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      const decision = mapPermissionResponse(response);
      log(
        "info",
        `session/request_permission tool=${permission.toolName} decision=${decision.decision}`,
      );
      return decision;
    } catch (error) {
      // 宿主不支持该方法（-32601）/ 连接异常 / 超时：不把工具调用判死。
      // 这里的宿主是用户驱动的 Multica 会话，工作目录是该任务的独立 workdir，
      // 等价于「宿主预授权」（与 acp-mode 的 unattended 策略同一口径）。
      log(
        "warn",
        `session/request_permission 失败（按宿主未表态放行）: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { decision: "allow" };
    }
  }

  /**
   * 处理宿主对出站请求的响应帧。
   *
   * @param message - 已解析的协议帧
   * @returns 是否消费了该帧
   */
  function handleResponse(message: Record<string, unknown>): boolean {
    const id = message.id;
    if (typeof id !== "number") return false;
    const pending = pendingPermissions.get(id);
    if (!pending) return false;
    pendingPermissions.delete(id);
    if (message.error !== undefined && message.error !== null) {
      pending.resolve(undefined);
      return true;
    }
    pending.resolve(message.result);
    return true;
  }

  /** 连接关闭时结算所有在飞请求（调用方按「宿主未表态」兜底） */
  function failPendingPermissions(): void {
    for (const [id, pending] of pendingPermissions) {
      pendingPermissions.delete(id);
      pending.resolve(undefined);
    }
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

    const entry = options.createSessionEntry
      ? options.createSessionEntry(workdir)
      : (() => {
          const agent = options.createAgent(workdir);
          return { agent, session: agent.createSession() };
        })();
    const record: SessionRecord = { agent: entry.agent, session: entry.session };
    sessions.set(entry.session.id, record);
    log("info", `session/new sessionId=${entry.session.id} cwd=${workdir}`);
    return { sessionId: entry.session.id };
  }

  /** 解析宿主给的 cwd（与 `session/new` 同一套宽容规则） */
  function resolveWorkdir(params: Record<string, unknown>): string {
    const rawCwd = typeof params.cwd === "string" ? params.cwd : "";
    const workdir = rawCwd ? resolve(rawCwd) : process.cwd();
    if (rawCwd && !isAbsolute(rawCwd)) {
      log("warn", `session cwd 不是绝对路径（${rawCwd}），已解析为 ${workdir}`);
    }
    return workdir;
  }

  /**
   * 注册（或返回已注册的）会话记录。
   *
   * `session/resume` 的 `sessionId` 必须成为本进程内的会话键：宿主后续的
   * `session/prompt` 只会带那个 id，若这里换成新建会话的自生成 id，prompt 就会
   * 落到 `unknown session` 上 —— 那只是把 `-32601` 换成了 `-32602`。
   */
  function registerSession(sessionId: string, workdir: string): SessionRecord {
    const existing = sessions.get(sessionId);
    if (existing) return existing;

    let agent: Agent;
    let session: Session;
    if (options.resumeAgent) {
      ({ agent, session } = options.resumeAgent(workdir, sessionId));
    } else {
      agent = options.createAgent(workdir);
      session = agent.createSession();
    }
    // 宿主 id 优先：resume 语义就是「延续这个 id」，不是「换一个新 id」。
    session.id = sessionId;
    const record: SessionRecord = { agent, session };
    sessions.set(sessionId, record);
    return record;
  }

  /**
   * 恢复会话（`session/resume` / `session/load` 共用）。
   *
   * 返回形状对标 ACP `ResumeSessionResponse`（`models` / `modes` / `configOptions`
   * 全部可选，本桥只声明 baseline，因此不回这三项）。
   *
   * @param params - 宿主请求参数（`sessionId` 必填）
   * @returns 会话记录
   */
  function resumeSession(params: Record<string, unknown>): SessionRecord {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw invalidParams("sessionId must be a non-empty string");
    }
    const workdir = resolveWorkdir(params);
    const record = registerSession(sessionId, workdir);
    log(
      "info",
      `session/resume sessionId=${record.session.id} cwd=${workdir} messages=${record.session.messages.length}`,
    );
    return record;
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
        ...(permissionBridge
          ? {
              requestPermission: (permission: {
                toolName: string;
                input: unknown;
                reason?: string;
              }) => requestPermissionFromHost(record.session.id, permission),
            }
          : {}),
      };
      record.inflight = inflight;

      void (async () => {
        try {
          for await (const event of record.agent.prompt(text, record.session, {
            ...(inflight.requestPermission
              ? { requestPermission: inflight.requestPermission }
              : {}),
          })) {
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
        // `sessionCapabilities.resume` 属于 spec 内的会话续聊能力（对标
        // @deepseek-ai/dsh-acp / opencode）：守护进程续聊走 `session/resume`，
        // 声明它让宿主知道「带 sessionId 回来是安全的」。
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentInfo: { name: agentInfo.name, version: agentInfo.version },
          agentCapabilities: {
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            sessionCapabilities: { resume: {} },
          },
          authMethods: [],
        };

      case "authenticate":
        // 未声明任何 auth method，因此是 no-op。
        return {};

      case "session/new":
        return createSession(args);

      case "session/resume": {
        const record = resumeSession(args);
        return { sessionId: record.session.id };
      }

      case "session/load": {
        // ACP `load_session`：恢复语义与 resume 相同（差异只在 spec 要求
        // `session/load` 回放历史；本桥的续聊入口是 resume，这里保底成功，
        // 避免宿主换用 load 时再撞一次 -32601）。
        resumeSession(args);
        return {};
      }

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
      // agent → client 的出站请求（权限桥）的响应走这里；除此之外本桥不主动发请求，
      // 收到未知响应说明对端行为异常 —— 记录即可。
      if (handleResponse(message)) return;
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
    // 先结算在飞的权限请求（宿主按「未表态」兜底），再拒绝新会话/新 prompt，
    // 最后等待写队列排空。
    failPendingPermissions();
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
 * 为什么 `console.error` 也必须包：error 级日志（shared logger 的 error 走
 * `console.error`，如 agent loop 的工具失败记录）虽天然落在 stderr、不污染协议，
 * 但**不带 `[fengagent-acp] ` 前缀**。宿主按行采集 stderr 并做错误启发式，
 * 无前缀行无法归属到本进程/本级别，实测被误分类为致命错误——22:33 那次
 * `agent_error="hermes provider error: [...]"` 与可真机复现的
 * `[ERROR] [agent-loop] [run] tool result: error, content=Error: [` 行逐字同源。
 * 统一前缀后，error 级行与其它级别一样可归属、可过滤。
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
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  const toStderr = (...args: unknown[]): void => {
    // 逐行加前缀：宿主按行采集 stderr，多行输出（pretty JSON 错误对象）被切开后
    // 每一行仍能归属到本进程、且首行不再是一个孤立的 `[` 碎片。
    const text = format(...args);
    const lines = text.split(/\r\n|\r|\n/);
    for (const line of lines) {
      process.stderr.write(`[fengagent-acp] ${line}\n`);
    }
  };

  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  console.error = toStderr;

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
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
  };
}
