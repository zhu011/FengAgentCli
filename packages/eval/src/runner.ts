/**
 * @fengagent/eval — 测试集执行器（RSI P1 地基）
 *
 * **现状缺口**：`--judge` 之前只把测试集列名（`eval/index.ts` 只打印 `testset.name`），
 * judge 评的是 trace 里的历史会话，用例从未被执行。本模块把「用例 → 隔离会话真跑
 * → 采 trace → 判分」这段补上，验证闸（`gate.ts`）才有可比对象。
 *
 * 三条设计约束：
 *
 * 1. **每个用例一个隔离会话**：用例之间不共享历史（`AgentSessionRunner` 每次 `run`
 *    都应当是新会话）；`workdir` 由调用方给隔离目录，避免测试集污染真实工作区。
 * 2. **trace 可核对**：每个用例的步数 / 工具调用数 / token / 耗时 / 最终文本都随
 *    结果返回，并在 `traceDir` 存在时落 JSON 文件（`traceRef` 指向它）。
 * 3. **负面用例必须判 fail**：判分只看 judge 结论 + 完成度阈值，不看「跑完了」；
 *    判分函数（judge）也是依赖注入项 —— 生产用 LLM-judge，测试用确定性判分。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@fengagent/core";
import type { TestCase, TestSet } from "./testset.ts";

/** 判分结论（对齐 judge 的六态枚举） */
export interface RunnerVerdict {
  /** 完成度 0–100 */
  completionScore: number;
  /** 正确性 0–100 */
  correctnessScore?: number;
  /** 结论枚举：completed / partial / failed / tool_misused / unsafe / inefficient */
  conclusion: string;
  /** 判分依据 */
  note?: string;
}

/** 单个用例的 trace（可核对、可落盘） */
export interface CaseTrace {
  /** 用例 id */
  caseId: string;
  /** 用例输入 */
  input: string;
  /** 期望输出（judge 参照） */
  expected?: string;
  /** LLM 轮次数（一个 turn-end 记一步） */
  steps: number;
  /** 工具调用次数 */
  toolCalls: number;
  /** token 用量 */
  tokens: { input: number; output: number };
  /** 用时（毫秒） */
  durationMs: number;
  /** 最终助手文本 */
  finalText: string;
  /** 运行期错误 */
  errors: string[];
  /** trace 引用（落盘路径或 `memory:<caseId>`） */
  traceRef: string;
}

/** 单用例结果 */
export interface CaseOutcome extends CaseTrace {
  /** 是否通过 */
  passed: boolean;
  /** 综合分（默认取 completionScore） */
  score: number;
  /** 判分结论 */
  verdict: RunnerVerdict;
}

/** 一次测试集执行结果 */
export interface TestSetRun {
  /** 测试集名称 */
  setName: string;
  /** 用例结果 */
  cases: CaseOutcome[];
  /** 通过数 */
  passed: number;
  /** 失败数 */
  failed: number;
  /** 通过率（0–1；无用例时为 0） */
  passRate: number;
  /** 平均完成度 */
  meanCompletionScore: number;
  /** 平均正确性 */
  meanCorrectnessScore: number;
  /** 平均步数 */
  meanSteps: number;
  /** 平均 token（输入 + 输出） */
  meanTokens: number;
  /** 平均耗时（毫秒） */
  meanDurationMs: number;
  /** 总 token */
  totalTokens: number;
  /** 是否因成本上限中止 */
  aborted: boolean;
  /** 中止原因 */
  abortReason?: string;
}

/** 隔离会话执行器（生产用真实 Agent，测试用 mock） */
export interface AgentSessionRunner {
  /**
   * 在一个**隔离会话**里跑一条用例。
   *
   * @param input - 用例输入
   * @param ctx - 用例上下文（caseId + 隔离 workdir）
   * @returns 事件流与最终文本
   */
  run(
    input: string,
    ctx: { caseId: string; workdir: string },
  ): Promise<{ events: AgentEvent[]; finalText: string }>;
}

