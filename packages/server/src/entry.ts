/**
 * @fengagent/server — 独立运行入口
 *
 * 用法：
 *   bun run packages/server/src/entry.ts
 *   bun run serve
 *
 * 从 config.json + 环境变量分层加载配置，创建 Agent，启动 HTTP 服务。
 */

import { loadConfig } from "@fengagent/core";
import { Agent } from "@fengagent/agent";
import { SessionStore } from "@fengagent/agent";
import { createClientFromEnv } from "@fengagent/llm";
import {
  createToolRegistry,
  createToolExecutor,
  registerBuiltinTools,
  createPermissionChecker,
  createHookRegistry,
} from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { startServer } from "./server.ts";
import { resolve } from "node:path";
import { createLogger } from "@fengagent/shared";

const log = createLogger("server-entry");

async function main() {
  // 分层加载配置：默认值 → 全局配置 → 项目配置 → 环境变量
  const config = await loadConfig();

  log.info("main", `config loaded provider=${config.provider}, model=${config.model}, autoApproveTools=${config.autoApproveTools}`);

  // 将 config 中的 API 配置注入为等效环境变量（供 createClientFromEnv 使用）
  // 仅在环境变量未设置时注入，避免覆盖用户显式设置的环境变量
  const envForLLM: Record<string, string | undefined> = { ...process.env };
  function injectConfigEnv(key: string, configVal: string | undefined) {
    if (configVal !== undefined && configVal !== "" && !envForLLM[key]) {
      envForLLM[key] = configVal;
    }
  }
  injectConfigEnv("FENG_PROVIDER", config.provider);
  injectConfigEnv("FENG_MODEL", config.model);
  injectConfigEnv("ANTHROPIC_API_KEY", config.anthropicApiKey);
  injectConfigEnv("OPENAI_API_KEY", config.openaiApiKey);
  injectConfigEnv("OPENAI_COMPATIBLE_API_KEY", config.openaiCompatibleApiKey);
  injectConfigEnv("OPENAI_COMPATIBLE_BASE_URL", config.openaiCompatibleBaseUrl);
  injectConfigEnv("OPENAI_COMPATIBLE_MODEL", config.openaiCompatibleModel);

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

  const { client } = createClientFromEnv(envForLLM);
  const workdir = process.cwd();

  // 共享 Hook 注册器和权限检查器
  const hookRegistry = createHookRegistry();
  const permissionChecker = createPermissionChecker(workdir);

  // SQLite 会话持久化 — 让 WebUI 跨重启恢复历史会话
  const dbPath = resolve(workdir, ".fengagent", "sessions.db");
  const sessionStore = new SessionStore(dbPath);
  log.info("main", `sessionStore dbPath=${dbPath}`);

  function createAgent(): Agent {
    const toolRegistry = createToolRegistry();
    registerBuiltinTools(toolRegistry);
    const toolExecutor = createToolExecutor(permissionChecker, hookRegistry);
    const contextManager = createContextManager({
      config: {
        contextWindow: config.contextWindow,
        compactThreshold: config.compactThreshold,
        compactKeepTokens: config.compactKeepTokens,
        disableCompact: config.disableCompact,
        smallModel: config.smallModel,
      },
      summaryGenerator: client,
      systemContextOptions: { workdir, loadAgentsMd: false },
    });
    return new Agent({
      llmClient: client,
      toolRegistry,
      toolExecutor,
      contextManager,
      config,
      workdir,
      sessionStore,
    });
  }

  // 静态文件目录（web-ui 构建产物）
  // 从项目根目录（cwd）出发查找 web-ui/dist
  const staticDir = resolve(workdir, "packages/web-ui/dist");

  log.info("main", `staticDir=${staticDir}`);

  log.info("main", `server starting host=${config.serverHost}, port=${config.serverPort}`);
  startServer({ config, createAgent, staticDir, sessionStore });
}

main();
