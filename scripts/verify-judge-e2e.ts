/**
 * R2 全链路验收 smoke：真实 HTTP 监听 → per-message 路由 → judgeMessage（stub LLM）→ judge 字段。
 * 运行：bun scripts/verify-judge-e2e.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/server/src/server.ts";
import type { LLMClient, LLMResponse } from "../packages/llm/src/types.ts";

const dataRoot = mkdtempSync(join(tmpdir(), "feng-judge-e2e-"));
process.env.FENG_DATA_DIR = dataRoot;

const DATE = "2026-08-22";
const line = (r: Record<string, unknown>) => JSON.stringify(r);
const records = [
  // 用户轮次：request + response（含工具调用 + 回复文本），messageId=msg-1
  line({ timestamp: `${DATE}T10:00:00.000Z`, sessionId: "sess-1", messageId: "msg-1", direction: "request", model: "deepseek-v4-pro", messages: [{ role: "user", content: [{ type: "text", text: "列出当前目录文件" }] }], tools: ["bash"] }),
  line({ timestamp: `${DATE}T10:00:02.000Z`, sessionId: "sess-1", messageId: "msg-1", direction: "response", model: "deepseek-v4-pro", durationMs: 2000, inputTokens: 500, outputTokens: 120, hasToolCalls: true, toolCalls: [{ name: "bash", input: { cmd: "ls -la" } }], finishReason: "tool_use", responseText: "我先用 bash 查看目录内容。" }),
  // 第二轮：messageId=msg-2
  line({ timestamp: `${DATE}T10:00:05.000Z`, sessionId: "sess-1", messageId: "msg-2", direction: "request", model: "deepseek-v4-pro", messages: [{ role: "user", content: [{ type: "text", text: "好的" }] }], tools: ["bash"] }),
  line({ timestamp: `${DATE}T10:00:07.000Z`, sessionId: "sess-1", messageId: "msg-2", direction: "response", model: "deepseek-v4-pro", durationMs: 1500, inputTokens: 400, outputTokens: 90, hasToolCalls: false, finishReason: "end_turn", responseText: "目录已列出，共 12 个条目。" }),
];
mkdirSync(join(dataRoot, "logs"), { recursive: true });
writeFileSync(join(dataRoot, "logs", `llm-trace-${DATE}.jsonl`), records.join("\n"));

// stub LLM client：返回固定 judge JSON
const JUDGE_JSON = `{"completionScore": 92, "correctnessScore": 95, "conclusion": "completed", "note": "任务完成，工具使用正确"}`;
const llmClient: LLMClient = {
  generate: async (): Promise<LLMResponse> => ({
    id: "stub-judge",
    model: "stub",
    content: [{ type: "text", text: JUDGE_JSON }],
    usage: { inputTokens: 10, outputTokens: 5 },
    finishReason: "end_turn",
  }),
  stream: async function* () {},
} as unknown as LLMClient;

const { app } = createApp({
  config: {
    model: "test-model",
    smallModel: "test-small-model",
    provider: "anthropic",
    maxTokens: 4096,
    temperature: 1.0,
    contextWindow: 200_000,
    serverHost: "127.0.0.1",
    serverPort: 0,
    corsOrigin: "*",
  } as never,
  createAgent: () => ({}) as never,
  sessionStore: undefined,
  llmClient,
});

const server = Bun.serve({ port: 0, fetch: app.fetch });
const base = `http://127.0.0.1:${server.port}`;

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

try {
  // 1) 评测页：judge 由 judgeMessage 填充 + messageId 合并
  const evalRes = await fetch(
    `${base}/api/eval/messages/${DATE}?sessionId=sess-1&messageId=msg-1`,
  );
  check("eval/messages 200", evalRes.status === 200, evalRes.status);
  const evalBody = (await evalRes.json()) as {
    judge: { messageId: string; sessionId: string; completionScore: number; correctnessScore: number; conclusion: string; note?: string } | null;
    trace: { llmCallCount: number; toolCallCount: number } | null;
  };
  check("judge 非空", Boolean(evalBody.judge), evalBody.judge);
  check("judge.messageId 合并", evalBody.judge?.messageId === "msg-1", evalBody.judge?.messageId);
  check("judge.sessionId", evalBody.judge?.sessionId === "sess-1", evalBody.judge?.sessionId);
  check("judge 分数透传", evalBody.judge?.completionScore === 92 && evalBody.judge?.correctnessScore === 95, evalBody.judge);
  check("judge.conclusion", evalBody.judge?.conclusion === "completed", evalBody.judge?.conclusion);
  check("trace 摘要（1 次 LLM 调用）", evalBody.trace?.llmCallCount === 1, evalBody.trace);
  check("trace 工具计数", evalBody.trace?.toolCallCount === 1, evalBody.trace);

  // 2) 观测页：per-message callchain 聚焦 msg-2
  const ccRes = await fetch(
    `${base}/api/observability/traces/${DATE}/callchain?sessionId=sess-1&messageId=msg-2`,
  );
  const ccBody = (await ccRes.json()) as {
    sessions: Array<{ steps: Array<{ messageId?: string }> }>;
    focus: { messageId: string; role: string; resolvedMessageIds: string[] } | null;
  };
  check("callchain 过滤到 msg-2", ccBody.sessions.length === 1 && ccBody.sessions[0]?.steps.length === 2, ccBody.sessions[0]?.steps.length);
  check("focus 命中", ccBody.focus?.messageId === "msg-2" && ccBody.focus?.resolvedMessageIds.includes("msg-2"), ccBody.focus);

  // 3) 无 llmClient 时 judge 为 null（不触发 LLM）——用无 client 的 app 再验一次
  const { app: appNoClient } = createApp({
    config: { model: "m", smallModel: "s", provider: "anthropic", maxTokens: 1, temperature: 0, contextWindow: 1000, serverHost: "127.0.0.1", serverPort: 0, corsOrigin: "*" } as never,
    createAgent: () => ({}) as never,
    sessionStore: undefined,
  });
  const noClientRes = await appNoClient.request(
    `/api/eval/messages/${DATE}?sessionId=sess-1&messageId=msg-1`,
  );
  const noClientBody = (await noClientRes.json()) as { judge: unknown };
  check("无 llmClient → judge null", noClientBody.judge === null, noClientBody.judge);

  // 4) 前端渲染路径：judge 结构被 eval.tsx ScoreBar 消费（completionScore/correctnessScore/conclusion/note 字段齐备即可渲染）
  check("前端渲染字段齐备", typeof evalBody.judge?.completionScore === "number" && typeof evalBody.judge?.conclusion === "string" && evalBody.judge?.note !== undefined, evalBody.judge);
} finally {
  server.stop();
  rmSync(dataRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL PASS — judgeMessage 全链路验收通过");
