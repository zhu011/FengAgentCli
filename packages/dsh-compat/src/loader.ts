/**
 * @fengagent/dsh-compat — dsh 插件装载器
 *
 * Cordis 4.0.1 的 `ctx.plugin` 本就接受「带 `apply` 的对象」并读取其 `inject`
 * （见 vendored cordis `plugin()` 实现），dsh 插件模块（命名导出
 * `name` / `inject` / `apply`）无需翻译即可直装。FengAgentCli runtime 的
 * 用户插件路径（`import(entry.id)` → `mod.default ?? mod` → `ctx.plugin`）
 * 同样兼容——本装载器只是把这条路径显式化，供程序化装载与校验。
 */

/** dsh/Cordis 插件模块的结构形状 */
export interface DshPluginModule {
  name?: string;
  inject?: string[];
  apply: (ctx: unknown, config?: unknown) => unknown;
}

/**
 * 按模块标识导入并校验一个 dsh/Cordis 插件。
 *
 * @param id - 模块标识：包名（需可从仓库根 node_modules 解析）或模块路径
 * @throws 不是合法插件形状（无 `apply`、无 default）时抛错
 */
export async function importDshPlugin(id: string): Promise<DshPluginModule> {
  const mod = (await import(/* @vite-ignore */ id)) as Record<string, unknown>;
  const plugin = (mod.default ?? mod) as Record<string, unknown> | undefined;
  const applicable =
    typeof plugin === "function" ||
    (plugin !== null && typeof plugin === "object" && typeof plugin["apply"] === "function");
  if (!applicable) {
    throw new Error(
      `dsh-compat: "${id}" 不是 dsh/Cordis 插件（需要命名导出 apply，或 default 导出函数/对象）`,
    );
  }
  return plugin as unknown as DshPluginModule;
}

/**
 * 把一个 dsh 插件装载进当前上下文。
 *
 * @param ctx - 已加载 dsh-compat（tools 面已 patch）的 Cordis 上下文
 * @param id - 模块标识（包名或路径）
 * @param config - 传给插件 `apply(ctx, config)` 的配置
 * @returns `ctx.plugin` 的 fiber（await 即等待装载完成）
 */
export function loadDshPlugin(
  ctx: { plugin: (plugin: unknown, config?: unknown) => unknown },
  id: string,
  config: Record<string, unknown> = {},
): Promise<unknown> {
  return (async () => {
    const plugin = await importDshPlugin(id);
    return ctx.plugin(plugin, config);
  })() as Promise<unknown>;
}
