/**
 * @fengagent/server — ACP (Agent Communication Protocol) 适配层
 *
 * 实现 Multica 桌面守护进程所需的 ACP 兼容接口，
 * 使 FengAgentCli 可被 Multica 自动发现并作为运行时使用。
 *
 * 协议端点：
 * - POST /agent        — 接收任务上下文和提示，返回 SSE 流式事件
 * - POST /agent/cancel — 中断运行中任务
 *
 * AgentEvent → ACP 事件映射：
 * - text-delta      → text/generated
 * - tool-call-start → tool/start
 * - tool-call-result→ tool/end
 * - turn-end        → turn/end
 * - error           → error
 *
 * 参考 Kimi/Hermes ACP 实现模式。
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { AgentEvent, Config } from "@fengagent/core";
import type { Agent } from "@fengagent/agent";

/** ACP 请求体 */
interface AcpAgentRequest {
  /** 用户提示文本 */
  prompt: string;
  /** 可选工作目录 */
  workdir?: string;
  /** 可选模型覆盖 */
  model?: string;
  /** 可选会话 ID（恢复已有会话） */
  sessionId?: string;
}

/** ACP 事件类型 */
type AcpEvent =
  | { type: "text/generated"; text: string }
  | { type: "tool/start"; id: string; name: string; input: unknown }
  | {
      type: "tool/end";
      id: string;
      result: { content: string; isError?: boolean };
    }
  | { type: "turn/end"; reason: string }
  | { type: "error"; message: string }
  | { type: "session/start"; sessionId: string }
  | { type: "session/end" };

/** 运行中任务句柄 */
interface RunningAcpTask {
  aborted: boolean;
  abort: () => void;
}

/** ACP Server 构造选项 */
export interface AcpServerOptions {
  /** 配置 */
  config: Config;
  /** Agent 工厂函数 */
  createAgent: () => Agent;
}

/**
 * 将 AgentEvent 转换为 ACP 事件格式。
 */
function agentEventToAcp(event: AgentEvent): AcpEvent | null {
  switch (event.type) {
    case "session-start":
      return { type: "session/start", sessionId: event.session.id };

    case "text-delta":
      return { type: "text/generated", text: event.text };

    case "tool-call-start":
      return {
        type: "tool/start",
        id: event.toolUseId,
        name: event.name,
        input: event.input,
      };

    case "tool-call-result":
      return {
        type: "tool/end",
        id: event.toolUseId,
        result: event.result,
      };

    case "turn-end":
      return { type: "turn/end", reason: event.reason };

    case "error":
      return { type: "error", message: event.error.message };

    case "session-end":
      return { type: "session/end" };

    // 其他事件不需要映射
    default:
      return null;
  }
}

/**
 * 创建 ACP 兼容 Hono 应用。
 *
 * 端点：
 * - POST /agent — 启动 Agent 执行，返回 SSE 流
 * - POST /agent/cancel — 中断当前任务
 * - GET /health — 健康检查
 *
 * @param options - 服务选项
 * @returns Hono 应用实例
 */
export function createAcpApp(options: AcpServerOptions): Hono {
  const { createAgent } = options;

  // 运行中任务（单会话模式，ACP 协议为单任务）
  let runningTask: RunningAcpTask | null = null;

  const app = new Hono();

  // CORS
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  // 健康检查
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      provider: "fengagent",
      version: "0.1.0",
    }),
  );

  // POST /agent — 接收任务并返回 SSE 流式事件
  app.post("/agent", (c) =>
    streamSSE(c, async (stream) => {
      const body = await c.req.json().catch(() => ({} as AcpAgentRequest));
      const prompt =
        typeof body.prompt === "string"
          ? body.prompt
          : typeof body.content === "string"
            ? body.content
            : "";

      if (!prompt) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ type: "error", message: "prompt is required" }),
        });
        return;
      }

      // 中断之前的任务
      if (runningTask) {
        runningTask.aborted = true;
        runningTask.abort();
        runningTask = null;
      }

      // 创建 Agent 实例
      const agent = createAgent();
      const session = agent.createSession();

      // 应用模型覆盖
      if (typeof body.model === "string" && body.model) {
        session.model = body.model;
      }

      // 创建中断控制器
      const abortController = new AbortController();
      runningTask = {
        aborted: false,
        abort: () => abortController.abort(),
      };

      try {
        const generator = agent.prompt(prompt, session);

        for await (const event of generator) {
          if (runningTask.aborted) {
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({
                type: "error",
                message: "Task cancelled",
              }),
            });
            break;
          }

          const acpEvent = agentEventToAcp(event);
          if (acpEvent) {
            await stream.writeSSE({
              event: acpEvent.type,
              data: JSON.stringify(acpEvent),
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ type: "error", message }),
        });
      } finally {
        runningTask = null;
      }
    }),
  );

  // POST /agent/cancel — 中断运行中任务
  app.post("/agent/cancel", (c) => {
    if (runningTask) {
      runningTask.aborted = true;
      runningTask.abort();
      runningTask = null;
      return c.json({ cancelled: true });
    }
    return c.json({ cancelled: false, message: "No running task" }, 404);
  });

  return app;
}

/**
 * 启动 ACP 兼容服务。
 *
 * 监听指定端口，提供 ACP 协议接口供 Multica 守护进程调用。
 *
 * @param options - 服务选项
 * @returns Bun 服务实例
 */
export function startAcpServer(options: AcpServerOptions): ReturnType<typeof Bun.serve> {
  const app = createAcpApp(options);

  // ACP 服务使用独立端口，默认 0（随机端口，由 Multica 守护进程发现）
  const port = options.config.serverPort + 1;

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: app.fetch,
  });

  console.log(`FengAgent ACP server listening on http://127.0.0.1:${port}`);

  return server;
}
