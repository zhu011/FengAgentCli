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
  CallChainResponse,
  EvalOverview,
  MarkdownReport,
  MessageEvalResponse,
  MessageTracesResponse,
  ModelsResponse,
  PermissionResult,
  Session,
  SessionMeta,
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
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${req.sessionId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: req.content,
          ...(req.model ? { model: req.model } : {}),
        }),
        signal: req.signal,
      },
    );

    if (!res.ok) {
      throw await this.toApiError(res, "Failed to send message");
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
  async getTraceAnalysis(date: string): Promise<TraceAnalysisResponse> {
    const res = await fetch(
      `${this.baseUrl}/api/observability/traces/${encodeURIComponent(date)}`,
    );
    if (!res.ok) {
      throw await this.toApiError(res, "Failed to get trace analysis");
    }
    return (await res.json()) as TraceAnalysisResponse;
  }

  /** GET /api/observability/traces/:date/callchain — 指定日期的完整调用链 */
  async getCallChains(date: string): Promise<CallChainResponse> {
    const res = await fetch(
      `${this.baseUrl}/api/observability/traces/${encodeURIComponent(date)}/callchain`,
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

  /** GET /api/eval/messages/:date?sessionId&messageId — 单条消息评测（trace 摘要 + judge 扩展点） */
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
