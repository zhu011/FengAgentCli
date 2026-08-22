/**
 * @fengagent/eval — 测试集加载与解析测试
 */

import { describe, expect, test } from "bun:test";
import { parseTestSet, listTestSets } from "../testset.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("测试集解析", () => {
  test("DeepEval 风格 cases 数组", () => {
    const dir = mkdtempSync(join(tmpdir(), "feng-testset-1-"));
    const file = join(dir, "basic.json");
    writeFileSync(file, JSON.stringify({
      name: "basic",
      cases: [
        { input: "列出文件", expected: "文件列表" },
        { input: "查找代码", expected: "路径" },
      ],
    }));
    const ts = parseTestSet(file);
    expect(ts.valid).toBe(true);
    expect(ts.name).toBe("basic");
    expect(ts.cases).toHaveLength(2);
    expect(ts.cases[0]!.input).toBe("列出文件");
    expect(ts.cases[0]!.expected).toBe("文件列表");
    rmSync(dir, { recursive: true });
  });

  test("items 数组字段名", () => {
    const dir = mkdtempSync(join(tmpdir(), "feng-testset-2-"));
    const file = join(dir, "items.json");
    writeFileSync(file, JSON.stringify({
      name: "items-test",
      items: [{ prompt: "测试", answer: "结果" }],
    }));
    const ts = parseTestSet(file);
    expect(ts.valid).toBe(true);
    expect(ts.cases[0]!.input).toBe("测试");
    expect(ts.cases[0]!.expected).toBe("结果");
    rmSync(dir, { recursive: true });
  });

  test("纯数组格式", () => {
    const dir = mkdtempSync(join(tmpdir(), "feng-testset-3-"));
    const file = join(dir, "array.json");
    writeFileSync(file, JSON.stringify(["问题1", "问题2"]));
    const ts = parseTestSet(file);
    expect(ts.valid).toBe(true);
    expect(ts.cases).toHaveLength(2);
    expect(ts.cases[0]!.input).toBe("问题1");
    rmSync(dir, { recursive: true });
  });

  test("无效 JSON 文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "feng-testset-4-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, "not json {{{");
    const ts = parseTestSet(file);
    expect(ts.valid).toBe(false);
    expect(ts.shape).toBe("invalid_json");
    rmSync(dir, { recursive: true });
  });

  test("文件不存在", () => {
    const ts = parseTestSet("/nonexistent/path.json");
    expect(ts.valid).toBe(false);
    expect(ts.shape).toBe("not_found");
  });

  test("listTestSets — 列出目录中全部测试集", () => {
    const dir = mkdtempSync(join(tmpdir(), "feng-testset-5-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ name: "a", cases: [{ input: "q1" }] }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ name: "b", cases: [{ input: "q2" }] }));
    writeFileSync(join(dir, "c.txt"), "not a test set");
    const sets = listTestSets(dir);
    expect(sets).toHaveLength(2);
    expect(sets.map((s) => s.name).sort()).toEqual(["a", "b"]);
    rmSync(dir, { recursive: true });
  });

  test("空 cases 数组标记为 invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "feng-testset-6-"));
    const file = join(dir, "empty.json");
    writeFileSync(file, JSON.stringify({ name: "empty", cases: [] }));
    const ts = parseTestSet(file);
    expect(ts.valid).toBe(false);
    expect(ts.cases).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });
});
