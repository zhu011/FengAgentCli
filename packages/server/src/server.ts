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
import type { LLMClient } from "@fengagent/llm";
import { SessionManager } from "./session-manager.ts";
import { createSessionRoutes } from "./routes/sessions.ts";
import { createModelRoutes } from "./routes/models.ts";
import { createHealthRoutes } from "./routes/health.ts";
import { createObservabilityRoutes, extractLiveSession } from "./routes/observability.ts";
import { createEvalRoutes } from "./routes/eval.ts";
import { createAgentTaskRoutes, createRuntimeRoutes } from "./routes/agent-tasks.ts";
import { createGroupRoutes } from "./routes/groups.ts";
import { createGroupMcpRoutes } from "./mcp-groups.ts";
import { createWebuiRoutes, type WebuiRouteSource } from "./routes/webui.ts";
import { createPluginRoutes, type PluginRouteSource, type MarketRouteSource } from "./routes/plugins.ts";
import { createSettingsRoutes, type SettingsRouteSource } from "./routes/settings.ts";
import { createSkillRoutes } from "./routes/skills.ts";
import type { AgentTaskService } from "./agent-task-service.ts";
import type { AgentGroupService } from "@fengagent/groups";
import type { GroupOrchestrator } from "@fengagent/groups";

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
  /** LLM 客户端（可选；评测模块 per-message judgeMessage 使用，缺失时 judge 返回 null） */
  llmClient?: LLMClient;
  /**
   * per-message judge 缓存根目录（可选；默认 <数据根>/judge-cache）。
   * 测试用它隔离缓存，避免用例间互相命中。
   */
  judgeCacheRoot?: string;
  /**
   * 外派任务服务（Agents 页 / `dispatch_task`）。
   *
   * 缺省时不挂 `/api/runtimes` 与 `/api/agent-tasks`（WebUI 会回退演示数据），
   * 生产入口 `entry.ts` 会传 `createRuntimeAgent().agentTaskService`。
   */
  agentTaskService?: AgentTaskService;
  /**
   * 群聊服务（群聊页 `/api/groups` + 群工具）。
   *
   * 缺省时不挂 `/api/groups`（前端群聊页会提示后端未就绪）。
   */
  agentGroupService?: AgentGroupService;
  /** 数据根（v2：群 MCP token 持久化） */
  dataRoot?: string;
  /**
   * 群编排器（G3）：提供时 `/api/groups/:id/conclude|stop` 走它（收口说明 + 取消在跑任务）。
   */
  agentGroupOrchestrator?: GroupOrchestrator;
  /**
   * WebUI 插件注册表（S1：`ctx.webui`）。
   *
   * 提供时挂 `/api/webui/manifest` 与 `/api/webui/assets/*`；缺省不挂
   * （测试/无插件场景），前端据此回退「无插件」。
   */
  webui?: WebuiRouteSource;
  /**
   * 插件管理面（S2：`ctx.plugins`）。
   *
   * 提供时挂 `/api/plugins`（列表/安装/启停/卸载）；缺省不挂，
   * 前端据此把「插件」tab 显示为不可用。
   */
  plugins?: PluginRouteSource;
  /**
   * 插件市场目录（A：`/api/plugins/market` + `/api/plugins/market/:name`）。
   *
   * 与 `plugins` 同时提供时，市场安装（`marketName`）先过 catalog 策展校验（B）。
   */
  market?: MarketRouteSource;
  /**
   * 模型设置面（S3：`/api/settings/model` + `/api/settings/providers`）。
   *
   * 提供时挂 `/api/settings`；缺省不挂（测试 / 无 runtime 场景），
   * 前端据此把「模型」tab 显示为不可用。
   */
  settings?: SettingsRouteSource;
  /**
   * 团队级技能库（P0：`/api/skills`）。
   *
   * 缺省即挂载（技能是本地文件，无外部依赖）；`workdir` 决定「本目录」层，
   * `teamDir` 给测试注入临时团队根，不传则按 `FENG_TEAM_HOME` / `~/.fengagent-cordis` 解析。
   */
  skills?: {
    workdir?: string;
    teamDir?: string;
    env?: Record<string, string | undefined>;
  };
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
  const { config, createAgent, staticDir, sessionStore, llmClient, judgeCacheRoot } = options;

  // 创建会话管理器
  const sessionManager = new SessionManager({ createAgent, sessionStore });

  // 创建 Hono 应用
  const app = new Hono();

  // CORS 中间件
  app.use(
    "*",
    cors({
      origin: config.corsOrigin,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  // API 路由
  app.route("/api/health", createHealthRoutes());
  app.route("/api/sessions", createSessionRoutes(sessionManager));
  app.route("/api/models", createModelRoutes(config));

  // Agents 外派能力（P2 契约：runtime 卡片 + 任务列表/详情/取消/重试/SSE）
  // 服务缺失时不挂路由 —— WebUI 探测 /api/runtimes 404 后自动回退演示数据。
  if (options.agentTaskService) {
    app.route("/api/runtimes", createRuntimeRoutes(options.agentTaskService));
    app.route("/api/agent-tasks", createAgentTaskRoutes(options.agentTaskService));
  }

  // 群聊（G1：群 CRUD + 消息 + 群 SSE；G3：conclude/stop 走编排器）
  // 缺服务时不挂，前端群聊页据此提示未就绪。
  if (options.agentGroupService) {
    app.route(
      "/api/groups",
      createGroupRoutes(options.agentGroupService, options.agentGroupOrchestrator),
    );
    // v2 V2-1：群 MCP 服务面（claude/kimi 等外部 CLI 直连发言；token 绑定成员身份）
    app.route("/api/groups/mcp", createGroupMcpRoutes(options.agentGroupService, options.dataRoot ?? "."));
  }

  // 可观测性（AgentLoop 观测面板） + 评测模块（WebUI）
  // 调用链中的工具返回结果优先从实时会话消息回填；
  // per-message 深链（用户消息 → 助手轮次）通过会话消息解析
  app.route(
    "/api/observability",
    createObservabilityRoutes({
      getLiveSession: (sessionId) => {
        const session = sessionManager.getSession(sessionId);
        if (!session) return undefined;
        return extractLiveSession(session.messages);
      },
      getSessionMessages: (sessionId) => {
        const session = sessionManager.getSession(sessionId);
        return session?.messages as unknown as import("./routes/observability.ts").SessionMessageLike[] | undefined;
      },
    }),
  );
  app.route("/api/eval", createEvalRoutes({
    getSessionMessages: (sessionId) => {
      const session = sessionManager.getSession(sessionId);
      return session?.messages as unknown as import("./routes/observability.ts").SessionMessageLike[] | undefined;
    },
    // per-message LLM-judge：llmClient 缺失时 judge 返回 null（评测页展示等待接入提示）
    llmClient,
    ...(judgeCacheRoot ? { judgeCacheRoot } : {}),
  }));

  // S1：WebUI 插件装载链 —— 插件清单 + 插件静态资源（白名单 dataRoot/plugins）
  if (options.webui) {
    app.route("/api/webui", createWebuiRoutes(options.webui));
  }

  // S2 + A/B：插件管理面 —— 列表/安装/启停/卸载 + 市场目录（服务端搜索分页）
  if (options.plugins) {
    app.route("/api/plugins", createPluginRoutes(options.plugins, options.market));
  }

  // S3：模型设置面 —— 生效值 / 来源 / 环境变量锁定 + PATCH 落盘并热切换
  if (options.settings) {
    app.route("/api/settings", createSettingsRoutes(options.settings));
  }

  // 团队级技能库（P0）：三层合并视图 + CRUD + 启用停用 + 恢复默认
  // 常驻挂载：技能就是本地 .md，无外部服务依赖
  app.route(
    "/api/skills",
    createSkillRoutes({
      workdir: options.skills?.workdir ?? process.cwd(),
      ...(options.skills?.teamDir ? { teamDir: options.skills.teamDir } : {}),
      ...(options.skills?.env ? { env: options.skills.env } : {}),
    }),
  );

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
    // 请求超时（秒，Bun 默认 10s）。评测路由的 per-message LLM-judge 是真实模型调用
    // （实测 10–33s+），默认 10s 会在评审完成前掐断连接（HTTP 000），而服务端仍跑完 →
    // 前端永远停在「加载中」且白烧 token。评审已改为「缓存 + 默认异步」，这里的 120s
    // 只是给 `?sync=1` 同步路径和报告生成（runEval）留足余量。
    idleTimeout: 120,
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
