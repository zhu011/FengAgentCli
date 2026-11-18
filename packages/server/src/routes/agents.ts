/**
 * @fengagent/server — 智能体管理面（P0）
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET | `/api/agents` | 列表（runtime 状态 + 7 天 run 计数） |
 * | GET | `/api/agents/templates` | 内置模板（一键创建用） |
 * | POST | `/api/agents` | 创建（`{id?, displayName?, runtime?, template?}`） |
 * | GET | `/api/agents/:id` | 详情（配置聚合：instructions/skills/mcp/env 掩码/权限） |
 * | PATCH | `/api/agents/:id` | 改指令 / 模型 / runtime 绑定 / 权限；`runtime:null` = 解绑 |
 * | DELETE | `/api/agents/:id` | 归档（软删，不删目录、不删历史） |
 * | GET | `/api/agents/:id/overview` | 概览（7 天指标 + 最近 run + 最后错误） |
 * | GET | `/api/agents/:id/runs` | 运行历史（session/dispatch/group，keyset 分页） |
 * | GET | `/api/agents/:id/env` | 环境变量（secret 只回掩码） |
 * | PUT | `/api/agents/:id/env` | 写环境变量（secret 存 `secrets.env`，只回引用） |
 * | GET | `/api/runs/:id` | 单次运行（摘要 + 消息） |
 * | GET | `/api/runs/:id/messages` | 对话/事件记录（`?since=` 增量） |
 *
 * 错误契约与 `/api/runtimes` 一致：`{error:{message,code}}`，`message` 可直接展示。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentConfigFile,
  AgentRecord,
  AgentRegistry,
  AgentTemplate,
  RunIndex,
  RunMessage,
  RunStatus,
  RunSummary,
  SkillMountStore,
} from "@fengagent/agent";
import { AgentRegistryError } from "@fengagent/agent";
import type { RuntimeInfo } from "../agent-runtimes.ts";
import {
  AgentRuntimeBindingError,
  validateRuntimeBinding,
} from "../agent-runtime-binding.ts";

/** 7 天窗口 */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** 智能体路由依赖 */
export interface AgentRouteOptions {
  /** 智能体仓 */
  registry: AgentRegistry;
  /** 统一运行索引（概览/历史） */
  runIndex: RunIndex;
  /** 运行时卡片（来自 `AgentTaskService.listRuntimes()`；缺省视为无运行时） */
  listRuntimes?: () => RuntimeInfo[];
  /** 技能挂载层仓（P1：`/api/agents/:id/skills`） */
  skillMounts?: SkillMountStore;
  /**
   * 技能内容层查询（P1：`SkillService`）。
   *
   * 只依赖这两个方法，避免 agent 路由反向依赖 server 的完整服务类型。
   */
  skillCatalog?: AgentSkillCatalog;
  now?: () => number;
}

/** 技能内容层的最小接口（`SkillService` 结构兼容） */
export interface AgentSkillCatalog {
  /** 详情；不存在时抛错 */
  detail(name: string): {
    name: string;
    description: string;
    trigger: string;
    prompt: string;
    source: string;
    enabled: boolean;
    overriddenBy?: string;
    shadowed: Array<{ source: string }>;
  };
  /** 「被谁使用」 */
  usage(name: string): { count: number; agents: Array<{ agentId: string; enabled: boolean }> };
}

/** 列表/卡片视图 */
interface AgentSummary {
  id: string;
  displayName: string;
  description: string;
  runtime: string | null;
  runtimeStatus: "online" | "offline" | "unprobed" | "unbound";
  probeStatus: "ok" | "unreachable" | "unprobed" | "missing";
  runtimeError?: string;
  agentName?: string;
  kind: string;
  visibility: string;
  archived: boolean;
  runs7d: number;
  success7d: number;
  failed7d: number;
  lastRunStatus?: string;
  updatedAt: string;
}

