/**
 * `/api/agents` + `/api/runs`（P0）测试。
 *
 * 覆盖：模板一键创建 / 列表状态 / 详情聚合 / 改绑与解绑 / 概览指标 /
 * 运行历史三路 / 环境变量掩码（secret 不落 config.json、不回显）/ 归档 / 运行详情。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, AgentTaskStore, RunIndex } from "@fengagent/agent";
import type { RuntimeInfo } from "../agent-runtimes.ts";
import { createAgentRoutes, createRunRoutes } from "../routes/agents.ts";

let root: string;
let registry: AgentRegistry;
let runIndex: RunIndex;
let taskStore: AgentTaskStore;
let app: ReturnType<typeof createAgentRoutes>;
let runsApp: ReturnType<typeof createRunRoutes>;

/** 一张「claude 在线」的运行时卡片 */
function runtime(name: string, probeStatus: RuntimeInfo["probeStatus"] = "ok"): RuntimeInfo {
  return {
    name,
    command: name,
    agentName: `${name}-acp`,
    agentVersion: "1.0.0",
    capabilities: { resume: true, loadSession: true, image: false },
    probeStatus,
    enabled: true,
    recentTaskCount: 0,
    ...(probeStatus === "ok" ? { probedAt: new Date().toISOString() } : {}),
  };
}

const runtimes: RuntimeInfo[] = [runtime("claude"), runtime("dsh", "unreachable")];

function json(body: unknown, method = "POST"): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-agents-api-"));
  registry = new AgentRegistry({ dataRoot: root, workdir: root });
  runIndex = new RunIndex({ dataRoot: root });
  taskStore = new AgentTaskStore(join(root, "agent-tasks.db"));
  app = createAgentRoutes({ registry, runIndex, listRuntimes: () => runtimes });
  runsApp = createRunRoutes({ runIndex });
});

afterEach(() => {
  runIndex.close();
  taskStore.close();
  rmSync(root, { recursive: true, force: true });
});

/** 造一条已完成派单 */
function seedRun(agentId: string, content: string, error?: string): string {
  const at = Date.now();
  const { task } = taskStore.create({ runtime: "claude", agentId, content, cwd: root, at });
  taskStore.setStatus(task.id, "dispatched", {}, at + 5);
  taskStore.appendEvent(task.id, "task/stream-chunk", "结果文本", at + 10);
  if (error === undefined) {
    taskStore.setStatus(task.id, "replied", { result: "结果文本" }, at + 20);
  } else {
    taskStore.setStatus(task.id, "failed", { error }, at + 20);
  }
  return task.id;
}

