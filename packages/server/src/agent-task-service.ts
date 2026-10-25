/**
 * @fengagent/server — 外派任务服务（P1 dispatch + P2 任务面）
 *
 * 把三块拼起来：
 *
 * ```
 * 注册表（能派给谁） ──┐
 *                      ├──▶ 外派任务仓（7 态 + 事件流）──▶ /api/agent-tasks（列表/详情/SSE）
 * ACP 客户端（怎么派） ─┘            ▲
 *                                    └── 副作用台账（operation_ledger，防重复执行）
 * ```
 *
 * 一次派发的完整生命周期（每一步都落事件，SSE 同步推）：
 *
 * ```
 * created ──dispatch──▶ dispatched ──initialize+session/new──▶ (accepted 事件)
 *   └──首块输出──▶ running ──prompt 结束──▶ replied
 *                            └──错误/超时/权限拒绝──▶ failed
 *                            └──用户取消──▶ cancelled
 * ```
 *
 * 两条硬约束：
 *
 * 1. **不重复执行**：每次 dispatch 是一个 `agent-task:<id>:attempt-<n>` 的副作用操作，
 *    进 AGE-29 的 `operation_ledger`。台账里已有 succeeded → 直接回放结果；
 *    仍是 pending/unknown（上轮崩在半路）→ 拒绝重跑并要求人工核对，绝不静默重放。
 * 2. **权限请求不静默挂起**：headless 派发没有人在场审批，策略默认 `deny`，
 *    但决策一定写进事件流（`task/stream-chunk` + `[permission]` 前缀 —— 冻结的
 *    事件枚举里没有独立类型，这里复用 detail 承载，UI 时间线可见）。
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { AcpClient, AgentTaskStore, isTerminalTaskStatus } from "@fengagent/agent";
import type {
  AgentTaskEventRow,
  AgentTaskRecord,
  AgentTaskStatus,
  AcpHandshake,
  AcpPermissionRequest,
  AcpSessionUpdate,
} from "@fengagent/agent";
import type { OperationLedger } from "@fengagent/core";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { digestResult } from "@fengagent/core";
import { createLogger, generateId } from "@fengagent/shared";
import { AgentRuntimeRegistry } from "./agent-runtimes.ts";
import type { RuntimeInfo } from "./agent-runtimes.ts";

const log = createLogger("agent-tasks");

/**
 * 中立工作目录（**仓库外**）：`~/.fengagent/dispatch-workspace/<数据根指纹>`。
 *
 * 派发出去的目标 agent 会在 cwd 里读 `AGENTS.md` / `CLAUDE.md` / `.git` 来推断
 * 「我是谁、我在哪个项目」，若默认 cwd 落在本仓库里，它就会自报成别的 agent、
 * 甚至把这次外派当成在自己项目里干活（F 段 P0：身份/环境污染）。
 */
function neutralDispatchCwd(dataRoot: string): string {
  const fingerprint = createHash("sha256").update(dataRoot).digest("hex").slice(0, 8);
  return join(homedir(), ".fengagent", "dispatch-workspace", fingerprint);
}

/** 与 WebUI `AgentTask` 契约一致的任务 DTO（时间戳为 ISO 字符串） */
export interface AgentTaskDto {
  id: string;
  fromSession: string;
  runtime: string;
  status: AgentTaskStatus;
  content: string;
  result?: string;
  error?: string;
  createdAt: string;
  dispatchedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  acpSessionId?: string;
}

/** 与 WebUI `AgentTaskEvent` 契约一致的事件 DTO */
export interface AgentTaskEventDto {
  seq: number;
  at: string;
  type: AgentTaskEventRow["type"];
  detail?: string;
}

/** SSE 推送帧（与 WebUI `AgentTaskStreamEvent` 契约一致） */
export type AgentTaskStreamEvent =
  | { type: "status"; task: AgentTaskDto }
  | { type: "chunk"; text: string }
  | { type: "event"; event: AgentTaskEventDto };

