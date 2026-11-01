/**
 * @fengagent/dsh-compat — dsh 插件装载器（P1 加固版）
 *
 * Cordis 4.0.1 的 `ctx.plugin` 本就接受「带 `apply` 的对象」并读取其 `inject`
 * （见 cordis `plugin()` 实现），dsh 插件模块（命名导出 `name` / `inject` /
 * `apply`）无需翻译即可直装。FengAgentCli runtime 的用户插件路径
 * （`import(entry.id)` → `mod.default ?? mod` → `ctx.plugin`）同样兼容。
 *
 * 本装载器把这条路径显式化，并加三道**硬门**（市场插件实测教训：缺服务的
 * 插件装载会「快速返回、零工具、无报错」，用户误以为装上了）：
 *
 * 1. **inject 预检**：插件声明 inject 的服务必须已在线（`ctx.reflect.get`
 *    免 inject 查询），缺失即拒绝装载并点名缺谁；
 * 2. **装载超时**：fiber 在 `timeoutMs` 内未就绪即失败并卸载（默认 15s）；
 * 3. **工具增量门**：装载成功后要求至少注册 1 个工具（`requireTools`，
 *    默认开；服务型插件可显式关）。
 */

/** dsh/Cordis 插件模块的结构形状 */
export interface DshPluginModule {
  name?: string;
  inject?: string[];
  apply: (ctx: unknown, config?: unknown) => unknown;
}

/** 装载器需要的上下文面（结构类型，不 import cordis 类型） */
export interface DshLoadContext {
  plugin: (plugin: unknown, config?: unknown) => unknown;
  /** cordis 反射层：免 inject 读服务（`ctx.reflect.get(name)`） */
  reflect?: { get(name: string, strict?: boolean): unknown };
}

/** 装载选项 */
export interface LoadDshPluginOptions {
  /** 装载超时（毫秒），默认 15000；`0` 表示不限 */
  timeoutMs?: number;
  /** 装载后硬门：要求插件至少注册 1 个工具（默认 true；服务型插件可关） */
  requireTools?: boolean;
}

/** cordis fiber 的最小结构（`ctx.plugin` 的返回值） */
interface FiberLike {
  then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => PromiseLike<unknown>;
  dispose?: () => PromiseLike<unknown>;
}

/** 读取插件声明的 inject 服务名（数组或 name→config 映射两种形态） */
function declaredInjectNames(plugin: DshPluginModule): string[] {
  const inject = (plugin as { inject?: unknown }).inject;
  if (Array.isArray(inject)) return inject.filter((n): n is string => typeof n === "string");
  if (inject !== null && typeof inject === "object") return Object.keys(inject as Record<string, unknown>);
  return [];
}

/** 在线服务名（reflect 不可用时返回 null，预检跳过） */
function missingServices(ctx: DshLoadContext, names: string[]): string[] | null {
  const get = ctx.reflect?.get;
  if (typeof get !== "function") return null;
  return names.filter((n) => get.call(ctx.reflect, n) === undefined);
}

/** 当前已注册工具数（tools 服务不可达时返回 -1，增量门跳过） */
function countTools(ctx: DshLoadContext): number {
  const tools = ctx.reflect?.get?.("tools") as { listNames?: () => string[] } | undefined;
  return typeof tools?.listNames === "function" ? tools.listNames().length : -1;
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
 * 把一个 dsh 插件装载进当前上下文（带三道硬门，见文件头）。
 *
 * @param ctx - 已加载 dsh-compat（tools 面已 patch）的 Cordis 上下文
 * @param id - 模块标识（包名或路径）
 * @param config - 传给插件 `apply(ctx, config)` 的配置
 * @param options - 超时 / 工具增量门开关
 * @returns `ctx.plugin` 的 fiber（await 即等待装载完成）
 * @throws inject 预检失败 / 装载超时 / 装载后 0 工具增量
 */
export async function loadDshPlugin(
  ctx: DshLoadContext,
  id: string,
  config: Record<string, unknown> = {},
  options: LoadDshPluginOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const requireTools = options.requireTools ?? true;
  const plugin = await importDshPlugin(id);
  const label = plugin.name ?? id;

  // ① inject 预检：声明 inject 的服务必须已在线，否则拒绝装载（点名缺谁）
  const missing = missingServices(ctx, declaredInjectNames(plugin));
  if (missing !== null && missing.length > 0) {
    throw new Error(
      `dsh-compat: 插件 "${label}" inject 的服务未提供：${missing.join(", ")}（对应契约面未装配或暂不支持），` +
        "已拒绝装载——缺服务时插件会静默等待、不注册工具",
    );
  }

  // ② 工具基线（装载前快照）
  const before = requireTools ? countTools(ctx) : -1;

  const fiber = ctx.plugin(plugin, config) as FiberLike;

  // ③ 装载超时：ref 定时器（不能用 unref 的 AbortSignal.timeout——安静进程不触发）
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await (timeoutMs > 0
      ? Promise.race([
          Promise.resolve(fiber),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`dsh-compat: 插件 "${label}" 装载超时（>${timeoutMs}ms），疑似等待缺失服务或 apply 挂起`)),
              timeoutMs,
            );
          }),
        ])
      : Promise.resolve(fiber));
  } catch (err) {
    // 超时/装载失败：尽力卸载 fiber，避免半装载状态残留
    void Promise.resolve(fiber.dispose?.() ?? undefined).catch(() => {});
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  // ④ 装载后硬门：至少注册 1 个工具（tools-only 是 P1 的验收口径）
  if (requireTools) {
    const after = countTools(ctx);
    if (before >= 0 && after >= 0 && after <= before) {
      throw new Error(
        `dsh-compat: 插件 "${label}" 装载完成但未注册任何工具（可能非 tools-only，或注册被内部条件跳过）；` +
          "确为服务型插件可用 { requireTools: false } 跳过此门",
      );
    }
  }

  return fiber;
}