/** 详情视图（配置聚合；`config` 为分组视图，扁平字段对齐前端契约） */
interface AgentDetail extends AgentSummary {
  instructions: string;
  model: string;
  tools: string[];
  maxTurns: number;
  permissionMode: string;
  runtimeFallbacks: string[];
  createdAt: string;
  archivedAt?: string;
  /** 扁平环境变量（前端 AgentDetail.env 契约） */
  env: Record<string, string>;
  /** 敏感变量（只给掩码；前端 AgentDetail.envSecrets 契约） */
  envSecrets: Array<{ key: string; masked: string }>;
  /** 自定义参数（前端 AgentDetail.args 契约） */
  args: string[];
  /** 挂载的 skill 名（P1 起可编辑） */
  skills: string[];
  /** 挂载的 MCP server 名 */
  mcp: string[];
  config: {
    env: Array<{ key: string; value: string }>;
    secrets: Array<{ key: string; isSecret: true; masked: string; ref: string; hasValue: boolean }>;
    args: string[];
    cwd?: string;
    skills: string[];
    mcp: string[];
    integrations: string[];
  };
  assets: { skills: number; mcps: number; integrations: number; envKeys: number };
}

/** 运行 DTO（时间戳转 ISO，`durationMs` 缺省补 null —— 前端 formatDuration 契约） */
interface AgentRunDto
  extends Omit<RunSummary, "startedAt" | "endedAt" | "durationMs"> {
  startedAt: string;
  endedAt?: string;
  durationMs: number | null;
}

/** 运行记录 → API DTO */
function toRunDto(run: RunSummary): AgentRunDto {
  const { startedAt, endedAt, durationMs, ...rest } = run;
  return {
    ...rest,
    startedAt: new Date(startedAt).toISOString(),
    ...(endedAt === undefined ? {} : { endedAt: new Date(endedAt).toISOString() }),
    durationMs: durationMs ?? null,
  };
}

/** 错误 → HTTP 契约 */
function fail(c: Context, err: unknown) {
  if (err instanceof AgentRegistryError) {
    return c.json(err.toPayload(), err.status);
  }
  if (err instanceof AgentRuntimeBindingError) {
    return c.json(err.toPayload(), err.status);
  }
  return c.json(
    {
      error: {
        message: err instanceof Error ? err.message : String(err),
        code: "internal_error",
      },
    },
    500,
  );
}

/** 运行时状态归一 */
function runtimeStatusOf(
  agent: AgentRecord,
  runtimes: readonly RuntimeInfo[],
): Pick<AgentSummary, "runtimeStatus" | "probeStatus" | "runtimeError" | "agentName"> {
  if (agent.runtime === null) {
    return { runtimeStatus: "unbound", probeStatus: "missing" };
  }
  const info = runtimes.find((item) => item.name === agent.runtime);
  if (!info) {
    return {
      runtimeStatus: "offline",
      probeStatus: "missing",
      runtimeError: `运行时未注册: ${agent.runtime}`,
    };
  }
  const status = !info.enabled
    ? "offline"
    : info.probeStatus === "ok"
      ? "online"
      : info.probeStatus === "unreachable"
        ? "offline"
        : "unprobed";
  return {
    runtimeStatus: status,
    probeStatus: info.probeStatus,
    ...(info.probeError === undefined ? {} : { runtimeError: info.probeError }),
    ...(info.agentName === "" ? {} : { agentName: info.agentName }),
  };
}

/** 读 secrets.env（KEY=VALUE 行；坏行忽略） */
function readSecrets(path: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    if (!existsSync(path)) return map;
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index <= 0) continue;
      map.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
  } catch {
    // 读不到就当没有
  }
  return map;
}

/** 写 secrets.env（0600；保留既有键） */
function writeSecrets(path: string, values: Map<string, string>): void {
  const body =
    "# 由 FengAgent 智能体设置写入（0600，勿提交到 git）\n" +
    [...values.entries()].map(([key, value]) => `${key}=${value}`).join("\n") +
    "\n";
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows 上 chmod 语义有限，失败不致命
  }
}

/** 环境变量掩码（secret 永不回显明文） */
function maskedSecret(value: string | undefined): string {
  if (value === undefined || value === "") return "****";
  const prefix = value.slice(0, 4).replace(/[^A-Za-z0-9]/g, "");
  return `${prefix || "****"}****`;
}

