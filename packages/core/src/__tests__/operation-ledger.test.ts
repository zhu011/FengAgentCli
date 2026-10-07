/**
 * 副作用台账 — 块 3 验收（核心决策层）
 *
 * 验收点：
 * 1. 恢复决策四分派：无记录→执行 / 已成功→跳过 / 未决+幂等→重放 /
 *    未决+非幂等→**强制人工核对**；
 * 2. 幂等键是内容派生的（跨进程稳定）——不掺 toolUseId / 时间戳；
 * 3. 入参键序不影响幂等键（同一逻辑操作必须算出同一个 key）。
 */

import { describe, expect, test } from "bun:test";
import {
  decideOperationReplay,
  deriveOperationKey,
  digestResult,
  inputFingerprint,
} from "../operation-ledger.ts";
import type { OperationRecord } from "../operation-ledger.ts";

function record(status: OperationRecord["status"]): OperationRecord {
  return {
    operationId: "op-1",
    operationKey: "external_write::k1",
    toolName: "external_write",
    sessionId: "s",
    input: { key: "k1" },
    status,
    startedAt: 1,
  };
}

describe("decideOperationReplay", () => {
  test("无台账记录 → 正常执行", () => {
    expect(decideOperationReplay(null, "non-idempotent")).toEqual({
      action: "execute",
    });
  });

  test("已成功 → 跳过并复用记录", () => {
    const decision = decideOperationReplay(record("succeeded"), "non-idempotent");
    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.record.operationId).toBe("op-1");
    }
  });

  test("未决 + 幂等 → 允许重放（沿用同一 operationId）", () => {
    for (const status of ["pending", "unknown"] as const) {
      const decision = decideOperationReplay(record(status), "idempotent");
      expect(decision.action).toBe("replay");
      if (decision.action === "replay") {
        expect(decision.operationId).toBe("op-1");
      }
    }
  });

  test("未决 + 非幂等 → 强制人工核对（绝不静默重放）", () => {
    for (const status of ["pending", "unknown"] as const) {
      const decision = decideOperationReplay(record(status), "non-idempotent");
      expect(decision.action).toBe("manual-review");
      if (decision.action === "manual-review") {
        expect(decision.reason).toContain("幂等");
        expect(decision.record.status).toBe(status);
      }
    }
  });

  test("失败 → 允许重新执行（失败不等于已生效，幂等性由工具声明兜底）", () => {
    expect(decideOperationReplay(record("failed"), "idempotent").action).toBe(
      "execute",
    );
  });
});

describe("幂等键派生", () => {
  test("键不掺 toolUseId / 时间戳 —— 同内容必然同键", () => {
    const a = deriveOperationKey("external_write", { key: "k1", body: "hi" });
    const b = deriveOperationKey("external_write", { key: "k1", body: "hi" });
    expect(a).toBe(b);
  });

  test("键序无关", () => {
    expect(
      deriveOperationKey("t", { a: 1, b: 2 }),
    ).toBe(deriveOperationKey("t", { b: 2, a: 1 }));
  });

  test("嵌套结构同样键序无关", () => {
    expect(
      deriveOperationKey("t", { outer: { x: 1, y: [1, 2, { p: 1, q: 2 }] } }),
    ).toBe(
      deriveOperationKey("t", { outer: { y: [1, 2, { q: 2, p: 1 }], x: 1 } }),
    );
  });

  test("不同入参 / 不同工具 → 不同键", () => {
    expect(deriveOperationKey("t", { a: 1 })).not.toBe(
      deriveOperationKey("t", { a: 2 }),
    );
    expect(deriveOperationKey("t1", { a: 1 })).not.toBe(
      deriveOperationKey("t2", { a: 1 }),
    );
  });

  test("超长入参被截断（键长度有界）", () => {
    const key = deriveOperationKey("t", { blob: "x".repeat(5000) });
    expect(key.length).toBeLessThanOrEqual("t::".length + 512);
  });

  test("循环引用入参不抛（降级为 String）", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => inputFingerprint(cyclic)).not.toThrow();
  });
});

describe("digestResult", () => {
  test("区分成功与失败，且内容变化会改变摘要", () => {
    expect(digestResult("ok", false)).not.toBe(digestResult("ok", true));
    expect(digestResult("ok", false)).not.toBe(digestResult("ok2", false));
  });
});
