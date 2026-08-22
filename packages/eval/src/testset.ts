/**
 * @fengagent/eval — 测试集加载与解析
 *
 * 支持 AgentBench / DeepEval 风格的测试集 JSON 文件。
 * 宽容解析多种结构：cases / items / tests / examples / test_cases。
 *
 * 测试集格式示例（DeepEval 风格）：
 * {
 *   "name": "agent-bench-basic",
 *   "cases": [
 *     { "input": "列出当前目录文件", "expected": "包含文件列表" },
 *     { "input": "查找含 agent 的文件", "expected": "返回路径" }
 *   ]
 * }
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 单条测试用例 */
export interface TestCase {
  /** 输入文本（用户请求） */
  input: string;
  /** 预期输出（用于 judge 参照） */
  expected?: string;
  /** 可选 ID */
  id?: string;
}

/** 测试集元信息 */
export interface TestSet {
  /** 测试集名称（取自文件 name 字段或文件名） */
  name: string;
  /** 文件路径 */
  file: string;
  /** 测试用例列表 */
  cases: TestCase[];
  /** 是否成功解析 */
  valid: boolean;
  /** 原始结构类型 */
  shape: string;
}

/**
 * 宽容解析测试集 JSON。
 *
 * 支持的 cases 字段名：cases / items / tests / examples / test_cases
 * 支持的 case 字段名：input / prompt / query / question + expected / expected_output / answer
 */
export function parseTestSet(file: string): TestSet {
  const name = "unknown";
  if (!existsSync(file)) {
    return { name, file, cases: [], valid: false, shape: "not_found" };
  }

  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return { name, file, cases: [], valid: false, shape: "read_error" };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { name, file, cases: [], valid: false, shape: "invalid_json" };
  }

  // 提取 name
  const setName = (json as { name?: string })?.name ?? file.split(/[\\/]/).pop()!.replace(/\.json$/, "");

  // 提取 cases 数组（宽容字段名）
  const obj = json as Record<string, unknown>;
  const casesField = obj.cases ?? obj.items ?? obj.tests ?? obj.examples ?? obj.test_cases;
  const arr = Array.isArray(casesField) ? casesField : Array.isArray(json) ? json : [];

  const cases: TestCase[] = arr.map((item, i) => {
    if (typeof item === "string") {
      return { input: item, id: `case-${i}` };
    }
    const o = item as Record<string, unknown>;
    const input = String(o.input ?? o.prompt ?? o.query ?? o.question ?? "");
    const expected = o.expected ?? o.expected_output ?? o.answer ?? o.output;
    const id = String(o.id ?? `case-${i}`);
    return { input, expected: typeof expected === "string" ? expected : JSON.stringify(expected), id };
  });

  return {
    name: setName,
    file,
    cases,
    valid: cases.length > 0,
    shape: Array.isArray(json) ? "array" : Array.isArray(casesField) ? "object_with_cases" : "unknown",
  };
}

/**
 * 列出测试集目录中的全部测试集。
 *
 * @param testsetsDir - 测试集目录（默认 <数据根>/testsets）
 */
export function listTestSets(testsetsDir: string): TestSet[] {
  if (!existsSync(testsetsDir)) return [];
  return readdirSync(testsetsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => parseTestSet(join(testsetsDir, f)))
    .sort((a, b) => a.name.localeCompare(b.name));
}