/** 执行器选项 */
export interface RunTestSetOptions {
  /** 待执行测试集 */
  testSet: TestSet;
  /** 隔离会话执行器 */
  agent: AgentSessionRunner;
  /** 判分函数（生产 = LLM-judge；测试 = 确定性判分） */
  judge: (trace: CaseTrace) => RunnerVerdict | Promise<RunnerVerdict>;
  /** 隔离工作目录（默认由调用方准备；不传则不落盘 trace） */
  workdir?: string;
  /** trace 落盘目录（默认 `undefined` = 只在内存） */
  traceDir?: string;
  /** 通过阈值：completionScore ≥ 它且结论不是 failed/unsafe（默认 60） */
  passThreshold?: number;
  /** 最多执行多少条用例（默认全部） */
  maxCases?: number;
  /** 成本上限：token 超限即中止本次执行（后续用例记为未跑） */
  maxTokens?: number;
  /** 耗时上限：整体毫秒数超限即中止 */
  maxDurationMs?: number;
  /** 时钟（测试可注入） */
  now?: () => number;
}

/** 结论视为「不合格」的枚举 */
const FAILING_CONCLUSIONS = new Set(["failed", "unsafe", "tool_misused"]);

/**
 * 从事件流统计 trace 指标。
 *
 * @param caseId - 用例 id
 * @param input - 用例输入
 * @param events - Agent 事件流
 * @param finalText - 最终文本（事件流里也能拼出来，这里以调用方为准）
 * @param durationMs - 用时
 * @returns trace（`traceRef` 由调用方补）
 */
export function summarizeEvents(
  caseId: string,
  input: string,
  events: readonly AgentEvent[],
  finalText: string,
  durationMs: number,
): Omit<CaseTrace, "traceRef" | "expected"> {
  let steps = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const errors: string[] = [];
  let streamed = "";

  for (const event of events) {
    switch (event.type) {
      case "turn-end":
        steps++;
        break;
      case "tool-call-start":
        toolCalls++;
        break;
      case "usage":
        inputTokens += event.inputTokens;
        outputTokens += event.outputTokens;
        break;
      case "text-delta":
        streamed += event.text;
        break;
      case "error":
        errors.push(event.error.message);
        break;
      default:
        break;
    }
  }

  return {
    caseId,
    input,
    steps,
    toolCalls,
    tokens: { input: inputTokens, output: outputTokens },
    durationMs,
    finalText: finalText.length > 0 ? finalText : streamed,
    errors,
  };
}

/**
 * 执行一个测试集（真跑 + 采 trace + 判分）。
 *
 * @param options - 执行选项
 * @returns 测试集结果（含逐用例 trace 与聚合指标）
 */
export async function runTestSet(options: RunTestSetOptions): Promise<TestSetRun> {
  const now = options.now ?? Date.now;
  const passThreshold = options.passThreshold ?? 60;
  const cases = options.maxCases === undefined
    ? options.testSet.cases
    : options.testSet.cases.slice(0, options.maxCases);

  if (options.traceDir) {
    mkdirSync(options.traceDir, { recursive: true });
  }

  const startedAt = now();
  const outcomes: CaseOutcome[] = [];
  let totalTokens = 0;
  let aborted = false;
  let abortReason: string | undefined;

  for (const [index, testCase] of cases.entries()) {
    if (aborted) break;

    // 成本/耗时上限
    if (options.maxTokens !== undefined && totalTokens > options.maxTokens) {
      aborted = true;
      abortReason = `成本上限：已用 ${totalTokens} token > ${options.maxTokens}`;
      break;
    }
    if (options.maxDurationMs !== undefined && now() - startedAt > options.maxDurationMs) {
      aborted = true;
      abortReason = `耗时上限：已用 ${now() - startedAt}ms > ${options.maxDurationMs}ms`;
      break;
    }

    // 用例 id：必须带下标，否则没写 id 的用例全叫 case-0（trace 文件互相覆盖）
    const caseId = caseIdOf(testCase, index);
    const caseStart = now();
    let events: AgentEvent[] = [];
    let finalText = "";
    try {
      const run = await options.agent.run(testCase.input, {
        caseId,
        workdir: options.workdir ?? process.cwd(),
      });
      events = run.events;
      finalText = run.finalText;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      events = [{ type: "error", error: { message } }];
    }
    const durationMs = now() - caseStart;

    const summary = summarizeEvents(caseId, testCase.input, events, finalText, durationMs);
    const trace: CaseTrace = {
      ...summary,
      ...(testCase.expected === undefined ? {} : { expected: testCase.expected }),
      traceRef: `memory:${caseId}`,
    };

    // trace 落盘（可核对）
    if (options.traceDir) {
      const tracePath = join(options.traceDir, `${safeFileName(caseId)}.trace.json`);
      writeFileSync(tracePath, JSON.stringify(trace, null, 2), "utf-8");
      trace.traceRef = tracePath;
    }

    let verdict: RunnerVerdict;
    try {
      verdict = await options.judge(trace);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      verdict = {
        completionScore: 0,
        conclusion: "failed",
        note: `judge 调用失败：${message}`,
      };
    }

    const tokensUsed = trace.tokens.input + trace.tokens.output;
    totalTokens += tokensUsed;

    const passed =
      verdict.completionScore >= passThreshold &&
      !FAILING_CONCLUSIONS.has(verdict.conclusion);

    outcomes.push({
      ...trace,
      passed,
      score: verdict.completionScore,
      verdict,
    });
  }

  return aggregateRun(options.testSet.name, outcomes, totalTokens, aborted, abortReason);
}

