/**
 * AGE-29 RSI 首期 —— P0 自省卡 + P1 验证闸的端到端闭环测试
 *
 * 这是「闭环真的通了吗」的唯一证据，全程跑**真 Agent**（真 AgentLoop、真上下文装配、
 * 真 SQLite 仓、真 overlay 文件），只把 LLM 换成可编程 mock（不联网）：
 *
 * 1. 证据 → 卡：judge 失败 trace 入卡，带证据才进库；
 * 2. 卡 → 下一轮系统提示：`assemble()` 出现「过往教训」；
 * 3. 测试集真跑：`runTestSet` 每条用例都过 AgentLoop，采到真实步数 / token / 文本，
 *    负面用例判 fail；
 * 4. 验证闸：基线 vs 候选（候选注入了 overlay）→ adopted → overlay 落盘；
 * 5. 写回 → 下一轮生效：采纳后的 `assemble()` 出现 overlay 里的规则；
 * 6. `FENG_REFLECT_INJECT=off` 一键关：卡片与 overlay 两段都不注入。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMClient, LLMEvent, LLMRequest, LLMResponse } from "@fengagent/llm";
import type { Config } from "@fengagent/core";
import { createSession } from "@fengagent/core";
import { createContextManager } from "@fengagent/context";
import { createToolExecutor, createToolRegistry } from "@fengagent/tools";
import { Agent, ReflectionStore } from "@fengagent/agent";
import {
  createAgentSessionRunner,
  runTestSet,
  runVerificationGate,
  makeTestSet,
  readPromptOverlay,
  listExperiments,
  type RunnerVerdict,
  type TestSetRun,
} from "@fengagent/eval";

// ──────────────────────────────────────────────
// Mock LLM（按调用顺序返回固定回答；支持按 prompt 内容区分题目）
// ──────────────────────────────────────────────

class ScriptedLLM implements LLMClient {
  private queue: LLMEvent[][] = [];
  public readonly calls: LLMRequest[] = [];

  push(turns: LLMEvent[][]): void {
    this.queue = turns;
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    this.calls.push(request);
    const events = this.queue.shift() ?? [];
    for (const event of events) yield event;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.calls.push(request);
    return {
      id: `mock-${this.calls.length}`,
      model: request.model,
      content: [{ type: "text", text: "摘要" }],
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: "end_turn",
    };
  }
}

/** 一轮「只回文本」的 LLM 事件 */
function answer(text: string, tokens: [number, number] = [100, 20]): LLMEvent[] {
  return [
    { type: "text-delta", text },
    { type: "usage", inputTokens: tokens[0], outputTokens: tokens[1] },
    { type: "finish", reason: "end_turn" },
  ];
}

const CONFIG: Config = {
  model: "test-model",
  smallModel: "test-small-model",
  provider: "anthropic",
  maxTokens: 4096,
  temperature: 1.0,
  contextWindow: 200_000,
  compactThreshold: 0.85,
  compactKeepTokens: 8000,
  compactBuffer: 20_000,
  disableCompact: true,
  toolOutputMaxChars: 2000,
  serverPort: 3000,
  serverHost: "127.0.0.1",
  corsOrigin: "*",
  autoApproveTools: true,
  allowedTools: "*",
  bashTimeout: 120_000,
  maxToolConcurrency: 10,
  maxTurns: 10,
  logLevel: "error",
  dataDir: "~/.fengagent",
};

let workdir: string;
let dataRoot: string;
let store: ReflectionStore;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "feng-rsi-work-"));
  dataRoot = mkdtempSync(join(tmpdir(), "feng-rsi-data-"));
  store = new ReflectionStore(join(dataRoot, "reflect", "reflections.db"));
});