/** 建任务请求（与 WebUI `AgentTaskCreateRequest` 契约一致） */
export interface CreateAgentTaskRequest {
  runtime: string;
  content: string;
  /** 界面发起的任务不传；会话内派发传会话 id */
  fromSession?: string;
  /** 覆盖目标工作目录（默认服务数据根下的 `dispatch-workspace`） */
  cwd?: string;
  idempotencyKey?: string;
}

/** 外派任务服务选项 */
export interface AgentTaskServiceOptions {
  /** 数据根（任务库 / runtimes.json / 默认工作目录都在它下面） */
  dataRoot: string;
  /** 任务仓（默认 `<dataRoot>/agent-tasks.db`） */
  store?: AgentTaskStore;
  /** 运行时注册表（默认 `<dataRoot>/runtimes.json`） */
  registry?: AgentRuntimeRegistry;
  /** 副作用台账（传 `taskStore.ledger` 即复用 AGE-29 的防重复执行） */
  ledger?: OperationLedger;
  /** 未指定 cwd 时的默认工作目录（默认 `<dataRoot>/dispatch-workspace`） */
  defaultCwd?: string;
  /** 握手/建会话超时（默认 120000） */
  requestTimeoutMs?: number;
  /** 单次 prompt 超时（默认 600000） */
  promptTimeoutMs?: number;
  /** 权限策略（默认 deny；决策都会落事件） */
  permissionPolicy?: (ctx: {
    taskId: string;
    runtime: string;
    request: AcpPermissionRequest;
  }) => "allow" | "deny";
  /** 启动时后台探测一次全部 runtime（默认 true；测试建议关掉） */
  autoProbe?: boolean;
  /** 启动时把上一进程遗留的非终态任务收尾（默认 true） */
  recoverOnStart?: boolean;
  now?: () => number;
}

/** 单次任务的在飞句柄 */
interface ActiveRun {
  client: AcpClient;
  sessionId?: string;
  /** 用户是否已取消（用关闭客户端打断 prompt） */
  cancelled: boolean;
}

/**
 * 外派任务服务。
 *
 * 用法：
 * ```ts
 * const service = new AgentTaskService({ dataRoot, ledger: taskStore.ledger });
 * const task = await service.submit({ runtime: "kimi", content: "你好" });
 * const done = await service.waitForTerminal(task.id, 60_000);
 * ```
 */
