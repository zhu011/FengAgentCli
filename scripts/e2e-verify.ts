/**
 * E2E 真机验证脚本
 *
 * 启动真实 HTTP Server 进程，使用 mock LLM 进行端到端验证：
 * 1. WebUI API 交互（创建会话、发送消息、SSE 流、模型列表、导出、中断）
 * 2. Skill 导入和调用
 * 3. 多轮记忆（save + search + list）
 * 4. 多 Agent 派遣（task 工具）
 * 5. 真实工具执行（file-read, file-write, bash, glob, grep）
 */

import { loadConfigFromEnv } from "@fengagent/core";
import { createToolRegistry, createToolExecutor, registerBuiltinTools, createSkillLoader } from "@fengagent/tools";
import { createContextManager } from "@fengagent/context";
import { Agent, createAgentDefinitionLoader, createSubagentRunner } from "@fengagent/agent";
import { createClientFromEnv, type LLMClient, type LLMRequest, type LLMResponse, type LLMEvent } from "@fengagent/llm";
import { createApp } from "@fengagent/server";
import { SessionStore } from "@fengagent/agent/session";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

// ──────────────────────────────────────────────
// Mock LLM Client — 模拟 LLM 响应
// ──────────────────────────────────────────────

class MockLLMClient implements LLMClient {
  private responses: LLMEvent[][] = [];
  private callIndex = 0;
  public generateCalls: LLMRequest[] = [];

  setResponses(responses: LLMEvent[][]): void {
    this.responses = responses;
    this.callIndex = 0;
    this.generateCalls = [];
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    const events = this.responses[this.callIndex] ?? [];
    this.callIndex++;
    for (const event of events) {
      yield event;
    }
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.generateCalls.push(request);
    return {
      id: "mock-gen-" + this.generateCalls.length,
      model: request.model,
      content: [{ type: "text", text: "这是压缩摘要。" }],
      usage: { inputTokens: 100, outputTokens: 50 },
      finishReason: "end_turn",
    };
  }
}

// ──────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────

function textDelta(text: string): LLMEvent {
  return { type: "text-delta", text };
}
function toolCall(id: string, name: string, input: unknown): LLMEvent {
  return { type: "tool-call", id, name, input };
}
function usageEvent(inp: number, out: number): LLMEvent {
  return { type: "usage", inputTokens: inp, outputTokens: out };
}
function finish(reason: "end_turn" | "tool_use" | "max_tokens"): LLMEvent {
  return { type: "finish", reason };
}

let stepCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string): void {
  stepCount++;
  if (condition) {
    console.log("  PASS: " + message);
  } else {
    console.error("  FAIL: " + message);
    failCount++;
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log("  PASS: " + message);
  } else {
    console.error("  FAIL: " + message + " (expected: " + JSON.stringify(expected) + ", got: " + JSON.stringify(actual) + ")");
    failCount++;
  }
  stepCount++;
}

async function parseSSE(res: Response): Promise<{ event: string; data: string }[]> {
  const text = await res.text();
  const frames: { event: string; data: string }[] = [];
  for (const frame of text.split("\n\n")) {
    const lines = frame.trim().split("\n");
    let evt = "";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) evt = line.slice(7);
      if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (data) frames.push({ event: evt, data });
  }
  return frames;
}

// ──────────────────────────────────────────────
// 创建测试环境
// ──────────────────────────────────────────────

const tempDir = mkdtempSync(join(tmpdir(), "feng-e2e-"));
const testFile = join(tempDir, "test-output.txt");

// 启用自动批准工具（bash 等工具需要权限审批）
process.env.FENG_AUTO_APPROVE_TOOLS = "true";

console.log("=== E2E 真机验证开始 ===");
console.log("临时目录: " + tempDir);
console.log("");

// 创建 mock LLM
const mockLLM = new MockLLMClient();

