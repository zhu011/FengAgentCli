/**
 * @fengagent/dsh-compat — P1/M1 验收测试
 *
 * 1. tools-only dsh 插件（真实 defineTool 形态夹具）经 FengAgentCli runtime
 *    用户插件路径装载，注册 + 调用成功（走与原生工具相同的执行管道）；
 * 2. 原生 FengAgentCli 工具在 patch 后的 register 面照常直通；
 * 3. 真实 dsh 插件 `fengagent-groups`（integrations/）装载，5 个群工具注册成功，
 *    LLM 可见 schema 正确转换；
 * 4. 程序化装载器 `loadDshPlugin` 可用。
 *
 * 注意：用户插件 id 经 runtime.ts 的 `import(entry.id)` 解析，相对
 * `packages/cordis/src/` 目录。
 */

import { describe, expect, test } from "bun:test";
import type { ToolContext, ToolDefinition } from "@fengagent/core";
import {
  createRuntime,
  BUILTIN_PLUGINS,
  type FengRuntime,
  type RuntimePluginEntry,
} from "@fengagent/cordis";
import { loadDshPlugin } from "../loader.ts";

/** 相对 packages/cordis/src/（runtime.ts 动态 import 的解析基准） */
const COMPAT_ID = "../../dsh-compat/src/index.ts";
const FIXTURE_ID = "../../dsh-compat/src/__tests__/fixtures/dsh-demo-plugin/plugin.mjs";
const FENGAGENT_GROUPS_ID = "../../../integrations/fengagent-groups/src/plugin.mjs";

const GROUP_TOOLS = [
  "fengagent_group_list",
  "fengagent_group_create",
  "fengagent_group_send",
  "fengagent_group_history",
  "fengagent_group_dispatch",
];

function fakeToolContext(): ToolContext {
  return { workdir: ".", sessionId: "s", messageId: "m" };
}

async function startRuntime(plugins: RuntimePluginEntry[]): Promise<FengRuntime> {
  const runtime = createRuntime({ workdir: ".", plugins });
  await runtime.start();
  return runtime;
}

describe("P1/M1 — tools-only dsh 插件装进 FengAgentCli", () => {
  test("夹具 dsh 插件：装载 + 注册 + 调用（config 透传）", async () => {
    const runtime = await startRuntime([
      { id: BUILTIN_PLUGINS.TOOLS },
      { id: COMPAT_ID },
      { id: FIXTURE_ID, config: { greeting: "bonjour" } },
    ]);
    try {
      const tool = runtime.ctx.tools.get("demo_greet");
      expect(tool).toBeDefined();
      expect(tool?.description).toContain("dsh demo plugin");

      // LLM 可见 schema：直通 dsh 编译参数（providers 的 zodToJsonSchemaCompat 同款路径）
      const duck = tool?.inputSchema as unknown as {
        toJSONSchema: () => Record<string, unknown>;
      };
      expect(duck.toJSONSchema()["type"]).toBe("object");

      // 调用：走 ToolService.execute（与 agent 相同的执行管道）
      const results = await runtime.ctx.tools.execute(
        [{ tool: tool!, input: { who: "world" } }],
        fakeToolContext(),
      );
      expect(results[0]?.isError).toBeFalsy();
      expect(results[0]?.content).toBe("bonjour: world");
      expect((results[0]?.metadata as { ok: boolean }).ok).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  test("patch 后的原生 register 面照常直通（判别式不误伤）", async () => {
    const runtime = await startRuntime([
      { id: BUILTIN_PLUGINS.TOOLS },
      { id: COMPAT_ID },
    ]);
    try {
      const native = {
        name: "native_probe",
        description: "native feng tool",
        inputSchema: { parse: (x: unknown) => x },
        execute: async () => ({ content: "native ok" }),
      } as unknown as ToolDefinition;
      runtime.ctx.tools.register(native);
      expect(runtime.ctx.tools.get("native_probe")).toBeDefined();
      const results = await runtime.ctx.tools.execute(
        [{ tool: runtime.ctx.tools.get("native_probe")!, input: {} }],
        fakeToolContext(),
      );
      expect(results[0]?.content).toBe("native ok");
    } finally {
      await runtime.stop();
    }
  });

  test("真实 dsh 插件 fengagent-groups：装载 + 5 工具注册 + schema 转换", async () => {
    const runtime = await startRuntime([
      { id: BUILTIN_PLUGINS.TOOLS },
      { id: COMPAT_ID },
      { id: FENGAGENT_GROUPS_ID },
    ]);
    try {
      const names = runtime.ctx.tools.listNames();
      for (const toolName of GROUP_TOOLS) {
        expect(names).toContain(toolName);
      }
      // LLM 可见 schema 正确（编译后 JSON Schema 直通）
      const listTool = runtime.ctx.tools.get("fengagent_group_list");
      const duck = listTool?.inputSchema as unknown as {
        toJSONSchema: () => Record<string, unknown>;
      };
      expect(duck.toJSONSchema()["type"]).toBe("object");

      // 程序化装载器：同一 runtime 再装夹具插件（config 透传）
      await loadDshPlugin(runtime.ctx as never, FIXTURE_ID, { greeting: "salut" });
      expect(runtime.ctx.tools.get("demo_greet")).toBeDefined();
    } finally {
      await runtime.stop();
    }
  });
});
