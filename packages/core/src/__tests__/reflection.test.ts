/**
 * @fengagent/core — 自省卡领域层测试（RSI P0）
 *
 * 覆盖验收契约 A1（证据门）/ A3（TTL）/ A6（事件词汇）/ A7（作用域）的纯函数部分：
 * - 无证据卡被 {@link assertValidReflectionCard} 拒绝，`hasReflectionEvidence` 判定一致；
 * - 未注册触发源（如 "self_reflection"）被拒；
 * - 排序分：severity 优先、证据多者优先、越新越靠前；
 * - 可注入性：rejected / expired / 过期卡都不可注入。
 */

import { describe, test, expect } from "bun:test";
import {
  REFLECTION_TRIGGERS,
  REFLECT_EVENT_TYPES,
  ReflectionError,
  assertValidReflectionCard,
  hasReflectionEvidence,
  isReflectEventType,
  isReflectionInjectable,
  reflectionRank,
} from "../reflection.ts";
import type { ReflectionCard } from "../reflection.ts";

const NOW = 1_700_000_000_000;

/** 造一张最小可用卡片 */
function makeCard(overrides: Partial<ReflectionCard> = {}): ReflectionCard {
  return {
    id: "card-1",
    revision: 1,
    scope: "project",
    scopeKey: "project:default",
    status: "proposed",
    trigger: "judge_failed",
    signal: { conclusion: "failed" },
    lesson: "改文件前先读一遍目标文件，避免重复编辑同一片段",
    evidence: [{ kind: "trace", ref: "trace-2026-10-18-001" }],
    appliesTo: { kind: "system-prompt", target: "prompt-overlay.md" },
    effect: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 86_400_000,
    ...overrides,
  };
}

describe("自省卡 — 证据门（铁律 2）", () => {
  test("有证据的卡通过校验", () => {
    expect(() => assertValidReflectionCard(makeCard())).not.toThrow();
    expect(hasReflectionEvidence(makeCard())).toBe(true);
  });

  test("证据为空数组 → 拒绝（无证据的「觉得」不入库）", () => {
    const card = makeCard({ evidence: [] });
    expect(hasReflectionEvidence(card)).toBe(false);
    expect(() => assertValidReflectionCard(card)).toThrow(ReflectionError);
    try {
      assertValidReflectionCard(card);
    } catch (err) {
      expect((err as ReflectionError).code).toBe("evidence_required");
    }
  });

  test("证据 ref 是空白串 → 视同无证据", () => {
    const card = makeCard({ evidence: [{ kind: "trace", ref: "   " }] });
    expect(hasReflectionEvidence(card)).toBe(false);
    expect(() => assertValidReflectionCard(card)).toThrow(ReflectionError);
  });

  test("未注册触发源（self_reflection）→ 拒绝", () => {
    const card = makeCard({ trigger: "self_reflection" as never });
    expect(() => assertValidReflectionCard(card)).toThrow(ReflectionError);
    try {
      assertValidReflectionCard(card);
    } catch (err) {
      expect((err as ReflectionError).code).toBe("unknown_trigger");
    }
  });

  test("四类带证据来源都在白名单里，且没有「自我批评」入口", () => {
    expect(REFLECTION_TRIGGERS).toContain("judge_failed");
    expect(REFLECTION_TRIGGERS).toContain("judge_unsafe");
    expect(REFLECTION_TRIGGERS).toContain("guard_tripped");
    expect(REFLECTION_TRIGGERS).toContain("test_failed");
    expect(REFLECTION_TRIGGERS).toContain("human_negative");
    expect(REFLECTION_TRIGGERS).not.toContain("self_reflection" as never);
  });

  test("教训为空 → 拒绝", () => {
    const card = makeCard({ lesson: "   " });
    expect(() => assertValidReflectionCard(card)).toThrow(ReflectionError);
  });
});

describe("自省卡 — 排序", () => {
  test("unsafe 优先于 judge_failed（同为单证据、同时间）", () => {
    const unsafe = makeCard({ id: "a", trigger: "judge_unsafe" });
    const failed = makeCard({ id: "b", trigger: "judge_failed" });
    expect(reflectionRank(unsafe, NOW)).toBeGreaterThan(reflectionRank(failed, NOW));
  });

  test("证据更多的卡排序更高", () => {
    const one = makeCard({
      id: "one",
      evidence: [{ kind: "trace", ref: "t1" }],
    });
    const three = makeCard({
      id: "three",
      evidence: [
        { kind: "trace", ref: "t1" },
        { kind: "test", ref: "case-1" },
        { kind: "guard", ref: "repeat-call" },
      ],
    });
    expect(reflectionRank(three, NOW)).toBeGreaterThan(reflectionRank(one, NOW));
  });

  test("更近的卡排序更高（同一触发源、同一证据数）", () => {
    const fresh = makeCard({ id: "fresh", updatedAt: NOW });
    const stale = makeCard({ id: "stale", updatedAt: NOW - 48 * 3_600_000 });
    expect(reflectionRank(fresh, NOW)).toBeGreaterThan(reflectionRank(stale, NOW));
  });

  test("排序是纯函数：同一输入两次调用结果相同", () => {
    const card = makeCard();
    expect(reflectionRank(card, NOW)).toBe(reflectionRank(card, NOW));
  });
});

describe("自省卡 — 可注入性", () => {
  test("proposed / injected / adopted 可注入", () => {
    for (const status of ["proposed", "injected", "adopted"] as const) {
      expect(isReflectionInjectable(makeCard({ status }), NOW)).toBe(true);
    }
  });

  test("rejected / expired 不可注入", () => {
    for (const status of ["rejected", "expired"] as const) {
      expect(isReflectionInjectable(makeCard({ status }), NOW)).toBe(false);
    }
  });

  test("TTL 到期不可注入", () => {
    const expired = makeCard({ expiresAt: NOW - 1 });
    expect(isReflectionInjectable(expired, NOW)).toBe(false);
    const alive = makeCard({ expiresAt: NOW + 1 });
    expect(isReflectionInjectable(alive, NOW)).toBe(true);
  });

  test("无证据的卡即使状态合法也不可注入", () => {
    expect(isReflectionInjectable(makeCard({ evidence: [] }), NOW)).toBe(false);
  });
});

describe("reflect/* 事件词汇", () => {
  test("覆盖写入 / 注入 / 过期 / 采纳 / 拒绝", () => {
    expect(REFLECT_EVENT_TYPES).toEqual([
      "reflect/card-created",
      "reflect/card-updated",
      "reflect/injected",
      "reflect/expired",
      "reflect/adopted",
      "reflect/rejected",
    ]);
  });

  test("isReflectEventType 只认 reflect/* 词汇", () => {
    expect(isReflectEventType("reflect/injected")).toBe(true);
    expect(isReflectEventType("task/created")).toBe(false);
    expect(isReflectEventType("reflect/unknown")).toBe(false);
  });
});
