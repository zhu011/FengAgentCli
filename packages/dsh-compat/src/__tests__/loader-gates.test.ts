/**
 * @fengagent/dsh-compat — 装载器硬门测试（P1 加固）
 *
 * 市场插件实测教训（todo-plus）：缺服务的插件装载「快速返回、零工具、无报错」。
 * 三道门：① inject 预检（缺服务点名拒绝）② 装载超时 ③ 工具增量（0 增量报错）。
 *
 * 注意：loadDshPlugin 内部的 `import(id)` 相对 `packages/dsh-compat/src/` 解析，
 * fixture 路径沿用「../../dsh-compat/src/__tests__/fixtures/…」约定
 * （与 runtime.ts 用户插件路径的解析基准恰好同形）。
 */

import { describe, expect, test } from "bun:test";
import {
  createRuntime,
  BUILTIN_PLUGINS,
  type FengRuntime,
  type RuntimePluginEntry,
} from "@fengagent/cordis";
import { loadDshPlugin, type DshLoadContext } from "../loader.ts";

const COMPAT_ID = "../../dsh-compat/src/index.ts";
const FIXTURE_MISSING_SERVICE = "../../dsh-compat/src/__tests__/fixtures/missing-service-plugin/plugin.mjs";
const FIXTURE_MISSING_SERVICE_MAP = "../../dsh-compat/src/__tests__/fixtures/missing-service-map-plugin/plugin.mjs";
const FIXTURE_EMPTY = "../../dsh-compat/src/__tests__/fixtures/empty-plugin/plugin.mjs";

async function startRuntime(): Promise<FengRuntime> {
  const plugins: RuntimePluginEntry[] = [
    { id: BUILTIN_PLUGINS.TOOLS },
    { id: COMPAT_ID },
  ];
  const runtime = createRuntime({ workdir: ".", plugins });
  await runtime.start();
  return runtime;
}

describe("loadDshPlugin 硬门", () => {
  test("① inject 预检：缺服务点名拒绝，不再静默 0 工具", async () => {
    const runtime = await startRuntime();
    try {
      await expect(
        loadDshPlugin(runtime.ctx as unknown as DshLoadContext, FIXTURE_MISSING_SERVICE, {}),
      ).rejects.toThrow(/sessionProjections/);
      // 预检在 apply 之前：工具确实未注册
      expect(runtime.ctx.tools.listNames()).not.toContain("never_registered_tool");
    } finally {
      await runtime.stop();
    }
  });

  test("① inject 预检：注入映射形态（对象）也识别", async () => {
    const runtime = await startRuntime();
    try {
      await expect(
        loadDshPlugin(runtime.ctx as unknown as DshLoadContext, FIXTURE_MISSING_SERVICE_MAP, {}),
      ).rejects.toThrow(/sessionProjections/);
      expect(runtime.ctx.tools.listNames()).not.toContain("never_registered_map_tool");
    } finally {
      await runtime.stop();
    }
  });

  test("③ 工具增量门：装载成功但 0 工具 → 报错", async () => {
    const runtime = await startRuntime();
    try {
      await expect(
        loadDshPlugin(runtime.ctx as unknown as DshLoadContext, FIXTURE_EMPTY, {}),
      ).rejects.toThrow(/未注册任何工具/);
    } finally {
      await runtime.stop();
    }
  });

  test("③ 工具增量门：requireTools=false 时放行（服务型插件）", async () => {
    const runtime = await startRuntime();
    try {
      await loadDshPlugin(runtime.ctx as unknown as DshLoadContext, FIXTURE_EMPTY, {}, {
        requireTools: false,
      });
    } finally {
      await runtime.stop();
    }
  });

  test("② 装载超时：fiber 挂起 → 超时报错并卸载", async () => {
    // cordis fiber 不等待 apply 返回的悬空 Promise，真实的「fiber.await 挂起」
    // 只会来自等待永不出现的服务——那已被 inject 预检拦截。这里用 stub ctx
    // 直接单测超时门机制本身：thenable 永不 settle → 超时 → 报错 + dispose。
    let disposed = false;
    const stubCtx: DshLoadContext = {
      plugin: () => ({
        then: () => new Promise(() => {}),
        dispose: async () => {
          disposed = true;
        },
      }),
      reflect: { get: () => ({ listNames: () => [] }) },
    };
    await expect(
      loadDshPlugin(stubCtx, FIXTURE_EMPTY, {}, { timeoutMs: 120, requireTools: false }),
    ).rejects.toThrow(/装载超时/);
    expect(disposed).toBe(true);
  });

  test("peer 矩阵：根 node_modules 可解析 dsh-llm / dsh-fs（漏声明 peer 的兜底）", async () => {
    const llm = (await import("@deepseek-ai/dsh-llm")) as Record<string, unknown>;
    expect(Object.keys(llm).length).toBeGreaterThan(0);
    const fs = (await import("@deepseek-ai/dsh-fs")) as Record<string, unknown>;
    expect(Object.keys(fs).length).toBeGreaterThan(0);
  });
});
