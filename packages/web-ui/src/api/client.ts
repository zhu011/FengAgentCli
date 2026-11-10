/**
 * @fengagent/web-ui — API 客户端
 *
 * fetch 封装：创建会话、发送消息（SSE 流）、中断、权限响应、获取模型列表。
 *
 * SSE 流通过 fetch + ReadableStream 手动解析（而非 EventSource），
 * 因为 POST 请求不支持 EventSource，且需要自定义 headers。
 */

import type {
  AgentEvent,
  AgentTask,
  AgentTaskCreateRequest,
  AgentTaskDetailResponse,
  AgentTaskListResponse,
  AgentTaskStreamEvent,
  AgentTaskStreamRequest,
  CallChainResponse,
  EvalOverview,
  GraphData,
  GroupCreateRequest,
  GroupDetailResponse,
  GroupInfo,
  GroupListResponse,
  GroupMessage,
  GroupMessageRequest,
  GroupStopResponse,
  GroupStreamEvent,
  MarkdownReport,
  MarketCatalogResponse,
  MarketQuery,
  MessageEvalResponse,
  MessageTracesResponse,
  ModelsResponse,
  PermissionResult,
  PluginMutationResult,
  PluginsListResponse,
  RollbackResponse,
  RuntimeEntryInput,
  RuntimeInfo,
  RuntimeProbeResult,
  Session,
  SessionMeta,
  SkillEntryInput,
  SkillInfo,
  SkillListView,
  TraceAnalysisResponse,
  TraceFileMeta,
} from "./types.ts";

/** API 错误 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 创建会话请求 */
export interface CreateSessionRequest {
  title?: string;
  model?: string;
}

/** 发送消息请求 */
export interface SendMessageRequest {
  sessionId: string;
  content: string;
  model?: string;
  signal?: AbortSignal;
}

/**
 * API 客户端 — 封装所有与后端 server 的 HTTP 交互。
 */
