/**
 * @fengagent/dsh-compat — 兼容插件本体
 *
 * 作用：给运行中的 FengAgentCli `tools` 服务**长出 dsh 接口面**——
 * `ctx.tools.register(dshTool)`（defineTool 产物）自动适配后进入 FengAgentCli
 * 的 ToolRegistry；原生 FengAgentCli 工具定义照旧直通。同一服务实例服务两套
 * 词汇表，内部调用方零感知。
 *
 * 装载顺序：本插件必须在 feng.tools（提供 tools 服务的内置插件）之后、
 * 任何 dsh 插件之前加载。
 *
 * M1 范围与限制（P2 收敛）：
 * - `register` 返回的 disposer：ToolService 面暂无 `unregister`，先记警告 no-op
 *   （服务面补上后自动生效）；
 * - `restrict` / `sessions` / `agents` 等更高阶 dsh 服务面：不在 M1。
 */

import { adaptDshTool, isDshToolDefinition } from "./adapter.ts";

export const name = "dsh-compat";
export const inject = ["tools"];

/** FengAgentCli tools 服务的结构类型（不 import cordis 类型，避免实例纠缠） */
interface FengToolsService {
  register(tool: unknown): unknown;
  unregister?: (name: string) => boolean;
}

/** 已打补丁标记（防重复 patch） */
const PATCHED = Symbol.for("@fengagent/dsh-compat/tools-patched");

/** dsh 语义的注册撤销器（M1：ToolService 无 unregister 时记警告 no-op） */
function createDisposer(service: FengToolsService, toolName: string): () => void {
  return () => {
    if (typeof service.unregister === "function") {
      service.unregister(toolName);
      return;
    }
    console.warn(
      `[dsh-compat] unregister(${toolName}) 暂不受支持（ToolService 面无该方法），工具保持注册`,
    );
  };
}

/**
 * 兼容插件入口。对 ctx.tools 的 `register` 做判别式包装：
 * dsh 定义（defineTool 产物）→ 适配后注册并返回 disposer；
 * FengAgentCli 原生定义 → 原行为直通。
 */
export function apply(ctx: { tools: FengToolsService }, _config: Record<string, unknown> = {}): void {
  void _config;
  const service = ctx.tools;
  if (service === null || typeof service !== "object") {
    throw new Error("dsh-compat: ctx.tools 不是对象——请确认 feng.tools 已先行加载");
  }
  if (PATCHED in service) return;

  const inner = service.register.bind(service);
  const patchedRegister = (tool: unknown): unknown => {
    if (isDshToolDefinition(tool)) {
      const adapted = adaptDshTool(tool);
      inner(adapted);
      return createDisposer(service, adapted.name);
    }
    return inner(tool);
  };

  (service as unknown as Record<string, unknown>).register = patchedRegister;
  Object.defineProperty(service, PATCHED, { value: true });
}

/** 组装好的插件对象（供程序化 `ctx.plugin(dshCompatPlugin, config)` 使用） */
export const dshCompatPlugin = { name, inject, apply };
