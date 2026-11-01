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
 * 装配面（P2 起）：
 * - **执行上下文**：适配器带上 `exec.agent` / `exec.token`（`exec-context.ts`），
 *   `agent` 默认从 `ctx.agents` → `ctx.sessions` 解析；
 * - **事件桥**：`tools/pre-execute` / `tools/post-execute` ↔ `HookRegistry`
 *   （`events.ts`）。桥在 ctx 上有 `waterfall` 时自动启用；给了 `hooks` 就顺带把
 *   原生工具的执行也接进 dsh 事件（没给则只覆盖 dsh 工具自己）。
 */

import { adaptDshTool, isDshToolDefinition } from "./adapter.ts";
import { createDshExecContext, resolveAgentFromServices, type DshAgentResolver } from "./exec-context.ts";
import {
  DshToolEventBridge,
  type DshHookRegistryLike,
  type DshEventContextLike,
} from "./events.ts";
import type { DshToolExec } from "./exec-context.ts";

export const name = "dsh-compat";
export const inject = ["tools"];

/** FengAgentCli tools 服务的结构类型（不 import cordis 类型，避免实例纠缠） */
interface FengToolsService {
  register(tool: unknown): unknown;
  unregister?: (name: string) => boolean;
}

/** 兼容插件配置 */
export interface DshCompatConfig {
  /**
   * FengAgentCli 的 `HookRegistry`（`createHookRegistry()` 产物）。
   *
   * 传入后，原生工具的 pre/post-tool-use 也会翻译成 dsh 的
   * `tools/pre-execute` / `tools/post-execute`（审计类插件不再只看见 dsh 工具）。
   * 也可由宿主把它注册成 `hooks` 服务，本插件会自动发现。
   */
  hooks?: DshHookRegistryLike;
  /** 覆盖默认的 `exec.agent` 解析 */
  resolveAgent?: DshAgentResolver;
  /** 工具 `exec.deferContext(...)` 的交付回调（缺省丢弃，仅记录在 exec 上） */
  onDeferredContext?: (context: unknown, exec: DshToolExec) => void;
  /** 工具 `exec.concludeTurn()` 的交付回调（缺省丢弃，仅记录在 exec 上） */
  onConcludeTurn?: (exec: DshToolExec) => void;
  /** 事件桥诊断输出（缺省 console.warn） */
  onWarning?: (message: string, error?: unknown) => void;
  /** 关闭 dsh 事件桥（默认开启：ctx 有 `waterfall` 就启用） */
  events?: boolean;
}

/** 读服务面（`ctx.reflect.get`；Cordis 4 的代理在未 inject 时会抛错） */
type ReflectLike = {
  reflect?: {
    get?(name: string): unknown;
    provide?(name: string, value?: unknown): unknown;
  };
  waterfall?: unknown;
};

/** 已打补丁标记（防重复 patch） */
const PATCHED = Symbol.for("@fengagent/dsh-compat/tools-patched");

/** dsh 语义的注册撤销器（ToolService 无 unregister 时记警告 no-op） */
function createDisposer(
  service: FengToolsService,
  toolName: string,
  onDispose?: () => void,
): () => void {
  return () => {
    onDispose?.();
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
export function apply(
  ctx: { tools: FengToolsService } & ReflectLike,
  config: DshCompatConfig = {},
): void {
  const service = ctx.tools;
  if (service === null || typeof service !== "object") {
    throw new Error("dsh-compat: ctx.tools 不是对象——请确认 feng.tools 已先行加载");
  }
  if (PATCHED in service) return;

  const serviceOf = (name: string): unknown => {
    const reflect = ctx.reflect;
    if (!reflect || typeof reflect.get !== "function") return undefined;
    try {
      return reflect.get(name);
    } catch {
      // Cordis 4：未声明 inject 的代理读取会抛错——可选依赖按「没有」处理
      return undefined;
    }
  };

  const resolveAgent = config.resolveAgent ?? resolveAgentFromServices(serviceOf);
  const execContext = createDshExecContext({
    resolveAgent,
    ...(config.onDeferredContext === undefined
      ? {}
      : { onDeferredContext: config.onDeferredContext }),
    ...(config.onConcludeTurn === undefined ? {} : { onConcludeTurn: config.onConcludeTurn }),
  });

  // 事件桥：ctx 上有 waterfall（Cordis 4 事件总线）才建
  let bridge: DshToolEventBridge | undefined;
  if (config.events !== false && typeof ctx.waterfall === "function") {
    bridge = new DshToolEventBridge(ctx as unknown as DshEventContextLike, {
      resolveAgent,
      ...(config.onWarning === undefined ? {} : { onWarning: config.onWarning }),
    });
    const hooks = config.hooks ?? (serviceOf("hooks") as DshHookRegistryLike | undefined);
    if (hooks) bridge.attach(hooks);
    ctx.reflect?.provide?.("dshToolEvents", bridge);
  }

  const inner = service.register.bind(service);
  const patchedRegister = (tool: unknown): unknown => {
    if (isDshToolDefinition(tool)) {
      const adapted = adaptDshTool(tool, {
        execContext,
        ...(bridge === undefined ? {} : { events: bridge }),
      });
      inner(adapted);
      // 适配器自己发这次调用的事件 → 让钩子路径跳过同名工具，避免双发
      bridge?.markDshTool(adapted.name);
      return createDisposer(service, adapted.name, () => bridge?.unmarkDshTool(adapted.name));
    }
    return inner(tool);
  };

  (service as unknown as Record<string, unknown>).register = patchedRegister;
  Object.defineProperty(service, PATCHED, { value: true });
}

/** 组装好的插件对象（供程序化 `ctx.plugin(dshCompatPlugin, config)` 使用） */
export const dshCompatPlugin = { name, inject, apply };