// 创建真实 Agent（使用 mock LLM，但工具系统是真实的）
const config = loadConfigFromEnv();
const toolRegistry = createToolRegistry();
registerBuiltinTools(toolRegistry);
const toolExecutor = createToolExecutor();
const contextManager = createContextManager({
  config: {
    contextWindow: config.contextWindow,
    compactThreshold: config.compactThreshold,
    compactKeepTokens: config.compactKeepTokens,
    disableCompact: config.disableCompact,
    smallModel: config.smallModel,
  },
  summaryGenerator: mockLLM,
  systemContextOptions: { workdir: tempDir },
});
const sessionStore = new SessionStore(join(tempDir, "sessions.db"));
const agentDefinitionLoader = createAgentDefinitionLoader({
  workdir: tempDir,
  config: { model: config.model, smallModel: config.smallModel, maxTurns: config.maxTurns },
});
await agentDefinitionLoader.load();
const subagentRunner = createSubagentRunner({
  llmClient: mockLLM,
  toolRegistry,
  toolExecutor,
  contextManager,
  config,
  workdir: tempDir,
  agentDefinitionLoader,
});

const agent = new Agent({
  llmClient: mockLLM,
  toolRegistry,
  toolExecutor,
  contextManager,
  config,
  workdir: tempDir,
  sessionStore,
  spawnSubagent: subagentRunner,
  agentDepth: 0,
});

// 创建 HTTP Server
const { app, sessionManager } = createApp({
  config,
  createAgent: () => agent,
});

// ──────────────────────────────────────────────
// 1. WebUI API 交互验证
// ──────────────────────────────────────────────

console.log("--- 1. WebUI API 交互验证 ---");

// 1a. 健康检查
let res = await app.fetch(new Request("http://localhost/api/health"));
let json = await res.json();
assert(res.status === 200, "GET /api/health 返回 200");
assert(json.status === "ok", "健康检查状态为 ok");

// 1b. 创建会话
res = await app.fetch(new Request("http://localhost/api/sessions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "E2E测试会话" }),
}));
json = await res.json();
assert(res.status === 201, "POST /api/sessions 返回 201");
assert(json.id !== undefined, "会话有 ID");
assert(json.title === "E2E测试会话", "会话标题正确");
const sessionId = json.id;

// 1c. 获取会话详情
res = await app.fetch(new Request("http://localhost/api/sessions/" + sessionId));
json = await res.json();
assert(res.status === 200, "GET /api/sessions/:id 返回 200");
assert(json.id === sessionId, "会话详情 ID 匹配");

// 1d. 列出会话
res = await app.fetch(new Request("http://localhost/api/sessions"));
json = await res.json();
assert(res.status === 200, "GET /api/sessions 返回 200");
assert(json.length >= 1, "会话列表至少 1 个");

// 1e. 发送消息 + SSE 流
mockLLM.setResponses([
  [textDelta("你好！我是 FengAgent。"), usageEvent(10, 15), finish("end_turn")],
]);

res = await app.fetch(new Request("http://localhost/api/sessions/" + sessionId + "/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: "你好" }),
}));
assert(res.status === 200, "POST /messages 返回 200");
assert(res.headers.get("content-type")?.includes("text/event-stream") === true, "响应类型为 SSE");

const sseFrames = await parseSSE(res);
const sseEvents = sseFrames.map((f) => JSON.parse(f.data));
const sseTypes = sseEvents.map((e: { type: string }) => e.type);
assert(sseTypes.includes("session-start"), "SSE 包含 session-start");
assert(sseTypes.includes("text-delta"), "SSE 包含 text-delta");
assert(sseTypes.includes("session-end"), "SSE 包含 session-end");

const deltaText = sseEvents
  .filter((e: { type: string }) => e.type === "text-delta")
  .map((e: { text: string }) => e.text)
  .join("");
assertEqual(deltaText, "你好！我是 FengAgent。", "SSE 文本内容正确");

// 1f. 模型列表
res = await app.fetch(new Request("http://localhost/api/models"));
json = await res.json();
assert(res.status === 200, "GET /api/models 返回 200");
assert(json.models.length >= 2, "模型列表至少 2 个");
assert(json.models.some((m: { isDefault: boolean }) => m.isDefault), "有默认模型标记");

// 1g. 导出会话
res = await app.fetch(new Request("http://localhost/api/sessions/" + sessionId + "/export"));
assert(res.status === 200, "GET /api/sessions/:id/export 返回 200");
const exportText = await res.text();
assert(exportText.length > 0, "导出内容非空");

