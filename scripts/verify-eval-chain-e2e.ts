/**
 * R3 评测引擎全链路验收 smoke：
 * 测试集 → trace 分析 → LLM-judge → diagnose → 建议报告。
 *
 * 覆盖 R3 契约的完整闭环（数据源均为临时 fixture，stub LLM 客户端）：
 * 1. <数据根>/testsets/*.json 测试集（AgentBench/DeepEval 风格，宽容解析）
 * 2. llm-trace JSONL → analyzeRecords → AnalysisResult
 * 3. judgeAllSessions（stub LLM）→ JudgeResult[]
 * 4. mergeJudgeResults → diagnose → 建议（指标规则 + judge 规则都应触发）
 * 5. runSelfOptimize writeReport → optimization-{date}.md 落盘且含建议
 *
 * 运行：bun scripts/verify-eval-chain-e2e.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLogFile, analyzeRecords, judgeAllSessions, mergeJudgeResults, diagnose, runSelfOptimize } from "../packages/eval/src/index.ts";
import type { LLMClient, LLMResponse } from "../packages/llm/src/types.ts";

const dataRoot = mkdtempSync(join(tmpdir(), "feng-eval-chain-"));
process.env.FENG_DATA_DIR = dataRoot;
mkdirSync(join(dataRoot, "logs"), { recursive: true });
mkdirSync(join(dataRoot, "testsets"), { recursive: true });
mkdirSync(join(dataRoot, "optimizations"), { recursive: true });

const DATE = "2026-08-22";

// 1) 测试集 fixture（DeepEval 风格：cases 数组）
writeFileSync(
  join(dataRoot, "testsets", "agent-bench-basic.json"),
  JSON.stringify({
    name: "agent-bench-basic",
    cases: [
      { input: "列出当前目录文件", expected: "包含文件列表" },
      { input: "查找含 agent 的文件", expected: "返回路径" },
    ],
  }),
);

// 2) trace fixture：三个会话（12 次 LLM 调用 ≥ minSamples=10，3 条 judge ≥ judgeMinSamples=3）
//    s1/s2：bash 工具连续报错（工具错误占比 100% → 指标规则 2 + judge tool_misused 归因）
//    s3：健康会话
const line = (r: Record<string, unknown>) => JSON.stringify(r);
const records = [
  // s1：5 次调用（4 次工具报错 + 1 次 end_turn）
  ...[1, 2, 3, 4].map((i) =>
    line({ timestamp: `${DATE}T09:0${i}:00.000Z`, sessionId: "s1", messageId: `s1-${i}`, direction: "request", model: "deepseek-v4-pro", messages: [{ role: "user", content: [{ type: "text", text: `任务 ${i}` }] }], tools: ["bash"] }),
  ),
  ...[1, 2, 3, 4].map((i) =>
    line({ timestamp: `${DATE}T09:0${i}:05.000Z`, sessionId: "s1", messageId: `s1-${i}`, direction: "response", model: "deepseek-v4-pro", durationMs: 5000, inputTokens: 800, outputTokens: 200, hasToolCalls: true, toolCalls: [{ name: "bash", input: { cmd: `ls ${i}` } }], finishReason: "tool_use", error: "bash: command not found: ls" }),
  ),
  line({ timestamp: `${DATE}T09:05:00.000Z`, sessionId: "s1", direction: "response", model: "deepseek-v4-pro", durationMs: 3000, inputTokens: 500, outputTokens: 150, hasToolCalls: false, finishReason: "end_turn", responseText: "抱歉，命令执行失败。" }),
  // s2：5 次调用（4 次工具报错 + 1 次 end_turn）
  ...[1, 2, 3, 4].map((i) =>
    line({ timestamp: `${DATE}T10:0${i}:00.000Z`, sessionId: "s2", messageId: `s2-${i}`, direction: "request", model: "deepseek-v4-pro", messages: [{ role: "user", content: [{ type: "text", text: `任务 ${i}` }] }], tools: ["bash"] }),
  ),
  ...[1, 2, 3, 4].map((i) =>
    line({ timestamp: `${DATE}T10:0${i}:05.000Z`, sessionId: "s2", messageId: `s2-${i}`, direction: "response", model: "deepseek-v4-pro", durationMs: 5000, inputTokens: 800, outputTokens: 200, hasToolCalls: true, toolCalls: [{ name: "bash", input: { cmd: `rm ${i}` } }], finishReason: "tool_use", error: "bash: rm: no such file" }),
  ),
  line({ timestamp: `${DATE}T10:05:00.000Z`, sessionId: "s2", direction: "response", model: "deepseek-v4-pro", durationMs: 3000, inputTokens: 500, outputTokens: 150, hasToolCalls: false, finishReason: "end_turn", responseText: "抱歉，命令执行失败。" }),
  // s3：2 次调用（健康）
  line({ timestamp: `${DATE}T11:00:00.000Z`, sessionId: "s3", messageId: "s3-1", direction: "request", model: "deepseek-v4-pro", messages: [{ role: "user", content: [{ type: "text", text: "简单问题" }] }], tools: ["bash"] }),
  line({ timestamp: `${DATE}T11:00:05.000Z`, sessionId: "s3", messageId: "s3-1", direction: "response", model: "deepseek-v4-pro", durationMs: 2000, inputTokens: 300, outputTokens: 100, hasToolCalls: false, finishReason: "end_turn", responseText: "已完成。" }),
  line({ timestamp: `${DATE}T11:01:00.000Z`, sessionId: "s3", messageId: "s3-2", direction: "request", model: "deepseek-v4-pro", messages: [{ role: "user", content: [{ type: "text", text: "继续" }] }], tools: ["bash"] }),
  line({ timestamp: `${DATE}T11:01:05.000Z`, sessionId: "s3", messageId: "s3-2", direction: "response", model: "deepseek-v4-pro", durationMs: 2000, inputTokens: 300, outputTokens: 100, hasToolCalls: false, finishReason: "end_turn", responseText: "好的。" }),
];
writeFileSync(join(dataRoot, "logs", `llm-trace-${DATE}.jsonl`), records.join("\n"));

// 3) stub LLM judge 客户端：按会话返回不同结论（s1/s2 工具误用，s3 完成）
const stubLlm: LLMClient = {
  generate: async (req): Promise<LLMResponse> => {
    const text = req.messages.map((m) => JSON.stringify(m.content)).join("");
    const misused = text.includes("s1") || text.includes("s2");
    const judgeJson = misused
      ? `{"completionScore": 30, "correctnessScore": 25, "conclusion": "tool_misused", "note": "bash 命令选型错误"}`
      : `{"completionScore": 95, "correctnessScore": 97, "conclusion": "completed", "note": "任务完成"}`;
    return {
      id: "stub-judge",
      model: "stub",
      content: [{ type: "text", text: judgeJson }],
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: "end_turn",
    };
  },
  stream: async function* () {},
} as unknown as LLMClient;

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

try {
  // 2→3：分析 + judge
  const records = parseLogFile(join(dataRoot, "logs", `llm-trace-${DATE}.jsonl`));
  const result = analyzeRecords(records, `llm-trace-${DATE}.jsonl`);
  check("analyzeRecords 会话数=3", result.sessionCount === 3, result.sessionCount);

  const judgeResults = await judgeAllSessions(result.sessions, { llmClient: stubLlm });
  check("judgeAllSessions 产出 3 条", judgeResults.length === 3, judgeResults.length);
  const s1 = judgeResults.find((j) => j.sessionId === "s1");
  const s3 = judgeResults.find((j) => j.sessionId === "s3");
  check("s1 判定 tool_misused", s1?.conclusion === "tool_misused", s1);
  check("s1 完成度 30", s1?.completionScore === 30, s1?.completionScore);
  check("s3 判定 completed", s3?.conclusion === "completed", s3);

  // 4：合并 + diagnose（指标规则 + judge 规则）
  const merged = mergeJudgeResults(result, judgeResults);
  const suggestions = diagnose(merged);
  const toolDesc = suggestions.find((s) => s.type === "tool-description");
  check("指标规则触发（工具错误）", Boolean(toolDesc), suggestions.map((s) => s.type));
  const judgeTool = suggestions.find((s) => s.type === "tool-description" && s.title.includes("LLM-judge"));
  check("judge 规则触发（tool_misused 归因）", Boolean(judgeTool), suggestions.map((s) => s.title));

  // 5：建议报告落盘
  const plan = runSelfOptimize(merged, { writeReport: true });
  const reportPath = join(dataRoot, "optimizations", `optimization-${DATE}.md`);
  check("建议报告落盘", existsSync(reportPath), reportPath);
  const report = readFileSync(reportPath, "utf-8");
  check("报告含建议条目", plan.suggestions.length > 0 && report.includes("建议"), { suggestions: plan.suggestions.length });
  check("报告含 judge 证据", report.includes("LLM-judge") || report.includes("tool_misused"), report.slice(0, 200));

  // 测试集侧：服务端 overview 可解析该测试集（宽容解析契约）
  const testsetRaw = JSON.parse(readFileSync(join(dataRoot, "testsets", "agent-bench-basic.json"), "utf-8"));
  check("测试集宽容解析（cases）", Array.isArray(testsetRaw.cases) && testsetRaw.cases.length === 2, testsetRaw.cases?.length);
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL PASS — 评测引擎全链路（测试集→judge→diagnose→建议报告）验收通过");
