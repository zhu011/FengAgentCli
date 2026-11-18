/**
 * 派单 × 智能体绑定（P0）测试。
 *
 * 覆盖：`{agent}` 派单落到绑定 runtime（真 spawn fake-acp）、未绑定/已归档/不可用
 * 的明确错误码、以及「执行前二次校验」阻止改绑后的旧任务跑上新配置。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@fengagent/agent";
import { AgentTaskService } from "../agent-task-service.ts";
import { AgentRuntimeRegistry } from "../agent-runtimes.ts";
import { AgentRuntimeBindingError } from "../agent-runtime-binding.ts";

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

let root: string;
let agents: AgentRegistry;
let runtimes: AgentRuntimeRegistry;
let service: AgentTaskService;

/** 真 spawn 的 fake runtime + 已成功的探针（避免 test 里等 20s 真探测） */
async function build(probeOk = true): Promise<void> {
  runtimes = new AgentRuntimeRegistry({
    dataRoot: root,
    entries: [
      { name: "fake", command: process.execPath, args: [FIXTURE], enabled: true },
      ...(probeOk ? [] : [{ name: "down", command: "definitely-not-a-binary", enabled: true }]),
    ],
    probe: async (entry) => {
      if (entry.name === "down") throw new Error("spawn 失败");
      return {
        agentName: "fake-acp",
        agentVersion: "1.0.0",
        capabilities: { resume: false, loadSession: false, image: false },
        probedAt: new Date().toISOString(),
      };
    },
  });
  await runtimes.probeAll();
  service = new AgentTaskService({
    dataRoot: root,
    registry: runtimes,
    agentRegistry: agents,
    defaultCwd: mkdtempSync(join(tmpdir(), "feng-agent-binding-work-")),
    requestTimeoutMs: 8000,
    promptTimeoutMs: 15_000,
    autoProbe: false,
    recoverOnStart: false,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-agent-binding-"));
  agents = new AgentRegistry({ dataRoot: root, workdir: root });
});

afterEach(async () => {
  await service.close();
  rmSync(root, { recursive: true, force: true });
});

describe("AgentTaskService — 绑定的 agent 派单", () => {
  test("{agent} 派单：runtime 来自绑定，task.agentId 落库，结果回流", async () => {
    await build();
    agents.create({ id: "coder", displayName: "代码工程师", runtime: "fake" });
    const created = await service.submit({ agent: "coder", content: "打个招呼" });
    expect(created.runtime).toBe("fake");
    expect(created.agentId).toBe("coder");
    const done = await service.waitForTerminal(created.id, 15_000);
    expect(done.status).toBe("replied");
    expect(done.result).toContain("你");
    expect(service.store.get(created.id)?.agentId).toBe("coder");
  });

  test("未绑定 / 不存在 / 已归档：明确错误码，不静默失败", async () => {
    await build();
    agents.create({ id: "unbound" });
    const cases = [
      ["unbound", "agent_runtime_required"],
      ["ghost", "agent_not_found"],
    ] as const;
    for (const [agent, code] of cases) {
      try {
        await service.submit({ agent, content: "x" });
        throw new Error(`${agent} 应当抛错`);
      } catch (err) {
        expect(err).toBeInstanceOf(AgentRuntimeBindingError);
        expect((err as AgentRuntimeBindingError).code).toBe(code);
      }
    }

    agents.create({ id: "archived", runtime: "fake" });
    agents.archive("archived");
    try {
      await service.submit({ agent: "archived", content: "x" });
      throw new Error("归档 agent 应当抛错");
    } catch (err) {
      expect((err as AgentRuntimeBindingError).code).toBe("agent_archived");
    }
  });

  test("绑定到不可用 runtime：runtime_unavailable / runtime_not_found 并给出候选", async () => {
    await build(false);
    agents.create({ id: "down", runtime: "down" });
    try {
      await service.submit({ agent: "down", content: "x" });
      throw new Error("应当抛错");
    } catch (err) {
      expect((err as AgentRuntimeBindingError).code).toBe("runtime_unavailable");
      expect((err as AgentRuntimeBindingError).message).toContain("down");
    }

    agents.create({ id: "missing", runtime: "nope" });
    try {
      await service.submit({ agent: "missing", content: "x" });
      throw new Error("应当抛错");
    } catch (err) {
      expect((err as AgentRuntimeBindingError).code).toBe("runtime_not_found");
    }
  });

  test("改绑围栏：执行前发现绑定已变 → failed(runtime_rebound)，不 spawn", async () => {
    await build();
    agents.create({ id: "fence", runtime: "fake" });
    const { task } = service.store.create({
      runtime: "fake",
      agentId: "fence",
      content: "旧任务",
      cwd: root,
    });
    // 派单后、执行前改绑
    agents.update("fence", { runtime: "down" });
    await service.dispatch(task.id);
    const after = service.store.get(task.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toContain("runtime 已改绑");
  });
});
