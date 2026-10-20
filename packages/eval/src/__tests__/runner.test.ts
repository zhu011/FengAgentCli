/**
 * @fengagent/eval — 测试集执行器测试（RSI P1）
 *
 * 覆盖验收契约 B1（真跑）/ B7（基线可比）/ 成本上限：
 * - 用例被真的逐条执行（mock 执行器记录调用），负面用例必须判 fail；
 * - trace 指标（步数 / 工具调用 / token / 耗时）如实采集；
 * - judge 抛错 → 该用例判 fail 而不是让整批崩掉；
 * - trace 落盘可核对；
 * - 成本上限触发中止，后续用例不执行。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@fengagent/core";
import {
  runTestSet,
  aggregateRun,
  summarizeEvents,
  createAgentSessionRunner,
  makeTestSet,
  type CaseTrace,
  type RunnerVerdict,
} from "../runner.ts";

/** 造事件流：n 轮 + 工具调用 + token */
function events(opts: { turns: number; tools?: number; tokens?: [number, number]; error?: string }): AgentEvent[] {
  const list: AgentEvent[] = [];
  for (let i = 0; i < opts.turns; i++) {
    list.push({ type: "message-start", messageId: `m${i}`, role: "assistant" });
    list.push({ type: "text-delta", messageId: `m${i}`, text: `第 ${i} 步` });
    list.push({ type: "turn-end", reason: "end_turn" });
  }
  for (let i = 0; i < (opts.tools ?? 0); i++) {
    list.push({ type: "tool-call-start", toolUseId: `t${i}`, name: "read_file", input: {} });
  }
  if (opts.tokens) {
    list.push({ type: "usage", inputTokens: opts.tokens[0], outputTokens: opts.tokens[1] });
  }
  if (opts.error) {
    list.push({ type: "error", error: { message: opts.error } });
  }
  return list;
}

describe("summarizeEvents — trace 采集", () => {
  test("步数 / 工具调用 / token / 错误都如实统计", () => {
    const trace = summarizeEvents(
      "case-1",
      "列出文件",
      events({ turns: 3, tools: 2, tokens: [120, 30], error: "boom" }),
      "",
      42,
    );
    expect(trace.steps).toBe(3);
    expect(trace.toolCalls).toBe(2);
    expect(trace.tokens).toEqual({ input: 120, output: 30 });
    expect(trace.errors).toEqual(["boom"]);
    expect(trace.durationMs).toBe(42);
    expect(trace.finalText).toBe("第 0 步第 1 步第 2 步");
  });
});

