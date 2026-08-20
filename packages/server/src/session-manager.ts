/**
 * @fengagent/server — 会话管理器
 *
 * 内存中的 Agent 实例池（sessionId → Agent 运行时）。
 * 管理会话创建/销毁、权限请求回调（通过 SSE 推送 → 等待 HTTP 响应）。
 *
 * 参考 ARCHITECTURE.md 第 6.2 节和第 6.5 节（权限审批方案）。
 */

import type { AgentEvent, PermissionResult, Session, SessionMeta } from "@fengagent/core";
import type { Agent, RequestPermission } from "@fengagent/agent";
import { createLogger } from "@fengagent/shared";

const log = createLogger("session-manager");

/** 运行时 Agent 的图/回退扩展面（RuntimeAgent 提供；普通 Agent 无此能力） */
export interface GraphAgentLike {
  getGraphData(sessionId: string): {
    nodes: import("@fengagent/graph").ConversationNode[];
    activePath: import("@fengagent/graph").ConversationNode[];
    activeHead: import("@fengagent/graph").ConversationNode | undefined;
    chain: import("@fengagent/graph").ConversationNode[];
  };
  rollback(
    session: Session,
    nodeId?: string,
    reason?: string,
  ): {
    ok: boolean;
    message: string;
    target?: import("@fengagent/graph").ConversationNode;
    rollbackToNode?: import("@fengagent/graph").ConversationNode;
    truncatedToMessageId?: string;
  };
}

/** 权限请求记录 */
export interface PermissionRequest {
  /** 请求 ID（用于 HTTP 响应路由） */
  reqId: string;
  /** 会话 ID */
  sessionId: string;
  /** 工具名 */
  toolName: string;
  /** 工具输入参数 */
  input: unknown;
  /** 请求原因 */
  reason?: string;
  /** 等待用户决策的 Promise */
  resolve: (result: PermissionResult) => void;
  /** 超时拒绝器 */
  reject: (error: Error) => void;
}

/** 运行中的 Agent 任务句柄 */
interface RunningTask {
  /** 中断信号 */
  aborted: boolean;
  /** AgentEvent 生成器 */
  generator: AsyncGenerator<AgentEvent>;
}

/** SessionManager 构造选项 */
export interface SessionManagerOptions {
  /** Agent 工厂函数（每次创建会话时调用） */
  createAgent: () => Agent;
  /** 可选的 SessionStore，用于跨重启恢复历史会话 */
  sessionStore?: import("@fengagent/agent").SessionStore;
}

/**
 * 会话管理器 — 管理 Agent 实例池和权限交互。
 *
 * 职责：
 * - 创建会话（创建 Agent 实例并绑定 sessionId）
 * - 销毁会话（清理资源）
 * - 列出会话
 * - 发送消息（启动 Agent Loop，返回 AgentEvent 流）
 * - 中断当前运行
 * - 权限请求/响应桥接（SSE 推送 → HTTP 响应）
 */
export class SessionManager {
  private createAgent: () => Agent;
  private sessionStore?: import("@fengagent/agent").SessionStore;
  /** sessionId → Agent 实例 */
  private agents = new Map<string, Agent>();
  /** sessionId → Session 对象（内存缓存） */
  private sessions = new Map<string, Session>();
  /** sessionId → 运行中任务 */
  private runningTasks = new Map<string, RunningTask>();
  /** sessionId → 待处理权限请求列表 */
  private pendingPermissions = new Map<string, PermissionRequest[]>();
  /** sessionId → 权限请求监听器（SSE 消费者） */
  private permissionListeners = new Map<
    string,
    (req: PermissionRequest) => void
  >();

  constructor(options: SessionManagerOptions) {
    this.createAgent = options.createAgent;
    this.sessionStore = options.sessionStore;
  }

  /**
   * 创建新会话。
   *
   * 创建 Agent 实例并绑定 sessionId，同时持久化初始会话到 SessionStore。
   *
   * @param title - 可选会话标题
   * @returns 会话信息（含 id）
   */
  createSession(title?: string): Session {
    const agent = this.createAgent();
    const session = agent.createSession(title);
    this.agents.set(session.id, agent);
    this.sessions.set(session.id, session);
    log.info("createSession", `sessionId=${session.id}, title=${title ?? "(none)"}`);
    return session;
  }