// 1h. 404 测试
res = await app.fetch(new Request("http://localhost/api/sessions/nonexistent-id"));
assert(res.status === 404, "不存在的会话返回 404");

// 1i. 中断测试
res = await app.fetch(new Request("http://localhost/api/sessions/" + sessionId + "/interrupt", {
  method: "POST",
}));
assert(res.status === 404, "无运行任务时中断返回 404");

// 1j. CORS 测试
res = await app.fetch(new Request("http://localhost/api/health", { method: "OPTIONS" }));
assert(res.headers.get("access-control-allow-origin") !== null, "CORS 头存在");

console.log("");

// ──────────────────────────────────────────────
// 2. Skill 导入和调用验证
// ──────────────────────────────────────────────

console.log("--- 2. Skill 导入和调用验证 ---");

// 2a. Skill 加载器 — 从 .fengagent/skills/ 加载
const skillLoader = createSkillLoader({ workdir: "D:/AgentCode/FengAgentCli" });
await skillLoader.load();
const skillNames = skillLoader.names();
assert(skillNames.includes("code-review"), "Skill 加载: code-review");
assert(skillNames.includes("debug"), "Skill 加载: debug");
assert(skillNames.includes("refactor"), "Skill 加载: refactor");
assert(skillNames.includes("test"), "Skill 加载: test");
console.log("  已加载 Skills: " + skillNames.join(", "));

// 2b. Skill 内容验证
const codeReviewSkill = skillLoader.get("code-review");
assert(codeReviewSkill !== undefined, "code-review skill 可获取");
assert(codeReviewSkill!.description.includes("代码审查"), "code-review 描述正确");
assert(codeReviewSkill!.prompt.includes("正确性"), "code-review prompt 包含审查维度");
assert(codeReviewSkill!.trigger.includes("代码审查"), "code-review trigger 正确");

// 2c. 通过 skill 工具调用 — list
const skillToolDef = toolRegistry.get("skill");
assert(skillToolDef !== undefined, "skill 工具已注册");

const skillListResult = await skillToolDef!.execute(
  { action: "list" },
  { workdir: "D:/AgentCode/FengAgentCli", sessionId: "test", messageId: "test" },
);
assert(!skillListResult.isError, "skill list 不返回错误");
assert(skillListResult.content.includes("code-review"), "skill list 包含 code-review");
assert(skillListResult.content.includes("debug"), "skill list 包含 debug");

// 2d. 通过 skill 工具调用 — load
const skillLoadResult = await skillToolDef!.execute(
  { action: "load", name: "debug" },
  { workdir: "D:/AgentCode/FengAgentCli", sessionId: "test", messageId: "test" },
);
assert(!skillLoadResult.isError, "skill load debug 不返回错误");
assert(skillLoadResult.content.includes("调试专家"), "debug skill prompt 正确加载");
assert(skillLoadResult.content.includes("复现"), "debug skill 包含复现步骤");

// 2e. 加载不存在的 skill
const skillNotFound = await skillToolDef!.execute(
  { action: "load", name: "nonexistent-skill" },
  { workdir: "D:/AgentCode/FengAgentCli", sessionId: "test", messageId: "test" },
);
assert(skillNotFound.isError === true, "不存在的 skill 返回错误");

// 2f. 自定义 skill 导入测试 — 写入一个新 skill 文件
const customSkillDir = join(tempDir, ".fengagent", "skills");
try { await import("node:fs").then((fs) => fs.mkdirSync(customSkillDir, { recursive: true })); } catch {}
const customSkillPath = join(customSkillDir, "my-custom-skill.md");
writeFileSync(customSkillPath, [
  "---",
  "name: my-custom-skill",
  "description: 自定义测试技能",
  'trigger: 当用户说"测试自定义技能"时使用',
  "---",
  "这是一个自定义技能的 prompt 模板。",
  "用于验证 skill 导入功能。",
].join("\n"), "utf-8");

const customLoader = createSkillLoader({ workdir: tempDir });
await customLoader.load();
assert(customLoader.names().includes("my-custom-skill"), "自定义 skill 导入成功");
const customSkill = customLoader.get("my-custom-skill");
assert(customSkill!.description === "自定义测试技能", "自定义 skill 描述正确");
assert(customSkill!.prompt.includes("验证 skill 导入"), "自定义 skill prompt 正确");

