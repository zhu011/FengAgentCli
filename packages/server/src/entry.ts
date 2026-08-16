/**
 * @fengagent/server — 独立运行入口
 *
 * 用法：
 *   bun run packages/server/src/entry.ts
 *   bun run serve
 *
 * 从 config.json + 环境变量分层加载配置，经 createRuntimeAgent 插件化装配
 * （模型/工具/策略/存储/上下文/loop/图 全部走 Cordis 插件，与 CLI `serve`
 * 共用同一装配），启动 HTTP 服务。
 *
 * 经 RuntimeAgent 装配后，graph API（GET /api/sessions/:id/graph、
 * POST /api/sessions/:id/rollback）与 CLI serve 路径能力一致。
 */

import { loadConfig } from "@fengagent/core";
import { startServer } from "./server.ts";
import { createRuntimeAgent } from "./create-runtime-agent.ts";
import { resolve } from "node:path";
import { createLogger } from "@fengagent/shared";

const log = createLogger("server-entry");

async function main() {
  // 分层加载配置：默认值 → 全局配置 → 项目配置 → 环境变量
  const config = await loadConfig();

  log.info("main", `config loaded provider=${config.provider}, model=${config.model}, autoApproveTools=${config.autoApproveTools}`);

  // 权限配置注入：config.autoApproveTools → FENG_AUTO_APPROVE_TOOLS 环境变量
  // createPermissionChecker 读取的是环境变量，不是 config 对象，必须同步注入
  if (config.autoApproveTools && !process.env.FENG_AUTO_APPROVE_TOOLS) {
    process.env.FENG_AUTO_APPROVE_TOOLS = "true";
  }
  if (config.allowedTools && !process.env.FENG_ALLOWED_TOOLS) {
    process.env.FENG_ALLOWED_TOOLS = config.allowedTools;
  }
  if (config.deniedTools && !process.env.FENG_DENIED_TOOLS) {
    process.env.FENG_DENIED_TOOLS = config.deniedTools;
  }

  // 与 CLI `serve` 共用同一装配：createRuntimeAgent
  // 模型/工具/上下文/存储/图/loop 全部经 createRuntime 插件化装配；
  // 每个会话一个 RuntimeAgent 实例，共享同一 runtime（ctx.storage / ctx.graph）
  const runtimeResult = await createRuntimeAgent();
  const runtimeConfig = runtimeResult.config;

  log.info("main", `runtime agent ready provider=${runtimeConfig.provider}, model=${runtimeConfig.model}`);

  // 静态文件目录（web-ui 构建产物）
  // 从项目根目录（cwd）出发查找 web-ui/dist
  const workdir = process.cwd();
  const staticDir = resolve(workdir, "packages/web-ui/dist");

  log.info("main", `staticDir=${staticDir}`);
  log.info("main", `server starting host=${runtimeConfig.serverHost}, port=${runtimeConfig.serverPort}`);
  startServer({
    config: runtimeConfig,
    createAgent: () => runtimeResult.makeAgent(),
    staticDir,
    // Phase 3：跨重启恢复历史会话（与 ctx.storage 同一份 SessionStore）
    sessionStore: runtimeResult.sessionStore ?? undefined,
  });
}

main();
