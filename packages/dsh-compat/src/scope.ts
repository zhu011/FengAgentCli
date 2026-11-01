/**
 * @fengagent/dsh-compat — `scope` 映射（P3）
 *
 * dsh 的 `scope` **不是 Cordis 服务**，而是 `@deepseek-ai/dsh-scope` 这个模块提供的
 * 「带身份标签的注册上下文 + 按标签路由的事件载体」原语：
 *
 * - `createScope(ctx, key, { parent })` 铸一个带标签的子上下文，fiber 拥有其下所有注册；
 * - `scopeOf(ctx)` 读最近的标签（派生上下文继承）；
 * - `bindScopeParent / scopeChainOf` 维护父子链：注册视图沿链**向下**继承，
 *   事件准入沿链**向上**扩展（祖先监听器能收到后代事件，反之不行）；
 * - `scopeTarget(base, key)` 造带过滤器的 `thisArg`，`ScopedLayers` 负责按层合并命名注册。
 *
 * 结论：**direct**。FengAgentCli 的 runtime 就是 Cordis 4.0.1（与 dsh 同一条运行时），
 * 上述原语不需要翻译；本模块**直接重导出上游实现**，保证与 dsh 插件内部
 * `import { scopeOf } from "@deepseek-ai/dsh-scope"` 用的是同一份模块实例、同一套
 * 标签 symbol（自己再实现一份会让两边的 `scopeOf` 互相看不见标签，这是最容易
 * 假装兼容、实际静默失效的地方）。
 *
 * 本包额外提供的是**接线**：
 * - `scopeKeyForSession(sessionId)`：同一会话稳定拿到同一把 key（进程内缓存）；
 * - `createAgentScope(ctx, { sessionId, parent })`：给一个 live agent 铸 scope；
 * - `scopeKeyOf(ctx)` / `isScopedContext(ctx)`：宿主判断「这个上下文有没有归属」。
 *
 * 事件面接线（把 `tools/pre-execute` / `tools/post-execute` 发到 scope 载体上，让
 * 每个 agent 的审计插件只看到自己的事件）留在 P4：当前事件桥只发全局事件，
 * 偏差见 `docs/DSH-CONTRACT-MAP.md` §7。
 */

export {
  AnonymousEntries,
  NamedEntries,
  ScopedLayers,
  bindScopeParent,
  carrierKeyOf,
  createScope,
  isScopeCarrier,
  scopeChainOf,
  scopeOf,
  scopeParentOf,
  scopeTarget,
  type CreateScopeOptions,
  type Scope,
  type ScopeKey,
  type ScopeLayer,
  type ScopeParentBinding,
  type Scoped,
} from "@deepseek-ai/dsh-scope";

import { createScope, scopeOf, type Scope, type ScopeKey } from "@deepseek-ai/dsh-scope";

/** 铸 scope 所需的 Cordis 上下文面（结构类型） */
export interface DshScopeContextLike {
  plugin(plugin: unknown, config?: unknown): unknown;
}

/** `createAgentScope` 选项 */
export interface AgentScopeOptions {
  /** 会话 id：与 `sessionId` 二选一；同一 id 复用同一把 key */
  readonly sessionId?: string;
  /** 直接给 key（与 sessionId 二选一；都不给则铸一把新 key） */
  readonly key?: ScopeKey;
  /** 上层 scope（agent preset 的常驻挂载） */
  readonly parent?: ScopeKey;
}

/** 进程内 sessionId → scope key（会话恢复/多轮必须拿到同一把 key） */
const sessionScopeKeys = new Map<string, ScopeKey>();

/**
 * 同一会话 id → 同一把 scope key（进程内稳定）。
 *
 * @param sessionId - 会话 id
 * @returns 该会话的 scope key
 */
export function scopeKeyForSession(sessionId: string): ScopeKey {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("dsh-compat/scope: sessionId must be a non-empty string");
  }
  let key = sessionScopeKeys.get(sessionId);
  if (!key) {
    key = { sessionId };
    sessionScopeKeys.set(sessionId, key);
  }
  return key;
}

/** 一个 agent 的 scope：上游 `Scope` + 它的 key（便于日志/诊断） */
export interface AgentScope extends Scope {
  readonly key: ScopeKey;
}

/**
 * 给一个 live agent 铸 scope（`createScope` 的宿主接线）。
 *
 * @param ctx - 已激活的 Cordis 上下文（通常是 runtime 根的派生上下文）
 * @param options - sessionId / key / parent 三选一为主
 * @returns scope（`ctx` 带标签、`dispose()` 拥有其下所有注册）
 */
export function createAgentScope(ctx: DshScopeContextLike, options: AgentScopeOptions = {}): AgentScope {
  const key =
    options.key ?? (options.sessionId !== undefined ? scopeKeyForSession(options.sessionId) : ({} as ScopeKey));
  const scope = createScope(ctx as never, key, options.parent === undefined ? {} : { parent: options.parent });
  return Object.assign(scope, { key });
}

/**
 * 读上下文最近的 scope 标签。
 *
 * @param ctx - 任意（派生的）Cordis 上下文
 * @returns scope key，未打标签时为 `undefined`
 */
export function scopeKeyOf(ctx: unknown): ScopeKey | undefined {
  return scopeOf(ctx as never);
}

/**
 * 该上下文是否归属某个 scope。
 *
 * @param ctx - 任意 Cordis 上下文
 * @returns 是否带 scope 标签
 */
export function isScopedContext(ctx: unknown): boolean {
  return scopeKeyOf(ctx) !== undefined;
}

/**
 * 清理某个会话的进程内 key 缓存（会话被删除/重开时用，避免 Map 长存）。
 *
 * @param sessionId - 会话 id
 * @returns 是否真的移除了一条缓存
 */
export function forgetSessionScopeKey(sessionId: string): boolean {
  return sessionScopeKeys.delete(sessionId);
}
