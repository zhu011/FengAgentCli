// 装载门测试夹具：声明了不存在服务的插件（inject 预检应在装载前拒绝）
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-fixture-missing-service";
export const inject = ["sessionProjections"];

export function apply(ctx) {
  // 即使 apply 会注册工具，预检也应在装载前拒绝（缺 sessionProjections 服务）
  ctx.tools.register(
    defineTool({
      name: "never_registered_tool",
      description: "should never appear",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: { ok: { type: "boolean", required: true } },
        },
        render: () => [{ type: "text", text: "never" }],
      },
      async execute() {
        return { ok: true };
      },
    }),
  );
}