export class AgentTaskService {
  readonly store: AgentTaskStore;
  readonly registry: AgentRuntimeRegistry;
  private readonly ledger: OperationLedger | undefined;
  private readonly defaultCwd: string;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly permissionPolicy: NonNullable<AgentTaskServiceOptions["permissionPolicy"]>;
  private readonly now: () => number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly subscribers = new Map<string, Set<(event: AgentTaskStreamEvent) => void>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  /** 在飞的派发（close() 要等它们收尾） */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(options: AgentTaskServiceOptions) {
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 600_000;
    this.defaultCwd = options.defaultCwd ?? neutralDispatchCwd(options.dataRoot);
    this.ledger = options.ledger;
    this.permissionPolicy = options.permissionPolicy ?? (() => "deny");
    mkdirSync(this.defaultCwd, { recursive: true });

    this.store =
      options.store ?? new AgentTaskStore(join(options.dataRoot, "agent-tasks.db"));
    this.registry =
      options.registry ?? new AgentRuntimeRegistry({ dataRoot: options.dataRoot });

    if (options.recoverOnStart ?? true) this.recoverInterrupted();
    if (options.autoProbe ?? true) {
      // 后台探测一次，让 Agents 页首屏就有探测结果；失败不影响服务可用性。
      void this.registry.probeAll(this.taskCounts()).catch((err: unknown) => {
        log.warn("probe", `启动探测失败: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  // ──────────────────────────────────────────────
  // 读
  // ──────────────────────────────────────────────

  /** runtime 卡片（含近 24h 任务数） */
  listRuntimes(): RuntimeInfo[] {
    return this.registry.list(this.taskCounts());
  }

  /** 显式探测全部 runtime */
  async probeRuntimes(): Promise<RuntimeInfo[]> {
    return this.registry.probeAll(this.taskCounts());
  }

  /** 取任务 */
  getTask(id: string): AgentTaskDto | null {
    const record = this.store.get(id);
    return record ? toTaskDto(record) : null;
  }

  /** 列表（首页 + cursor） */
  listTasks(
    filter: {
      status?: AgentTaskStatus | AgentTaskStatus[];
      runtime?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): { tasks: AgentTaskDto[]; nextCursor?: string } {
    const limit = filter.limit ?? 50;
    const rows = this.store.list({ ...filter, limit });
    const tasks = rows.map(toTaskDto);
    const last = rows[rows.length - 1];
    if (rows.length < limit || !last) return { tasks };
    return { tasks, nextCursor: last.id };
  }

  /** 事件日志 */
  listEvents(id: string, afterSeq = 0): AgentTaskEventDto[] {
    return this.store.events(id, afterSeq).map(toEventDto);
  }

  // ──────────────────────────────────────────────
  // 写：建 / 派 / 取消 / 重试
  // ──────────────────────────────────────────────

  /**
   * 建任务并立即派发（不等待结果）。
   *
   * @param request - 派发请求
   * @returns 已进入 `dispatched`（或失败/复用）的任务
   */
  async submit(request: CreateAgentTaskRequest): Promise<AgentTaskDto> {
    const { task, reused } = this.store.create({
      runtime: request.runtime,
      content: request.content,
      cwd: request.cwd ?? this.defaultCwd,
      ...(request.fromSession === undefined ? {} : { fromSession: request.fromSession }),
      ...(request.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: request.idempotencyKey }),
    });
    if (reused) {
      log.info("submit", `幂等键命中，复用任务 ${task.id}（${task.status}）`);
      return toTaskDto(task);
    }
    // 不阻塞 HTTP：派发在后台跑，进度经事件流 / SSE 推给调用方
    this.startDispatch(task.id);
    return toTaskDto(this.store.get(task.id) ?? task);
  }

  /**
   * 起一次后台派发并登记在飞表（`close()` 会等它们收尾，避免关库后还有写入）。
   *
   * @param id - 任务 id
   */
  private startDispatch(id: string): void {
    const running = this.dispatch(id)
      .catch((err: unknown) => {
        log.error(
          "dispatch",
          `任务 ${id} 派发异常: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.inflight.delete(id);
      });
    this.inflight.set(id, running);
  }

  /**
   * 建任务并等它到终态（`dispatch_task` 工具用：结果要回流到当前会话）。
   *
   * @param request - 派发请求
   * @param timeoutMs - 等待上限（默认 10 分钟）
   * @returns 终态任务（超时返回当前状态，不抛错）
   */
  async dispatchAndWait(
    request: CreateAgentTaskRequest,
    timeoutMs = this.promptTimeoutMs,
  ): Promise<AgentTaskDto> {
    const created = await this.submit(request);
    if (isTerminalTaskStatus(created.status)) return created;
    return this.waitForTerminal(created.id, timeoutMs);
  }

  /**
   * 取消（非终态才可取消）：先通知目标侧 `session/cancel`，再关闭客户端打断等待。
   *
   * @param id - 任务 id
   */
  cancel(id: string): AgentTaskDto {
    const task = this.store.get(id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`任务 ${id} 已是终态（${task.status}），不能取消`);
    }
    const active = this.active.get(id);
    if (active) {
      active.cancelled = true;
      if (active.sessionId) active.client.cancel(active.sessionId);
      // 关闭打断在飞的 prompt 请求（否则要等目标侧回 stopReason）
      void active.client.close(300).catch(() => undefined);
    }
    const next = this.transit(id, "cancelled", { detail: "用户取消" });
    this.notifyTerminal(id);
    return toTaskDto(next);
  }

  /**
   * 重试：终态任务 → 新 attempt（同一 taskId，事件流留痕 `task/retried`）。
   *
   * @param id - 任务 id
   */
  retry(id: string): AgentTaskDto {
    const task = this.store.get(id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    const reset = this.store.resetForRetry(id);
    // resetForRetry 已经写了 `task/retried`（旁路事件，不是状态转移）—— 这里补推事件帧，
    // 再看实时时间线的客户端不会漏掉「重试」这一条。
    const events = this.store.events(id);
    const retriedEvent = events[events.length - 1];
    if (retriedEvent && retriedEvent.type === "task/retried") {
      this.emit(id, { type: "event", event: toEventDto(retriedEvent) });
    }
    this.emit(id, { type: "status", task: toTaskDto(reset) });
    this.startDispatch(id);
    return toTaskDto(this.store.get(id) ?? reset);
  }

  /**
   * 等任务到终态。
   *
   * @param id - 任务 id
   * @param timeoutMs - 等待上限
   */
  async waitForTerminal(id: string, timeoutMs = 60_000): Promise<AgentTaskDto> {
    const current = this.store.get(id);
    if (!current) throw new Error(`任务不存在: ${id}`);
    if (isTerminalTaskStatus(current.status)) return toTaskDto(current);
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(id) ?? new Set<() => void>();
      const done = (): void => {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        set.delete(done);
        resolve();
      }, timeoutMs);
      set.add(done);
      this.waiters.set(id, set);
    });
    const latest = this.store.get(id);
    return toTaskDto(latest ?? current);
  }

  /** 订阅某任务的实时进度（SSE） */
  subscribe(id: string, listener: (event: AgentTaskStreamEvent) => void): () => void {
    const set = this.subscribers.get(id) ?? new Set();
    set.add(listener);
    this.subscribers.set(id, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.subscribers.delete(id);
    };
  }

  /**
   * 收尾上一进程遗留的非终态任务（服务启动时调用一次）。
   *
   * - `created`（从未派发）→ `expired`：它已经错过了自己的派发窗口；
   * - `dispatched` / `running` → `failed`：目标进程随服务一起没了，**不自动重跑**
   *   （重跑必须是显式 retry，副作用次数才可控）。
   *
   * @returns 被收尾的任务 id
   */
  recoverInterrupted(): string[] {
    const recovered: string[] = [];
    for (const task of this.store.listNonTerminal()) {
      const next: AgentTaskStatus = task.status === "created" ? "expired" : "failed";
      const detail =
        task.status === "created"
          ? "服务重启时尚未派发（转入 expired，可 retry）"
          : "服务重启，执行中断（未自动重跑，可 retry）";
      try {
        this.store.setStatus(task.id, next, { detail });
        recovered.push(task.id);
        log.info("recover", `任务 ${task.id} ${task.status} → ${next}`);
      } catch (err) {
        log.warn("recover", `任务 ${task.id} 收尾失败: ${String(err)}`);
      }
    }
    return recovered;
  }

  /** 关闭：回收所有在飞子进程、等在飞派发收尾，再关 SQLite 连接 */
  async close(): Promise<void> {
    for (const [id, run] of this.active) {
      log.warn("close", `回收任务 ${id} 的子进程`);
      await run.client.close(300).catch(() => undefined);
    }
    // 等在飞派发把 catch/finally 跑完，否则它们会在关库之后再写一次
    await Promise.all([...this.inflight.values()]);
    this.active.clear();
    this.subscribers.clear();
    this.store.close();
  }

  // ──────────────────────────────────────────────
  // 派发实现
  // ──────────────────────────────────────────────

  /**
   * 派发一个已存在的任务（`created` / 重试重置后）到终态。
   *
   * `submit()` 会自动调用它；单独暴露是给「恢复/补派」用（也便于测试直接驱动）。
   *
   * @param id - 任务 id
   */
  async dispatch(id: string): Promise<void> {
    const task = this.store.get(id);
    if (!task || isTerminalTaskStatus(task.status)) return;

    const entry = this.registry.get(task.runtime);
    if (!entry) {
      this.fail(id, `未注册的 runtime: ${task.runtime}`);
      return;
    }
    if (!entry.enabled) {
      this.fail(id, `runtime 已停用: ${task.runtime}`);
      return;
    }

    // ① 幂等闸：同一 attempt 只允许真正执行一次
    const operationKey = `agent-task:${task.id}:attempt-${task.attempt}`;
    const operationId = generateId();
    if (this.ledger) {
      const existing = this.ledger.begin({
        operationId,
        operationKey,
        toolName: "dispatch_task",
        sessionId: task.fromSession,
        taskId: task.id,
        input: { runtime: task.runtime, content: task.content, attempt: task.attempt },
        startedAt: this.now(),
      });
      if (existing.operationId !== operationId) {
        if (existing.status === "succeeded") {
          const replayed =
            typeof existing.resultJson === "object" && existing.resultJson !== null
              ? (existing.resultJson as { text?: unknown }).text
              : undefined;
          // 上一轮真的派过（否则台账里不会有 succeeded）→ 补一条 dispatched 再收尾，
          // 事件流才与 7 态表一致（created → dispatched → replied）。
          this.transit(id, "dispatched", {
            detail: "幂等台账命中（该 attempt 已派发过）",
          });
          this.finish(id, "replied", {
            result: typeof replayed === "string" ? replayed : "",
            detail: "幂等台账命中（该 attempt 已执行过），直接回放结果",
          });
          return;
        }
        this.fail(
          id,
          `副作用未决（台账 ${existing.status}）：该 attempt 可能已执行过，需人工核对后再 retry`,
        );
        return;
      }
    }

    // ② 派发（可用性由这一次真 spawn 验证，不额外探测 —— dsh 冷启 13s，翻倍不划算）
    this.transit(id, "dispatched", {
      detail: `command=${entry.command} ${(entry.args ?? []).join(" ")}`,
    });

    const client = new AcpClient({
      command: entry.command,
      args: entry.args ?? ["acp"],
      cwd: task.cwd,
      env: entry.env ?? {},
      requestTimeoutMs: this.requestTimeoutMs,
      promptTimeoutMs: this.promptTimeoutMs,
      onLog: (level, message) => log[level]("dispatch", `${task.id}: ${message}`),
    });
    const run: ActiveRun = { client, cancelled: false };
    this.active.set(id, run);

    let text = "";
    try {
      const handshake = await client.initialize();
      // 建会话：上一 attempt 留下 acpSessionId 且目标声明了 resume 能力 → 续聊同一个
      // 目标会话（ACP 要求带全参 sessionId + cwd + mcpServers）；否则新建。
      const opened = await openTargetSession(client, task.cwd, task.acpSessionId, handshake);
      const sessionId = opened.sessionId;
      run.sessionId = sessionId;
      this.appendEvent(
        id,
        "task/accepted",
        `握手成功 agent=${handshake.agentInfo.name || "?"} v${handshake.agentInfo.version || "?"}` +
          ` resume=${handshake.capabilities.resume}；会话 ${opened.mode}=${sessionId}` +
          (opened.fallbackReason === undefined ? "" : `（resume 回退：${opened.fallbackReason}）`),
      );
      this.transit(id, "running", { acpSessionId: sessionId });

      const result = await client.prompt(sessionId, task.content, {
        onUpdate: (update) => {
          const chunk = chunkOf(update);
          if (chunk === null) return;
          text += chunk;
          this.emit(id, { type: "chunk", text: chunk });
        },
        onPermission: (request) => {
          // 优先级：注册表里给该 runtime 单独配的策略 > 服务默认策略（缺省 deny）。
          // 验收需要目标真写文件时，在 runtimes.json 里给测试 runtime 配 "allow"。
          const entryPolicy = this.registry.get(task.runtime)?.permissionPolicy;
          const decision: "allow" | "deny" =
            entryPolicy ??
            this.permissionPolicy({
              taskId: id,
              runtime: task.runtime,
              request,
            });
          this.appendEvent(
            id,
            "task/stream-chunk",
            `[permission] ${request.title ?? request.toolCallId ?? "tool"} → ${decision}`,
          );
          return decision;
        },
      });

      text = result.text.length > 0 ? result.text : text;
      if (run.cancelled || result.stopReason === "cancelled") {
        this.finish(id, "cancelled", { detail: "目标侧回报 cancelled" });
        return;
      }
      if (this.ledger) {
        this.ledger.complete(operationId, {
          digest: digestResult(text, false),
          json: { text, stopReason: result.stopReason },
          finishedAt: this.now(),
        });
      }
      this.finish(id, "replied", { result: text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.ledger) this.ledger.fail(operationId, message, this.now());
      const current = this.store.get(id);
      if (current && !isTerminalTaskStatus(current.status)) {
        if (run.cancelled) {
          this.finish(id, "cancelled", { detail: "用户取消（客户端已关闭）" });
        } else {
          const tail = client.stderrTail();
          this.fail(id, tail === "" ? message : `${message}；stderr: ${tail}`);
        }
      }
    } finally {
      // 只清自己这一条：retry 会在同一个 taskId 上起新 run，别把新的删掉
      if (this.active.get(id) === run) this.active.delete(id);
      await client.close(1000).catch(() => undefined);
    }
  }

  /** 收尾为 replied / cancelled（写结果 + 终态事件 + 终态状态 + 唤醒等待者） */
  private finish(
    id: string,
    status: Extract<AgentTaskStatus, "replied" | "cancelled">,
    patch: { result?: string; detail?: string },
  ): void {
    const current = this.store.get(id);
    if (!current || isTerminalTaskStatus(current.status)) return;
    this.transit(id, status, patch);
    this.notifyTerminal(id);
  }

  /** 收尾为 failed */
  private fail(id: string, error: string): void {
    const current = this.store.get(id);
    if (!current || isTerminalTaskStatus(current.status)) return;
    log.warn("dispatch", `任务 ${id} 失败: ${error.slice(0, 300)}`);
    this.transit(id, "failed", { error, detail: error.slice(0, 200) });
    this.notifyTerminal(id);
  }

  /**
   * 推进状态并**按顺序推两帧**：先 `event`（`task/<status>`），再 `status`。
   *
   * SSE 路由收到终态 `status` 帧就会结束流，所以终态事件帧必须在它之前发出去 ——
   * 否则实时时间线里只有状态没有事件（F 段 P0：终态事件不推送）。
   */
  private transit(
    id: string,
    next: AgentTaskStatus,
    patch: {
      detail?: string;
      result?: string;
      error?: string;
      acpSessionId?: string;
      attempt?: number;
    } = {},
  ): AgentTaskRecord {
    const { task, event } = this.store.transition(id, next, patch);
    if (event) this.emit(id, { type: "event", event: toEventDto(event) });
    this.emit(id, { type: "status", task: toTaskDto(task) });
    return task;
  }

  /** 写一条旁路事件并推送 */
  private appendEvent(id: string, type: AgentTaskEventRow["type"], detail?: string): void {
    const row = this.store.appendEvent(id, type, detail);
    this.emit(id, { type: "event", event: toEventDto(row) });
  }

  private emit(id: string, event: AgentTaskStreamEvent): void {
    for (const listener of this.subscribers.get(id) ?? []) {
      try {
        listener(event);
      } catch (err) {
        log.warn("sse", `订阅者回调失败: ${String(err)}`);
      }
    }
  }

  private notifyTerminal(id: string): void {
    for (const waiter of this.waiters.get(id) ?? []) waiter();
    this.waiters.delete(id);
  }

  /** runtime → 近 24h 任务数 */
  private taskCounts(): Map<string, number> {
    const since = this.now() - 24 * 60 * 60 * 1000;
    const counts = new Map<string, number>();
    for (const entry of this.registry.entries()) {
      counts.set(entry.name, this.store.countSince(entry.name, since));
    }
    return counts;
  }
}

