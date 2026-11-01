// fengagent-compat — 方向 B 兼容插件本体（DSH plugin）
//
// 作用：给运行中的 dsh `tools` 服务**长出 feng 接口面**——
// `ctx.tools.register(fengTool)`（FengAgentCli 的 ToolDefinition 形状：
// inputSchema + execute(input, context)）自动适配后进入 dsh 的工具注册表；
// dsh 原生定义（defineTool 产物）照旧直通。
//
// feng 插件的装载：**由本插件自己装载**（config.plugins 列表），而不是
// 与本插件并列挂在 profile 里——兄弟 fiber 的 apply 顺序是异步竞态
// （实测：并列时 feng 插件可能先于本补丁执行，直接打到未适配的 register
// 上报 output 校验错）。本插件先打补丁、再按列表顺序 ctx.plugin() 装载，
// 次序确定。与方向 A 的 loadDshPlugin 同构。
//
// 配置（profile 用户层 cordis.patch.yml 覆盖）：
//   - id: fengagent-compat
//     config:
//       plugins: ["<包名或模块路径>", ...]
//       configs: { "<包名>": { ...该插件的 config... } }
//
// 实现注记：ctx.tools 经 cordis 的 traced-proxy 暴露，其 set 陷阱会把
// `service.register = fn` 写到一次性 shadow receiver 上、不落在服务实例——
// 必须先经 `Symbol.for("cordis.original")` 逃生口拿裸实例再打补丁。

import { adaptFengTool, isFengToolDefinition } from "./adapter.mjs";

export const name = "fengagent-compat";
export const inject = ["tools"];

/** 已打补丁标记（防重复 patch） */
const PATCHED = Symbol.for("fengagent-compat/tools-patched");

/** cordis traced-proxy 的逃生口：取回裸服务实例 */
const CORDIS_ORIGINAL = Symbol.for("cordis.original");

/**
 * 兼容插件入口：
 * ① 对 tools 服务的 `register` 做判别式包装（feng 定义 → 适配后注册，
 *    返回 dsh 原生 disposer；dsh 定义 → 原行为直通）；
 * ② 按 config.plugins 顺序装载 feng 插件（补丁已就位，次序确定）。
 */
export function apply(ctx, config = {}) {
  const proxied = ctx.tools;
  if (proxied === null || typeof proxied !== "object") {
    throw new Error("fengagent-compat: ctx.tools 不是对象——请确认 dsh-base 已先行加载");
  }
  // 拿裸实例（非 cordis 环境/裸对象时就是自身）
  const service = proxied[CORDIS_ORIGINAL] ?? proxied;

  if (!(PATCHED in service)) {
    const inner = service.register.bind(service);
    let fengCount = 0;
    const patchedRegister = (tool) => {
      if (isFengToolDefinition(tool)) {
        const adapted = adaptFengTool(tool);
        const dispose = inner(adapted);
        fengCount += 1;
        console.log(`[fengagent-compat] feng tool registered: ${adapted.name} (total ${fengCount})`);
        return dispose;
      }
      return inner(tool);
    };

    service.register = patchedRegister;
    Object.defineProperty(service, PATCHED, { value: true });
    console.log("[fengagent-compat] tools patch active — feng-shaped ToolDefinitions now accepted");
  }

  // ② 装载 feng 插件（列表来自 config.plugins；每项可为包名或模块路径）
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  const configs = (config.configs && typeof config.configs === "object" ? config.configs : {}) ?? {};
  if (plugins.length === 0) return;
  console.log(`[fengagent-compat] loading ${plugins.length} feng plugin(s): ${plugins.join(", ")}`);

  ctx.effect(() => {
    void (async () => {
      for (const spec of plugins) {
        try {
          const mod = await import(/* @vite-ignore */ String(spec));
          const plugin = mod.default ?? mod;
          const applicable =
            typeof plugin === "function" ||
            (plugin !== null && typeof plugin === "object" && typeof plugin.apply === "function");
          if (!applicable) {
            console.warn(`[fengagent-compat] "${spec}" 不是插件（需要 apply 或 default 导出），跳过`);
            continue;
          }
          await ctx.plugin(plugin, configs[String(spec)] ?? {});
          console.log(`[fengagent-compat] feng plugin loaded: ${spec}`);
        } catch (err) {
          console.error(`[fengagent-compat] feng plugin "${spec}" 装载失败: ${err?.message ?? err}`);
        }
      }
    })();
    return () => {};
  }, "fengagent-compat.load-feng-plugins");
}
