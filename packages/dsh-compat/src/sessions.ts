/**
 * @fengagent/dsh-compat — `ctx.sessions` 契约映射（P2）
 *
 * 把 dsh 的 `SessionStore` 面映射到 FengAgentCli 的会话存储：
 * - 事实源：`ctx.storage`（`SessionStoreLike`，SQLite `sessions`/`messages` 表）；
 * - 读：`get` / `list` → {@link CompatSession}，`events` 是消息的**只读投影**
 *   （见 `projection.ts`，有损性在那里逐条写明）；
 * - 写：`create` / `fork` → `storage.saveSession` + `saveMessages`；
 * - 持久化屏障：`flush` → `storage.flush()`（图存储落盘；会话本身逐条同步写）；
 * - 事件溯源生命周期（`prepare` / `enter` / `announce`、`session.append`、
 *   `session.surface`）**明确不支持**：FengAgentCli 没有 append-only 事件日志
 *   作为会话事实源，假装支持会让 dsh 插件的写入静默丢失。调用即抛
 *   {@link DshContractUnsupportedError}。
 *
 * 身份约定：dsh 用 `session-<n>` 这类 id；这里只要调用方给 id 就原样使用，
 * 不给则用 FengAgentCli 的 uuid。
 */

import { createSession, type Message, type Session } from "@fengagent/core";
import type { StorageService } from "@fengagent/cordis";
import { isAbsolute } from "node:path";
import {
  DshContractError,
  DshContractUnsupportedError,
  type DshCreateSessionOptions,
  type DshSessionEvent,
  type DshSessionHeader,
  type DshSessionLike,
  type DshSessionsLike,
} from "./contracts.ts";
import {
  messageBoundaryForSeq,
  projectSessionEvents,
  type ProjectedSessionEvent,
} from "./projection.ts";

/** 不支持事件溯源写路径的统一说明 */
const EVENT_SOURCED_DETAIL =
  "FengAgentCli persists messages (SQLite sessions/messages), not an append-only session event log; " +
  "the event-sourced write path lands with the P3/P4 event-log bridge";

/** 会话创建元数据在内存中的覆盖（FengAgentCli 的 sessions 表没有这些列） */
interface SessionHeaderOverride {
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly seedLength?: number;
  readonly origin?: "subagent";
  readonly delegationDepth?: number;
}

/**
 * dsh `Session` 的只读投影。
 *
 * 每次读 `events` 都从存储重新投影，保证看到最新消息；`seq` 在消息追加后
 * 会整体位移（投影是派生视图，不是稳定日志），这是与 dsh 的关键差异，
 * 已在契约文档中标注。
 */
export class CompatSession implements DshSessionLike {
  private readonly headerValue: DshSessionHeader;

  constructor(
    readonly id: string,
    private readonly load: () => Session | null | undefined,
    override: SessionHeaderOverride = {},
  ) {
    const session = load();
    this.headerValue = Object.freeze({
      version: 1,
      id,
      createdAt: session?.createdAt ?? Date.now(),
      ...override,
    });
  }

  get header(): DshSessionHeader {
    return this.headerValue;
  }

  /** 会话消息（FengAgentCli 事实源；dsh 侧没有这个属性） */
  get messages(): readonly Message[] {
    return this.load()?.messages ?? [];
  }

  get events(): readonly DshSessionEvent[] {
    return projectSessionEvents(this.messages).map(({ seq, type, time, data }) => ({
      seq,
      type,
      time,
      data,
    }));
  }

  append(_type?: string, _data?: unknown): never {
    throw new DshContractUnsupportedError("session.append", EVENT_SOURCED_DETAIL);
  }

  requestHeader(): undefined {
    // FengAgentCli 不持久化 request/header；dsh 里这也是可选折叠（undefined 合法）。
    return undefined;
  }

  get surface(): never {
    throw new DshContractUnsupportedError(
      "session.surface",
      "the projection carries no surfaceOp/sourceEventSeqs, so an ordered surface cannot be derived",
    );
  }
}

/** `ctx.sessions` 的映射实现 */
export class SessionsCompat implements DshSessionsLike {
  private readonly live = new Map<string, CompatSession>();
  private readonly headers = new Map<string, SessionHeaderOverride>();

  constructor(
    private readonly storage: StorageService,
    private readonly defaultModel: () => string,
  ) {}

  get(id: string): CompatSession | undefined {
    const session = this.storage.loadSession(id);
    if (!session) {
      this.live.delete(id);
      return undefined;
    }
    const existing = this.live.get(id);
    if (existing) return existing;
    const view = new CompatSession(id, () => this.storage.loadSession(id), this.headers.get(id));
    this.live.set(id, view);
    return view;
  }

  list(): CompatSession[] {
    const views: CompatSession[] = [];
    for (const meta of this.storage.listSessions()) {
      const view = this.get(meta.id);
      if (view) views.push(view);
    }
    return views;
  }

