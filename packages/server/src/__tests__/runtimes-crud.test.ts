/**
 * @fengagent/server — 外部 agent 管理面（`/api/runtimes` CRUD + 探测）测试
 *
 * 覆盖「添加/编辑/删除/探测，且失败必须说清原因」这一整块：
 *
 * 1. 新增：落盘 `runtimes.json`、重名 409、缺字段 400、**命令不存在 400**；
 * 2. 协议：dispatch 只实现 `acp` / `claude-stream-json` —— 其它值、
 *    以及**opencode 这种「我们认识但没实现」的命令**必须明确报「协议不支持」
 *    （验收点：不能静默失败、不能按 ACP 瞎 spawn 一通）；
 * 3. 探测：真 spawn fixture 的 `initialize` → ok；探测失败 → `probeError` +
 *    `probeErrorCode`（握手失败 / 凭据缺失 / 命令不存在）；
 * 4. `probe-candidate`（表单「探测验证」）不落盘，永远回结果而不是抛错；
 * 5. 编辑 / 删除 / 启停：只改出现的字段、改连接参数作废旧探测、未知 runtime 404。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTaskService } from "../agent-task-service.ts";
import { AgentRuntimeRegistry, RuntimeRegistryError } from "../agent-runtimes.ts";
import { createRuntimeRoutes } from "../routes/agent-tasks.ts";

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

/** Windows 上子进程 cwd 会占住目录句柄：删不掉不算测试失败（清理不是断言） */
function safeRm(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
}

/** 错误体形状（`{error:{message,code}}`） */
interface ErrorBody {
  error: { message: string; code: string };
}

interface RuntimeCard {
  name: string;
  command: string;
  args?: string[];
  protocol?: string;
  env?: Record<string, string>;
  enabled: boolean;
  probeStatus: "ok" | "unreachable" | "unprobed";
  probeError?: string;
  probeErrorCode?: string;
  agentName: string;
  agentVersion: string;
}

