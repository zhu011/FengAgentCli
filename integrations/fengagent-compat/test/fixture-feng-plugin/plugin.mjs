// FengAgentCli 形状的插件（方向 B 验收夹具）：
// apply(ctx) 里用 feng 的 ToolDefinition 形状（inputSchema + execute(input, context)）
// 注册工具。在 dsh 里经 fengagent-compat 适配后，dsh agent 可直接调用。
// 用鸭子 schema（真 Zod 场景由 fengagent-compat 单测覆盖，E2E 免依赖）。
export const name = "feng-fixture-plugin";
export const inject = ["tools"];

export function apply(ctx, _config) {
  ctx.tools.register({
    name: "hello_feng",
    description: "Say hello from a FengAgentCli plugin running inside dsh (direction B fixture)",
    inputSchema: { parse: (x) => x },
    async execute(input) {
      const who = typeof input?.name === "string" && input.name !== "" ? input.name : "world";
      return { content: `hello from feng tool: ${who}` };
    },
  });
  console.log("[feng-fixture] feng plugin applied, hello_feng registered");
}
