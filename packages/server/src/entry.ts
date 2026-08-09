/**
 * @fengagent/server — 独立运行入口
 *
 * 用法：
 *   bun run packages/server/src/server.ts
 *
 * 从环境变量加载配置，创建 Agent，启动 HTTP 服务。
 */

import { loadConfigFromEnv } from "@fengagent/core";
import { Agent } from "@fengagent/agent";
import { createClientFromEnv } from "@fengagent/llm";
import {
  createToolRegistry,
  createToolExecutor,
  registerBuiltinTools,
} from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { startServer } from "./server.ts";

async function main() {
  const config = loadConfigFromEnv();
  const { client } = createClientFromEnv();

  function createAgent(): Agent {
    const toolRegistry = createToolRegistry();
    registerBuiltinTools(toolRegistry);
    const toolExecutor = createToolExecutor();
    const contextManager = createContextManager({
      config: {
        contextWindow: config.contextWindow,
        compactThreshold: config.compactThreshold,
        compactKeepTokens: config.compactKeepTokens,
        disableCompact: config.disableCompact,
        smallModel: config.smallModel,
      },
      summaryGenerator: client,
      systemContextOptions: { workdir: process.cwd() },
    });
    return new Agent({
      llmClient: client,
      toolRegistry,
      toolExecutor,
      contextManager,
      config,
      workdir: process.cwd(),
    });
  }

  startServer({ config, createAgent });
}

main();