describe("外部 agent 管理面 — /api/runtimes CRUD + 探测", () => {
  let service: AgentTaskService;
  let dir: string;
  let work: string;
  let app: ReturnType<typeof createRuntimeRoutes>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "feng-runtimes-crud-"));
    work = mkdtempSync(join(tmpdir(), "feng-runtimes-work-"));
    const registry = new AgentRuntimeRegistry({
      dataRoot: dir,
      // 空注册表：用例里每个 runtime 都由 CRUD 添加，断言不受默认条目干扰
      entries: [],
      probeTimeoutMs: 8_000,
    });
    service = new AgentTaskService({
      dataRoot: dir,
      registry,
      defaultCwd: work,
      autoProbe: false,
      recoverOnStart: false,
      requestTimeoutMs: 8_000,
      promptTimeoutMs: 8_000,
    });
    app = createRuntimeRoutes(service);
  });

  afterEach(async () => {
    await service.close();
    safeRm(dir);
    safeRm(work);
  });

  /** 发 JSON 请求（返回状态码 + 解析后的 body） */
  async function send(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const res = await app.request(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text === "" ? null : (JSON.parse(text) as unknown) };
  }

  /** 直接读落盘的注册表（验证「真的写进 runtimes.json 了」） */
  function persisted(): { runtimes: Array<Record<string, unknown>> } {
    const file = join(dir, "runtimes.json");
    expect(existsSync(file)).toBe(true);
    return JSON.parse(readFileSync(file, "utf-8")) as { runtimes: Array<Record<string, unknown>> };
  }

  /** 一个能真握手的最小 ACP runtime 载荷 */
  const fakePayload = {
    name: "fake",
    command: process.execPath,
    args: [FIXTURE],
  };

  test("POST / → 201 落盘 runtimes.json，列表带 args/protocol", async () => {
    const { status, body } = await send("/", "POST", fakePayload);
    expect(status).toBe(201);

    const list = body as RuntimeCard[];
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("fake");
    expect(list[0]!.args).toEqual([FIXTURE]);
    expect(list[0]!.protocol).toBe("acp");
    expect(list[0]!.enabled).toBe(true);
    expect(list[0]!.probeStatus).toBe("unprobed");

    const saved = persisted();
    expect(saved.runtimes).toHaveLength(1);
    expect(saved.runtimes[0]).toMatchObject({ name: "fake", command: process.execPath });
  });

  test("POST / 重名 → 409 conflict（原因说清是哪个名字）", async () => {
    await send("/", "POST", fakePayload);
    const { status, body } = await send("/", "POST", fakePayload);
    expect(status).toBe(409);
    const err = (body as ErrorBody).error;
    expect(err.code).toBe("conflict");
    expect(err.message).toContain("fake");
  });

  test("POST / 缺 name / 缺 command → 400 bad_request（带可读原因）", async () => {
    const noName = await send("/", "POST", { command: process.execPath });
    expect(noName.status).toBe(400);
    expect((noName.body as ErrorBody).error.code).toBe("bad_request");
    expect((noName.body as ErrorBody).error.message).toContain("name 必填");

    const noCommand = await send("/", "POST", { name: "x" });
    expect(noCommand.status).toBe(400);
    expect((noCommand.body as ErrorBody).error.message).toContain("command 必填");

    const badArgs = await send("/", "POST", { name: "x", command: process.execPath, args: "acp" });
    expect(badArgs.status).toBe(400);
    expect((badArgs.body as ErrorBody).error.code).toBe("bad_request");
  });

  test("POST / 命令不存在 → 400 command_not_found（不等探测超时）", async () => {
    const { status, body } = await send("/", "POST", {
      name: "ghost",
      command: "definitely-not-installed-agent-xyz",
    });
    expect(status).toBe(400);
    const err = (body as ErrorBody).error;
    expect(err.code).toBe("command_not_found");
    expect(err.message).toContain("命令不存在");
    expect(err.message).toContain("definitely-not-installed-agent-xyz");
    // 失败不能留下半条注册
    expect(service.listRuntimes()).toHaveLength(0);
  });

  test("POST / 未知协议值 → 400 unsupported_protocol（列出支持的协议）", async () => {
    const { status, body } = await send("/", "POST", {
      ...fakePayload,
      name: "runjson",
      protocol: "run-json",
    });
    expect(status).toBe(400);
    const err = (body as ErrorBody).error;
    expect(err.code).toBe("unsupported_protocol");
    expect(err.message).toContain("协议不支持");
    expect(err.message).toContain("acp");
    expect(err.message).toContain("claude-stream-json");
  });

  test("POST / opencode + acp → 400「协议不支持」（opencode 走 run --json）", async () => {
    // 验收用例：opencode 不是 ACP。就算本机装了 opencode，也不能按 ACP 瞎 spawn。
    const { status, body } = await send("/", "POST", {
      name: "opencode",
      command: "opencode",
      protocol: "acp",
    });
    expect(status).toBe(400);
    const err = (body as ErrorBody).error;
    expect(err.code).toBe("unsupported_protocol");
    expect(err.message).toContain("协议不支持");
    expect(err.message).toContain("run --json");
    expect(service.listRuntimes()).toHaveLength(0);
  });

  test("POST / opencode + run-json → 同样明确报「协议不支持」", async () => {
    const { status, body } = await send("/", "POST", {
      name: "opencode",
      command: "opencode",
      protocol: "run-json",
    });
    expect(status).toBe(400);
    const err = (body as ErrorBody).error;
    expect(err.code).toBe("unsupported_protocol");
    expect(err.message).toContain("协议不支持");
  });

  test("POST / claude + acp → 400（claude 是 stream-json，提示应选哪个）", async () => {
    const { status, body } = await send("/", "POST", {
      name: "cc",
      command: "claude",
      protocol: "acp",
    });
    expect(status).toBe(400);
    const err = (body as ErrorBody).error;
    expect(err.code).toBe("unsupported_protocol");
    expect(err.message).toContain("stream-json");
  });

  test("POST / probe=true → 真 spawn initialize，卡片变 ok", async () => {
    const { status, body } = await send("/", "POST", { ...fakePayload, probe: true });
    expect(status).toBe(201);
    const card = (body as RuntimeCard[])[0]!;
    expect(card.probeStatus).toBe("ok");
    expect(card.agentName).toBe("fake-acp");
    expect(card.agentVersion).toBe("0.0.1");
    // 探测结果也落盘（重启后首屏就有）
    expect((persisted() as unknown as { probes: Record<string, unknown> }).probes).toBeDefined();
  });

  test("POST / probe=true 探测失败 → 422 + 原因，且不落盘", async () => {
    const { status, body } = await send("/", "POST", {
      name: "broken",
      command: process.execPath,
      // 起来就退出（stderr 有内容）：握手失败要带 stderr 尾巴
      args: ["-e", "console.error('boom: no protocol here'); process.exit(1)"],
      probe: true,
    });
    expect(status).toBe(422);
    const err = (body as ErrorBody).error;
    expect(["handshake_failed", "spawn_failed"]).toContain(err.code);
    expect(err.message.length).toBeGreaterThan(0);
    expect(service.listRuntimes()).toHaveLength(0);
  });

  test("POST / probe=true 缺凭据 → 422 credentials_missing", async () => {
    const { status, body } = await send("/", "POST", {
      name: "needkey",
      command: process.execPath,
      args: ["-e", "console.error('Error: ANTHROPIC_API_KEY is not set'); process.exit(1)"],
      probe: true,
    });
    expect(status).toBe(422);
    const err = (body as ErrorBody).error;
    expect(err.code).toBe("credentials_missing");
    expect(err.message).toContain("凭据");
  });

  test("POST /probe-candidate → 真 spawn 探测成功（不落盘）", async () => {
    const { status, body } = await send("/probe-candidate", "POST", {
      command: process.execPath,
      args: [FIXTURE],
    });
    expect(status).toBe(200);
    const result = body as {
      probeStatus: string;
      agentName?: string;
      agentVersion?: string;
      capabilities?: { resume: boolean };
    };
    expect(result.probeStatus).toBe("ok");
    expect(result.agentName).toBe("fake-acp");
    expect(result.capabilities?.resume).toBe(true);
    // 「探测验证」不能顺手把东西注册进注册表
    expect(service.listRuntimes()).toHaveLength(0);
    // 空注册表 + 只探测 → 连 runtimes.json 都不该被写出来（写了也必须是空列表）
    const file = join(dir, "runtimes.json");
    expect(existsSync(file) ? persisted().runtimes.length : 0).toBe(0);
  });

  test("POST /probe-candidate opencode → unreachable +「协议不支持」（表单原样展示）", async () => {
    const { status, body } = await send("/probe-candidate", "POST", {
      command: "opencode",
      args: ["run", "--json"],
      protocol: "acp",
    });
    expect(status).toBe(200);
    const result = body as { probeStatus: string; probeError?: string; probeErrorCode?: string };
    expect(result.probeStatus).toBe("unreachable");
    expect(result.probeErrorCode).toBe("unsupported_protocol");
    expect(result.probeError).toContain("协议不支持");
    expect(result.probeError).toContain("run --json");
  });

  test("POST /probe-candidate 命令不存在 → unreachable + command_not_found", async () => {
    const { body } = await send("/probe-candidate", "POST", {
      command: "definitely-not-installed-agent-xyz",
    });
    const result = body as { probeStatus: string; probeError?: string; probeErrorCode?: string };
    expect(result.probeStatus).toBe("unreachable");
    expect(result.probeErrorCode).toBe("command_not_found");
    expect(result.probeError).toContain("命令不存在");
  });

  test("POST /probe-candidate 缺命令 → unreachable + bad_request（不炸 500）", async () => {
    const { status, body } = await send("/probe-candidate", "POST", { args: ["acp"] });
    expect(status).toBe(200);
    const result = body as { probeStatus: string; probeErrorCode?: string };
    expect(result.probeStatus).toBe("unreachable");
    expect(result.probeErrorCode).toBe("bad_request");
  });

  test("POST /:name/probe → 单个探测；未知 runtime 404", async () => {
    await send("/", "POST", fakePayload);
    const ok = await send("/fake/probe", "POST");
    expect(ok.status).toBe(200);
    expect((ok.body as RuntimeCard).probeStatus).toBe("ok");
    expect((ok.body as RuntimeCard).agentName).toBe("fake-acp");

    const missing = await send("/nope/probe", "POST");
    expect(missing.status).toBe(404);
    expect((missing.body as ErrorBody).error.code).toBe("not_found");
  });

  test("PATCH /:name → 改 args/env/enabled；改连接参数作废旧探测", async () => {
    await send("/", "POST", fakePayload);
    await send("/fake/probe", "POST");
    expect(service.listRuntimes()[0]!.probeStatus).toBe("ok");

    const { status, body } = await send("/fake", "PATCH", {
      args: [FIXTURE, "--flag"],
      env: { MY_TOKEN: "v" },
      enabled: false,
      // name 不可改：注册名是派发参数，传了也忽略
      name: "renamed",
    });
    expect(status).toBe(200);
    const card = (body as RuntimeCard[])[0]!;
    expect(card.name).toBe("fake");
    expect(card.args).toEqual([FIXTURE, "--flag"]);
    expect(card.env).toEqual({ MY_TOKEN: "v" });
    expect(card.enabled).toBe(false);
    // 连接参数变了 → 之前的「可用」不再可信
    expect(card.probeStatus).toBe("unprobed");
    expect(persisted().runtimes[0]).toMatchObject({ name: "fake", enabled: false });
  });

  test("PATCH /:name 未知 runtime → 404；非法协议 → 400 协议不支持", async () => {
    const missing = await send("/nope", "PATCH", { enabled: false });
    expect(missing.status).toBe(404);
    expect((missing.body as ErrorBody).error.code).toBe("not_found");

    await send("/", "POST", fakePayload);
    const bad = await send("/fake", "PATCH", { protocol: "run-json" });
    expect(bad.status).toBe(400);
    expect((bad.body as ErrorBody).error.message).toContain("协议不支持");
  });

  test("DELETE /:name → 删除并落盘；再删 404", async () => {
    await send("/", "POST", fakePayload);
    const del = await send("/fake", "DELETE");
    expect(del.status).toBe(200);
    expect(del.body as RuntimeCard[]).toHaveLength(0);
    expect(persisted().runtimes).toHaveLength(0);

    const again = await send("/fake", "DELETE");
    expect(again.status).toBe(404);
    expect((again.body as ErrorBody).error.code).toBe("not_found");
  });

  test("POST /:name/enabled 参数/未知 → 结构化 400/404", async () => {
    await send("/", "POST", fakePayload);
    const bad = await send("/fake/enabled", "POST", { enabled: "yes" });
    expect(bad.status).toBe(400);
    expect((bad.body as ErrorBody).error.code).toBe("bad_request");

    const missing = await send("/nope/enabled", "POST", { enabled: true });
    expect(missing.status).toBe(404);
    expect((missing.body as ErrorBody).error.code).toBe("not_found");
  });

  test("GET /protocols → 支持列表 + 已知未实现（opencode）", async () => {
    const { status, body } = await send("/protocols", "GET");
    expect(status).toBe(200);
    const payload = body as {
      supported: string[];
      known: Array<{ command: string; protocol: string }>;
    };
    expect(payload.supported).toEqual(["acp", "claude-stream-json"]);
    expect(payload.known.some((item) => item.command === "opencode")).toBe(true);
  });

  test("RuntimeRegistryError → 状态码/契约（直接单元验证）", () => {
    const err = new RuntimeRegistryError("unsupported_protocol", "协议不支持: x");
    expect(err.status).toBe(400);
    expect(err.toPayload()).toEqual({
      error: { message: "协议不支持: x", code: "unsupported_protocol" },
    });
  });
});