/**
 * 从请求体收配置：`config` 分组 + 前端契约的扁平 `env` / `args` 都认。
 *
 * 前端设置页保存时发 `{env, args}`（顶层），旧 SDK 调用方发 `{config:{...}}`；
 * 两者合并成一份 `Partial<AgentConfigFile>`。
 */
function configFromBody(body: Record<string, unknown>): Partial<AgentConfigFile> | undefined {
  const patch: Partial<AgentConfigFile> = {};
  if (body.config !== null && typeof body.config === "object" && !Array.isArray(body.config)) {
    Object.assign(patch, body.config as Partial<AgentConfigFile>);
  }
  if (isStringMap(body.env)) patch.env = body.env;
  if (Array.isArray(body.args)) patch.args = body.args.map(String);
  return Object.keys(patch).length === 0 ? undefined : patch;
}

/** 创建智能体路由 */
export function createAgentRoutes(options: AgentRouteOptions): Hono {
  const { registry, runIndex } = options;
  const now = options.now ?? Date.now;
  const runtimes = (): RuntimeInfo[] => {
    try {
      return options.listRuntimes?.() ?? [];
    } catch {
      return [];
    }
  };
  const secretsPath = join(registry.dataRoot, "secrets.env");

  /** 7 天计数（单 agent） */
  const counters = (
    agent: AgentRecord,
  ): { runs7d: number; success7d: number; failed7d: number; lastRunStatus?: string } => {
    const page = runIndex.list({
      agentId: agent.id,
      runtime: agent.runtime,
      from: now() - SEVEN_DAYS_MS,
      limit: 1000,
    });
    const success7d = page.runs.filter((run) => run.status === "completed").length;
    const failed7d = page.runs.filter((run) => run.status === "failed").length;
    return {
      runs7d: page.runs.length,
      success7d,
      failed7d,
      ...(page.runs[0] === undefined ? {} : { lastRunStatus: page.runs[0].status }),
    };
  };

  const toSummary = (agent: AgentRecord): AgentSummary => ({
    id: agent.id,
    displayName: agent.displayName,
    description: agent.description,
    runtime: agent.runtime,
    ...runtimeStatusOf(agent, runtimes()),
    kind: agent.kind,
    visibility: agent.visibility,
    archived: agent.archivedAt !== undefined,
    ...counters(agent),
    updatedAt: new Date(agent.updatedAt).toISOString(),
  });

  const toDetail = (agent: AgentRecord): AgentDetail => {
    const secrets = readSecrets(secretsPath);
    const env = Object.entries(agent.config.env).map(([key, value]) => ({ key, value }));
    const secretEntries = Object.entries(agent.config.envSecrets).map(([key, ref]) => {
      const name = ref.startsWith("secret://") ? ref.slice("secret://".length) : ref;
      const value = secrets.get(name);
      return {
        key,
        isSecret: true as const,
        masked: maskedSecret(value),
        ref,
        hasValue: value !== undefined,
      };
    });
    const base = toSummary(agent);
    return {
      ...base,
      instructions: agent.instructions,
      model: agent.model,
      tools: agent.tools,
      maxTurns: agent.maxTurns,
      permissionMode: agent.permissionMode,
      runtimeFallbacks: agent.runtimeFallbacks,
      createdAt: new Date(agent.createdAt).toISOString(),
      ...(agent.archivedAt === undefined
        ? {}
        : { archivedAt: new Date(agent.archivedAt).toISOString() }),
      env: agent.config.env,
      envSecrets: secretEntries.map((item) => ({ key: item.key, masked: item.masked })),
      args: agent.config.args,
      skills: agent.config.skills,
      mcp: agent.config.mcp,
      config: {
        env,
        secrets: secretEntries,
        args: agent.config.args,
        ...(agent.config.cwd === undefined ? {} : { cwd: agent.config.cwd }),
        skills: agent.config.skills,
        mcp: agent.config.mcp,
        integrations: agent.config.integrations,
      },
      assets: {
        skills: agent.config.skills.length,
        mcps: agent.config.mcp.length,
        integrations: agent.config.integrations.length,
        envKeys: env.length + secretEntries.length,
      },
    };
  };

  const app = new Hono();

  // GET /templates — 内置模板（静态路由必须先于 /:id）
  app.get("/templates", (c) => c.json(registry.templates() satisfies readonly AgentTemplate[]));

  // GET / — 列表
  app.get("/", (c) => {
    const includeArchived = c.req.query("includeArchived") === "1";
    return c.json(registry.list({ includeArchived }).map(toSummary));
  });

  // POST / — 创建（模板一键创建：template + 可选 runtime）
  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const runtimesNow = runtimes();
    const templateId = typeof body.template === "string" ? body.template : undefined;
    // 模板建议的 runtime：本机装了才自动绑定，否则留空（可后续在详情页绑定）
    const template =
      templateId === undefined
        ? undefined
        : registry.templates().find((item) => item.id === templateId);
    const requestedRuntime =
      body.runtime === null
        ? null
        : typeof body.runtime === "string" && body.runtime !== ""
          ? body.runtime
          : undefined;
    const autoRuntime =
      requestedRuntime === undefined &&
      template?.suggestedRuntime !== undefined &&
      runtimesNow.some((item) => item.name === template.suggestedRuntime)
        ? template.suggestedRuntime
        : undefined;
    const runtime = requestedRuntime === undefined ? (autoRuntime ?? null) : requestedRuntime;
    const runtimeError = validateRuntimeBinding(runtime, runtimesNow);
    if (runtimeError !== null) {
      return c.json({ error: { message: runtimeError, code: "runtime_not_found" } }, 400);
    }
    const configPatch = configFromBody(body);
    try {
      const created = registry.create({
        ...(typeof body.id === "string" && body.id !== "" ? { id: body.id } : {}),
        ...(typeof body.displayName === "string" && body.displayName !== ""
          ? { displayName: body.displayName }
          : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
        ...(templateId === undefined ? {} : { template: templateId }),
        runtime,
        ...(Array.isArray(body.runtimeFallbacks)
          ? { runtimeFallbacks: body.runtimeFallbacks.map(String) }
          : {}),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        ...(Array.isArray(body.tools) ? { tools: body.tools.map(String) } : {}),
        ...(typeof body.maxTurns === "number" ? { maxTurns: body.maxTurns } : {}),
        ...(body.visibility === "workspace" || body.visibility === "private"
          ? { visibility: body.visibility }
          : {}),
        ...(body.permissionMode === "inherit" ||
        body.permissionMode === "ask" ||
        body.permissionMode === "allow" ||
        body.permissionMode === "deny"
          ? { permissionMode: body.permissionMode }
          : {}),
        ...(configPatch === undefined ? {} : { config: configPatch }),
      });
      return c.json(toDetail(created), 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  // GET /:id — 详情
  app.get("/:id", (c) => {
    const agent = registry.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: { message: "智能体不存在", code: "agent_not_found" } }, 404);
    }
    return c.json(toDetail(agent));
  });

  // PATCH /:id — 改指令 / 模型 / 绑定 / 权限 / 配置
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = registry.get(id);
    if (!existing) {
      return c.json({ error: { message: "智能体不存在", code: "agent_not_found" } }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const runtimesNow = runtimes();
    const runtime =
      body.runtime === null
        ? null
        : typeof body.runtime === "string" && body.runtime !== ""
          ? body.runtime
          : undefined;
    if (runtime !== undefined) {
      const runtimeError = validateRuntimeBinding(runtime, runtimesNow);
      if (runtimeError !== null) {
        return c.json({ error: { message: runtimeError, code: "runtime_not_found" } }, 400);
      }
    }
    const configPatch = configFromBody(body);
    try {
      const updated = registry.update(id, {
        ...(typeof body.displayName === "string"
          ? { displayName: body.displayName }
          : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
        ...(runtime === undefined ? {} : { runtime }),
        ...(Array.isArray(body.runtimeFallbacks)
          ? { runtimeFallbacks: body.runtimeFallbacks.map(String) }
          : {}),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        ...(Array.isArray(body.tools) ? { tools: body.tools.map(String) } : {}),
        ...(typeof body.maxTurns === "number" ? { maxTurns: body.maxTurns } : {}),
        ...(body.visibility === "workspace" || body.visibility === "private"
          ? { visibility: body.visibility }
          : {}),
        ...(body.permissionMode === "inherit" ||
        body.permissionMode === "ask" ||
        body.permissionMode === "allow" ||
        body.permissionMode === "deny"
          ? { permissionMode: body.permissionMode }
          : {}),
        ...(configPatch === undefined ? {} : { config: configPatch }),
      });
      return c.json(toDetail(updated));
    } catch (err) {
      return fail(c, err);
    }
  });

  // DELETE /:id — 归档（软删）
  app.delete("/:id", (c) => {
    try {
      const agent = registry.archive(c.req.param("id"));
      return c.json({ ok: true, agent: toDetail(agent) });
    } catch (err) {
      return fail(c, err);
    }
  });

  // GET /:id/overview — 概览
  app.get("/:id/overview", (c) => {
    const agent = registry.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: { message: "智能体不存在", code: "agent_not_found" } }, 404);
    }
    const since = now() - SEVEN_DAYS_MS;
    const page = runIndex.list({
      agentId: agent.id,
      runtime: agent.runtime,
      from: since,
      limit: 1000,
    });
    const completed = page.runs.filter((run) => run.status === "completed").length;
    const failed = page.runs.filter((run) => run.status === "failed").length;
    const durations = page.runs
      .map((run) => run.durationMs)
      .filter((value): value is number => value !== undefined);
    const tokens = page.runs.reduce((sum, run) => sum + (run.usage?.tokens ?? 0), 0);
    const recent = runIndex.list({
      agentId: agent.id,
      runtime: agent.runtime,
      limit: 10,
    });
    const lastErrorRun = page.runs.find(
      (run) => run.status === "failed" && run.error !== undefined,
    );
    const info = runtimes().find((item) => item.name === agent.runtime);
    const status = runtimeStatusOf(agent, runtimes());
    return c.json({
      agent: {
        id: agent.id,
        displayName: agent.displayName,
        runtime: agent.runtime,
        runtimeStatus: status.runtimeStatus,
        probeStatus: status.probeStatus,
        ...(info?.probedAt === undefined ? {} : { probedAt: info.probedAt }),
        archived: agent.archivedAt !== undefined,
      },
      counters: {
        runs7d: page.runs.length,
        success7d: completed,
        failed7d: failed,
        successRate7d: completed + failed === 0 ? null : completed / (completed + failed),
        avgDurationMs:
          durations.length === 0
            ? null
            : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
        tokens7d: tokens,
      },
      assets: {
        skills: agent.config.skills.length,
        mcps: agent.config.mcp.length,
        integrations: agent.config.integrations.length,
        envKeys:
          Object.keys(agent.config.env).length + Object.keys(agent.config.envSecrets).length,
      },
      recentRuns: recent.runs.map(toRunDto),
      lastError:
        lastErrorRun === undefined
          ? null
          : {
              at: lastErrorRun.startedAt,
              message: lastErrorRun.error ?? "未知错误",
              runId: lastErrorRun.id,
            },
    });
  });

  // GET /:id/runs — 运行历史（三路 UNION）
  app.get("/:id/runs", (c) => {
    const agent = registry.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: { message: "智能体不存在", code: "agent_not_found" } }, 404);
    }
    const kind = parseKinds(c.req.query("kind"));
    const status = parseStatuses(c.req.query("status"));
    const from = parseTime(c.req.query("from"));
    const to = parseTime(c.req.query("to"));
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const cursor = c.req.query("cursor");
    const page = runIndex.list({
      agentId: agent.id,
      runtime: agent.runtime,
      ...(kind === undefined ? {} : { kind }),
      ...(status === undefined ? {} : { status }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(Number.isFinite(rawLimit) && rawLimit > 0 ? { limit: rawLimit } : {}),
      ...(cursor === undefined || cursor === "" ? {} : { cursor }),
    });
    return c.json({
      runs: page.runs.map(toRunDto),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });

  // GET /:id/env — 环境变量（掩码）
  app.get("/:id/env", (c) => {
    const agent = registry.get(c.req.param("id"));
    if (!agent) {
      return c.json({ error: { message: "智能体不存在", code: "agent_not_found" } }, 404);
    }
    const secrets = readSecrets(secretsPath);
    return c.json({
      env: Object.entries(agent.config.env).map(([key, value]) => ({
        key,
        isSecret: false,
        value,
      })),
      secrets: Object.entries(agent.config.envSecrets).map(([key, ref]) => {
        const name = ref.startsWith("secret://") ? ref.slice("secret://".length) : ref;
        const value = secrets.get(name);
        return {
          key,
          isSecret: true,
          masked: maskedSecret(value),
          ref,
          hasValue: value !== undefined,
        };
      }),
      args: agent.config.args,
    });
  });

  // PUT /:id/env — 写环境变量（secret 值落 secrets.env，config 只存引用）
  app.put("/:id/env", async (c) => {
    const id = c.req.param("id");
    const agent = registry.get(id);
    if (!agent) {
      return c.json({ error: { message: "智能体不存在", code: "agent_not_found" } }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const env = body.env;
    const secretsInput = body.secrets;
    if (
      (env !== undefined && !isStringMap(env)) ||
      (secretsInput !== undefined && !isStringMap(secretsInput))
    ) {
      return c.json(
        { error: { message: "env/secrets 必须是 {KEY: string} 对象", code: "bad_request" } },
        400,
      );
    }
    const nextEnv: Record<string, string> = { ...agent.config.env };
    if (env !== undefined) {
      for (const key of Object.keys(nextEnv)) delete nextEnv[key];
      for (const [key, value] of Object.entries(env as Record<string, string>)) {
        const error = validateEnvKey(key, value);
        if (error !== null) {
          return c.json({ error: { message: error, code: "bad_request" } }, 400);
        }
        nextEnv[key] = value;
      }
    }
    const nextSecrets: Record<string, string> = { ...agent.config.envSecrets };
    if (secretsInput !== undefined) {
      const store = readSecrets(secretsPath);
      for (const [key, value] of Object.entries(secretsInput as Record<string, string>)) {
        const error = validateEnvKey(key, value);
        if (error !== null) {
          return c.json({ error: { message: error, code: "bad_request" } }, 400);
        }
        if (value.startsWith("secret://")) {
          nextSecrets[key] = value;
          continue;
        }
        // 明文只进 secrets.env（0600），config.json 只留引用
        store.set(key, value);
        nextSecrets[key] = `secret://${key}`;
      }
      try {
        writeSecrets(secretsPath, store);
      } catch (err) {
        return fail(c, err);
      }
    }
    try {
      registry.update(id, { config: { ...agent.config, env: nextEnv, envSecrets: nextSecrets } });
    } catch (err) {
      return fail(c, err);
    }
    const secrets = readSecrets(secretsPath);
    return c.json({
      env: Object.entries(nextEnv).map(([key, value]) => ({ key, isSecret: false, value })),
      secrets: Object.entries(nextSecrets).map(([key, ref]) => {
        const name = ref.startsWith("secret://") ? ref.slice("secret://".length) : ref;
        const value = secrets.get(name);
        return {
          key,
          isSecret: true,
          masked: maskedSecret(value),
          ref,
          hasValue: value !== undefined,
        };
      }),
      args: agent.config.args,
    });
  });

  // ── P1：技能挂载（内容留在共享库，卸载只删关系）────────────
  const mounts = options.skillMounts;
  const catalog = options.skillCatalog;

  /** 挂载 + 内容层合并视图（内容缺失只标记 missing，不让列表 500） */
  const skillEntries = (agentId: string) => {
    if (!mounts) return [];
    return mounts.listForAgent(agentId).map((mount) => {
      let description = "";
      let trigger = mount.triggerOverride ?? "";
      let shadowed = false;
      let missing = false;
      if (catalog) {
        try {
          const detail = catalog.detail(mount.skillName);
          description = detail.description;
          if (mount.triggerOverride === undefined) trigger = detail.trigger;
          // 前端契约：shadowed 是布尔（是否被更高优先层覆盖），不是层次数组
          shadowed = detail.overriddenBy !== undefined;
        } catch {
          missing = true;
        }
      }
      return {
        name: mount.skillName,
        source: mount.source,
        enabled: mount.enabled,
        shadowed,
        ...(trigger === "" ? {} : { trigger }),
        ...(description === "" ? {} : { description }),
        missing,
        mountedAt: new Date(mount.createdAt).toISOString(),
        updatedAt: new Date(mount.updatedAt).toISOString(),
      };
    });
  };

  /** 双写 `config.skills`（P0 详情页/旧消费方仍读它，spec §5.3.1） */
  const syncConfigSkills = (agentId: string): void => {
    if (!mounts) return;
    const agent = registry.get(agentId);
    if (!agent) return;
    const names = mounts.listForAgent(agentId).map((mount) => mount.skillName);
    registry.update(agentId, { config: { ...agent.config, skills: names } });
  };

  /** 挂载前置校验：装配/agent 存在/skill 在内容层存在 */
  const requireMountContext = (
    c: Context,
    agentId: string,
    skillName?: string,
  ): Response | null => {
    if (!mounts) {
      return c.json(
        { error: { message: "技能挂载未装配（缺少 skillMounts）", code: "not_configured" } },
        501,
      );
    }
    if (!registry.get(agentId)) {
      return c.json({ error: { message: "智能体不存在", code: "agent_not_found" } }, 404);
    }
    if (skillName !== undefined && catalog) {
      try {
        catalog.detail(skillName);
      } catch {
        return c.json(
          { error: { message: `技能不存在: ${skillName}`, code: "skill_not_found" } },
          404,
        );
      }
    }
    return null;
  };

  if (mounts) {
    // GET /:id/skills — 已挂载列表（含 enabled / 来源 / 是否被 shadow）
    app.get("/:id/skills", (c) => {
      const agentId = c.req.param("id");
      const blocked = requireMountContext(c, agentId);
      if (blocked) return blocked;
      const skills = skillEntries(agentId);
      c.header("Cache-Control", "no-cache");
      return c.json(skills);
    });

    // POST /:id/skills — 增量添加（已挂载则原样返回，不改启停）
    app.post("/:id/skills", async (c) => {
      const agentId = c.req.param("id");
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name === "") {
        return c.json({ error: { message: "name 必填", code: "bad_request" } }, 400);
      }
      const blocked = requireMountContext(c, agentId, name);
      if (blocked) return blocked;
      let source = "team";
      if (catalog) {
        try {
          source = catalog.detail(name).source;
        } catch {
          // 上面已经校验过；竞态下退化为 team
        }
      }
      const { created } = mounts.add({ agentId, skillName: name, source });
      syncConfigSkills(agentId);
      return c.json(skillEntries(agentId), created ? 201 : 200);
    });

    // PUT /:id/skills — 全量替换（对齐 Multica SetAgentSkills）
    app.put("/:id/skills", async (c) => {
      const agentId = c.req.param("id");
      const blocked = requireMountContext(c, agentId);
      if (blocked) return blocked;
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const raw = body.names ?? body.skills;
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
        return c.json(
          { error: { message: "names 必须是字符串数组", code: "bad_request" } },
          400,
        );
      }
      const names = (raw as string[]).map((name) => name.trim()).filter((name) => name !== "");
      const unknown: string[] = [];
      if (catalog) {
        for (const name of names) {
          try {
            catalog.detail(name);
          } catch {
            unknown.push(name);
          }
        }
      }
      if (unknown.length > 0) {
        return c.json(
          { error: { message: `技能不存在: ${unknown.join("、")}`, code: "skill_not_found" } },
          404,
        );
      }
      mounts.replace(agentId, names);
      syncConfigSkills(agentId);
      return c.json(skillEntries(agentId));
    });

    // PATCH /:id/skills/:name — 启停 / 覆盖 trigger
    app.patch("/:id/skills/:name", async (c) => {
      const agentId = c.req.param("id");
      const name = c.req.param("name");
      const blocked = requireMountContext(c, agentId, name);
      if (blocked) return blocked;
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const enabled =
        typeof body.enabled === "boolean" ? (body.enabled as boolean) : undefined;
      const trigger =
        body.trigger === null
          ? null
          : typeof body.trigger === "string"
            ? body.trigger
            : undefined;
      const updated = mounts.patch(agentId, name, {
        ...(enabled === undefined ? {} : { enabled }),
        ...(trigger === undefined ? {} : { triggerOverride: trigger }),
      });
      if (!updated) {
        return c.json(
          { error: { message: `未挂载该技能: ${name}`, code: "not_found" } },
          404,
        );
      }
      return c.json(skillEntries(agentId));
    });

    // DELETE /:id/skills/:name — 卸载（只删关系，内容留在技能库）
    app.delete("/:id/skills/:name", (c) => {
      const agentId = c.req.param("id");
      const name = c.req.param("name");
      const blocked = requireMountContext(c, agentId);
      if (blocked) return blocked;
      const removed = mounts.remove(agentId, name);
      if (!removed) {
        return c.json(
          { error: { message: `未挂载该技能: ${name}`, code: "not_found" } },
          404,
        );
      }
      syncConfigSkills(agentId);
      return c.json(skillEntries(agentId));
    });
  }

  return app;
}

