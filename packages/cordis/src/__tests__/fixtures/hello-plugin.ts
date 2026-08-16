/**
 * 测试用用户插件 — 模拟 .fengagent/plugins/hello-tool.ts
 *
 * 通过 createRuntime 的「用户插件路径」加载（id = 模块路径），
 * 演示：换插件即换能力 — 装上它，ctx.tools 就多一个 hello-tool。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ToolContext, ToolDefinition, ToolResult } from "@fengagent/core";

function helloToolPlugin(ctx: Context) {
  const tool: ToolDefinition = {
    name: "hello-tool",
    description: "打招呼工具（由用户插件注入）",
    inputSchema: undefined,
    async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
      return { content: `hello, ${(input as { name?: string })?.name ?? "world"}` };
    },
  } as unknown as ToolDefinition;

  // 通过 ctx.tools 服务挂载新工具（能力随插件注入）
  ctx.tools.register(tool);
}

// 声明依赖注入：tools 服务就绪后才启动（Cordis 声明式装配）
(helloToolPlugin as unknown as { inject?: string[] }).inject = ["tools"];

export default helloToolPlugin;
