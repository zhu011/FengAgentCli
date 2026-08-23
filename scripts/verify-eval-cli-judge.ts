/**
 * R3 CLI 级验收：`bun run eval --judge` 用户路径端到端。
 *
 * 用本地 stub OpenAI 兼容服务冒充 LLM 提供商：
 * 真实 CLI 进程（import.meta.main 入口）→ loadConfig → buildEnvForLLM →
 * createClientFromEnv → judgeAllSessions（HTTP 到 stub）→ diagnose → 报告落盘。
 *
 * 运行：bun scripts/verify-eval-cli-judge.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const dataRoot = mkdtempSync(join(tmpdir(), "feng-eval-cli-"));
mkdirSync(join(dataRoot, "logs"), { recursive: true });
mkdirSync(join(dataRoot, "testsets"), { recursive: true });

const DATE = "2026-08-22";
const line = (r: Record<string, unknown>) => JSON.stringify(r);
const records = [
  ...[1, 2, 3, 4].map((i) =>
    line({ timestamp: `${DATE}T09:0${i}:00.000Z`, sessionId: "s1", messageId: `s1-${i}`, direction: "request", model: "deepseek-v4-pro", messages: [{ role: "user", content: [{ type: "text", text: `任务 ${i}` }] }], tools: ["bash"] }),
  ),
  ...[1, 2, 3, 4].map((i) =>
    line({ timestamp: `${DATE}T09:0${i}:05.000Z`, sessionId: "s1", messageId: `s1-${i}`, direction: "response", model: "deepseek-v4-pro", durationMs: 5000, inputTokens: 800, outputTokens: 200, hasToolCalls: true, toolCalls: [{ name: "bash", input: { cmd: `ls ${i}` } }], finishReason: "tool_use", error: "bash: command not found: ls" }),
  ),
  line({ timestamp: `${DATE}T09:05:00.000Z`, sessionId: "s1", direction: "response", model: "deepseek-v4-pro", durationMs: 3000, inputTokens: 500, outputTokens: 150, hasToolCalls: false, finishReason: "end_turn", responseText: "抱歉，命令执行失败。" }),
  ...[1, 2, 3, 4].map((i) =>
    line({ timestamp: `${DATE}T10:0${i}:00.000Z`, sessionId: "s2", messageId: `s2-${i}`, direction: "request", model: "deepseek-v4-pro", messages: [{ role: "user", content: [{ type: "text", text: `任务 ${i}` }] }], tools: ["bash"] }),
  ),
  ...[1, 2, 3, 4].map((i) =>
    line({ timestamp: `${DATE}T10:0${i}:05.000Z`, sessionId: "s2", messageId: `s2-${i}`, direction: "response", model: "deepseek-v4-pro", durationMs: 5000, inputTokens: 800, outputTokens: 200, hasToolCalls: true, toolCalls: [{ name: "bash", input: { cmd: `rm ${i}` } }], finishReason: "tool_use", error: "bash: rm: no such file" }),
  ),
  line({ timestamp: `${DATE}T10:05:00.000Z`, sessionId: "s2", direction: "response", model: "deepseek-v4-pro", durationMs: 3000, inputTokens: 500, outputTokens: 150, hasToolCalls: false, finishReason: "end_turn", responseText: "抱歉，命令执行失败。" }),
  line({ timestamp: `${DATE}T11:00:00.000Z`, sessionId: "s3", messageId: "s3-1", direction: "request", model: "deepseek-v4-pro", messages: [{ role: "user", content: [{ type: "text", text: "简单问题" }] }], tools: ["bash"] }),
  line({ timestamp: `${DATE}T11:00:05.000Z`, sessionId: "s3", messageId: "s3-1", direction: "response", model: "deepseek-v4-pro", durationMs: 2000, inputTokens: 300, outputTokens: 100, hasToolCalls: false, finishReason: "end_turn", responseText: "已完成。" }),
];
writeFileSync(join(dataRoot, "logs", `llm-trace-${DATE}.jsonl`), records.join("\n"));
writeFileSync(
  join(dataRoot, "testsets", "agent-bench-basic.json"),
  JSON.stringify({ name: "agent-bench-basic", cases: [{ input: "任务 A", expected: "X" }, { input: "任务 B", expected: "Y" }] }),
);

// stub OpenAI 兼容服务：按会话返回不同 judge 结论
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    const body = (await req.json()) as { messages?: Array<{ content?: unknown }> };
    const text = JSON.stringify(body.messages ?? []);
    const misused = text.includes("s1") || text.includes("s2");
    const content = misused
      ? `{"completionScore": 30, "correctnessScore": 25, "conclusion": "tool_misused", "note": "bash 命令选型错误"}`
      : `{"completionScore": 95, "correctnessScore": 97, "conclusion": "completed", "note": "任务完成"}`;
    return Response.json({
      id: "stub",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  },
});

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

// 真实 CLI 进程：bun run packages/eval/src/index.ts --judge --file=<trace>
const cli = spawn(
  process.execPath,
  ["run", "packages/eval/src/index.ts", "--judge", `--file=${join(dataRoot, "logs", `llm-trace-${DATE}.jsonl`)}`],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FENG_DATA_DIR: dataRoot,
      FENG_PROVIDER: "openai-compatible",
      OPENAI_COMPATIBLE_API_KEY: "test-key",
      OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      OPENAI_COMPATIBLE_MODEL: "stub-model",
      // 隔离：不读取真实用户配置
      FENG_CONFIG_FILE: "/nonexistent",
    },
  },
);

let stdout = "";
let stderr = "";
const exitCode = await new Promise<number>((resolve) => {
  cli.stdout.on("data", (d) => (stdout += d.toString()));
  cli.stderr.on("data", (d) => (stderr += d.toString()));
  cli.on("close", (code) => resolve(code ?? -1));
});
server.stop();

console.log("\n--- CLI stdout（节选）---");
console.log(stdout.slice(0, 1800));
if (stderr.trim()) console.log("--- CLI stderr ---\n" + stderr.slice(0, 500));

check("CLI 退出码 0", exitCode === 0, exitCode);
check("--judge 模式进入", stdout.includes("LLM-judge 评测"), "");
check("测试集概览显示", stdout.includes("agent-bench-basic(2)"), "");
check("judge 结果输出（tool_misused）", stdout.includes("结论=tool_misused"), "");
check("judge 结果输出（completed）", stdout.includes("结论=completed"), "");
check("自优化诊断（含 judge 规则）", stdout.includes("自优化诊断"), "");
check("建议报告落盘", existsSync(join(dataRoot, "optimizations", `optimization-${DATE}.md`)), "");

rmSync(dataRoot, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL PASS — `bun run eval --judge` CLI 全链路验收通过");
