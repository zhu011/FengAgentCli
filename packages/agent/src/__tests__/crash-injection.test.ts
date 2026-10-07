/**
 * 块 6 验收：崩溃注入（「工具已执行、turn 未落盘」窗口 kill）
 *
 * 验收物本身必须**可信**：所以 kill 走独立子进程的 `process.exit`（真硬中断，
 * 不经任何 catch / finally），恢复走**全新连接 + 全新 TaskStore 实例**，
 * 断言的是端到端的外部副作用计数，而不是日志里的一句「已跳过」。
 *
 * 矩阵（每格都独立复现）：
 *   ① before-side-effect  台账 pending、副作用未发生  → 人工核对闸挡住，journal 保持 0
 *   ② mid-side-effect     台账 pending、副作用已发生  → 人工核对闸挡住，journal 保持 1
 *   ③ after-tool-result   台账 succeeded、turn 未落盘 → 自动恢复 + 跳过，journal 保持 1
 * 变体：幂等工具在 ② 窗口 → 允许重放，外部状态仍只有 1 条（幂等语义端到端成立）
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

const FIXTURE = join(import.meta.dir, "fixtures", "crash-runner.ts");
const SESSION_ID = "sess-crash";
const TASK_ID = "task-crash";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feng-crash-"));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上偶发占用：临时目录残留不影响断言
  }
});

/** 统计外部系统的副作用条数（唯一的端到端计数口径） */
function journalCount(): number {
  const path = join(dir, "journal.jsonl");
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

/** 读取「硬中断点位」标记（子进程 stdio 在受限环境不可捕获，用文件传证据） */
function killMarker(): string {
  const path = join(dir, "kill.marker");
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "(missing)";
}

/** 在子进程里跑到指定 kill 点，返回退出码与中断点位 */
function runFixture(killPoint: string, sideEffect = "non-idempotent") {
  // stdio 一律不接管：受限沙箱下 `pipe` 会让 uv_spawn 直接 EPERM，
  // 而「能不能捕获子进程输出」与「崩溃注入是否成立」无关 —— 证据走标记文件。
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", FIXTURE, dir, SESSION_ID, killPoint, sideEffect],
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

/** 恢复侧脚本化 LLM：**重新发起同一个工具调用**（崩溃后模型自然重试同一动作） */
class ReplayLLM implements LLMClient {
  private call = 0;
  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    this.call++;
    if (this.call === 1) {
      yield { type: "tool-call", id: "tu-2", name: "notify_external", input: { channel: "ops", body: "deploy-done" } };
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
 * 跑恢复轮：用全新 TaskStore 连接 + 重新发起同一工具调用。
 *
 * @param taskStore - 恢复侧任务仓
 * @param sessionStore - 恢复侧会话仓
 * @param kind - 恢复侧工具的副作用类别（必须与被测场景一致）
 * @returns 事件流
 */
async function runRecoveryRound(
  taskStore: TaskStore,
  sessionStore: SessionStore,
  kind: "idempotent" | "non-idempotent" = "non-idempotent",
) {
  const session = sessionStore.loadSession(SESSION_ID);
  if (!session) throw new Error("session not persisted by fixture");

  const toolRegistry = createToolRegistry();
  toolRegistry.register({
    name: "notify_external",
    description: "通知外部系统",
    inputSchema: z.object({ channel: z.string(), body: z.string() }),
    sideEffect: () => kind,
    operationKey: (input: { channel: string }) => `notify_external::${input.channel}`,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute(input: { channel: string; body: string }) {
      // 外部系统：非幂等 = 追加一行（错误重放会多一行）；
      // 幂等 = 按行去重 upsert（重放与执行一次等价）。
      const { appendFileSync, existsSync, readFileSync } = await import("node:fs");
      const journalPath = join(dir, "journal.jsonl");
      const line = JSON.stringify(input);
      if (kind === "idempotent") {
        const existing = existsSync(journalPath)
          ? readFileSync(journalPath, "utf8").split("\n").filter(Boolean)
          : [];
        if (existing.includes(line)) return { content: `notified ${input.channel} (dedup)` };
      }
      appendFileSync(journalPath, `${line}\n`);
      return { content: `notified ${input.channel}` };
    },
  });

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

function toolResultOf(events: AgentEvent[]) {
  for (const event of events) {
    if (event.type === "tool-call-result") return event;
  }
  return null;
}

describe("崩溃注入：子进程硬中断 + 全新连接恢复", () => {
  test("夹具可运行：无中断时副作用恰好 1 条（对照组）", () => {
    const result = runFixture("none");
    expect(result.exitCode).toBe(0);
    expect(journalCount()).toBe(1);
    const store = reopen();
    expect(store.getTask(TASK_ID)!.status).toBe("completed");
    store.close();
  });

  test("矩阵① 工具执行前中断：台账 pending、副作用未发生 → 强制人工核对，不自动执行", () => {
    const killed = runFixture("before-side-effect");
    expect(killed.exitCode).toBe(9);
    expect(killed.killPoint).toBe("before-side-effect");
    expect(journalCount()).toBe(0);

    const store = reopen();
    const sessionStore = new SessionStore(join(dir, "sessions.db"));
    const session = sessionStore.loadSession(SESSION_ID)!;

    // 状态：pending_tools 已写入（intent 已落），步未结算
    const state = store.getTask(TASK_ID)!;
    expect(state.pendingTools).toHaveLength(1);
    expect(state.pendingTools[0]!.operationKey).toBe("notify_external::ops");
    expect(state.completedSteps).toHaveLength(0);

    // 台账：pending（进程死在 complete 之前）
    const unresolved = store.ledger.listBySession(SESSION_ID);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.status).toBe("pending");

    // 恢复核对：非幂等 + 未决 → 必须显式确认
    const report = buildTaskRecoveryReport(store, session, () => "non-idempotent");
    expect(report.canResumeAutomatically).toBe(false);
    expect(report.requiresConfirmation.join()).toContain("notify_external");
    store.close();
    sessionStore.close();
  });

  test("矩阵② 工具执行中中断：副作用已发生、台账 pending → 恢复链路一次都不能再执行", async () => {
    const killed = runFixture("mid-side-effect");
    expect(killed.exitCode).toBe(9);
    expect(journalCount()).toBe(1);

    const store = reopen();
    const sessionStore = new SessionStore(join(dir, "sessions.db"));
    const session = sessionStore.loadSession(SESSION_ID)!;

    const report = buildTaskRecoveryReport(store, session, () => "non-idempotent");
    expect(report.canResumeAutomatically).toBe(false);
    expect(report.unresolvedOperations).toHaveLength(1);
    expect(report.unresolvedOperations[0]!.status).toBe("pending");

    // 即便调用方无视核对报告直接续跑，执行器的闸也必须挡住
    const events = await runRecoveryRound(store, sessionStore);
    const toolResult = toolResultOf(events);
    expect(toolResult).not.toBeNull();
    if (toolResult && toolResult.type === "tool-call-result") {
      expect(toolResult.result.isError).toBe(true);
      expect(
        (toolResult.result.metadata as Record<string, unknown>)?.operationReviewRequired,
      ).toBe(true);
    }
    // 端到端：外部副作用仍然只有 1 条（没有第二次）
    expect(journalCount()).toBe(1);
    // 任务停在 blocked，等待人工显式放行
    expect(store.getTask(TASK_ID)!.status).toBe("blocked");

    // 事件重放与实时状态零差异
    expect(JSON.stringify(store.replay(TASK_ID))).toBe(
      JSON.stringify(store.getTask(TASK_ID)),
    );

    store.close();
    sessionStore.close();
  });

  test("矩阵③ 工具已执行、turn 未落盘：恢复后跳过重复执行，副作用端到端恰好 1 次", async () => {
    const killed = runFixture("after-tool-result");
    expect(killed.exitCode).toBe(9);
    expect(killed.killPoint).toBe("after-tool-result");
    expect(journalCount()).toBe(1);

    const store = reopen();
    const sessionStore = new SessionStore(join(dir, "sessions.db"));
    const session = sessionStore.loadSession(SESSION_ID)!;

    // 崩溃现场：副作用已成功记账，但这一步尚未结算（turn 未落盘）
    const state = store.getTask(TASK_ID)!;
    expect(state.pendingTools).toHaveLength(1);
    expect(state.completedSteps).toHaveLength(0);
    const ledgerRows = store.ledger.listBySession(SESSION_ID);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.status).toBe("succeeded");
    expect(ledgerRows[0]!.resultDigest).toContain("OK:");

    // 恢复核对：已成功记账不算未决 → 允许自动恢复
    const report = buildTaskRecoveryReport(store, session, () => "non-idempotent");
    expect(report.canResumeAutomatically).toBe(true);
    expect(report.unresolvedOperations).toHaveLength(0);
    expect(report.pendingTools).toHaveLength(1);
    // 归因按台账三态：有行且 succeeded → 「已成功，恢复跳过」，不是「无台账行」
    expect(report.ledgerRows).toHaveLength(1);
    expect(report.notes.join(" ")).toContain("succeeded");
    expect(report.notes.join(" ")).toContain("跳过");
    expect(report.notes.join(" ")).not.toContain("无台账行");

    // 恢复轮：重新发起同一调用 → 命中台账 → 跳过执行
    const events = await runRecoveryRound(store, sessionStore);
    const toolResult = toolResultOf(events);
    expect(toolResult).not.toBeNull();
    if (toolResult && toolResult.type === "tool-call-result") {
      expect(toolResult.result.isError).toBeFalsy();
      const meta = toolResult.result.metadata as Record<string, unknown>;
      expect(meta.ledgerHit).toBe("succeeded");
      expect(meta.ledgerStatus).toBe("succeeded");
      // 复用的是**已记录的结果**，不是重新执行的产物
      expect(toolResult.result.content).toContain("notified ops");
    }

    // ★ 端到端断言：同一副作用只发生一次
    expect(journalCount()).toBe(1);

    // 恢复轮把这一步结了账，pending 清空
    const after = store.getTask(TASK_ID)!;
    expect(after.pendingTools).toHaveLength(0);
    expect(after.completedSteps.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(store.replay(TASK_ID))).toBe(JSON.stringify(after));

    store.close();
    sessionStore.close();
  });

  test("变体：幂等工具在「执行中中断」窗口 → 允许重放，外部状态仍只有 1 条", async () => {
    const killed = runFixture("mid-side-effect", "idempotent");
    expect(killed.exitCode).toBe(9);
    expect(journalCount()).toBe(1);

    const store = reopen();
    const sessionStore = new SessionStore(join(dir, "sessions.db"));
    const session = sessionStore.loadSession(SESSION_ID)!;

    const ledgerRow = store.ledger.listBySession(SESSION_ID)[0]!;
    expect(ledgerRow.status).toBe("pending");

    // 幂等 → 不打扰用户，允许重放
    const report = buildTaskRecoveryReport(store, session, () => "idempotent");
    expect(report.canResumeAutomatically).toBe(true);

    await runRecoveryRound(store, sessionStore, "idempotent");
    // 幂等语义：重放执行了，但外部状态仍然只有 1 条（按行去重）
    expect(journalCount()).toBe(1);
    expect(store.ledger.listBySession(SESSION_ID)[0]!.status).toBe("succeeded");

    store.close();
    sessionStore.close();
  });
});
