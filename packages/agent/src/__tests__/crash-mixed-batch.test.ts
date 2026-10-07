/**
 * 块 6 补格验收：**混合批次**崩溃恢复（同一步两条 intent，一条已记账、一条没记）
 *
 * 为什么单工具矩阵（`crash-injection.test.ts`）不够：那个 fixture 只发一条
 * `tool-call`，所以它证明不了「同一步里的两条 intent 各自按台账归因、互不污染」。
 * 本文件用 `fixtures/crash-mixed-runner.ts` 把 kill 点精确落在 **B 的 `sideEffect()`
 * 第 2 次调用**（= 执行器里 B 的 begin 之前），制造批内边界：
 *
 *   崩溃现场：journal `{a:1, b:0}`、台账只有 `notify_a=succeeded`、pendingTools 两条、
 *            completedSteps 0；恢复核对按三态分别归因（A → 已成功跳过；B → 无台账行，重跑安全）
 *   恢复之后：A 命中台账复用已记录结果（journal 不增）、B 补跑一次 →
 *            journal `{a:1, b:1}`、pending 清空、completedSteps 2、replay == state
 *
 * 断言口径与 `crash-injection.test.ts` 一致：真子进程硬中断 + 全新连接恢复 +
 * 端到端外部副作用计数。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Config } from "@fengagent/core";
import type { LLMClient, LLMEvent, LLMRequest, LLMResponse } from "@fengagent/llm";
import { createContextManager } from "@fengagent/context";
import { createToolExecutor, createToolRegistry } from "@fengagent/tools";
import { z } from "zod";
import { AgentLoop } from "../loop.ts";
import { SessionStore } from "../session.ts";
import { TaskStore } from "../task-store.ts";
import { buildTaskRecoveryReport } from "../task-recovery.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "crash-mixed-runner.ts");
const SESSION_ID = "sess-mixed";
const TASK_ID = "task-mixed";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feng-mixed-"));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上偶发占用：临时目录残留不影响断言
  }
});

/** 外部系统的副作用条数，按工具分别计数（唯一的端到端计数口径） */
function journalCounts(): { a: number; b: number } {
  const path = join(dir, "journal.jsonl");
  if (!existsSync(path)) return { a: 0, b: 0 };
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { tool: string; body: string });
  return {
    a: rows.filter((row) => row.tool === "a").length,
    b: rows.filter((row) => row.tool === "b").length,
  };
}

/** 读取「硬中断点位」标记（子进程 stdio 在受限环境不可捕获，用文件传证据） */
function killMarker(): string {
  const path = join(dir, "kill.marker");
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "(missing)";
}

/** 在子进程里跑到指定 kill 点，返回退出码与中断点位 */
function runFixture(killPoint: string) {
  // stdio 一律不接管：受限沙箱下 `pipe` 会让 uv_spawn 直接 EPERM，
  // 而「能不能捕获子进程输出」与「崩溃注入是否成立」无关 —— 证据走标记文件。
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", FIXTURE, dir, SESSION_ID, killPoint],
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "ignore",
  });
  return { exitCode: proc.exitCode, killPoint: killMarker() };
}

/** 恢复侧：全新连接 + 全新实例（模拟下一个进程） */
function reopen() {
  return new TaskStore(join(dir, "tasks.db"));
}

/** 恢复侧脚本化 LLM：**重新发起同一批两条调用**（崩溃后模型自然重试同一批动作） */
class ReplayLLM implements LLMClient {
  private call = 0;
  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    this.call++;
    if (this.call === 1) {
      // toolUseId 换新无所谓：幂等键由内容派生，不含 toolUseId
      yield { type: "tool-call", id: "tu-a2", name: "notify_a", input: { body: "alpha" } };
      yield { type: "tool-call", id: "tu-b2", name: "notify_b", input: { body: "beta" } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }
    yield { type: "text-delta", text: "完成。" };
    yield { type: "finish", reason: "end_turn" };
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    return {
      id: "mock-gen",
      model: request.model,
      content: [{ type: "text", text: "摘要。" }],
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: "end_turn",
    };
  }
}

const replayConfig: Config = {
  provider: "mock",
  model: "mock-model",
  maxTokens: 1024,
  temperature: 0,
  maxTurns: 5,
  contextWindow: 128000,
  compactThreshold: 0.8,
  compactKeepTokens: 8000,
  compactBuffer: 20_000,
  disableCompact: true,
  toolOutputMaxChars: 2000,
  smallModel: "mock-small",
  serverPort: 3000,
  serverHost: "127.0.0.1",
  corsOrigin: "*",
  autoApproveTools: true,
  allowedTools: "*",
  bashTimeout: 120_000,
  maxToolConcurrency: 10,
  logLevel: "error",
  dataDir: "",
};

/**
 * 跑恢复轮：全新 TaskStore 连接 + 重新发起同一批两条调用。
 *
 * @param taskStore - 恢复侧任务仓
 * @param sessionStore - 恢复侧会话仓
 * @returns 事件流
 */
