/**
 * @fengagent/eval — 产卡跳（测试集真跑 → 判分 → 自省卡 → 入库）测试
 *
 * 覆盖验收里「运行态接线缺失」的核心一跳：
 *
 * 1. 用例真跑（有步数/token/最终文本）→ 失败用例产卡，通过用例不产卡；
 * 2. 证据指针指向真跑出来的 trace 文件（可回查）；
 * 3. judge 自己挂掉 → 不产卡（铁律 1）；
 * 4. 没给 sink → 只产草稿不落库；
 * 5. **`runEval --judge` 默认路径**：即使没有历史 trace 日志，也照样真跑测试集并入库
 *    （以前这条路径只会 `process.exit(1)`，所以 `reflections.db` 永远为空）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@fengagent/core";
import {
  runTestSetCards,
  reflectTraceDir,
  LLM_FAILURE_NOTE_PREFIX,
  runEval,
  makeTestSet,
  parseTestSet,
  type AgentSessionRunner,
  type CaseTrace,
  type ReflectionCardDraft,
  type RunnerVerdict,
} from "../index.ts";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "feng-rsi-cards-"));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

/** 一条「真跑过」的用例事件流（步数 / token / 工具调用 / 最终文本都在） */
function caseEvents(text: string, tokens: [number, number] = [120, 30]): AgentEvent[] {
  return [
    { type: "message-start", messageId: "m1", role: "assistant" },
    { type: "turn-end", reason: "end_turn" },
    { type: "usage", inputTokens: tokens[0], outputTokens: tokens[1] },
    { type: "text-delta", messageId: "m1", text },
  ];
}

/** 假执行器：按用例输入决定「答对」还是「答错」 */
function fakeRunner(answer: (input: string) => string): AgentSessionRunner {
  return {
    async run(input) {
      return { events: caseEvents(answer(input)), finalText: answer(input) };
    },
  };
}

/** 假判分：结果里含「对」→ completed，否则 failed */
function judgeByText(trace: CaseTrace): RunnerVerdict {
  const ok = trace.finalText.includes("对");
  return ok
    ? { completionScore: 92, correctnessScore: 90, conclusion: "completed", note: "答对了" }
    : { completionScore: 20, correctnessScore: 10, conclusion: "failed", note: "没答对" };
}

function collectingSink(): { drafts: ReflectionCardDraft[]; ingest: (d: ReflectionCardDraft) => unknown } {
  const drafts: ReflectionCardDraft[] = [];
  return {
    drafts,
    ingest(draft) {
      drafts.push(draft);
      return { id: `card-${drafts.length}` };
    },
  };
}

describe("产卡跳：测试集真跑 → judge → 自省卡 → 入库", () => {
  test("失败用例产卡、通过用例不产卡，证据指向真跑 trace 文件", async () => {
    const sink = collectingSink();
    const traceDir = reflectTraceDir(dataRoot, "smoke");

    const results = await runTestSetCards({
      testSets: [
        makeTestSet("smoke", [
          { id: "ok", input: "简单问题", expected: "对" },
          { id: "bad", input: "难问题", expected: "对" },
        ]),
      ],
      agent: fakeRunner((input) => (input === "难问题" ? "不知道" : "对")),
      judge: judgeByText,
      ingestCard: sink.ingest,
      workdir: dataRoot,
      traceDir: () => traceDir,
    });

    expect(results).toHaveLength(1);
    const [result] = results;
    // 真跑证据：步数与 token 来自事件流，不是「列个名字」
    expect(result!.run.cases).toHaveLength(2);
    for (const c of result!.run.cases) {
      expect(c.steps).toBeGreaterThan(0);
      expect(c.tokens.input).toBeGreaterThan(0);
    }

    // 只给失败的那条产卡
    expect(result!.drafts).toHaveLength(1);
    expect(result!.drafts[0]!.trigger).toBe("judge_failed");
    expect(result!.drafts[0]!.evidence[0]!.kind).toBe("trace");
    const ref = result!.drafts[0]!.evidence[0]!.ref;
    expect(ref).toBe(join(traceDir, "bad.trace.json"));
    expect(existsSync(ref)).toBe(true); // 证据可回查
    expect(result!.ingested).toBe(1);
    expect(sink.drafts).toHaveLength(1);
  });

  test("judge 调用失败 → 不产卡（评测器坏了不算被评对象的问题）", async () => {
    const sink = collectingSink();
    const results = await runTestSetCards({
      testSets: [makeTestSet("broken-judge", [{ id: "c1", input: "题" }])],
      agent: fakeRunner(() => "随便答"),
      judge: () => ({ completionScore: 0, conclusion: "failed", note: `${LLM_FAILURE_NOTE_PREFIX}: 超时` }),
      ingestCard: sink.ingest,
      workdir: dataRoot,
    });
    expect(results[0]!.drafts).toHaveLength(0);
    expect(results[0]!.ingested).toBe(0);
    expect(sink.drafts).toHaveLength(0);
  });

  test("没给 sink → 只产草稿不落库（dry-run 不谎报入库）", async () => {
    const results = await runTestSetCards({
      testSets: [makeTestSet("dry", [{ id: "c1", input: "题" }])],
      agent: fakeRunner(() => "答错"),
      judge: () => ({ completionScore: 10, conclusion: "failed" }),
      workdir: dataRoot,
    });
    expect(results[0]!.drafts).toHaveLength(1);
    expect(results[0]!.ingested).toBe(0);
    // 没给 traceDir → 内存引用（不假装有文件）
    expect(results[0]!.drafts[0]!.evidence[0]!.ref).toBe("dry/c1#judge");
  });

  test("maxCases 成本闸生效（只跑前 N 条）", async () => {
    const results = await runTestSetCards({
      testSets: [
        makeTestSet(
          "many",
          Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, input: `题 ${i}` })),
        ),
      ],
      agent: fakeRunner(() => "答错"),
      judge: () => ({ completionScore: 10, conclusion: "failed" }),
      workdir: dataRoot,
      maxCases: 2,
    });
    expect(results[0]!.run.cases).toHaveLength(2);
  });
});