describe("runTestSet — 真跑与判分", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "feng-runner-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("逐条真跑：每条用例都进隔离执行器一次", async () => {
    const seen: string[] = [];
    const set = makeTestSet("demo", [
      { id: "c1", input: "第一题", expected: "答对" },
      { id: "c2", input: "第二题", expected: "答对" },
      { id: "c3", input: "第三题", expected: "答对" },
    ]);

    const run = await runTestSet({
      testSet: set,
      agent: {
        async run(input, ctx) {
          seen.push(`${ctx.caseId}:${input}`);
          return { events: events({ turns: 1, tokens: [10, 5] }), finalText: "答对" };
        },
      },
      judge: (trace) =>
        trace.finalText.includes("答对")
          ? { completionScore: 90, conclusion: "completed" }
          : { completionScore: 10, conclusion: "failed" },
    });

    expect(seen).toEqual(["c1:第一题", "c2:第二题", "c3:第三题"]);
    expect(run.cases).toHaveLength(3);
    expect(run.passed).toBe(3);
    expect(run.passRate).toBe(1);
  });

  test("负面用例必须判 fail（不是「跑完就算过」）", async () => {
    const set = makeTestSet("mixed", [
      { id: "good", input: "答对的题" },
      { id: "bad", input: "答错的题" },
    ]);

    const run = await runTestSet({
      testSet: set,
      agent: {
        async run(input) {
          return {
            events: events({ turns: 1, tokens: [10, 5] }),
            finalText: input.includes("答错") ? "我不确定" : "答对",
          };
        },
      },
      judge: (trace) =>
        trace.finalText === "答对"
          ? { completionScore: 88, conclusion: "completed" }
          : { completionScore: 20, conclusion: "failed" },
    });

    expect(run.cases.find((c) => c.caseId === "good")!.passed).toBe(true);
    expect(run.cases.find((c) => c.caseId === "bad")!.passed).toBe(false);
    expect(run.passed).toBe(1);
    expect(run.failed).toBe(1);
    expect(run.passRate).toBe(0.5);
  });

  test("结论是 unsafe 时即使分数高也判 fail", async () => {
    const run = await runTestSet({
      testSet: makeTestSet("unsafe", [{ id: "u1", input: "rm -rf /" }]),
      agent: {
        async run() {
          return { events: events({ turns: 1 }), finalText: "已删除" };
        },
      },
      judge: () => ({ completionScore: 95, conclusion: "unsafe" }),
    });
    expect(run.cases[0]!.passed).toBe(false);
  });

  test("judge 抛错 → 该用例判 fail，不影响其它用例", async () => {
    let call = 0;
    const run = await runTestSet({
      testSet: makeTestSet("judge-err", [
        { id: "a", input: "a" },
        { id: "b", input: "b" },
      ]),
      agent: {
        async run() {
          return { events: events({ turns: 1 }), finalText: "ok" };
        },
      },
      judge: () => {
        call++;
        if (call === 1) throw new Error("judge 超时");
        return { completionScore: 90, conclusion: "completed" };
      },
    });
    expect(run.cases[0]!.passed).toBe(false);
    expect(run.cases[0]!.verdict.note).toContain("judge 调用失败");
    expect(run.cases[1]!.passed).toBe(true);
  });

  test("执行器抛错 → 记为本用例失败并保留错误", async () => {
    const run = await runTestSet({
      testSet: makeTestSet("boom", [{ id: "x", input: "x" }]),
      agent: {
        async run() {
          throw new Error("会话启动失败");
        },
      },
      judge: () => ({ completionScore: 90, conclusion: "completed" }),
    });
    expect(run.cases[0]!.errors).toContain("会话启动失败");
    expect(run.cases[0]!.steps).toBe(0);
  });

  test("trace 落盘可核对（traceRef 指向真实文件）", async () => {
    const traceDir = join(dir, "traces");
    const run = await runTestSet({
      testSet: makeTestSet("trace", [{ id: "t1", input: "题目" }]),
      traceDir,
      agent: {
        async run() {
          return { events: events({ turns: 2, tokens: [7, 3] }), finalText: "ok" };
        },
      },
      judge: () => ({ completionScore: 80, conclusion: "completed" }),
    });

    const ref = run.cases[0]!.traceRef;
    expect(existsSync(ref)).toBe(true);
    const persisted = JSON.parse(readFileSync(ref, "utf-8")) as CaseTrace;
    expect(persisted.steps).toBe(2);
    expect(persisted.tokens).toEqual({ input: 7, output: 3 });
  });

  test("成本上限：token 超限即中止，后续用例不执行", async () => {
    const seen: string[] = [];
    const run = await runTestSet({
      testSet: makeTestSet("cost", [
        { id: "c1", input: "1" },
        { id: "c2", input: "2" },
        { id: "c3", input: "3" },
      ]),
      agent: {
        async run(input) {
          seen.push(input);
          return { events: events({ turns: 1, tokens: [500, 500] }), finalText: "ok" };
        },
      },
      judge: () => ({ completionScore: 90, conclusion: "completed" }),
      maxTokens: 800,
    });
    expect(seen).toEqual(["1"]); // 第 1 条就把预算跑穿（1000 > 800），后续不再执行
    expect(run.aborted).toBe(true);
    expect(run.abortReason).toContain("成本上限");
    expect(run.cases).toHaveLength(1);
  });

  test("maxCases 可以只跑前 N 条（held-in / held-out 切分基础）", async () => {
    const run = await runTestSet({
      testSet: makeTestSet("slice", [
        { id: "1", input: "1" },
        { id: "2", input: "2" },
      ]),
      maxCases: 1,
      agent: {
        async run() {
          return { events: events({ turns: 1 }), finalText: "ok" };
        },
      },
      judge: () => ({ completionScore: 90, conclusion: "completed" }),
    });
    expect(run.cases).toHaveLength(1);
    expect(run.aborted).toBe(false);
  });

  test("同一测试集两次执行指标可比（同模型/同设置 ⇒ 同结果）", async () => {
    const makeOpts = () => ({
      testSet: makeTestSet("stable", [{ id: "s", input: "题" }]),
      agent: {
        async run() {
          return { events: events({ turns: 2, tools: 1, tokens: [20, 10] }), finalText: "ok" };
        },
      },
      judge: (): RunnerVerdict => ({ completionScore: 77, correctnessScore: 66, conclusion: "partial" }),
    });
    const a = await runTestSet(makeOpts());
    const b = await runTestSet(makeOpts());
    expect(a.passRate).toBe(b.passRate);
    expect(a.meanCompletionScore).toBe(b.meanCompletionScore);
    expect(a.meanSteps).toBe(b.meanSteps);
    expect(a.meanTokens).toBe(b.meanTokens);
  });
});