async function runRecoveryRound(taskStore: TaskStore, sessionStore: SessionStore) {
  const session = sessionStore.loadSession(SESSION_ID);
  if (!session) throw new Error("session not persisted by fixture");

  const toolRegistry = createToolRegistry();
  for (const [name, tool] of [
    ["notify_a", "a"],
    ["notify_b", "b"],
  ] as const) {
    toolRegistry.register({
      name,
      description: `写外部系统 ${tool.toUpperCase()}（非幂等）`,
      inputSchema: z.object({ body: z.string() }),
      sideEffect: () => "non-idempotent",
      operationKey: (input: { body: string }) => `${name}::${input.body}`,
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async execute(input: { body: string }) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(join(dir, "journal.jsonl"), `${JSON.stringify({ tool, body: input.body })}\n`);
        return { content: `notified ${tool} ${input.body}` };
      },
    });
  }

  const contextManager = createContextManager({
    config: {
      contextWindow: replayConfig.contextWindow,
      compactThreshold: replayConfig.compactThreshold,
      compactKeepTokens: replayConfig.compactKeepTokens,
      disableCompact: replayConfig.disableCompact,
      smallModel: replayConfig.smallModel,
    },
    summaryGenerator: new ReplayLLM(),
    systemContextOptions: { workdir: dir },
  });

  const task = taskStore.getTask(TASK_ID)!;
  const loop = new AgentLoop({
    llmClient: new ReplayLLM(),
    toolRegistry,
    toolExecutor: createToolExecutor(),
    contextManager,
    config: { ...replayConfig, dataDir: dir },
    workdir: dir,
    taskRuntime: { store: taskStore, taskId: task.taskId },
  });

  const events: AgentEvent[] = [];
  for await (const event of loop.run(session, {})) {
    events.push(event);
  }
  return events;
}

/** 取恢复轮里某个 toolUseId 的结果事件 */
function resultOf(events: AgentEvent[], toolUseId: string) {
  for (const event of events) {
    if (event.type === "tool-call-result" && event.toolUseId === toolUseId) return event;
  }
  return null;
}

describe("混合批次崩溃恢复：同批两工具，一个已记账一个没记账", () => {
  test("夹具可运行：无中断时 A、B 各恰好 1 条（对照组）", () => {
    const result = runFixture("none");
    expect(result.exitCode).toBe(0);
    expect(journalCounts()).toEqual({ a: 1, b: 1 });
    const store = reopen();
    expect(store.getTask(TASK_ID)!.status).toBe("completed");
    store.close();
  });

  test("kill 在 B 的 begin 之前：A 已记账、B 无行，恢复后 A 跳过、B 重跑，合计恰好 2 次", async () => {
    const killed = runFixture("between-batch-tools");
    expect(killed.exitCode).toBe(9);
    expect(killed.killPoint).toBe("between-batch-tools");
    // 崩溃现场：A 的副作用已发生，B 的没有
    expect(journalCounts()).toEqual({ a: 1, b: 0 });

    const store = reopen();
    const sessionStore = new SessionStore(join(dir, "sessions.db"));
    const session = sessionStore.loadSession(SESSION_ID)!;

    // 状态：整批 intent 已写（两条待办），这一步尚未结算
    const state = store.getTask(TASK_ID)!;
    expect(state.pendingTools).toHaveLength(2);
    expect(state.pendingTools.map((p) => p.toolName).sort()).toEqual(["notify_a", "notify_b"]);
    expect(state.completedSteps).toHaveLength(0);

    // 台账：只有 A 一行且已结算；B 没有任何行
    const ledgerRows = store.ledger.listBySession(SESSION_ID);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.toolName).toBe("notify_a");
    expect(ledgerRows[0]!.status).toBe("succeeded");

    // 恢复核对：两条待办各自按台账归因，互不污染
    const report = buildTaskRecoveryReport(store, session, () => "non-idempotent");
    expect(report.canResumeAutomatically).toBe(true);
    expect(report.requiresConfirmation).toEqual([]);
    expect(report.unresolvedOperations).toHaveLength(0);
    expect(report.pendingTools).toHaveLength(2);
    const notes = report.notes.join(" ");
    // A：有行且 succeeded → 已成功，恢复跳过（**不得**被说成「无台账行」）
    expect(notes).toContain("notify_a");
    expect(notes).toContain("succeeded");
    expect(notes).toContain("跳过");
    // B：无台账行 → 副作用开始前中断，重跑安全
    expect(notes).toContain("notify_b");
    expect(notes).toContain("无台账行");
    // 两条归因是分开写的（不是一条糊住两条）
    expect(report.notes).toHaveLength(2);

    // 恢复轮：重新发起同一批调用 → A 命中台账跳过、B 真执行
    const events = await runRecoveryRound(store, sessionStore);

    // ★ 端到端断言先行：A 没有第二次、B 补跑一次，合计恰好 2 行。
    // 放在结果事件断言之前，是为了让「跳过闸被弄坏 → 副作用翻倍」这类变异
    // 在第一断言就红，而不是先红在某个元数据字段上。
    expect(journalCounts()).toEqual({ a: 1, b: 1 });

    const resultA = resultOf(events, "tu-a2");
    expect(resultA).not.toBeNull();
    if (resultA && resultA.type === "tool-call-result") {
      expect(resultA.result.isError).toBeFalsy();
      const meta = resultA.result.metadata as Record<string, unknown>;
      expect(meta.ledgerHit).toBe("succeeded");
      // 复用的是**已记录的结果**，不是重新执行的产物
      expect(resultA.result.content).toContain("notified a");
    }

    const resultB = resultOf(events, "tu-b2");
    expect(resultB).not.toBeNull();
    if (resultB && resultB.type === "tool-call-result") {
      expect(resultB.result.isError).toBeFalsy();
      const meta = resultB.result.metadata as Record<string, unknown>;
      // B 没有被跳过：它是真执行的
      expect(meta.ledgerHit).toBeUndefined();
      expect(resultB.result.content).toContain("notified b");
    }

    // 恢复轮把这一步结了账：pending 清空、步数结算、重放零差异
    const after = store.getTask(TASK_ID)!;
    expect(after.pendingTools).toHaveLength(0);
    expect(after.completedSteps.length).toBeGreaterThanOrEqual(1);
    expect(store.ledger.listBySession(SESSION_ID).map((row) => row.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(JSON.stringify(store.replay(TASK_ID))).toBe(JSON.stringify(after));

    store.close();
    sessionStore.close();
  });
});