describe("/api/agents", () => {
  test("templates + 模板一键创建（自动绑定本机已装的建议运行时）", async () => {
    const templates = await app.request("/templates");
    expect(templates.status).toBe(200);
    const list = (await templates.json()) as Array<{ id: string }>;
    expect(list.map((item) => item.id)).toEqual(["coder", "researcher", "reviewer"]);

    const created = await app.request("/", json({ template: "coder", displayName: "代码工程师" }));
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      id: string;
      runtime: string | null;
      runtimeStatus: string;
      instructions: string;
      tools: string[];
    };
    expect(body.id).toBe("coder");
    expect(body.runtime).toBe("claude");
    expect(body.runtimeStatus).toBe("online");
    expect(body.instructions).toContain("代码编写 Agent");
    expect(body.tools).toContain("file-read");
  });

  test("列表：runtime 徽标 + 7 天计数；详情聚合配置；解绑保留记录", async () => {
    await app.request("/", json({ template: "coder", runtime: "claude" }));
    seedRun("coder", "跑个任务");

    const listRes = await app.request("/");
    const agents = (await listRes.json()) as Array<{
      id: string;
      runs7d: number;
      success7d: number;
      runtimeStatus: string;
    }>;
    const coder = agents.find((agent) => agent.id === "coder")!;
    expect(coder.runs7d).toBe(1);
    expect(coder.success7d).toBe(1);
    expect(coder.runtimeStatus).toBe("online");

    const detail = (await (await app.request("/coder")).json()) as {
      config: { skills: string[] };
      assets: { skills: number };
      env: Record<string, string>;
      args: string[];
      skills: string[];
      mcp: string[];
    };
    expect(detail.config.skills).toEqual([]);
    expect(detail.assets.skills).toBe(0);
    // 前端 AgentDetail 契约：扁平 env/args/skills/mcp
    expect(detail.env).toEqual({});
    expect(detail.args).toEqual([]);
    expect(detail.skills).toEqual([]);
    expect(detail.mcp).toEqual([]);

    // 前端设置页保存时发扁平 {env, args}
    const saved = await app.request(
      "/coder",
      json({ env: { NODE_ENV: "test" }, args: ["--max-output", "64000"] }, "PATCH"),
    );
    expect(saved.status).toBe(200);
    const savedDetail = (await saved.json()) as {
      env: Record<string, string>;
      args: string[];
      config: { args: string[] };
    };
    expect(savedDetail.env.NODE_ENV).toBe("test");
    expect(savedDetail.args).toEqual(["--max-output", "64000"]);
    expect(savedDetail.config.args).toEqual(["--max-output", "64000"]);

    const unbound = await app.request("/coder", json({ runtime: null }, "PATCH"));
    expect(unbound.status).toBe(200);
    const after = (await unbound.json()) as { runtime: string | null; runtimeStatus: string };
    expect(after.runtime).toBeNull();
    expect(after.runtimeStatus).toBe("unbound");
    // 解绑不删 agent、不删历史
    expect((await app.request("/coder")).status).toBe(200);
    expect((await (await app.request("/coder/runs")).json() as { runs: unknown[] }).runs.length).toBe(1);
  });

  test("绑定校验：未注册 runtime 400，归档后不可再派单（历史仍可查）", async () => {
    await app.request("/", json({ id: "a1", displayName: "A1" }));
    const bad = await app.request("/a1", json({ runtime: "nope" }, "PATCH"));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("runtime_not_found");

    seedRun("a1", "失败任务", "目标拒绝执行");
    const archived = await app.request("/a1", { method: "DELETE" });
    expect(archived.status).toBe(200);
    const archivedBody = (await archived.json()) as { ok: boolean; agent: { archived: boolean } };
    expect(archivedBody.ok).toBe(true);
    expect(archivedBody.agent.archived).toBe(true);
    expect((await (await app.request("/")).json() as unknown[]).length).toBe(0);
    expect(((await (await app.request("/a1")).json()) as { archivedAt?: string }).archivedAt).toBeDefined();
    expect((await (await app.request("/a1/runs")).json() as { runs: unknown[] }).runs.length).toBe(1);
  });

  test("概览：7 天指标与真实 run 数一致，最后错误可定位", async () => {
    await app.request("/", json({ template: "coder", runtime: "claude" }));
    seedRun("coder", "成功任务");
    seedRun("coder", "失败任务", "目标拒绝执行");

    const res = await app.request("/coder/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent: { runtime: string; runtimeStatus: string };
      counters: {
        runs7d: number;
        success7d: number;
        failed7d: number;
        successRate7d: number;
        avgDurationMs: number;
      };
      assets: { skills: number };
      recentRuns: unknown[];
      lastError: { message: string; runId: string } | null;
    };
    expect(body.agent.runtime).toBe("claude");
    expect(body.agent.runtimeStatus).toBe("online");
    expect(body.counters.runs7d).toBe(2);
    expect(body.counters.success7d).toBe(1);
    expect(body.counters.failed7d).toBe(1);
    expect(body.counters.successRate7d).toBe(0.5);
    expect(body.counters.avgDurationMs).toBeGreaterThan(0);
    expect(body.recentRuns.length).toBe(2);
    expect(body.lastError?.message).toContain("目标拒绝执行");
    expect(body.lastError?.runId.startsWith("dispatch:")).toBe(true);
  });

  test("环境变量：secret 只回掩码，明文落 secrets.env，不进 config.json", async () => {
    await app.request("/", json({ id: "env-agent" }));
    const written = await app.request(
      "/env-agent/env",
      json({ env: { NODE_ENV: "development" }, secrets: { GITHUB_TOKEN: "ghp_secret_value" } }, "PUT"),
    );
    expect(written.status).toBe(200);
    const view = (await written.json()) as {
      env: Array<{ key: string; value: string }>;
      secrets: Array<{ key: string; masked: string; hasValue: boolean }>;
    };
    expect(view.env.find((item) => item.key === "NODE_ENV")?.value).toBe("development");
    const secret = view.secrets.find((item) => item.key === "GITHUB_TOKEN")!;
    expect(secret.hasValue).toBe(true);
    expect(secret.masked).not.toContain("secret_value");

    const configRaw = readFileSync(join(root, "agents", "env-agent", "config.json"), "utf8");
    expect(configRaw).not.toContain("ghp_secret_value");
    expect(configRaw).toContain("secret://GITHUB_TOKEN");
    expect(existsSync(join(root, "secrets.env"))).toBe(true);
    expect(readFileSync(join(root, "secrets.env"), "utf8")).toContain("GITHUB_TOKEN=ghp_secret_value");

    // 详情同样掩码
    const detail = (await (await app.request("/env-agent")).json()) as {
      config: { secrets: Array<{ masked: string }> };
    };
    expect(detail.config.secrets[0]!.masked).not.toContain("secret_value");
  });

  test("错误契约：不存在 404、非法 body 400、重名 409", async () => {
    expect((await app.request("/nope")).status).toBe(404);
    expect((await app.request("/nope", { method: "DELETE" })).status).toBe(404);
    await app.request("/", json({ id: "dup" }));
    expect((await app.request("/", json({ id: "dup" }))).status).toBe(409);
    expect(
      (await app.request("/dup/env", json({ env: { "bad key": "x" } }, "PUT"))).status,
    ).toBe(400);
  });
});

describe("/api/runs", () => {
  test("运行详情 + 消息增量（dispatch 来源）", async () => {
    await app.request("/", json({ id: "coder2", runtime: "claude" }));
    const taskId = seedRun("coder2", "写个测试");

    const detail = await runsApp.request(`/dispatch:${taskId}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      run: { id: string; kind: string; status: string };
      messages: Array<{ type: string; content: string }>;
    };
    expect(body.run.kind).toBe("dispatch");
    expect(body.run.status).toBe("completed");
    expect(body.messages.some((message) => message.content.includes("结果文本"))).toBe(true);

    const incremental = await runsApp.request(`/dispatch:${taskId}/messages?since=5`);
    expect(incremental.status).toBe(200);
    const page = (await incremental.json()) as { messages: Array<{ seq: number }>; nextSince?: number };
    expect(page.messages.every((message) => message.seq > 5)).toBe(true);

    // 裸 taskId 兼容
    expect((await runsApp.request(`/${taskId}`)).status).toBe(200);
    expect((await runsApp.request("/dispatch:nope")).status).toBe(404);
  });
});
