/**
 * @fengagent/eval — trace 记录来源判定（测试数据 vs 生产数据）
 *
 * 背景（AGE-29 P1 实测缺陷）：e2e / 冒烟脚本用假模型（`test-model`）跑对话时，
 * 记录同样落进 `<数据根>/logs/llm-trace-{date}.jsonl`，于是观测页的「模型对比」
 * 等生产视图里混入 `test-model 0ms` 这类噪声，且当时没有任何来源维度可过滤。
 *
 * 两道防线：
 *   1. **写侧**：`packages/llm/src/trace.ts` 现在把 `FENG_TRACE_SOURCE` 写进记录的
 *      `source` 字段（e2e 脚本设 `FENG_TRACE_SOURCE=test`），新数据自带来源。
 *   2. **读侧**：本模块给出统一的判定与过滤，观测路由默认排除非生产记录，
 *      `?includeTest=1` 可回看。对**没有** `source` 字段的旧日志，按模型名形态
 *      兜底识别（`test-model` / `mock-*` / `fake*` / `dummy*` / `stub*`），
 *      以便历史污染数据也能被正确排除。
 */

import type { TraceRecord } from "./analyzer.ts";

/** 非生产来源标记（`FENG_TRACE_SOURCE` 约定取值） */
export const NON_PRODUCTION_SOURCES = ["test", "e2e", "mock", "fixture", "bench"] as const;

/**
 * 旧日志（无 `source` 字段）的兜底识别：模型名形如 test / mock / fake / dummy / stub。
 *
 * 真实模型名不会以这些词开头，故作为启发式足够安全。
 */
const TEST_MODEL_PATTERN = /^(test|mock|fake|dummy|stub)([-_.]|$)/i;

/**
 * 判定单条 trace 记录的来源。
 *
 * @returns `source` 字段值；缺省时：模型名像测试模型 → "test"，否则 "runtime"
 */
export function traceSourceOf(record: Pick<TraceRecord, "source" | "model">): string {
  const explicit = record.source?.trim();
  if (explicit) return explicit;
  const model = record.model ?? "";
  return TEST_MODEL_PATTERN.test(model) ? "test" : "runtime";
}

/** 该记录是否属于测试 / 非生产数据 */
export function isTestTraceRecord(record: Pick<TraceRecord, "source" | "model">): boolean {
  const source = traceSourceOf(record).toLowerCase();
  return (NON_PRODUCTION_SOURCES as readonly string[]).includes(source);
}

/** 过滤结果（保留被排除条数，便于在响应里如实说明） */
export interface TraceFilterResult<T> {
  /** 过滤后的记录 */
  records: T[];
  /** 被排除的非生产记录数 */
  excluded: number;
}

/**
 * 分离生产记录与非生产记录。
 *
 * @param records - 原始 trace 记录
 * @param includeTest - true 时原样返回（`excluded` 为 0），用于 `?includeTest=1`
 */
export function splitTraceRecords<T extends Pick<TraceRecord, "source" | "model">>(
  records: T[],
  includeTest = false,
): TraceFilterResult<T> {
  if (includeTest) return { records, excluded: 0 };
  const kept: T[] = [];
  let excluded = 0;
  for (const r of records) {
    if (isTestTraceRecord(r)) excluded++;
    else kept.push(r);
  }
  return { records: kept, excluded };
}