export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    // 开发模式通过 Vite proxy 转发 /api，生产模式同源
    this.baseUrl = baseUrl ?? "";
  }

  // ──────────────────────────────────────────────
  // 会话管理
  // ──────────────────────────────────────────────

  /** POST /api/sessions — 创建会话 */
  async createSession(req?: CreateSessionRequest): Promise<Session> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req ?? {}),
    });
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to create session");
    }
    return (await res.json()) as Session;
  }

  /** GET /api/sessions — 列出会话 */
  async listSessions(): Promise<SessionMeta[]> {
    const res = await fetch(`${this.baseUrl}/api/sessions`);
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to list sessions");
    }
    return (await res.json()) as SessionMeta[];
  }

  /** GET /api/sessions/:id — 获取会话详情 */
  async getSession(id: string): Promise<Session> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${id}`);
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get session");
    }
    return (await res.json()) as Session;
  }

  /** PATCH /api/sessions/:id — 重命名会话（侧边栏双击重命名 / 顶栏标题编辑） */
  async renameSession(id: string, title: string): Promise<Session> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to rename session");
    }
    return (await res.json()) as Session;
  }

  /** DELETE /api/sessions/:id — 销毁会话 */
  async deleteSession(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to delete session");
    }
  }

  // ──────────────────────────────────────────────
  // 消息 + SSE
  // ──────────────────────────────────────────────

  /**
   * POST /api/sessions/:id/messages — 发送消息并返回 SSE 事件流。
   *
   * 使用 fetch + ReadableStream 手动解析 SSE 帧，
   * 因为需要 POST + JSON body（EventSource 不支持 POST）。
   */
  async *sendMessage(req: SendMessageRequest): AsyncGenerator<AgentEvent> {
    const body: Record<string, unknown> = { content: req.content };
    if (req.model) body.model = req.model;
    yield* this.postSSE(`/api/sessions/${req.sessionId}/messages`, body, req.signal);
  }

  /**
   * GET /api/sessions/:id/events — 订阅某会话的事件流（SSE，按会话路由）。
   *
   * 真后台语义（AGE-29）：运行与单个连接解耦 —— 本订阅可随时连接/断开而不
   * 影响后台运行；若订阅时该会话正在运行，服务端会先回放本次运行已产生的事件
   * （补看进度），随后实时接收。流以内部 `run-end` 帧标记一轮运行结束
   * （连接保持打开，可等待下一次运行）。
   */
  async *sessionEvents(
    sessionId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${sessionId}/events`,
      { signal },
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to subscribe session events");
    }
    yield* this.readSSEBody(res);
  }

  /**
   * POST /api/sessions/:id/rollback-retry — 回退到目标节点并自动重答（SSE 流）。
   *
   * 与 CLI /rollback <节点id> 同一语义：回退（旧分支作废保留）→ 截断 → 重答。
   *
   * 增量（AGE-29 图三件套）：
   * - `granularity: "step"` → 步级续跑（回退点精确到一轮内的一步，已执行工具不重跑）；
   * - `toolOverride` → 图上「改参并重放」：该工具调用以新入参执行（与 HITL 审批改参同链路），
   *   同时会带 `mode: "replay"`（必须重放该步，改写入参才会被那次调用命中）。
   */
  async *rollbackRetry(
    sessionId: string,
    nodeId?: string,
    reason = "用户回退并重答",
    signal?: AbortSignal,
    extras?: {
      granularity?: "turn" | "step";
      mode?: "replay" | "resume";
      toolOverride?: { toolName: string; from?: unknown; to: unknown };
    },
  ): AsyncGenerator<AgentEvent> {
    // 改参重放必须重放该步（否则改写入参等不到匹配的那次调用）
    const mode = extras?.mode ?? (extras?.toolOverride ? "replay" : undefined);
    yield* this.postSSE(
      `/api/sessions/${sessionId}/rollback-retry`,
      {
        ...(nodeId ? { nodeId } : {}),
        ...(reason ? { reason } : {}),
        ...(extras?.granularity ? { granularity: extras.granularity } : {}),
        ...(mode ? { mode } : {}),
        ...(extras?.toolOverride ? { toolOverride: extras.toolOverride } : {}),
      },
      signal,
    );
  }

  /**
   * 通用 SSE POST：发起 JSON POST 请求并解析 SSE 事件流。
   */
  private async *postSSE(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      throw await this.toApiError(res, `POST ${path} failed`);
    }

    yield* this.readSSEBody(res);
  }

  // ──────────────────────────────────────────────
  // Agents 外派能力（P2 契约；后端未落地时页面自动回退 mock）
  // ──────────────────────────────────────────────

  /** GET /api/runtimes — 运行时注册表（含探测状态） */
  async listRuntimes(): Promise<RuntimeInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/runtimes`);
    if (!res.ok) throw await this.toApiError(res, "Failed to list runtimes");
    return (await res.json()) as RuntimeInfo[];
  }

  /** POST /api/runtimes — 添加 runtime（失败回 {error:{message,code}} 具体原因） */
  async createRuntime(req: RuntimeEntryInput): Promise<RuntimeInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/runtimes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to create runtime");
    return (await res.json()) as RuntimeInfo[];
  }

  /** PATCH /api/runtimes/:name — 编辑 runtime（command/args/protocol/env/enabled） */
  async updateRuntime(name: string, req: Partial<RuntimeEntryInput>): Promise<RuntimeInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/runtimes/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to update runtime");
    return (await res.json()) as RuntimeInfo[];
  }

  /** DELETE /api/runtimes/:name — 删除 runtime */
  async deleteRuntime(name: string): Promise<RuntimeInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/runtimes/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to delete runtime");
    return (await res.json()) as RuntimeInfo[];
  }

  /** POST /api/runtimes/probe-candidate — 探测表单里的候选项（不落盘，「探测验证」按钮用） */
  async probeRuntimeCandidate(req: {
    command: string;
    args?: string[];
    protocol?: string;
    env?: Record<string, string>;
  }): Promise<RuntimeProbeResult> {
    const res = await fetch(`${this.baseUrl}/api/runtimes/probe-candidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to probe runtime");
    return (await res.json()) as RuntimeProbeResult;
  }

  /** POST /api/runtimes/:name/enabled — 启停 runtime */
  async setRuntimeEnabled(name: string, enabled: boolean): Promise<RuntimeInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/runtimes/${encodeURIComponent(name)}/enabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to toggle runtime");
    return (await res.json()) as RuntimeInfo[];
  }

  // ──────────────────────────────────────────────
  // 团队级技能库（对齐后端 4c67aca 契约；后端未落地时技能库页回退 mock）
  // ──────────────────────────────────────────────

  /** GET /api/skills — 列表视图（merge=1 时 skills=胜出项、layers=逐层明细含被覆盖条目） */
  async listSkills(merge = false): Promise<SkillListView> {
    const res = await fetch(`${this.baseUrl}/api/skills${merge ? "?merge=1" : ""}`);
    if (!res.ok) throw await this.toApiError(res, "Failed to list skills");
    return (await res.json()) as SkillListView;
  }

  /** GET /api/skills/:name — 单个技能详情（含 prompt，「填入输入框」用） */
  async getSkill(name: string): Promise<SkillInfo> {
    const res = await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(name)}`);
    if (!res.ok) throw await this.toApiError(res, "Failed to get skill");
    return (await res.json()) as SkillInfo;
  }

  /** POST /api/skills — 添加团队级技能（.md 由后端拼装落盘；团队层重名 409） */
  async createSkill(req: SkillEntryInput): Promise<SkillInfo> {
    const res = await fetch(`${this.baseUrl}/api/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to create skill");
    return (await res.json()) as SkillInfo;
  }

  /** PATCH /api/skills/:name — 编辑（名称锁定；内置/本目录 = 在团队层创建同名覆盖） */
  async updateSkill(name: string, patch: Partial<SkillEntryInput>): Promise<SkillInfo> {
    const res = await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to update skill");
    return (await res.json()) as SkillInfo;
  }

  /** DELETE /api/skills/:name — 删除团队层文件（内置/本目录 409 提示用 reset） */
  async deleteSkill(name: string): Promise<{ ok: boolean; name: string }> {
    const res = await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!res.ok) throw await this.toApiError(res, "Failed to delete skill");
    return (await res.json()) as { ok: boolean; name: string };
  }

  /** POST /api/skills/:name/reset — 恢复默认（移除团队覆盖 + 解除停用） */
  async resetSkill(name: string): Promise<SkillInfo> {
    const res = await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(name)}/reset`, { method: "POST" });
    if (!res.ok) throw await this.toApiError(res, "Failed to reset skill");
    return (await res.json()) as SkillInfo;
  }

  /** GET /api/agent-tasks — 外派任务列表 */
  async listAgentTasks(): Promise<AgentTaskListResponse> {
    const res = await fetch(`${this.baseUrl}/api/agent-tasks`);
    if (!res.ok) throw await this.toApiError(res, "Failed to list agent tasks");
    return (await res.json()) as AgentTaskListResponse;
  }

  /** GET /api/agent-tasks/:id — 任务详情 + 事件日志 */
  async getAgentTask(taskId: string): Promise<AgentTaskDetailResponse> {
    const res = await fetch(`${this.baseUrl}/api/agent-tasks/${encodeURIComponent(taskId)}`);
    if (!res.ok) throw await this.toApiError(res, "Failed to get agent task");
    return (await res.json()) as AgentTaskDetailResponse;
  }

  /** POST /api/agent-tasks — 发起外派任务 */
  async createAgentTask(req: AgentTaskCreateRequest): Promise<AgentTask> {
    const res = await fetch(`${this.baseUrl}/api/agent-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to create agent task");
    return (await res.json()) as AgentTask;
  }

  /** POST /api/agent-tasks/:id/cancel — 取消（非终态可取消） */
  async cancelAgentTask(taskId: string): Promise<AgentTask> {
    const res = await fetch(`${this.baseUrl}/api/agent-tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to cancel agent task");
    return (await res.json()) as AgentTask;
  }

  /** POST /api/agent-tasks/:id/retry — 重试（终态 failed/cancelled/expired 可重试；幂等台账防重复执行） */
  async retryAgentTask(taskId: string): Promise<AgentTask> {
    const res = await fetch(`${this.baseUrl}/api/agent-tasks/${encodeURIComponent(taskId)}/retry`, {
      method: "POST",
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to retry agent task");
    return (await res.json()) as AgentTask;
  }

  /**
   * GET /api/agent-tasks/:id/stream — 任务流式进度（SSE）。
   * 与 sendMessage 同一套 fetch + ReadableStream 解析，但事件类型为 AgentTaskStreamEvent。
   */
  async *streamAgentTask(req: AgentTaskStreamRequest): AsyncGenerator<AgentTaskStreamEvent> {
    const res = await fetch(`${this.baseUrl}/api/agent-tasks/${encodeURIComponent(req.taskId)}/stream`, {
      signal: req.signal,
    });
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to stream agent task");
    }
    if (!res.body) {
      throw new Error("Response has no body");
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      while (true) {
        const idx = buffer.indexOf("\n\n");
        if (idx === -1) break;
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) continue;
        try {
          yield JSON.parse(dataLines.join("\n")) as AgentTaskStreamEvent;
        } catch {
          // 忽略无法解析的帧
        }
      }
    }
  }

  // ──────────────────────────────────────────────
  // 群聊（G1 契约 v1.0；后端未落地时页面自动回退 mock）
  // ──────────────────────────────────────────────

  /** GET /api/groups — 群列表 + 可选成员（runtime 卡片） */
  async listGroups(): Promise<GroupListResponse> {
    const res = await fetch(`${this.baseUrl}/api/groups`);
    if (!res.ok) throw await this.toApiError(res, "Failed to list groups");
    return (await res.json()) as GroupListResponse;
  }

  /** POST /api/groups — 建群 */
  async createGroup(req: GroupCreateRequest): Promise<GroupInfo> {
    const res = await fetch(`${this.baseUrl}/api/groups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to create group");
    return (await res.json()) as GroupInfo;
  }

  /** GET /api/groups/:id — 群详情 + 全量消息 */
  async getGroup(groupId: string): Promise<GroupDetailResponse> {
    const res = await fetch(`${this.baseUrl}/api/groups/${encodeURIComponent(groupId)}`);
    if (!res.ok) throw await this.toApiError(res, "Failed to get group");
    return (await res.json()) as GroupDetailResponse;
  }

  /** POST /api/groups/:id/messages — human 发言（fromKind 固定 human） */
  async sendGroupMessage(groupId: string, req: GroupMessageRequest): Promise<GroupMessage> {
    const res = await fetch(`${this.baseUrl}/api/groups/${encodeURIComponent(groupId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to send group message");
    return (await res.json()) as GroupMessage;
  }

  /** PATCH /api/groups/:id — 改发言模式（V2-3/V2-4） */
  async updateGroup(groupId: string, patch: { speechMode?: "coordinated" | "free" }): Promise<GroupInfo> {
    const res = await fetch(`${this.baseUrl}/api/groups/${encodeURIComponent(groupId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to update group");
    return (await res.json()) as GroupInfo;
  }

  /** GET /api/groups/:id/status — 编排状态快照（V2-4 状态条） */
  async getGroupStatus(groupId: string): Promise<{ speechMode: "coordinated" | "free"; rounds: number; maxRounds: number; lastSpeaker?: string; nextSpeaker?: string; budget?: { limit: number; remaining: Record<string, number> } }> {
    const res = await fetch(`${this.baseUrl}/api/groups/${encodeURIComponent(groupId)}/status`);
    if (!res.ok) throw await this.toApiError(res, "Failed to get group status");
    return await res.json();
  }

  /** POST /api/groups/:id/conclude — 结束讨论（幂等） */
  async concludeGroup(groupId: string): Promise<GroupInfo> {
    const res = await fetch(`${this.baseUrl}/api/groups/${encodeURIComponent(groupId)}/conclude`, {
      method: "POST",
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to conclude group");
    return (await res.json()) as GroupInfo;
  }

  /** POST /api/groups/:id/stop — 人类中途关停（收口 + 取消该群未终态任务，G3） */
  async stopGroup(groupId: string): Promise<GroupStopResponse> {
    const res = await fetch(`${this.baseUrl}/api/groups/${encodeURIComponent(groupId)}/stop`, {
      method: "POST",
    });
    if (!res.ok) throw await this.toApiError(res, "Failed to stop group");
    return (await res.json()) as GroupStopResponse;
  }

  /**
   * GET /api/groups/:id/stream?after=<seq> — 群 SSE（快照 → 回放 → 实时）。
   * 与 streamAgentTask 同一套 fetch + ReadableStream 解析。
   */
  async *streamGroup(
    groupId: string,
    after = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<GroupStreamEvent> {
    const res = await fetch(
      `${this.baseUrl}/api/groups/${encodeURIComponent(groupId)}/stream?after=${after}`,
      { signal },
    );
    if (!res.ok) throw await this.toApiError(res, "Failed to stream group");
    if (!res.body) throw new Error("Response has no body");
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      while (true) {
        const idx = buffer.indexOf("\n\n");
        if (idx === -1) break;
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) continue;
        try {
          yield JSON.parse(dataLines.join("\n")) as GroupStreamEvent;
        } catch {
          // 忽略无法解析的帧
        }
      }
    }
  }

  /**
   * 从 SSE Response 中解析 AgentEvent 事件流（fetch + ReadableStream 手动解析）。
   */
  private async *readSSEBody(res: Response): AsyncGenerator<AgentEvent> {
    if (!res.body) {
      throw new Error("Response has no body");
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += value;

      // SSE 帧以 \n\n 分隔
      while (true) {
        const idx = buffer.indexOf("\n\n");
        if (idx === -1) break;

        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const parsed = this.parseSSEChunk(rawEvent);
        if (parsed) {
          yield parsed;
        }
      }
    }
  }

  /** POST /api/sessions/:id/interrupt — 中断当前运行 */
  async interrupt(sessionId: string): Promise<boolean> {
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${sessionId}/interrupt`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to interrupt");
    }
    const data = (await res.json()) as { interrupted: boolean };
    return data.interrupted;
  }

  // ──────────────────────────────────────────────
  // 权限
  // ──────────────────────────────────────────────

  /** POST /api/sessions/:id/permissions/:reqId — 响应权限请求 */
  async respondPermission(
    sessionId: string,
    reqId: string,
    result: PermissionResult,
  ): Promise<boolean> {
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${sessionId}/permissions/${reqId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      },
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to respond permission");
    }
    const data = (await res.json()) as { responded: boolean };
    return data.responded;
  }

  /** GET /api/sessions/:id/permissions — 获取待处理权限请求 */
  async getPendingPermissions(
    sessionId: string,
  ): Promise<
    Array<Omit<import("./types.ts").PermissionRequest, "resolve" | "reject">>
  > {
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${sessionId}/permissions`,
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get pending permissions");
    }
    return await res.json();
  }

  // ──────────────────────────────────────────────
  // 模型
  // ──────────────────────────────────────────────

  /** GET /api/models — 获取可用模型列表 */
  async getModels(): Promise<ModelsResponse> {
    const res = await fetch(`${this.baseUrl}/api/models`);
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get models");
    }
    return (await res.json()) as ModelsResponse;
  }

  // ──────────────────────────────────────────────
  // 导出
  // ──────────────────────────────────────────────

  /** GET /api/sessions/:id/export — 导出会话为 JSON */
  async exportSession(sessionId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/export`);
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to export session");
    }
    return await res.text();
  }

  // ──────────────────────────────────────────────
  // 对话图（Phase 3/4：分支可视化 + 回退）
  // ──────────────────────────────────────────────

  /** GET /api/sessions/:id/graph — 获取会话对话图（节点/分支/溯源链） */
  async getGraph(sessionId: string): Promise<GraphData> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/graph`);
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get graph");
    }
    return (await res.json()) as GraphData;
  }

  /** POST /api/sessions/:id/rollback — 回退到目标节点（旧分支保留可溯源） */
  async rollbackSession(
    sessionId: string,
    nodeId?: string,
    reason = "用户回退",
  ): Promise<RollbackResponse> {
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${sessionId}/rollback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(nodeId ? { nodeId } : {}),
          ...(reason ? { reason } : {}),
        }),
      },
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to rollback session");
    }
    return (await res.json()) as RollbackResponse;
  }

  // ──────────────────────────────────────────────
  // 可观测性（AgentLoop 观测面板）
  // ──────────────────────────────────────────────

  /** GET /api/observability/traces — 列出全部 trace 日志文件 */
  async listTraces(): Promise<TraceFileMeta[]> {
    const res = await fetch(`${this.baseUrl}/api/observability/traces`);
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to list traces");
    }
    return (await res.json()) as TraceFileMeta[];
  }

  /** GET /api/observability/traces/:date — 指定日期的指标分析 */
  async getTraceAnalysis(
    date: string,
    options?: { includeTest?: boolean },
  ): Promise<TraceAnalysisResponse> {
    const qs = options?.includeTest ? "?includeTest=1" : "";
    const res = await fetch(
      `${this.baseUrl}/api/observability/traces/${encodeURIComponent(date)}${qs}`,
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get trace analysis");
    }
    return (await res.json()) as TraceAnalysisResponse;
  }

  /** GET /api/observability/traces/:date/callchain — 指定日期的完整调用链 */
  async getCallChains(
    date: string,
    options?: { includeTest?: boolean },
  ): Promise<CallChainResponse> {
    const qs = options?.includeTest ? "?includeTest=1" : "";
    const res = await fetch(
      `${this.baseUrl}/api/observability/traces/${encodeURIComponent(date)}/callchain${qs}`,
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get call chains");
    }
    return (await res.json()) as CallChainResponse;
  }

  /** GET /api/observability/traces/:date/callchain?sessionId&messageId — 单条消息轮次的调用链（deep-link） */
  async getCallChainForMessage(
    date: string,
    sessionId: string,
    messageId: string,
  ): Promise<CallChainResponse> {
    const params = new URLSearchParams({ sessionId, messageId });
    const res = await fetch(
      `${this.baseUrl}/api/observability/traces/${encodeURIComponent(date)}/callchain?${params.toString()}`,
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get message call chain");
    }
    return (await res.json()) as CallChainResponse;
  }

  /** GET /api/observability/traces/:date/messages?sessionId — 指定会话的按消息粒度摘要（消息选择器） */
  async getMessageTraces(date: string, sessionId: string): Promise<MessageTracesResponse> {
    const params = new URLSearchParams({ sessionId });
    const res = await fetch(
      `${this.baseUrl}/api/observability/traces/${encodeURIComponent(date)}/messages?${params.toString()}`,
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get message traces");
    }
    return (await res.json()) as MessageTracesResponse;
  }

  // ──────────────────────────────────────────────
  // 评测模块
  // ──────────────────────────────────────────────

  /** GET /api/eval/overview — 评测报告 / 自优化建议 / 测试集清单 */
  async getEvalOverview(): Promise<EvalOverview> {
    const res = await fetch(`${this.baseUrl}/api/eval/overview`);
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get eval overview");
    }
    return (await res.json()) as EvalOverview;
  }

  /** GET /api/eval/reports/:date — 评测报告（Markdown） */
  async getEvalReport(date: string): Promise<MarkdownReport> {
    const res = await fetch(
      `${this.baseUrl}/api/eval/reports/${encodeURIComponent(date)}`,
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get eval report");
    }
    return (await res.json()) as MarkdownReport;
  }

  /** GET /api/eval/optimizations/:date — 自优化建议报告（Markdown） */
  async getOptimizationReport(date: string): Promise<MarkdownReport> {
    const res = await fetch(
      `${this.baseUrl}/api/eval/optimizations/${encodeURIComponent(date)}`,
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get optimization report");
    }
    return (await res.json()) as MarkdownReport;
  }

  /** GET /api/eval/testsets/:name — 单个测试集原始 JSON */
  async getTestSet(name: string): Promise<unknown> {
    const res = await fetch(
      `${this.baseUrl}/api/eval/testsets/${encodeURIComponent(name)}`,
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get test set");
    }
    return await res.json();
  }

  /** GET /api/eval/messages/:date?sessionId&messageId — 单条消息评测（trace 指标 + judge 状态） */
  async getMessageEval(
    date: string,
    sessionId: string,
    messageId: string,
  ): Promise<MessageEvalResponse> {
    const params = new URLSearchParams({ sessionId, messageId });
    const res = await fetch(
      `${this.baseUrl}/api/eval/messages/${encodeURIComponent(date)}?${params.toString()}`,
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get message eval");
    }
    return (await res.json()) as MessageEvalResponse;
  }

  /**
   * POST /api/eval/reports — 触发生成评测报告（复用 CLI 评测管线）。
   *
   * 服务端为真实 LLM/CPU 工作，耗时较长；成功时返回刷新后的三合一清单。
   */
  async generateEvalReport(
    date?: string,
    options?: { optimize?: boolean },
  ): Promise<EvalOverview & { date: string }> {
    const res = await fetch(`${this.baseUrl}/api/eval/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, optimize: options?.optimize === true }),
    });
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to generate eval report");
    }
    return (await res.json()) as EvalOverview & { date: string };
  }

  // ──────────────────────────────────────────────
  // 插件管理与市场（/api/plugins）
  // ──────────────────────────────────────────────

  /** GET /api/plugins — 已装插件列表 */
  async listPlugins(): Promise<PluginsListResponse> {
    const res = await fetch(`${this.baseUrl}/api/plugins`, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to list plugins");
    }
    return (await res.json()) as PluginsListResponse;
  }

  /** POST /api/plugins/install — 本地源安装（目录或 .tgz 路径） */
  async installPluginFromSource(source: string): Promise<PluginMutationResult> {
    const res = await fetch(`${this.baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source }),
    });
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to install plugin");
    }
    return (await res.json()) as PluginMutationResult;
  }

  /** POST /api/plugins/install — 市场安装（`{marketName, marketVersion?}`，spec 由服务端从 catalog 策展解析，marketVersion 缺省 = latest） */
  async installPluginFromMarket(name: string, version?: string): Promise<PluginMutationResult> {
    const res = await fetch(`${this.baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marketName: name, ...(version ? { marketVersion: version } : {}) }),
    });
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to install market plugin");
    }
    return (await res.json()) as PluginMutationResult;
  }

  /** POST /api/plugins/:id/enable|disable — 启停插件 */
  async setPluginEnabled(id: string, enabled: boolean): Promise<PluginMutationResult> {
    const res = await fetch(
      `${this.baseUrl}/api/plugins/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`,
      { method: "POST" },
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to toggle plugin");
    }
    return (await res.json()) as PluginMutationResult;
  }

  /** DELETE /api/plugins/:id — 卸载插件 */
  async uninstallPlugin(id: string): Promise<PluginMutationResult> {
    const res = await fetch(`${this.baseUrl}/api/plugins/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to uninstall plugin");
    }
    return (await res.json()) as PluginMutationResult;
  }

  /** GET /api/plugins/market — 市场目录（服务端搜索分页） */
  async getMarketCatalog(query: MarketQuery = {}): Promise<MarketCatalogResponse> {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.category) params.set("category", query.category);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    const qs = params.toString();
    const res = await fetch(`${this.baseUrl}/api/plugins/market${qs ? `?${qs}` : ""}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to load market catalog");
    }
    return (await res.json()) as MarketCatalogResponse;
  }


  // ──────────────────────────────────────────────
  // SSE 解析
  // ──────────────────────────────────────────────

  /**
   * 解析单个 SSE 帧（event: xxx\ndata: {...}）。
   */
  private parseSSEChunk(chunk: string): AgentEvent | null {
    const lines = chunk.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    if (lines.length === 0) return null;

    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
      // "event:" 行不需要单独解析——data JSON 中已包含 type
    }

    if (dataLines.length === 0) return null;

    try {
      return JSON.parse(dataLines.join("\n")) as AgentEvent;
    } catch {
      return null;
    }
  }

  /** 将非 OK 响应转换为 ApiError */
  private async toApiError(res: Response, fallback: string): Promise<ApiError> {
    let message = fallback;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: string } };
      if (body?.error?.message) {
        message = body.error.message;
        code = body.error.code;
      }
    } catch {
      // 非 JSON 响应
    }
    return new ApiError(message, res.status, code);
  }
}

/** 创建默认 API 客户端实例 */
export function createApiClient(baseUrl?: string): ApiClient {
  return new ApiClient(baseUrl);
}
