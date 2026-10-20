/**
 * @fengagent/shared — RSI 自省通道环境变量测试
 *
 * 覆盖两件事：
 * 1. `resolveReflectBudget()` 的解析口径（默认值 / 覆盖 / 非法值回退）；
 * 2. `resolveReflectStoreOptions()` 把 `FENG_REFLECT_TTL_MS` 交给卡片仓 ——
 *    修复前该变量只解析不接线，改它不影响卡片存活期。
 */

import { describe, expect, test } from "bun:test";
import {
  REFLECT_INJECT_DEFAULTS,
  isReflectInjectionEnabled,
  resolveReflectBudget,
  resolveReflectStoreOptions,
} from "../reflect-env.ts";

describe("resolveReflectBudget — 自省注入预算", () => {
  test("缺省值：5 条 / 600 token / 14 天", () => {
    expect(resolveReflectBudget({})).toEqual({
      maxCards: 5,
      maxTokens: 600,
      ttlMs: REFLECT_INJECT_DEFAULTS.ttlMs,
    });
  });

  test("三个变量都能覆盖", () => {
    expect(
      resolveReflectBudget({
        FENG_REFLECT_MAX_CARDS: "2",
        FENG_REFLECT_MAX_TOKENS: "128",
        FENG_REFLECT_TTL_MS: "60000",
      }),
    ).toEqual({ maxCards: 2, maxTokens: 128, ttlMs: 60000 });
  });

  test("非法 / 非正数一律回退默认（不抛错）", () => {
    for (const raw of ["abc", "0", "-5", ""]) {
      expect(resolveReflectBudget({ FENG_REFLECT_TTL_MS: raw }).ttlMs).toBe(
        REFLECT_INJECT_DEFAULTS.ttlMs,
      );
    }
  });
});

describe("resolveReflectStoreOptions — 卡片仓装配口径", () => {
  test("TTL 来自环境变量（交给 ReflectionStore，而不是库内硬编码常量）", () => {
    expect(resolveReflectStoreOptions({ FENG_REFLECT_TTL_MS: "3600000" })).toEqual({
      ttlMs: 3600000,
    });
  });

  test("未设置时即 14 天默认值", () => {
    expect(resolveReflectStoreOptions({})).toEqual({ ttlMs: REFLECT_INJECT_DEFAULTS.ttlMs });
  });
});

describe("isReflectInjectionEnabled — 注入开关", () => {
  test("默认开；off / 0 / false / no 关", () => {
    expect(isReflectInjectionEnabled({})).toBe(true);
    for (const raw of ["off", "OFF", " 0 ", "false", "no"]) {
      expect(isReflectInjectionEnabled({ FENG_REFLECT_INJECT: raw })).toBe(false);
    }
  });
});