/** 任务记录 → API DTO（毫秒时间戳转 ISO） */
export function toTaskDto(task: AgentTaskRecord): AgentTaskDto {
  const durationMs =
    task.finishedAt === undefined ? undefined : task.finishedAt - task.createdAt;
  return {
    id: task.id,
    fromSession: task.fromSession,
    runtime: task.runtime,
    status: task.status,
    content: task.content,
    ...(task.result === undefined ? {} : { result: task.result }),
    ...(task.error === undefined ? {} : { error: task.error }),
    createdAt: new Date(task.createdAt).toISOString(),
    ...(task.dispatchedAt === undefined
      ? {}
      : { dispatchedAt: new Date(task.dispatchedAt).toISOString() }),
    ...(task.startedAt === undefined
      ? {}
      : { startedAt: new Date(task.startedAt).toISOString() }),
    ...(task.finishedAt === undefined
      ? {}
      : { finishedAt: new Date(task.finishedAt).toISOString() }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(task.acpSessionId === undefined ? {} : { acpSessionId: task.acpSessionId }),
  };
}

/** 事件行 → API DTO */
export function toEventDto(row: AgentTaskEventRow): AgentTaskEventDto {
  return {
    seq: row.seq,
    at: new Date(row.at).toISOString(),
    type: row.type,
    ...(row.detail === undefined ? {} : { detail: row.detail }),
  };
}

/**
 * 打开目标会话：能 resume 就续聊同一个目标会话，否则新建。
 *
 * ACP 的 `session/resume` 必须带**全参** `{sessionId, cwd, mcpServers}`（缺 cwd 会被
 * kimi / 原版 dsh 直接拒），因此这里把 cwd 一起传下去。resume 失败（目标不支持、
 * 会话已被回收）不阻塞派发 —— 回退 `session/new` 并把原因写进 `task/accepted` 的 detail。
 *
 * @param client - 已握手的客户端
 * @param cwd - 目标工作目录（绝对路径）
 * @param previousSessionId - 上一 attempt 留下的目标会话 id（可空）
 * @param handshake - 握手结果（据此判断 resume 能力）
 */
async function openTargetSession(
  client: AcpClient,
  cwd: string,
  previousSessionId: string | undefined,
  handshake: AcpHandshake,
): Promise<{ sessionId: string; mode: "resume" | "new"; fallbackReason?: string }> {
  const canResume =
    previousSessionId !== undefined &&
    previousSessionId !== "" &&
    handshake.capabilities.resume;
  if (canResume) {
    try {
      const sessionId = await client.resumeSession(previousSessionId, cwd);
      return { sessionId, mode: "resume" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const sessionId = await client.newSession(cwd);
      return { sessionId, mode: "new", fallbackReason: reason.slice(0, 200) };
    }
  }
  return { sessionId: await client.newSession(cwd), mode: "new" };
}

/** 从 `session/update` 取文本增量（兼容 snake/camel 两套命名） */
function chunkOf(update: AcpSessionUpdate): string | null {  const kind = update.sessionUpdate;
  if (
    kind !== "agent_message_chunk" &&
    kind !== "agentMessageChunk" &&
    kind !== "assistant_message_chunk"
  ) {
    return null;
  }
  const content = update.content;
  if (!content || typeof content !== "object") return null;
  return typeof content.text === "string" ? content.text : null;
}