describe("runEval --judge 默认路径（没有历史 trace 也要能产卡）", () => {
  test("无 trace 日志 + 有测试集 → 真跑并入库，且不 process.exit", async () => {
    // 只有测试集，没有 logs/llm-trace-*.jsonl
    const testsetsDir = join(dataRoot, "testsets");
    mkdirSync(testsetsDir, { recursive: true });
    writeFileSync(
      join(testsetsDir, "basic.json"),
      JSON.stringify({
        name: "basic",
        cases: [
          { id: "good", input: "对的问题", expected: "对" },
          { id: "bad", input: "难的问题", expected: "对" },
        ],
      }),
      "utf-8",
    );

    const sink = collectingSink();
    await runEval({
      judge: true,
      logDir: join(dataRoot, "logs"), // 不存在 → 无日志
      testsetsDir,
      dataRoot,
      caseRunner: fakeRunner((input) => (input === "难的问题" ? "不知道" : "对")),
      caseJudge: judgeByText,
      ingestCard: sink.ingest,
    });

    // 卡真的产出来了（以前这里 0 张：只列测试集名字）
    expect(sink.drafts).toHaveLength(1);
    expect(sink.drafts[0]!.evidence[0]!.ref).toContain("bad.trace.json");
    const traceFile = join(reflectTraceDir(dataRoot, "basic"), "bad.trace.json");
    expect(existsSync(traceFile)).toBe(true);
  });

  test("测试集文件能被 listTestSets 读到（id 缺省也不串号）", async () => {
    const testsetsDir = join(dataRoot, "testsets");
    mkdirSync(testsetsDir, { recursive: true });
    writeFileSync(
      join(testsetsDir, "noid.json"),
      JSON.stringify({ name: "noid", cases: [{ input: "甲" }, { input: "乙" }] }),
      "utf-8",
    );
    const parsed = parseTestSet(join(testsetsDir, "noid.json"));
    expect(parsed.cases.map((c) => c.id)).toEqual(["case-0", "case-1"]);

    const results = await runTestSetCards({
      testSets: [parsed],
      agent: fakeRunner(() => "答错"),
      judge: () => ({ completionScore: 10, conclusion: "failed" }),
      workdir: dataRoot,
      traceDir: () => reflectTraceDir(dataRoot, "noid"),
    });
    const caseIds = results[0]!.run.cases.map((c) => c.caseId);
    expect(caseIds).toEqual(["case-0", "case-1"]);
    // trace 文件按 id 分开落盘（旧的 caseIdOf 不带下标会互相覆盖）
    const dir = reflectTraceDir(dataRoot, "noid");
    expect(existsSync(join(dir, "case-0.trace.json"))).toBe(true);
    expect(existsSync(join(dir, "case-1.trace.json"))).toBe(true);
  });
});
