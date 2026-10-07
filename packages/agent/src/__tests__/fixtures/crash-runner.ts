/**
 * 崩溃注入执行器（**独立子进程**）
 *
 * 用途：块 6 的验收物 —— 在真实进程边界上制造「工具已执行 / turn 未落盘」等
 * 窗口的硬中断（`process.exit`，不走任何 try/catch 清理），再由父进程以
 * **全新连接 + 全新 TaskStore 实例**做恢复，断言同一副作用只发生一次。
 *
 * 为什么必须是子进程：进程内模拟「kill」时 executor 的 catch 会兜住异常、
 * 顺手把台账结算掉，窗口就被抹平了 —— 那种测试证明不了任何事。
 *
 * 用法：
 *   bun run crash-runner.ts <dir> <sessionId> <killPoint> [sideEffect]
 *
 *   killPoint:
 *     before-side-effect  —— 台账 begin 之后、副作用之前硬中断（矩阵①）
 *     mid-side-effect     —— 副作用已发生、工具未返回时硬中断（矩阵②）
 *     after-tool-result   —— 工具结果已产出、turn 未落盘时硬中断（矩阵③）
 *     none                —— 跑完整轮（对照组）
 *
 *   sideEffect: non-idempotent（缺省）| idempotent | none
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { LLMClient, LLMEvent, LLMRequest, LLMResponse } from "@fengagent/llm";
import type { Config, SideEffectKind } from "@fengagent/core";
import { createSession, createUserMessage } from "@fengagent/core";
import { createContextManager } from "@fengagent/context";
import { createToolExecutor, createToolRegistry } from "@fengagent/tools";
import { AgentLoop } from "../../loop.ts";
import { SessionStore } from "../../session.ts";
import { TaskStore } from "../../task-store.ts";

const dir: string = process.argv[2] ?? "";
const sessionId: string = process.argv[3] ?? "";
const killPoint: string = process.argv[4] ?? "";
const sideEffectArg: string | undefined = process.argv[5];
if (!dir || !sessionId || !killPoint) {
  process.stderr.write("usage: crash-runner <dir> <sessionId> <killPoint> [sideEffect]\n");
  process.exit(2);
}

const sideEffect = (sideEffectArg ?? "non-idempotent") as SideEffectKind;
const journalPath = join(dir, "journal.jsonl");
const markerPath = join(dir, "kill.marker");
const taskId = "task-crash";

/**
 * 落一个「硬中断发生在哪个点位」的标记再退出。
 *
 * 用文件而不是 stderr：验收机器上的子进程 stdio 可能不可捕获（管道受限），
 * 标记文件是任何环境下都读得回来的证据。
 */
function killNow(point: string): never {
  mkdirSync(dir, { recursive: true });
  writeFileSync(markerPath, point);
  process.exit(9);
}

/** 外部系统：日志文件按行追加（非幂等）；幂等模式下按行去重 upsert */
function applyExternalEffect(payload: { channel: string; body: string }): void {
  if (!existsSync(journalPath)) mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(payload);
  if (sideEffect === "idempotent") {
    const existing = existsSync(journalPath)
      ? readFileSync(journalPath, "utf8").split("\n").filter(Boolean)
      : [];
    if (existing.includes(line)) return;
    appendFileSync(journalPath, `${line}\n`);
    return;
  }
  appendFileSync(journalPath, `${line}\n`);
}

const config: Config = {
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
  dataDir: dir,
};

/** 脚本化 LLM：第 1 次调用发起副作用工具，第 2 次收尾 */
class ScriptedLLM implements LLMClient {
  private call = 0;
  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    this.call++;
    if (this.call === 1) {
      yield { type: "text-delta", text: "正在通知外部系统。" };
      yield { type: "tool-call", id: "tu-1", name: "notify_external", input: { channel: "ops", body: "deploy-done" } };
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

const toolRegistry = createToolRegistry();
toolRegistry.register({
  name: "notify_external",
  description: "把结果通知到外部系统（写外部系统，非幂等）",
  inputSchema: z.object({ channel: z.string(), body: z.string() }),
  sideEffect: () => sideEffect,
  operationKey: (input: { channel: string }) => `notify_external::${input.channel}`,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async execute(input: { channel: string; body: string }) {
    if (killPoint === "before-side-effect") {
      // 台账 begin 已落盘、副作用尚未发生 → 硬中断（矩阵①）
      killNow("before-side-effect");
    }
    applyExternalEffect(input);
    if (killPoint === "mid-side-effect") {
      // 副作用已发生、工具没有返回 → 硬中断（矩阵②）
      killNow("mid-side-effect");
    }
    return { content: `notified ${input.channel}`, metadata: { notified: true } };
  },
});

const toolExecutor = createToolExecutor();
const sessionStore = new SessionStore(join(dir, "sessions.db"));
const taskStore = new TaskStore(join(dir, "tasks.db"));
taskStore.createTask({
  taskId,
  sessionId,
  coreIntent: "把部署结果通知外部系统",
});

const session = createSession(config.model, "crash-injection");
session.id = sessionId;
session.messages.push(createUserMessage("通知外部系统：部署完成"));
sessionStore.saveSession(session);
sessionStore.saveMessages(session.id, session.messages);

const contextManager = createContextManager({
  config: {
    contextWindow: config.contextWindow,
    compactThreshold: config.compactThreshold,
    compactKeepTokens: config.compactKeepTokens,
    disableCompact: config.disableCompact,
    smallModel: config.smallModel,
  },
  summaryGenerator: new ScriptedLLM(),
  systemContextOptions: { workdir: dir },
});

const loop = new AgentLoop({
  llmClient: new ScriptedLLM(),
  toolRegistry,
  toolExecutor,
  contextManager,
  config,
  workdir: dir,
  taskRuntime: { store: taskStore, taskId },
});

for await (const event of loop.run(session, {})) {
  if (
    killPoint === "after-tool-result" &&
    event.type === "tool-call-result" &&
    event.toolUseId === "tu-1"
  ) {
    // 副作用已执行、台账已 complete，但助手消息 / 步结算都还没落盘
    // —— 矩阵③「工具已执行、turn 未落盘」的最致命窗口
    killNow("after-tool-result");
  }
}

writeFileSync(join(dir, "kill.marker"), "none");
process.exit(0);