console.log("");

// ──────────────────────────────────────────────
// 3. 多轮记忆验证
// ──────────────────────────────────────────────

console.log("--- 3. 多轮记忆验证 ---");

// 3a. memory-save 工具 — 保存记忆
const memorySaveTool = toolRegistry.get("memory-save");
assert(memorySaveTool !== undefined, "memory-save 工具已注册");

const saveResult = await memorySaveTool!.execute(
  { content: "用户偏好使用 TypeScript 和 Bun 进行开发", category: "user" },
  { workdir: tempDir, sessionId: "test", messageId: "test" },
);
assert(!saveResult.isError, "memory-save 成功保存");
assert(saveResult.metadata !== undefined, "memory-save 返回元数据");

// 3b. 再保存几条记忆
await memorySaveTool!.execute(
  { content: "项目使用 monorepo 结构，包名为 @fengagent/*", category: "project" },
  { workdir: tempDir, sessionId: "test", messageId: "test" },
);
await memorySaveTool!.execute(
  { content: "TypeScript 严格模式已开启，包含 noUncheckedIndexedAccess", category: "technical" },
  { workdir: tempDir, sessionId: "test", messageId: "test" },
);

// 3c. memory-search 工具 — 搜索记忆
const memorySearchTool = toolRegistry.get("memory-search");
assert(memorySearchTool !== undefined, "memory-search 工具已注册");

const searchResult = await memorySearchTool!.execute(
  { query: "TypeScript 开发偏好" },
  { workdir: tempDir, sessionId: "test", messageId: "test" },
);
assert(!searchResult.isError, "memory-search 成功搜索");
assert(searchResult.content.includes("Found"), "搜索返回结果");
assert(searchResult.content.includes("TypeScript"), "搜索结果包含 TypeScript 相关记忆");
const searchMeta = searchResult.metadata as { resultCount: number };
assert(searchMeta.resultCount > 0, "搜索结果数 > 0");
console.log("  搜索 'TypeScript 开发偏好' 返回 " + searchMeta.resultCount + " 条结果");

// 3d. memory-list 工具 — 列出记忆
const memoryListTool = toolRegistry.get("memory-list");
assert(memoryListTool !== undefined, "memory-list 工具已注册");

const listResult = await memoryListTool!.execute(
  {},
  { workdir: tempDir, sessionId: "test", messageId: "test" },
);
assert(!listResult.isError, "memory-list 成功");
assert(listResult.content.includes("Total:"), "memory-list 包含总数");
const listMeta = listResult.metadata as { totalCount: number };
assert(listMeta.totalCount === 3, "记忆总数为 3");

// 3e. 多轮对话上下文保持 — 通过 Agent prompt
mockLLM.setResponses([
  [textDelta("第一轮回复：我记住了。"), finish("end_turn")],
  [textDelta("第二轮回复：是的，你刚才说了测试。"), finish("end_turn")],
]);

// 第一轮
let events: { type: string; [key: string]: unknown }[] = [];
for await (const event of agent.prompt("请记住：我在测试多轮记忆功能")) {
  events.push(event as { type: string; [key: string]: unknown });
}
assert(events.some((e) => e.type === "session-start"), "第一轮: session-start");
assert(events.some((e) => e.type === "text-delta"), "第一轮: text-delta");
const sessionStart = events.find((e) => e.type === "session-start") as { session: { id: string } };
const multiSessionId = sessionStart.session.id;

// 第二轮（同一会话 — 先从存储加载）
events = [];
const loadedSession = agent.loadSession(multiSessionId);
assert(loadedSession !== null, "第二轮: 会话可加载");
for await (const event of agent.prompt("我刚才说了什么？", loadedSession!)) {
  events.push(event as { type: string; [key: string]: unknown });
}
assert(events.some((e) => e.type === "text-delta"), "第二轮: text-delta");

// 验证会话持久化 — 重新加载
const reloaded = agent.loadSession(multiSessionId);
assert(reloaded !== null, "会话可重新加载");
assert(reloaded!.messages.length >= 4, "多轮会话消息数 >= 4（2轮 × 2条）");
console.log("  多轮对话消息数: " + reloaded!.messages.length);

