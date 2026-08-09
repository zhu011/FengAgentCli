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
    return session;
  }

  /**
   * 获取会话（含消息历史）。
   *
   * 优先从内存缓存读取，回退到 SessionStore 加载。
   *
   * @param sessionId - 会话 ID
   * @returns 会话对象，不存在则返回 null
   */
  getSession(sessionId: string): Session | null {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    const agent = this.agents.get(sessionId);
    if (!agent) return null;
    return agent.loadSession(sessionId);
  }

  /**
   * 列出所有会话。
   *
   * 从内存缓存中返回会话元信息，按更新时间降序。
   *
   * @returns 会话元信息列表
   */
  listSessions(): SessionMeta[] {
    const all: SessionMeta[] = [];
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
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
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
      }
    } finally {
      this.runningTasks.delete(sessionId);
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
    if (!task) return false;
    task.aborted = true;
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
