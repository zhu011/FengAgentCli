/**
 * @fengagent/server — HTTP 服务入口
 *
 * Hono HTTP 服务，为 WebUI 提供后端 API 和 SSE 流式推送。
 *
 * 职责：
 * - 创建 Hono 应用
 * - 注册 CORS 中间件
 * - 挂载 API 路由（/api/sessions, /api/models, /api/health）
 * - 静态文件服务（生产模式托管 web-ui 构建产物）
 * - 启动 HTTP 服务监听
 *
 * 参考 ARCHITECTURE.md 第 6.2 节（WebUI 模式）。
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import type { Config } from "@fengagent/core";
import type { Agent } from "@fengagent/agent";
import { SessionManager } from "./session-manager.ts";
import { createSessionRoutes } from "./routes/sessions.ts";
import { createModelRoutes } from "./routes/models.ts";
import { createHealthRoutes } from "./routes/health.ts";
import { createObservabilityRoutes, extractLiveSession } from "./routes/observability.ts";
import { createEvalRoutes } from "./routes/eval.ts";

/** Server 构造选项 */
export interface ServerOptions {
  /** 配置 */
  config: Config;
  /** Agent 工厂函数（每次创建会话时调用） */
  createAgent: () => Agent;
  /** 静态文件目录（可选，生产模式托管 WebUI） */
  staticDir?: string;
  /** 可选的 SessionStore，用于跨重启恢复历史会话 */
  sessionStore?: import("@fengagent/agent").SessionStore;
}

/**
 * 创建 Hono 应用（不启动监听）。
 *
 * 包含：
 * - CORS 中间件
 * - /api/health — 健康检查
 * - /api/sessions — 会话管理 + SSE 流
 * - /api/models — 模型列表
 * - 静态文件服务（如果 staticDir 提供）
 *
 * @param options - 服务选项
 * @returns Hono 应用实例 + SessionManager
 */
export function createApp(options: ServerOptions): {
  app: Hono;
  sessionManager: SessionManager;
} {
  const { config, createAgent, staticDir, sessionStore } = options;

  // 创建会话管理器
  const sessionManager = new SessionManager({ createAgent, sessionStore });

  // 创建 Hono 应用
  const app = new Hono();

  // CORS 中间件
  app.use(
    "*",
    cors({
      origin: config.corsOrigin,
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  // API 路由
  app.route("/api/health", createHealthRoutes());
  app.route("/api/sessions", createSessionRoutes(sessionManager));
  app.route("/api/models", createModelRoutes(config));

  // 可观测性（AgentLoop 观测面板） + 评测模块（WebUI）
  // 调用链中的工具返回结果优先从实时会话消息回填
  app.route(
    "/api/observability",
    createObservabilityRoutes({
      getLiveSession: (sessionId) => {
        const session = sessionManager.getSession(sessionId);
        if (!session) return undefined;
        return extractLiveSession(session.messages);
      },
    }),
  );
  app.route("/api/eval", createEvalRoutes());

  // 静态文件服务（生产模式托管 WebUI 构建产物）
  if (staticDir) {
    app.use("/*", serveStatic({ root: staticDir }));
  }

  return { app, sessionManager };
}

/**
 * 启动 HTTP 服务。
 *
 * 监听 config.serverHost:config.serverPort（默认 127.0.0.1:3000）。
 * 可通过环境变量 FENG_SERVER_PORT / FENG_SERVER_HOST 覆盖。
 *
 * @param options - 服务选项
 * @returns 服务实例 + SessionManager
 */
export function startServer(options: ServerOptions): {
  server: ReturnType<typeof Bun.serve>;
  sessionManager: SessionManager;
} {
  const { app, sessionManager } = createApp(options);
  const { config } = options;

  const server = Bun.serve({
    port: config.serverPort,
    hostname: config.serverHost,
    fetch: app.fetch,
  });

  console.log(
    `FengAgent server listening on http://${config.serverHost}:${config.serverPort}`,
  );

  return { server, sessionManager };
}

/**
 * 启动服务的便捷函数（从环境变量加载配置）。
 *
 * 读取 FENG_* 环境变量，创建 Agent 工厂，启动服务。
 *
 * @param createAgent - Agent 工厂函数
 * @param config - 已加载的配置
 * @param staticDir - 可选静态文件目录
 */
export function serve(
  createAgent: () => Agent,
  config: Config,
  staticDir?: string,
): void {
  startServer({ config, createAgent, staticDir });
}