afterEach(() => {
  store.close();
  rmSync(workdir, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
});

/** 装配真 Agent（每次新建 = 隔离会话） */
function makeAgent(llm: ScriptedLLM, reflectEnv: Record<string, string | undefined> = {}) {
  const toolRegistry = createToolRegistry();
  const toolExecutor = createToolExecutor();
  const contextManager = createContextManager({
    config: {
      contextWindow: CONFIG.contextWindow,
      compactThreshold: CONFIG.compactThreshold,
      compactKeepTokens: CONFIG.compactKeepTokens,
      disableCompact: true,
      smallModel: CONFIG.smallModel,
    },
    summaryGenerator: llm,
    systemContextOptions: {
      workdir,
      loadMemory: false,
      loadAgentsMd: false,
      reflections: () => store.selectForInjection({ at: Date.now() }),
      reflectDataRoot: dataRoot,
      reflectEnv,
    },
  });
  const agent = new Agent({
    llmClient: llm,
    toolRegistry,
    toolExecutor,
    contextManager,
    config: CONFIG,
    workdir,
  });
  return { agent, contextManager };
}

// ──────────────────────────────────────────────
// 1+2. 证据 → 卡 → 下一轮系统提示
// ──────────────────────────────────────────────

describe("P0 闭环：证据 → 自省卡 → 注入下一轮", () => {
  test("judge 失败 trace 入卡后，下一轮系统提示出现该教训", async () => {
    const llm = new ScriptedLLM();
    const { contextManager } = makeAgent(llm);

    // 注入前：无「过往教训」小节
    const before = await contextManager.assemble(createSession("test-model"));
    expect(before.system).not.toContain("过往教训");

    // 证据 → 卡（无证据的「觉得」进不来）
    expect(
      store.ingest({ trigger: "judge_failed", lesson: "凭感觉的教训", evidence: [] }),
    ).toBeNull();
    const card = store.ingest({
      trigger: "judge_failed",
      lesson: "改文件前先读目标文件再编辑",
      evidence: [{ kind: "trace", ref: "trace-2026-10-18-001" }],
      signal: { conclusion: "failed", completionScore: 40, sessionId: "s-1" },
      scopeKey: `workdir:${workdir}`,
    });
    expect(card).not.toBeNull();

    // 下一轮系统提示（缓存失效 → 重新装配）
    contextManager.invalidateSystemPrompt();
    const after = await contextManager.assemble(createSession("test-model"));
    expect(after.system).toContain("过往教训");
    expect(after.system).toContain("改文件前先读目标文件再编辑");
    expect(after.system).toContain("证据: trace:trace-2026-10-18-001");
    expect(after.system).not.toContain("凭感觉的教训");
  });

  test("注入后卡片被标记为 injected，事件流可复原（reflect/injected）", async () => {
    const card = store.ingest({
      trigger: "guard_tripped",
      lesson: "同一工具连续失败三次就停下来换策略",
      evidence: [{ kind: "guard", ref: "consecutive-tool-errors" }],
    })!;
    const picked = store.selectForInjection({ at: Date.now() });
    expect(picked.map((c) => c.id)).toEqual([card.id]);

    store.recordInjection([card.id], "session-xyz");
    const reloaded = store.get(card.id)!;
    expect(reloaded.status).toBe("injected");
    expect(reloaded.effect?.injectedCount).toBe(1);
    expect(store.events(card.id).map((e) => e.type)).toEqual([
      "reflect/card-created",
      "reflect/card-updated",
      "reflect/injected",
    ]);
  });

  test("FENG_REFLECT_INJECT=off 时注入为 0（主流程行为不变）", async () => {
    store.ingest({
      trigger: "judge_failed",
      lesson: "关掉注入后这条不该出现",
      evidence: [{ kind: "trace", ref: "t-1" }],
    });
    const llm = new ScriptedLLM();
    const { contextManager } = makeAgent(llm, { FENG_REFLECT_INJECT: "off" });
    const ctx = await contextManager.assemble(createSession("test-model"));
    expect(ctx.system).not.toContain("过往教训");
    expect(ctx.system).not.toContain("关掉注入后这条不该出现");
  });
});

// ──────────────────────────────────────────────
// 3. 测试集执行器：真跑 AgentLoop
// ──────────────────────────────────────────────

describe("P1 测试集执行器：真跑隔离会话 + 判分", () => {
  test("每条用例都过真 AgentLoop（步数/token/文本来自真实事件流）", async () => {
    const llm = new ScriptedLLM();
    const agentRunner = createAgentSessionRunner(() => makeAgent(llm).agent);

    const run = await runTestSet({
      testSet: makeTestSet("smoke", [
        { id: "c1", input: "列出当前目录", expected: "含文件列表" },
        { id: "c2", input: "解释这段代码", expected: "含解释" },
      ]),
      agent: {
        async run(input, ctx) {
          llm.push([answer(`回答：${input}`)]);
          return agentRunner.run(input, ctx);
        },
      },
      judge: (trace): RunnerVerdict => ({
        completionScore: trace.finalText.includes("回答：") ? 90 : 10,
        conclusion: trace.finalText.includes("回答：") ? "completed" : "failed",
      }),
    });

    expect(run.cases).toHaveLength(2);
    for (const c of run.cases) {
      expect(c.steps).toBeGreaterThan(0); // 真的走了一轮 LLM
      expect(c.tokens.input).toBeGreaterThan(0); // 真的有 token 计费
      expect(c.tokens.output).toBeGreaterThan(0);
      expect(c.finalText).toContain("回答：");
      expect(c.passed).toBe(true);
    }
    expect(run.passRate).toBe(1);
  });

  test("负面用例在真跑下也判 fail（不是「跑完就算过」）", async () => {
    const llm = new ScriptedLLM();
    const agentRunner = createAgentSessionRunner(() => makeAgent(llm).agent);

    const run = await runTestSet({
      testSet: makeTestSet("negative", [
        { id: "good", input: "正常问题", expected: "正常回答" },
        { id: "bad", input: "会答错的问题", expected: "正确答案" },
      ]),
      agent: {
        async run(input, ctx) {
          llm.push([answer(input.includes("答错") ? "我不知道" : "正常回答")]);
          return agentRunner.run(input, ctx);
        },
      },
      judge: (trace) =>
        trace.finalText === "正常回答"
          ? { completionScore: 92, conclusion: "completed" }
          : { completionScore: 15, conclusion: "failed" },
    });

    const bad = run.cases.find((c) => c.caseId === "bad")!;
    expect(bad.steps).toBeGreaterThan(0); // 真的跑了
    expect(bad.passed).toBe(false); // 但还是判 fail
    expect(run.failed).toBe(1);
  });
});

// ──────────────────────────────────────────────
// 4+5. 验证闸：A/B + 采纳 → overlay 生效
// ──────────────────────────────────────────────

describe("P1 验证闸：A/B 双集 + 拒绝回滚 + 采纳生效", () => {
  test("双集不劣 → adopted → overlay 写回 → 下一轮系统提示读到规则", async () => {
    const card = store.ingest({
      trigger: "judge_failed",
      lesson: "先读文件再改，避免覆盖他人改动",
      evidence: [{ kind: "trace", ref: "trace-1" }],
    })!;

    const held = makeTestSet("held", [{ id: "h1", input: "改这个文件", expected: "改对" }]);
    const heldOut = makeTestSet("held-out", [{ id: "o1", input: "改另一个文件", expected: "改对" }]);

    const runWith = async (which: "in" | "out"): Promise<TestSetRun> => {
      const llm = new ScriptedLLM();
      const agentRunner = createAgentSessionRunner(() => makeAgent(llm).agent);
      const set = which === "in" ? held : heldOut;
      return runTestSet({
        testSet: set,
        agent: {
          async run(input, ctx) {
            llm.push([answer("改对了")]);
            return agentRunner.run(input, ctx);
          },
        },
        judge: () => ({ completionScore: 85, conclusion: "completed" }),
      });
    };

    const experiment = await runVerificationGate({
      dataRoot,
      card,
      id: "exp-e2e",
      // 耗时护栏是墙钟倍数：整套测试并发跑时抖动可达数倍，这里放宽（护栏逻辑本身
      // 在 gate.test.ts 用确定性假数据覆盖），其余上限保持默认。
      limits: { maxDurationRatio: 1_000 },
      runBaseline: (which) => runWith(which === "held-in" ? "in" : "out"),
      runCandidate: (which) => runWith(which === "held-in" ? "in" : "out"),
      onAdopted: () => {
        const latest = store.get(card.id)!;
        store.transition(card.id, latest.revision, { status: "adopted" });
      },
    });

    expect(experiment.verdict, JSON.stringify(experiment.reasons)).toBe("adopted");
    expect(experiment.rolledBack).toBe(false);

    // overlay 落盘（唯一的写回落点）
    const overlay = readPromptOverlay(dataRoot);
    expect(overlay.existed).toBe(true);
    expect(overlay.content).toContain("先读文件再改，避免覆盖他人改动");

    // 写回 → 下一轮系统提示（真正生效的那一跳）
    const llm = new ScriptedLLM();
    const { contextManager } = makeAgent(llm);
    contextManager.invalidateSystemPrompt();
    const ctx = await contextManager.assemble(createSession("test-model"));
    expect(ctx.system).toContain("先读文件再改，避免覆盖他人改动");

    // 卡片状态被回调推进为 adopted
    expect(store.get(card.id)!.status).toBe("adopted");
  });

  test("候选回归 → rejected → overlay 回滚 → 拒绝留痕可查询", async () => {
    const card = store.ingest({
      trigger: "test_failed",
      lesson: "不要重复读同一文件",
      evidence: [{ kind: "test", ref: "case-42" }],
    })!;
    const rejectedCalls: string[] = [];

    const experiment = await runVerificationGate({
      dataRoot,
      card,
      id: "exp-regress",
      runBaseline: async (which) =>
        runTestSet({
          testSet: makeTestSet(which, [{ id: "x", input: "题" }]),
          agent: {
            async run() {
              return { events: [{ type: "turn-end", reason: "end_turn" }], finalText: "对" };
            },
          },
          judge: () => ({ completionScore: 90, conclusion: "completed" }),
        }),
      runCandidate: async (which) =>
        runTestSet({
          testSet: makeTestSet(which, [{ id: "x", input: "题" }]),
          agent: {
            async run() {
              return { events: [{ type: "turn-end", reason: "end_turn" }], finalText: "错" };
            },
          },
          judge: () => ({ completionScore: 20, conclusion: "failed" }),
        }),
      onRejected: (e) => rejectedCalls.push(e.id),
    });

    expect(experiment.verdict).toBe("rejected");
    expect(experiment.rolledBack).toBe(true);
    expect(rejectedCalls).toEqual(["exp-regress"]);
    // 回滚后 overlay 不存在（被拒的写回不留痕在数据根里）
    expect(readPromptOverlay(dataRoot).existed).toBe(false);
    // 拒绝留痕
    expect(listExperiments(dataRoot, { verdict: "rejected" })).toHaveLength(1);
  });
});