/**
 * 运行详情/消息路由。
 *
 * @param options - 运行索引
 */
export function createRunRoutes(options: { runIndex: RunIndex }): Hono {
  const app = new Hono();
  const { runIndex } = options;

  // GET /:id — 单次运行（摘要 + 最近 200 条消息）
  app.get("/:id", (c) => {
    const id = c.req.param("id");
    const run = runIndex.get(id);
    if (!run) {
      return c.json({ error: { message: "运行记录不存在", code: "run_not_found" } }, 404);
    }
    return c.json({ run: toRunDto(run), messages: runIndex.messages(run.id, 0, 200) satisfies RunMessage[] });
  });

  // GET /:id/messages — 增量对话/事件（`?since=<seq>`）
  app.get("/:id/messages", (c) => {
    const id = c.req.param("id");
    const run = runIndex.get(id);
    if (!run) {
      return c.json({ error: { message: "运行记录不存在", code: "run_not_found" } }, 404);
    }
    const rawSince = Number.parseInt(c.req.query("since") ?? "0", 10);
    const since = Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 0;
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const messages = runIndex.messages(
      run.id,
      since,
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 500,
    );
    const last = messages[messages.length - 1];
    return c.json({
      messages,
      ...(last === undefined ? {} : { nextSince: last.seq }),
    });
  });

  return app;
}

/** `kind` 查询参数 */
function parseKinds(raw: string | undefined): RunSummary["kind"] | RunSummary["kind"][] | undefined {
  if (raw === undefined || raw === "") return undefined;
  const allowed: RunSummary["kind"][] = ["session", "dispatch", "group"];
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is RunSummary["kind"] => (allowed as string[]).includes(item));
  return values.length === 0 ? undefined : values;
}

/** `status` 查询参数 */
function parseStatuses(raw: string | undefined): RunStatus | RunStatus[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  const allowed: RunStatus[] = [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "expired",
  ];
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is RunStatus => (allowed as string[]).includes(item));
  return values.length === 0 ? undefined : values;
}

/** 时间参数（毫秒或 ISO） */
function parseTime(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const num = Number(raw);
  if (Number.isFinite(num)) return num;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `{KEY: string}` 校验 */
function isStringMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

/** 环境变量键/值校验（拒绝换行与非法键名） */
function validateEnvKey(key: string, value: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return `非法环境变量名: ${key}（只允许字母/数字/下划线，且不以数字开头）`;
  }
  if (value.includes("\n") || value.includes("\r")) {
    return `环境变量 ${key} 的值不能包含换行`;
  }
  return null;
}