  /**
   * 获取会话（含消息历史）。
   *
   * 优先从内存缓存读取，回退到 SessionStore 加载。
   * 加载后缓存到内存并创建 Agent 实例。
   *
   * @param sessionId - 会话 ID
   * @returns 会话对象，不存在则返回 null
   */
  getSession(sessionId: string): Session | null {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;

    // 内存缓存未命中 — 尝试从 Agent 实例加载
    const existingAgent = this.agents.get(sessionId);
    if (existingAgent) {
      const loaded = existingAgent.loadSession(sessionId);
      if (loaded) {
        this.sessions.set(sessionId, loaded);
        return loaded;
      }
    }

    // Agent 实例也未命中 — 如果有 SessionStore，创建新 Agent 并加载
    if (this.sessionStore) {
      try {
        const loaded = this.sessionStore.loadSession(sessionId);
        if (loaded) {
          // 创建 Agent 实例并缓存
          const agent = this.createAgent();
          this.agents.set(sessionId, agent);
          this.sessions.set(sessionId, loaded);
          return loaded;
        }
      } catch {
        // SessionStore 加载失败
      }
    }

    return null;
  }

  /**
   * 列出所有会话。
   *
   * 优先从内存缓存返回，内存为空时从 SessionStore 加载。
   * 按更新时间降序排列。
   *
   * @returns 会话元信息列表
   */
  listSessions(): SessionMeta[] {
    const all: SessionMeta[] = [];

    // 内存缓存中的会话
    for (const session of this.sessions.values()) {
      all.push({
        id: session.id,
        title: session.title,
        model: session.model,
        status: session.status,
        tokenCount: session.tokenCount,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    }

    // 如果有 SessionStore 且内存缓存不足，补充 SQLite 中的历史会话
    if (this.sessionStore) {
      try {
        const stored = this.sessionStore.listSessions();
        const memIds = new Set(all.map((s) => s.id));
        for (const s of stored) {
          if (!memIds.has(s.id)) {
            all.push(s);
          }
        }
      } catch {
        // SessionStore 读取失败 — 仅返回内存缓存
      }
    }

    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 重命名会话（同步内存缓存 + 持久化）。
   *
   * 更新内存缓存的会话标题与更新时间，并同步到 Agent 的
   * SessionStore（若存在）。WebUI 侧边栏「双击重命名」入口。
   *
   * @param sessionId - 会话 ID
   * @param title - 新标题（空白拒绝）
   * @returns 更新后的会话，不存在返回 null
   */
  renameSession(sessionId: string, title: string): Session | null {
    const trimmed = title.trim();
    if (!trimmed) return null;
    const session = this.sessions.get(sessionId) ?? this.getSession(sessionId);
    if (!session) return null;

    session.title = trimmed;
    session.updatedAt = Date.now();
    this.sessions.set(sessionId, session);

    const agent = this.agents.get(sessionId);
    if (agent && typeof agent.renameSession === "function") {
      agent.renameSession(sessionId, trimmed);
    }
    log.info("renameSession", `sessionId=${sessionId}, title=${trimmed}`);
    return session;
  }

  /**
   * 销毁会话（清理资源）。
   *
   * @param sessionId - 会话 ID
   */
  destroySession(sessionId: string): void {
    this.interrupt(sessionId);
    this.agents.delete(sessionId);
    this.sessions.delete(sessionId);
    this.runningTasks.delete(sessionId);
    this.pendingPermissions.delete(sessionId);
    this.permissionListeners.delete(sessionId);
  }

  /**
   * 发送消息并返回 AgentEvent 流。
   *
   * 从内存缓存中获取会话，启动 Agent Loop。
   * 权限请求通过 permissionRequest 回调转发到 SSE 监听器。
   *
   * @param sessionId - 会话 ID
   * @param text - 用户消息
   * @param model - 可选模型覆盖（不传则使用会话当前模型）
   * @returns AgentEvent 异步生成器
   */
  async *sendMessage(
    sessionId: string,
    text: string,
    model?: string,
  ): AsyncGenerator<AgentEvent> {
    const agent = this.agents.get(sessionId);
    if (!agent) {
      throw new SessionNotFoundError(sessionId);
    }

    // 从内存缓存获取会话
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      throw new SessionNotFoundError(sessionId);
    }

    // 应用模型覆盖
    if (model && model !== existing.model) {
      existing.model = model;
      existing.updatedAt = Date.now();
    }

    log.info("sendMessage", `sessionId=${sessionId}, text preview=${text.slice(0, 50)}, model=${existing.model}`);

    // 创建权限回调（将权限请求推送到 SSE 监听器）
    const requestPermission: RequestPermission = async (permission) => {
      return this.requestPermission(sessionId, permission);
    };

    // 启动 Agent Loop
    const generator = agent.prompt(text, existing, { requestPermission });

    // 记录运行中任务
    const task: RunningTask = {
      aborted: false,
      generator,
    };
    this.runningTasks.set(sessionId, task);

    try {
      for await (const event of generator) {
        if (task.aborted) {
          yield {
            type: "error",
            error: { message: "Interrupted by user" },
          };
          break;
        }
        yield event;
        log.debug("sendMessage", `event type=${event.type}`);
      }
    } finally {
      this.runningTasks.delete(sessionId);
      log.info("sendMessage", `completed sessionId=${sessionId}`);
    }
  }

  /**
   * 中断当前运行。
   *
   * 设置中断标志，AgentEvent 流将在下一次迭代时退出。
   *
   * @param sessionId - 会话 ID
   * @returns 是否成功中断（有运行中的任务）
   */
  interrupt(sessionId: string): boolean {
    const task = this.runningTasks.get(sessionId);
    if (!task) {
      log.info("interrupt", `sessionId=${sessionId}, result=false`);
      return false;
    }
    task.aborted = true;
    log.info("interrupt", `sessionId=${sessionId}, result=true`);
    return true;
  }

  /**
   * 权限请求 — 推送到 SSE 监听器并等待 HTTP 响应。
   *
   * 当 Agent Loop 中的工具需要用户审批时调用此方法。
   * 权限请求被推送到通过 `subscribePermissions` 注册的监听器，
   * 然后等待用户通过 `respondPermission` 响应。
   *
   * 超时（5 分钟）后自动拒绝。
   *
   * @param sessionId - 会话 ID
   * @param permission - 权限请求信息
   * @returns 用户决策
   */
  private async requestPermission(
    sessionId: string,
    permission: {
      toolName: string;
      input: unknown;
      reason?: string;
    },
  ): Promise<PermissionResult> {
    const reqId = crypto.randomUUID();

    log.info("requestPermission", `sessionId=${sessionId}, toolName=${permission.toolName}, reqId=${reqId}`);

    return new Promise<PermissionResult>((resolve, reject) => {
      const request: PermissionRequest = {
        reqId,
        sessionId,
        toolName: permission.toolName,
        input: permission.input,
        reason: permission.reason,
        resolve,
        reject,
      };

      // 存入待处理列表
      let pending = this.pendingPermissions.get(sessionId);
      if (!pending) {
        pending = [];
        this.pendingPermissions.set(sessionId, pending);
      }
      pending.push(request);

      // 推送到监听器（SSE 消费者）
      const listener = this.permissionListeners.get(sessionId);
      if (listener) {
        listener(request);
      }

      // 超时（5 分钟）
      setTimeout(() => {
        reject(new Error("Permission request timed out"));
        this.removePendingPermission(sessionId, reqId);
      }, 5 * 60 * 1000);
    });
  }

  /**
   * 响应权限请求（用户通过 HTTP POST 提交决策）。
   *
   * @param sessionId - 会话 ID
   * @param reqId - 权限请求 ID
   * @param decision - 决策结果
   * @returns 是否成功响应（找到对应请求）
   */
  respondPermission(
    sessionId: string,
    reqId: string,
    decision: PermissionResult,
  ): boolean {
    const pending = this.pendingPermissions.get(sessionId);
    if (!pending) return false;

    const idx = pending.findIndex((r) => r.reqId === reqId);
    if (idx === -1) return false;

    const [request] = pending.splice(idx, 1);
    if (!request) return false;
    request.resolve(decision);
    log.info("respondPermission", `sessionId=${sessionId}, reqId=${reqId}, decision=${decision.decision}`);
    return true;
  }

  /**
   * 订阅权限请求事件（SSE 监听器注册）。
   *
   * 当有新的权限请求时调用回调。
   *
   * @param sessionId - 会话 ID
   * @param callback - 权限请求回调
   */
  subscribePermissions(
    sessionId: string,
    callback: (req: PermissionRequest) => void,
  ): void {
    this.permissionListeners.set(sessionId, callback);

    // 推送已有的待处理请求
    const pending = this.pendingPermissions.get(sessionId);
    if (pending) {
      for (const request of pending) {
        callback(request);
      }
    }
  }

  /**
   * 取消权限请求订阅。
   *
   * @param sessionId - 会话 ID
   */
  unsubscribePermissions(sessionId: string): void {
    this.permissionListeners.delete(sessionId);
  }

  /**
   * 获取待处理的权限请求列表。
   *
   * @param sessionId - 会话 ID
   * @returns 权限请求列表（不含 resolve/reject）
   */
  getPendingPermissions(
    sessionId: string,
  ): Array<Omit<PermissionRequest, "resolve" | "reject">> {
    const pending = this.pendingPermissions.get(sessionId);
    if (!pending) return [];
    return pending.map(({ resolve: _r, reject: _j, ...rest }) => rest);
  }

  /** 从待处理列表中移除指定请求 */
  private removePendingPermission(sessionId: string, reqId: string): void {
    const pending = this.pendingPermissions.get(sessionId);
    if (!pending) return;
    const idx = pending.findIndex((r) => r.reqId === reqId);
    if (idx !== -1) {
      pending.splice(idx, 1);
    }
  }

  /**
   * 获取会话对应的 Agent 实例。
   *
   * @param sessionId - 会话 ID
   * @returns Agent 实例，不存在则返回 null
   */
  getAgent(sessionId: string): Agent | null {
    return this.agents.get(sessionId) ?? null;
  }

  /**
   * 获取会话的对话图数据（Phase 3/4：WebUI 分支可视化）。
   *
   * @param sessionId - 会话 ID
   * @returns 图数据；Agent 未接入 Graph 机制时返回 null
   */
  getGraph(sessionId: string): {
    nodes: import("@fengagent/graph").ConversationNode[];
    activePath: import("@fengagent/graph").ConversationNode[];
    activeHead: import("@fengagent/graph").ConversationNode | undefined;
    chain: import("@fengagent/graph").ConversationNode[];
  } | null {
    const agent = this.agents.get(sessionId);
    const graphAgent = agent as unknown as GraphAgentLike | undefined;
    if (!graphAgent?.getGraphData) return null;
    try {
      return graphAgent.getGraphData(sessionId);
    } catch (err) {
      log.error("getGraph", `sessionId=${sessionId}, error=${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * 回退会话到目标节点（Phase 4：WebUI 回退按钮）。
   *
   * 回退后旧分支作废保留（可溯源），会话消息截断到回退点；
   * WebUI 端重新渲染会话，用户可再次提问（或直接重发最后一条消息）。
   *
   * @param sessionId - 会话 ID
   * @param nodeId - 目标节点 id（缺省取活跃路径最后一个 assistant 节点）
   * @param reason - 回退原因
   * @returns 回退结果 + 最新图数据
   */
  rollbackSession(
    sessionId: string,
    nodeId?: string,
    reason = "用户回退",
  ): {
    ok: boolean;
    message: string;
    target?: import("@fengagent/graph").ConversationNode;
    rollbackToNode?: import("@fengagent/graph").ConversationNode;
    truncatedToMessageId?: string;
    graph?: ReturnType<NonNullable<GraphAgentLike["getGraphData"]>>;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, message: `Session "${sessionId}" not found` };
    }
    const agent = this.agents.get(sessionId);
    const graphAgent = agent as unknown as GraphAgentLike | undefined;
    if (!graphAgent?.rollback) {
      return { ok: false, message: "当前 Agent 未接入 Graph 机制（非运行时装配）。" };
    }
    const result = graphAgent.rollback(session, nodeId, reason);
    if (!result.ok) return result;
    // 同步内存缓存中的会话状态
    this.sessions.set(sessionId, session);
    return { ...result, graph: graphAgent.getGraphData(sessionId) };
  }

  /**
   * 导出会话为 JSON 字符串。
   *
   * 从内存缓存中获取完整会话（含消息历史）。
   *
   * @param sessionId - 会话 ID
   * @returns JSON 字符串，会话不存在返回 null
   */
  exportSession(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return JSON.stringify(session, null, 2);
  }
}

/** 会话不存在错误 */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" not found`);
    this.name = "SessionNotFoundError";
  }
}