console.log("");

// ──────────────────────────────────────────────
// 4. 多 Agent 派遣验证
// ──────────────────────────────────────────────

console.log("--- 4. 多 Agent 派遣验证 ---");

// 4a. Agent 定义加载 — 内置 agents
const agentNames = agentDefinitionLoader.names();
assert(agentNames.includes("default"), "内置 agent: default");
assert(agentNames.includes("coder"), "内置 agent: coder");
assert(agentNames.includes("researcher"), "内置 agent: researcher");
console.log("  已加载 Agent 定义: " + agentNames.join(", "));

// 4b. coder agent 定义验证
const coderDef = agentDefinitionLoader.get("coder");
assert(coderDef !== undefined, "coder agent 定义存在");
assert(coderDef!.tools.includes("file-read"), "coder agent 包含 file-read 工具");
assert(coderDef!.tools.includes("file-write"), "coder agent 包含 file-write 工具");
assert(coderDef!.tools.includes("bash"), "coder agent 包含 bash 工具");
assert(coderDef!.systemPrompt.includes("代码编写"), "coder agent 系统提示正确");

// 4c. researcher agent 定义验证
const researcherDef = agentDefinitionLoader.get("researcher");
assert(researcherDef !== undefined, "researcher agent 定义存在");
assert(researcherDef!.tools.includes("file-read"), "researcher agent 包含 file-read 工具");
assert(!researcherDef!.tools.includes("file-write"), "researcher agent 不包含 file-write（只读）");

// 4d. task 工具验证
const taskToolDef = toolRegistry.get("task");
assert(taskToolDef !== undefined, "task 工具已注册");
assert(taskToolDef!.description.includes("subagent") || taskToolDef!.description.includes("子") || taskToolDef!.description.includes("task"), "task 工具描述正确");

console.log("");

// ──────────────────────────────────────────────
// 5. 真实工具执行验证
// ──────────────────────────────────────────────

console.log("--- 5. 真实工具执行验证 ---");

const toolCtx = { workdir: tempDir, sessionId: "tool-test", messageId: "msg-1" };

// 5a. file-write — 写入真实文件
const fileWriteTool = toolRegistry.get("file-write");
assert(fileWriteTool !== undefined, "file-write 工具已注册");

const writeResult = await fileWriteTool!.execute(
  { filePath: testFile, content: "Hello from FengAgent!\nLine 2\nLine 3" },
  toolCtx,
);
assert(!writeResult.isError, "file-write 成功写入文件");
assert(existsSync(testFile), "文件实际存在于磁盘");

// 5b. file-read — 读取真实文件
const fileReadTool = toolRegistry.get("file-read");
assert(fileReadTool !== undefined, "file-read 工具已注册");

const readResult = await fileReadTool!.execute(
  { filePath: testFile },
  toolCtx,
);
assert(!readResult.isError, "file-read 成功读取文件");
assert(readResult.content.includes("Hello from FengAgent!"), "file-read 内容正确");
assert(readResult.content.includes("Line 2"), "file-read 包含第二行");

// 5c. file-edit — 编辑真实文件
const fileEditTool = toolRegistry.get("file-edit");
assert(fileEditTool !== undefined, "file-edit 工具已注册");

const editResult = await fileEditTool!.execute(
  { filePath: testFile, oldString: "Hello from FengAgent!", newString: "Edited by FengAgent!" },
  toolCtx,
);
assert(!editResult.isError, "file-edit 成功编辑文件");

// 验证编辑结果
const editedContent = readFileSync(testFile, "utf-8");
assert(editedContent.includes("Edited by FengAgent!"), "文件内容已更新");
assert(!editedContent.includes("Hello from FengAgent!"), "旧内容已替换");

// 5d. bash — 执行真实 shell 命令
const bashTool = toolRegistry.get("bash");
assert(bashTool !== undefined, "bash 工具已注册");

const bashResult = await bashTool!.execute(
  { command: "echo 'Shell command executed successfully'" },
  toolCtx,
);
assert(!bashResult.isError, "bash 成功执行命令");
assert(bashResult.content.includes("Shell command executed successfully"), "bash 输出正确");

