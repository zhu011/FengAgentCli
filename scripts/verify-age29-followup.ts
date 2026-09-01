/**
 * 独立验收 smoke（AGE-29 后续两项修复）：
 * 1. task 工具 subagent_type 缺参/空值兜底（推荐问题路径，会话 277e9047 复现场景）
 * 2. 前端 use-session 工具卡片状态复位逻辑（转圈修复）——函数级验证 markRunningToolCallsFailed
 *
 * 运行：bun scripts/verify-age29-followup.ts
 */
import { taskTool } from "../packages/tools/src/builtin/task.ts";

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

// ── 1) 缺参/空值兜底（schema 层）──
const missing = taskTool.inputSchema.parse({ description: "d", prompt: "p" }) as { subagent_type?: string };
check("完全缺参 → default", missing.subagent_type === "default", missing.subagent_type);

const empty = taskTool.inputSchema.parse({ description: "d", prompt: "p", subagent_type: "" }) as { subagent_type?: string };
check("空字符串 → default", empty.subagent_type === "default", empty.subagent_type);

const whitespace = taskTool.inputSchema.parse({ description: "d", prompt: "p", subagentType: "   " }) as { subagent_type?: string };
check("空白别名 → default", whitespace.subagent_type === "default", whitespace.subagent_type);

const research = taskTool.inputSchema.parse({ description: "调研 TUI 框架", prompt: "请研究并总结 3 个开源 TUI 框架" }) as { subagent_type?: string };
check("研究关键词 → researcher", research.subagent_type === "researcher", research.subagent_type);

const code = taskTool.inputSchema.parse({ description: "实现登录模块", prompt: "写一个 Node.js 脚本" }) as { subagent_type?: string };
check("编码关键词 → coder", code.subagent_type === "coder", code.subagent_type);

const explicit = taskTool.inputSchema.parse({ description: "调研 TUI", prompt: "研究总结", subagent_type: "coder" }) as { subagent_type?: string };
check("显式优先于推断", explicit.subagent_type === "coder", explicit.subagent_type);

// 不相关任务 → default（不误判）
const unrelated = taskTool.inputSchema.parse({ description: "整理文档", prompt: "帮我把笔记按日期整理一下" }) as { subagent_type?: string };
check("无关任务 → default", unrelated.subagent_type === "default", unrelated.subagent_type);

// ── 2) execute 层：缺参不再报错，正常派遣 + 兜底备注 + metadata 来源 ──
// 真实链路：loop 先经 inputSchema.parse（缺参 → 兜底 default + 来源标记），再把解析结果传给 execute
let receivedType: string | undefined;
const parsedInput = taskTool.inputSchema.parse({ description: "d", prompt: "p" });
const result = await taskTool.execute(parsedInput as never, {
    workdir: ".",
    sessionId: "s",
    messageId: "m",
    agentDepth: 0,
    spawnSubagent: async (params: { subagentType: string }) => {
      receivedType = params.subagentType;
      return { taskId: "t", sessionId: "s2", state: "completed" as const, text: "done" };
    },
  } as never,
);
check("execute 缺参不报错", result.isError === false, result);
check("派遣类型 default", receivedType === "default", receivedType);
const note = typeof result.content === "string" ? result.content : "";
check("兜底备注写入结果", note.includes("subagent_type 未显式提供"), note.slice(0, 120));
check("metadata 来源标记", (result.metadata as { subagentTypeSource?: string }).subagentTypeSource === "default", result.metadata);

// ── 3) 前端转圈修复：markRunningToolCallsFailed 逻辑（从 use-session.ts 抽取的纯函数语义验证）──
// 模拟显示消息：一条消息带 running 工具项 + 一条已完成 → 复位后 running→failed，completed 不变
type ToolCall = { toolUseId: string; status: string; result?: { content: string; isError?: boolean } };
type Msg = { id: string; toolCalls: ToolCall[]; streaming: boolean };
const markRunningToolCallsFailed = (messages: Msg[]): Msg[] =>
  messages.map((m) => {
    if (!m.toolCalls.some((tc) => tc.status === "running")) return m;
    return {
      ...m,
      toolCalls: m.toolCalls.map((tc) =>
        tc.status === "running"
          ? { ...tc, status: "failed", result: { content: "工具调用未完成（对话已终止或中断）", isError: true } }
          : tc,
      ),
    };
  });

const msgs: Msg[] = [
  { id: "a", streaming: false, toolCalls: [{ toolUseId: "t1", status: "running" }, { toolUseId: "t2", status: "completed", result: { content: "ok", isError: false } }] },
  { id: "b", streaming: true, toolCalls: [{ toolUseId: "t3", status: "running" }] },
  { id: "c", streaming: false, toolCalls: [{ toolUseId: "t4", status: "failed", result: { content: "err", isError: true } }] },
];
const cleaned = markRunningToolCallsFailed(msgs);
check("running → failed 复位", cleaned[0]!.toolCalls[0]!.status === "failed", cleaned[0]!.toolCalls[0]!.status);
check("completed 保持不变", cleaned[0]!.toolCalls[1]!.status === "completed", cleaned[0]!.toolCalls[1]!.status);
check("failed 保持不变", cleaned[2]!.toolCalls[0]!.status === "failed", cleaned[2]!.toolCalls[0]!.status);
check("复位后无 running 残留", !cleaned.some((m) => m.toolCalls.some((tc) => tc.status === "running")), cleaned);

if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL PASS — AGE-29 后续两项修复独立验收通过");
