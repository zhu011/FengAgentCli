/**
 * 派单注入智能体上下文（P1）测试。
 *
 * 用 fake-acp 夹具验证：`composePrompt` 的返回值真的进了目标进程的 prompt
 * （夹具收到 `FAIL` 才回拒绝；未注入时应正常回「你好」）。
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@fengagent/agent";
import { AgentTaskService } from "../agent-task-service.ts";
import { AgentRuntimeRegistry } from "../agent-runtimes.ts";

const FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "agent",
  "src",
  "__tests__",
  "fixtures",
  "fake-acp-agent.ts",
);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function build(composePrompt?: (agentId: string, content: string) => string): Promise<{
  service: AgentTaskService;
  agents: AgentRegistry;
}> {
  const root = mkdtempSync(join(tmpdir(), "feng-agent-context-"));
  const agents = new AgentRegistry({ dataRoot: root, workdir: root });
  agents.create({
    id: "coder",
    displayName: "代码工程师",
    instructions: "你是代码工程师。",
    runtime: "fake",
  });
  const runtimes = new AgentRuntimeRegistry({
    dataRoot: root,
    entries: [{ name: "fake", command: process.execPath, args: [FIXTURE], enabled: true }],
    probe: async () => ({
      agentName: "fake-acp",
      agentVersion: "1.0.0",
      capabilities: { resume: false, loadSession: false, image: false },
      probedAt: new Date().toISOString(),
    }),
  });
  await runtimes.probeAll();
  const service = new AgentTaskService({
    dataRoot: root,
    registry: runtimes,
    agentRegistry: agents,
    defaultCwd: mkdtempSync(join(tmpdir(), "feng-agent-context-work-")),
    requestTimeoutMs: 8000,
    promptTimeoutMs: 15_000,
    autoProbe: false,
    recoverOnStart: false,
    ...(composePrompt ? { composePrompt } : {}),
  });
  cleanups.push(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { service, agents };
}

describe("派单上下文注入", () => {
  test("composePrompt 的返回值进入目标 prompt（注入 FAIL 才失败）", async () => {
    const { service } = await build((_agentId, content) => `${content}\nFAIL`);
    const task = await service.submit({ agent: "coder", content: "做点事" });
    const done = await service.waitForTerminal(task.id, 20_000);
    expect(done.status).toBe("failed");
    expect(done.error ?? "").toContain("目标拒绝执行");
  }, 30_000);

  test("不传 composePrompt：正文原样发送（零回归）", async () => {
    const { service } = await build();
    const task = await service.submit({ agent: "coder", content: "打个招呼" });
    const done = await service.waitForTerminal(task.id, 20_000);
    expect(done.status).toBe("replied");
    expect(done.result).toContain("你好");
  }, 30_000);
});