/**
 * 聚合指标（验证闸比较用）。
 *
 * @param setName - 测试集名称
 * @param cases - 用例结果
 * @param totalTokens - 已消耗 token（中止时用于成本核算）
 */
export function aggregateRun(
  setName: string,
  cases: readonly CaseOutcome[],
  totalTokens?: number,
  aborted = false,
  abortReason?: string,
): TestSetRun {
  const n = cases.length;
  const sum = (pick: (c: CaseOutcome) => number) =>
    n === 0 ? 0 : cases.reduce((acc, c) => acc + pick(c), 0) / n;
  const tokens = totalTokens ?? cases.reduce(
    (acc, c) => acc + c.tokens.input + c.tokens.output,
    0,
  );
  return {
    setName,
    cases: [...cases],
    passed: cases.filter((c) => c.passed).length,
    failed: cases.filter((c) => !c.passed).length,
    passRate: n === 0 ? 0 : cases.filter((c) => c.passed).length / n,
    meanCompletionScore: sum((c) => c.verdict.completionScore),
    meanCorrectnessScore: sum((c) => c.verdict.correctnessScore ?? 0),
    meanSteps: sum((c) => c.steps),
    meanTokens: sum((c) => c.tokens.input + c.tokens.output),
    meanDurationMs: sum((c) => c.durationMs),
    totalTokens: tokens,
    aborted,
    ...(abortReason === undefined ? {} : { abortReason }),
  };
}

/**
 * 用真实 Agent（`Agent#prompt`）构造隔离会话执行器。
 *
 * 每次 `run` 都新建一个 Agent —— 用例之间不共享历史（隔离会话语义）。
 *
 * @param createAgent - 工厂（每次调用返回全新 Agent）
 */
export function createAgentSessionRunner(
  createAgent: () => { prompt(text: string): AsyncGenerator<AgentEvent> },
): AgentSessionRunner {
  return {
    async run(input) {
      const agent = createAgent();
      const events: AgentEvent[] = [];
      let finalText = "";
      for await (const event of agent.prompt(input)) {
        events.push(event);
        if (event.type === "text-delta") finalText += event.text;
      }
      return { events, finalText };
    },
  };
}

/** 用例 id（缺省用下标） */
export function caseIdOf(testCase: TestCase, index?: number): string {
  if (testCase.id !== undefined && testCase.id !== "") return testCase.id;
  return `case-${index ?? 0}`;
}

/** 文件名安全化 */
function safeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** 把用例列表包装成 TestSet（held-in / held-out 切分用） */
export function makeTestSet(name: string, cases: readonly TestCase[], file = ""): TestSet {
  return {
    name,
    file,
    cases: [...cases],
    valid: cases.length > 0,
    shape: "object_with_cases",
  };
}