  create(id?: string, options: DshCreateSessionOptions = {}): CompatSession {
    if (options.seedSource === "persistence") {
      throw new DshContractUnsupportedError(
        "sessions.create",
        "seedSource:'persistence' restores an event-sourced log; FengAgentCli restores from SQLite via storage.loadSession",
      );
    }
    if (options.seed && options.seed.length > 0) {
      throw new DshContractUnsupportedError(
        "sessions.create",
        "non-empty seed requires replaying dsh events into messages; not mapped in P2",
      );
    }
    const cwd = options.meta?.cwd;
    if (cwd !== undefined && !isAbsolute(cwd)) {
      throw new DshContractError("sessions.create", `meta.cwd must be absolute, got ${cwd}`);
    }
    if (id !== undefined && this.storage.loadSession(id)) {
      throw new DshContractError("sessions.create", `session "${id}" already exists`);
    }

    const session = createSession(this.defaultModel());
    if (id !== undefined) session.id = id;
    this.storage.saveSession(session);

    const override: SessionHeaderOverride = {
      ...(cwd === undefined ? {} : { cwd }),
      ...(options.meta?.parentSession === undefined
        ? {}
        : { parentSession: options.meta.parentSession }),
      ...(options.meta?.seedLength === undefined ? {} : { seedLength: options.meta.seedLength }),
      ...(options.meta?.origin === undefined ? {} : { origin: options.meta.origin }),
      ...(options.meta?.delegationDepth === undefined
        ? {}
        : { delegationDepth: options.meta.delegationDepth }),
    };
    if (Object.keys(override).length > 0) this.headers.set(session.id, override);

    const view = new CompatSession(
      session.id,
      () => this.storage.loadSession(session.id),
      override,
    );
    this.live.set(session.id, view);
    return view;
  }

  /**
   * 从一条 live 会话的投影前缀分叉。
   *
   * 偏差：dsh 复制事件（消息 id 保持），这里必须**重发消息 id**——FengAgentCli 的
   * `messages.id` 是全局主键，沿用会 `INSERT OR REPLACE` 改写源会话的行。
   *
   * @param source - 源会话对象或 id
   * @param boundary - inclusive 事件 seq；省略取日志末尾
   * @param childId - 子会话 id；省略由存储生成
   */
  fork(source: DshSessionLike | string, boundary?: number, childId?: string): CompatSession {
    const sourceId = typeof source === "string" ? source : source.id;
    const parent = this.storage.loadSession(sourceId);
    if (!parent) {
      throw new DshContractError("sessions.fork", `source session "${sourceId}" is not live`);
    }
    if (childId !== undefined && this.storage.loadSession(childId)) {
      throw new DshContractError("sessions.fork", `session "${childId}" already exists`);
    }

    const projected: ProjectedSessionEvent[] = projectSessionEvents(parent.messages);
    let upTo: number;
    let seedLength: number;
    if (boundary === undefined) {
      upTo = projected.length === 0 ? -1 : projected[projected.length - 1]!.messageIndex;
      seedLength = projected.length;
    } else {
      upTo = messageBoundaryForSeq(projected, boundary);
      seedLength = boundary + 1;
    }

    const child = createSession(parent.model, `${parent.title} (fork)`);
    if (childId !== undefined) child.id = childId;
    const messages = parent.messages.slice(0, upTo + 1).map((message) => ({
      ...structuredClone(message),
      id: crypto.randomUUID(),
    }));
    child.messages = messages;
    child.tokenCount = parent.tokenCount;
    this.storage.saveSession(child);
    this.persistMessages(child.id, messages);
    const override: SessionHeaderOverride = {
      ...(this.headers.get(parent.id) ?? {}),
      parentSession: parent.id,
      seedLength,
    };
    this.headers.set(child.id, override);

    const view = new CompatSession(
      child.id,
      () => this.storage.loadSession(child.id),
      override,
    );
    this.live.set(child.id, view);
    return view;
  }

  async flush(session: DshSessionLike): Promise<boolean> {
    if (!this.live.has(session.id) && !this.storage.loadSession(session.id)) {
      throw new DshContractError("sessions.flush", `session "${session.id}" is not live`);
    }
    await this.storage.flush();
    return true;
  }

  prepare(_id?: string, _options?: DshCreateSessionOptions): never {
    throw new DshContractUnsupportedError(
      "sessions.prepare",
      "prepare/enter/announce model dsh's unpublished creation transaction; FengAgentCli creation is a plain storage write",
    );
  }

  enter(_session?: DshSessionLike): never {
    throw new DshContractUnsupportedError(
      "sessions.enter",
      "prepare/enter/announce model dsh's unpublished creation transaction; FengAgentCli creation is a plain storage write",
    );
  }

  announce(_session?: DshSessionLike): never {
    throw new DshContractUnsupportedError(
      "sessions.announce",
      "prepare/enter/announce model dsh's unpublished creation transaction; FengAgentCli creation is a plain storage write",
    );
  }

  /** `StorageService.saveMessages` 是可选面（内存存储可以没有）；逐条兜底 */
  private persistMessages(sessionId: string, messages: readonly Message[]): void {
    if (this.storage.saveMessages) {
      this.storage.saveMessages(sessionId, [...messages]);
      return;
    }
    for (const message of messages) this.storage.saveMessage?.(sessionId, message);
  }
}
