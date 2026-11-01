// 装载门测试夹具：以「name→config 映射」形态声明不存在服务的插件
// （inject 预检对数组与映射两种声明形态都要识别）
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-fixture-missing-service-map";
export const inject = { sessionProjections: {} };

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "never_registered_map_tool",
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
