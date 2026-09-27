/**
 * @fengagent/eval — trace 来源判定测试（AGE-29 P1）
 *
 * 缺陷原状：e2e / 冒烟脚本用 `test-model` 跑出的记录混进生产 trace 日志，
 * 观测页「模型对比」里出现 `test-model 0ms`，且没有任何来源维度可过滤。
 * 修复后新数据带 `source` 字段，旧数据按模型名兜底识别，观测路由默认排除。
 */

import { describe, test, expect } from "bun:test";
import {
  NON_PRODUCTION_SOURCES,
  traceSourceOf,
  isTestTraceRecord,
  splitTraceRecords,
} from "../trace-source.ts";
import type { TraceRecord } from "../analyzer.ts";

/** 构造最小 trace 记录 */
function rec(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    timestamp: "2026-09-26T00:00:00.000Z",
    sessionId: "s1",
    direction: "response",
    model: "deepseek-v4-pro",
    hasToolCalls: false,
    ...overrides,
  };
}

describe("traceSourceOf", () => {
  test("显式 source 字段优先", () => {
    expect(traceSourceOf(rec({ source: "test" }))).toBe("test");
    expect(traceSourceOf(rec({ source: "e2e" }))).toBe("e2e");
    expect(traceSourceOf(rec({ source: "runtime" }))).toBe("runtime");
  });

  test("无 source 字段时默认 runtime", () => {
    expect(traceSourceOf(rec())).toBe("runtime");
  });

  test("无 source 字段的旧日志：模型名像测试模型 → test", () => {
    for (const model of ["test-model", "test_small", "mock-model", "fake-llm", "dummy", "stub-v1"]) {
      expect(traceSourceOf(rec({ model }))).toBe("test");
    }
  });

  test("真实模型名不被误判（含 test 子串但非前缀词的模型）", () => {
    for (const model of ["deepseek-v4-pro", "claude-sonnet-4", "gpt-5", "latest-model", "contest-x"]) {
      expect(traceSourceOf(rec({ model }))).toBe("runtime");
    }
  });

  test("空白 source 视为未设置", () => {
    expect(traceSourceOf(rec({ source: "   " }))).toBe("runtime");
  });
});

describe("isTestTraceRecord", () => {
  test("非生产来源集合全部命中", () => {
    for (const source of NON_PRODUCTION_SOURCES) {
      expect(isTestTraceRecord(rec({ source }))).toBe(true);
    }
  });

  test("大小写不敏感", () => {
    expect(isTestTraceRecord(rec({ source: "TEST" }))).toBe(true);
    expect(isTestTraceRecord(rec({ source: "E2E" }))).toBe(true);
  });

  test("生产记录不命中", () => {
    expect(isTestTraceRecord(rec())).toBe(false);
    expect(isTestTraceRecord(rec({ source: "runtime" }))).toBe(false);
  });
});

describe("splitTraceRecords", () => {
  const records: TraceRecord[] = [
    rec({ sessionId: "prod-1", model: "deepseek-v4-pro" }),
    rec({ sessionId: "test-1", model: "test-model" }), // 旧日志：无 source，按模型名识别
    rec({ sessionId: "test-2", model: "deepseek-v4-pro", source: "test" }), // 新日志：显式标记
    rec({ sessionId: "prod-2", model: "claude-sonnet-4", source: "runtime" }),
  ];

  test("默认排除非生产记录并如实计数", () => {
    const { records: kept, excluded } = splitTraceRecords(records);
    expect(kept.map((r) => r.sessionId)).toEqual(["prod-1", "prod-2"]);
    expect(excluded).toBe(2);
  });

  test("includeTest=true 时原样返回（excluded=0）", () => {
    const { records: kept, excluded } = splitTraceRecords(records, true);
    expect(kept).toHaveLength(4);
    expect(excluded).toBe(0);
  });

  test("全部为生产记录时零排除（不改变原有行为）", () => {
    const { records: kept, excluded } = splitTraceRecords([
      rec({ model: "model-a" }),
      rec({ model: "model-b" }),
    ]);
    expect(kept).toHaveLength(2);
    expect(excluded).toBe(0);
  });
});