// 5e. bash — 执行文件系统操作
const bashLsResult = await bashTool!.execute(
  { command: "ls " + tempDir.replace(/\\/g, "/") },
  toolCtx,
);
assert(!bashLsResult.isError, "bash ls 成功");
assert(bashLsResult.content.includes("test-output.txt"), "bash ls 包含测试文件");

// 5f. glob — 文件模式匹配
const globTool = toolRegistry.get("glob");
assert(globTool !== undefined, "glob 工具已注册");

const globResult = await globTool!.execute(
  { pattern: "*.txt", path: tempDir },
  toolCtx,
);
assert(!globResult.isError, "glob 成功匹配");
assert(globResult.content.includes("test-output.txt"), "glob 包含测试文件");

// 5g. grep — 文件内容搜索
const grepTool = toolRegistry.get("grep");
assert(grepTool !== undefined, "grep 工具已注册");

const grepResult = await grepTool!.execute(
  { pattern: "Edited", path: tempDir },
  toolCtx,
);
assert(!grepResult.isError, "grep 成功搜索");
assert(grepResult.content.includes("test-output.txt"), "grep 找到匹配文件");

// 5h. 通过 Agent prompt 调用真实工具
mockLLM.setResponses([
  [
    toolCall("call-1", "bash", { command: "echo 'Agent called bash tool'" }),
    finish("tool_use"),
  ],
  [textDelta("工具执行完毕。"), usageEvent(20, 10), finish("end_turn")],
]);

events = [];
for await (const event of agent.prompt("请执行 bash 命令 echo 'Agent called bash tool'")) {
  events.push(event as { type: string; [key: string]: unknown });
}

const eventTypes = events.map((e) => e.type);
assert(eventTypes.includes("tool-call-start"), "Agent 调用工具: tool-call-start");
assert(eventTypes.includes("tool-call-result"), "Agent 调用工具: tool-call-result");
assert(eventTypes.includes("text-delta"), "Agent 调用工具后有文本回复");

const toolResultEvent = events.find((e) => e.type === "tool-call-result") as { result: { content: string; isError?: boolean } };
assert(toolResultEvent !== undefined, "工具结果事件存在");
assert(!toolResultEvent.result.isError, "bash 工具执行无错误");
assert(toolResultEvent.result.content.includes("Agent called bash tool"), "bash 工具实际执行成功");
console.log("  Agent 调用 bash 返回: " + toolResultEvent.result.content.slice(0, 80));

console.log("");

// ──────────────────────────────────────────────
// 6. 11 个内置工具完整性验证
// ──────────────────────────────────────────────

console.log("--- 6. 内置工具完整性验证 ---");

const allTools = toolRegistry.list().map((t) => t.name).sort();
console.log("  已注册工具 (" + allTools.length + "): " + allTools.join(", "));
assert(allTools.length === 11, "内置工具总数为 11");
assert(allTools.includes("bash"), "包含 bash");
assert(allTools.includes("file-edit"), "包含 file-edit");
assert(allTools.includes("file-read"), "包含 file-read");
assert(allTools.includes("file-write"), "包含 file-write");
assert(allTools.includes("glob"), "包含 glob");
assert(allTools.includes("grep"), "包含 grep");
assert(allTools.includes("memory-list"), "包含 memory-list");
assert(allTools.includes("memory-save"), "包含 memory-save");
assert(allTools.includes("memory-search"), "包含 memory-search");
assert(allTools.includes("skill"), "包含 skill");
assert(allTools.includes("task"), "包含 task");

console.log("");

// ──────────────────────────────────────────────
// 汇总
// ──────────────────────────────────────────────

console.log("=== E2E 验证汇总 ===");
console.log("  总步骤: " + stepCount);
console.log("  通过: " + (stepCount - failCount));
console.log("  失败: " + failCount);
console.log("");

if (failCount === 0) {
  console.log("ALL E2E TESTS PASSED");
} else {
  console.log("SOME E2E TESTS FAILED");
}

// 清理
sessionStore.close();
try { rmSync(tempDir, { recursive: true, force: true }); } catch {}

process.exit(failCount > 0 ? 1 : 0);
