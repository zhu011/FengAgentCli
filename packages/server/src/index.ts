/**
 * @fengagent/server — HTTP Server + SSE 流式推送
 *
 * 为 WebUI 提供后端 HTTP API 和 SSE 流式推送。
 *
 * 模块：
 * - createApp / startServer — Hono 应用创建与启动
 * - SessionManager — 会话管理 + 权限交互
 * - SSE helpers — AgentEvent → SSE 帧转换
 *
 * 参考 ARCHITECTURE.md 第 6.2 节。
 */

// 服务入口
export { createApp, startServer, serve } from "./server.ts";
export type { ServerOptions } from "./server.ts";

// 会话管理器
export { SessionManager, SessionNotFoundError } from "./session-manager.ts";
export type {
  PermissionRequest,
  SessionManagerOptions,
} from "./session-manager.ts";

// SSE 工具
export {
  agentEventToSSE,
  encodeSSEFrame,
  encodeAgentEventStream,
  SSE_HEARTBEAT,
} from "./sse.ts";
export type { SSEFrame } from "./sse.ts";

// 路由
export { createSessionRoutes } from "./routes/sessions.ts";
export { createModelRoutes, getDefaultModels } from "./routes/models.ts";
export { createHealthRoutes } from "./routes/health.ts";

// ACP 适配层
export { createAcpApp, startAcpServer } from "./acp-server.ts";
export type { AcpServerOptions } from "./acp-server.ts";

// 运行时 Agent 装配（CLI serve 与 server 入口共用同一装配）
export {
  createRuntimeAgent,
  RuntimeAgent,
  reloadProvider,
  buildEnvForLLM,
} from "./create-runtime-agent.ts";
export type {
  CreateRuntimeAgentOptions,
  CreateRuntimeAgentResult,
} from "./create-runtime-agent.ts";