describe("createAgentSessionRunner — 接真实 Agent", () => {
  test("每次 run 都新建 Agent（用例间隔离，不共享历史）", async () => {
    let created = 0;
    const runner = createAgentSessionRunner(() => {
      created++;
      return {
        async *prompt(_text: string) {
          yield { type: "text-delta", messageId: "m", text: "ok" } as AgentEvent;
          yield { type: "turn-end", reason: "end_turn" } as AgentEvent;
        },
      };
    });

    const first = await runner.run("a", { caseId: "c1", workdir: "." });
    const second = await runner.run("b", { caseId: "c2", workdir: "." });
    expect(created).toBe(2);
    expect(first.finalText).toBe("ok");
    expect(second.finalText).toBe("ok");
  });
});

describe("用例工作目录隔离", () => {
  test("给了隔离根：每条用例落到 <根>/<caseId>，且目录真的建好", async () => {
    const root = mkdtempSync(join(tmpdir(), "feng-runner-iso-"));
    const seen: string[] = [];
    try {
      await runTestSet({
        testSet: makeTestSet("iso", [
          { id: "c1", input: "1" },
          { id: "c2", input: "2" },
        ]),
        workdir: root,
        agent: {
          async run(_input, ctx) {
            seen.push(ctx.workdir);
            return { events: events({ turns: 1 }), finalText: "ok" };
          },
        },
        judge: () => ({ completionScore: 90, conclusion: "completed" }),
      });

      expect(seen).toEqual([join(root, "c1"), join(root, "c2")]);
      for (const dir of seen) expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("没给隔离根时沿用进程 cwd（历史行为，不额外建目录）", async () => {
    const seen: string[] = [];
    await runTestSet({
      testSet: makeTestSet("cwd", [{ id: "only", input: "x" }]),
      agent: {
        async run(_input, ctx) {
          seen.push(ctx.workdir);
          return { events: events({ turns: 1 }), finalText: "ok" };
        },
      },
      judge: () => ({ completionScore: 90, conclusion: "completed" }),
    });

    expect(seen).toEqual([process.cwd()]);
  });

  test("createAgentSessionRunner 把 ctx 透传给工厂（否则 Agent 绑在进程 cwd）", async () => {
    const seen: Array<{ caseId: string; workdir: string }> = [];
    const runner = createAgentSessionRunner((ctx) => {
      seen.push(ctx);
      return {
        async *prompt(_text: string) {
          yield { type: "text-delta", messageId: "m", text: "ok" } as AgentEvent;
          yield { type: "turn-end", reason: "end_turn" } as AgentEvent;
        },
      };
    });

    const caseWorkdir = join(tmpdir(), "feng-runner-iso", "c9");
    await runner.run("输入", { caseId: "c9", workdir: caseWorkdir });
    expect(seen).toEqual([{ caseId: "c9", workdir: caseWorkdir }]);
  });
});

describe("aggregateRun — 聚合口径", () => {
  test("空用例集：全部指标为 0（不除零）", () => {
    const run = aggregateRun("empty", []);
    expect(run.passRate).toBe(0);
    expect(run.meanCompletionScore).toBe(0);
    expect(run.meanSteps).toBe(0);
    expect(run.aborted).toBe(false);
  });
});
