// 真实形态的 tools-only dsh 插件（测试夹具）：
// 命名导出 name/inject/apply + defineTool —— 与 dshmarket 插件同构，
// 通过 FengAgentCli runtime 的用户插件路径装载（相对 cordis/src 解析）。
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-demo-plugin";
export const inject = ["tools"];

export function apply(ctx, config) {
  const greeting = config?.greeting ?? "hello";
  ctx.tools.register(
    defineTool({
      name: "demo_greet",
      description: "Greet someone (dsh demo plugin, tools-only)",
      parameters: {
        who: { type: "string", required: true, description: "Who to greet" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            ok: { type: "boolean", required: true },
            id: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: `${value.greeting}: ${value.who}` }],
      },
      async execute(args) {
        return { ok: true, id: `greet-${args.who}`, greeting, who: args.who };
      },
    }),
  );
}
