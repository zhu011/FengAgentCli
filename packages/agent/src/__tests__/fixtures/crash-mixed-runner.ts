/**
 * 混合批次崩溃注入执行器（**独立子进程**）
 *
 * 用途：块 6 的双工具补格 —— 同一批两个非幂等工具，「A 已记账、B 没记账」
 * 的批内边界硬中断（`process.exit`，不走任何 try/catch 清理），再由父进程
 * 以**全新连接 + 全新 TaskStore 实例**恢复，断言 A 命中台账跳过、B 补跑一次，
 * 合计副作用恰好 2 次。
 *
 * 与 `crash-runner.ts` 的区别：那个 fixture 只发一条 tool-call，所以它证明
 * 不了「同一步里两条 intent 各自归因、互不污染」—— 这正是本夹具存在的理由。
 *
 * 用法：
 *   bun run crash-mixed-runner.ts <dir> <sessionId> <killPoint>
 *
 *   killPoint:
 *     between-batch-tools —— notify_b 的 `sideEffect()` **第 2 次**被调用时硬中断
 *     none                —— 跑完整轮（对照组）
 *
 * 为什么 kill 点必须落在 `sideEffect()` 的第 2 次调用：
 *   第 1 次来自 loop 写 `task/pending`（整批 intent，A / B 各一次），
 *   第 2 次来自执行器对 B 的 `executeOne`（在台账 lookup / begin **之前**）。
 *   在「第 2 次」中断，才精确落在「A 已 begin+complete、B 尚未 begin」的批内
 *   边界；挪到 int 第 1 次会退化成矩阵①（整批都没记账），语义就变了。
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { LLMClient, LLMEvent, LLMRequest, LLMResponse } from "@fengagent/llm";
import type { Config } from "@fengagent/core";
import { createSession, createUserMessage } from "@fengagent/core";
import { createContextManager } from "@fengagent/context";
import { createToolExecutor, createToolRegistry } from "@fengagent/tools";
import { AgentLoop } from "../../loop.ts";
import { SessionStore } from "../../session.ts";
import { TaskStore } from "../../task-store.ts";

const dir: string = process.argv[2] ?? "";
const sessionId: string = process.argv[3] ?? "";
const killPoint: string = process.argv[4] ?? "";
if (!dir || !sessionId || !killPoint) {
  process.stderr.write("usage: crash-mixed-runner <dir> <sessionId> <killPoint>\n");
  process.exit(2);
}

const journalPath = join(dir, "journal.jsonl");
const markerPath = join(dir, "kill.marker");
const taskId = "task-mixed";

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

/** 外部系统：日志文件按行追加，每行带工具名与入参（唯一的端到端计数口径） */
function appendJournal(tool: "a" | "b", body: string): void {
  if (!existsSync(journalPath)) mkdirSync(dir, { recursive: true });
  appendFileSync(journalPath, `${JSON.stringify({ tool, body })}\n`);
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

/** 脚本化 LLM：第 1 次调用同时发起 A / B 两条副作用调用，第 2 次收尾 */
class ScriptedLLM implements LLMClient {
  private call = 0;
  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    this.call++;
    if (this.call === 1) {
      yield { type: "text-delta", text: "正在通知外部系统 A 和 B。" };
      yield { type: "tool-call", id: "tu-a", name: "notify_a", input: { body: "alpha" } };
      yield { type: "tool-call", id: "tu-b", name: "notify_b", input: { body: "beta" } };
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

const inputSchema = z.object({ body: z.string() });

/** notify_b 的 `sideEffect()` 被调用次数（第 1 次 = loop 写 intent，第 2 次 = 执行器） */
let bSideEffectCalls = 0;

const toolRegistry = createToolRegistry();
toolRegistry.register({
  name: "notify_a",
  description: "写外部系统 A（非幂等）",
  inputSchema,
  sideEffect: () => "non-idempotent",
  operationKey: (input: { body: string }) => `notify_a::${input.body}`,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async execute(input: { body: string }) {
    appendJournal("a", input.body);
    return { content: `notified a ${input.body}` };
  },
});

toolRegistry.register({
  name: "notify_b",
  description: "写外部系统 B（非幂等）",
  inputSchema,
  sideEffect: () => {
    bSideEffectCalls++;
    if (killPoint === "between-batch-tools" && bSideEffectCalls >= 2) {
      // 执行器里 B 的 begin 之前 —— A 已记账、B 尚未记账的批内边界
      killNow("between-batch-tools");
    }
    return "non-idempotent";
  },
  operationKey: (input: { body: string }) => `notify_b::${input.body}`,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async execute(input: { body: string }) {
    appendJournal("b", input.body);
    return { content: `notified b ${input.body}` };
  },
});

const toolExecutor = createToolExecutor();
const sessionStore = new SessionStore(join(dir, "sessions.db"));
const taskStore = new TaskStore(join(dir, "tasks.db"));
taskStore.createTask({
  taskId,
  sessionId,
  coreIntent: "把部署结果通知外部系统 A 和 B",
});

const session = createSession(config.model, "crash-mixed");
session.id = sessionId;
session.messages.push(createUserMessage("通知外部系统 A 和 B：部署完成"));
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

for await (const _event of loop.run(session, {})) {
  // 中断由夹具在工具内触发，不依赖事件流
}

writeFileSync(markerPath, "none");
process.exit(0);
