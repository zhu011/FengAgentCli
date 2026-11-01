/**
 * @fengagent/dsh-compat — P3 `scope` 映射验收
 *
 * dsh 的 scope 原语直接跑在同一条 Cordis 4 运行时上，本文件的重点是**证明**：
 * 1. `createAgentScope` 铸出的上下文带标签，派生上下文继承；`dispose()` 真正释放
 *    其下注册（不是只扔一个空对象）；
 * 2. 同一会话 id 稳定映射同一把 key（多轮/恢复不会换 scope）；
 * 3. 父子链方向：注册视图向下继承、事件准入向上扩展（祖先监听器收后代事件，
 *    兄弟/后代收不到祖先事件）；
 * 4. `scopeTarget` 载体保留原有过滤器，未打标签的监听器仍是全局的；
 * 5. 循环/重复绑定被拒绝（scope 链不会闭环）。
 *
 * 全部用真的 `@fengagent/cordis` 运行时（`createRuntime` 的根上下文）验证，
 * 不用 stub ctx——scope 的语义一半在 Cordis 的 `plugin/fiber/effect` 里。
 */

import { describe, expect, test } from "bun:test";
import { createRuntime, type FengRuntime } from "@fengagent/cordis";
import {
  bindScopeParent,
  carrierKeyOf,
  createAgentScope,
  forgetSessionScopeKey,
  isScopeCarrier,
  isScopedContext,
  scopeChainOf,
  scopeKeyForSession,
  scopeKeyOf,
  scopeTarget,
  type ScopeKey,
} from "../scope.ts";

/** 起一个最小运行时（无插件）拿到真 Cordis 根上下文 */
async function withRuntime(run: (runtime: FengRuntime) => Promise<void>): Promise<void> {
  const runtime = createRuntime({ workdir: ".", plugins: [] });
  await runtime.start();
  try {
    await run(runtime);
  } finally {
    await runtime.stop();
  }
}

/** 载体上的 Cordis 过滤函数（`Context.filter` 是 symbol，且本包不直接依赖 cordis 包） */
function scopeFilterOf(carrier: object): ((ctx: unknown) => boolean) | undefined {
  for (const symbol of Object.getOwnPropertySymbols(carrier)) {
    const value = (carrier as Record<symbol, unknown>)[symbol];
    if (typeof value === "function") return value as (ctx: unknown) => boolean;
  }
  return undefined;
}

describe("scope：agent 上下文标签", () => {
  test("createAgentScope 打标签、派生上下文继承、dispose 幂等且真释放注册", async () => {
    await withRuntime(async (runtime) => {
      const scope = createAgentScope(runtime.ctx, { sessionId: "session-1" });

      expect(scopeKeyOf(scope.ctx)).toBe(scope.key);
      expect(scopeKeyOf(scope.ctx.extend({}))).toBe(scope.key);
      expect(isScopedContext(scope.ctx)).toBe(true);
      expect(scopeKeyOf(runtime.ctx)).toBeUndefined();

      let disposed = 0;
      scope.ctx.effect(() => () => {
        disposed += 1;
      });
      await scope.dispose();
      await scope.dispose();
      expect(disposed).toBe(1);
    });
  });

  test("同一 sessionId 稳定同一把 key；可显式遗忘", () => {
    const first = scopeKeyForSession("session-2");
    expect(scopeKeyForSession("session-2")).toBe(first);
    expect(scopeKeyForSession("session-3")).not.toBe(first);
    expect(forgetSessionScopeKey("session-2")).toBe(true);
    expect(scopeKeyForSession("session-2")).not.toBe(first);
    expect(forgetSessionScopeKey("session-2")).toBe(true);
  });

  test("createAgentScope 可复用显式 key", async () => {
    await withRuntime(async (runtime) => {
      const key: ScopeKey = {};
      const scope = createAgentScope(runtime.ctx, { key });
      expect(scopeKeyOf(scope.ctx)).toBe(key);
      await scope.dispose();
    });
  });
});

describe("scope：父子链与事件路由", () => {
  test("bindScopeParent：链顺序、重复绑定与闭环拒绝", () => {
    const child: ScopeKey = {};
    const parent: ScopeKey = {};
    const grandparent: ScopeKey = {};
    bindScopeParent(parent, grandparent);
    bindScopeParent(child, parent);
    expect(scopeChainOf(child)).toEqual([child, parent, grandparent]);
    expect(scopeChainOf(undefined)).toEqual([]);
    expect(() => bindScopeParent(child, {})).toThrow(/already bound/);

    const a: ScopeKey = {};
    const b: ScopeKey = {};
    bindScopeParent(a, b);
    expect(() => bindScopeParent(b, a)).toThrow();
  });

  test("scopeTarget：祖先监听器收后代事件，兄弟/后代收不到祖先事件", async () => {
    await withRuntime(async (runtime) => {
      const parentScope = createAgentScope(runtime.ctx, { sessionId: "parent" });
      const childScope = createAgentScope(runtime.ctx, { sessionId: "child", parent: parentScope.key });
      const siblingScope = createAgentScope(runtime.ctx, { sessionId: "sibling" });

      // 事件按「派发者的 scope」造载体：后代事件可被祖先监听器收到
      const carrier = scopeTarget(runtime.ctx, childScope.key);
      expect(isScopeCarrier(carrier)).toBe(true);
      expect(carrierKeyOf(carrier)).toBe(childScope.key);

      const filter = scopeFilterOf(carrier);
      expect(typeof filter).toBe("function");
      if (!filter) throw new Error("scopeTarget carrier has no Cordis filter");

      // 未打标签 = 全局（Cordis 的默认语义）
      expect(filter(runtime.ctx)).toBe(true);
      // 自己 / 祖先监听器都收后代事件
      expect(filter(childScope.ctx)).toBe(true);
      expect(filter(parentScope.ctx)).toBe(true);
      // 兄弟收不到
      expect(filter(siblingScope.ctx)).toBe(false);

      // 反向：祖先事件不下发给后代监听器
      const parentCarrier = scopeTarget(runtime.ctx, parentScope.key);
      const parentFilter = scopeFilterOf(parentCarrier);
      if (!parentFilter) throw new Error("scopeTarget carrier has no Cordis filter");
      expect(parentFilter(parentScope.ctx)).toBe(true);
      expect(parentFilter(childScope.ctx)).toBe(false);

      await Promise.all([parentScope.dispose(), childScope.dispose(), siblingScope.dispose()]);
    });
  });

  test("非载体不会伪装成 scope 载体", () => {
    expect(isScopeCarrier({})).toBe(false);
    expect(carrierKeyOf({})).toBeUndefined();
  });
});
