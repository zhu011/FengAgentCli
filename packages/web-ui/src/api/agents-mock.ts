/**
 * @fengagent/web-ui — 智能体的 mock 后端（AI 团队平台 P0）
 *
 * 后端（/api/agents）落地前的演示数据源：智能体子视图探测失败时自动回退。
 * 契约与 client.ts 智能体方法一一对齐（列表/详情/创建/编辑/归档/概览/历史/模板），
 * 错误抛 ApiError（与 `{error:{message,code}}` 同形）。
 */

import { ApiError } from "./client.ts";
import type {
  AgentCard,
  AgentDetail,
  AgentInput,
  AgentOverview,
  AgentRun,
  AgentTemplate,
} from "./types.ts";

/** 智能体数据源（client 与 mock 共同满足；页面统一走这个接口） */
export interface AgentSource {
  listAgents(): Promise<AgentCard[]>;
  getAgent(id: string): Promise<AgentDetail>;
  createAgent(req: AgentInput): Promise<AgentDetail>;
  updateAgent(id: string, patch: AgentInput): Promise<AgentDetail>;
  archiveAgent(id: string): Promise<{ ok: boolean }>;
  getAgentOverview(id: string): Promise<AgentOverview>;
  listAgentRuns(
    id: string,
    query: { kind?: string; cursor?: string; limit?: number },
  ): Promise<{ runs: AgentRun[]; nextCursor?: string }>;
  listAgentTemplates(): Promise<AgentTemplate[]>;
}

/** P0 内置模板（与 spec「coder/researcher」一致；后端落地后走真实接口） */
export const BUILTIN_AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "coder",
    displayName: "代码工程师",
    description: "代码编写 Agent，擅长读改代码和执行命令",
    instructions: "你是一个代码编写 Agent。按任务要求读改代码、执行命令并验证结果；改动最小化，遵循项目既有约定。",
  },
  {
    id: "researcher",
    displayName: "调研员",
    description: "信息检索与方案调研 Agent，产出结构化摘要",
    instructions: "你是一个调研 Agent。针对问题检索资料、读代码，产出结构化摘要：结论先行、要点分列、附来源路径。",
  },
];

const TEMPLATE_BY_ID = new Map(BUILTIN_AGENT_TEMPLATES.map((t) => [t.id, t]));

/** mock 智能体仓（页面实例持有，仅演示；CRUD 内存生效） */
export class AgentsMock implements AgentSource {
  private agents = new Map<string, AgentDetail>();

  constructor() {
    const seed = (d: AgentDetail) => this.agents.set(d.id, d);
    seed({
      id: "coder",
      displayName: "代码工程师",
      description: "代码编写 Agent，擅长读改代码和执行命令",
      runtime: "dsh",
      runtimeStatus: "online",
      runs7d: 12,
      lastRunStatus: "replied",
      archived: false,
      instructions: TEMPLATE_BY_ID.get("coder")!.instructions,
      model: "",
      env: { NODE_ENV: "development" },
      envSecrets: [{ key: "GITHUB_TOKEN", masked: "ghp_****" }],
      args: ["--max-output", "64000"],
      skills: ["code-review", "test"],
      mcp: ["context7"],
      permissionMode: "inherit",
      visibility: "private",
    });
    seed({
      id: "researcher",
      displayName: "调研员",
      description: "信息检索与方案调研 Agent，产出结构化摘要",
      runtime: null,
      runtimeStatus: "unbound",
      runs7d: 3,
      lastRunStatus: "failed",
      archived: false,
      instructions: TEMPLATE_BY_ID.get("researcher")!.instructions,
      model: "",
      env: {},
      envSecrets: [],
      args: [],
      skills: [],
      mcp: [],
      permissionMode: "ask",
      visibility: "workspace",
    });
  }

  private assertNotArchived(agent: AgentDetail): void {
    if (agent.archived) throw new ApiError(`智能体「${agent.id}」已归档`, 409, "conflict");
  }

  async listAgents(): Promise<AgentCard[]> {
    return [...this.agents.values()]
      .filter((a) => !a.archived)
      .map(({ id, displayName, description, runtime, runtimeStatus, runs7d, lastRunStatus, archived }) => ({
        id,
        displayName,
        description,
        runtime,
        runtimeStatus,
        runs7d,
        lastRunStatus,
        archived,
      }));
  }

  async getAgent(id: string): Promise<AgentDetail> {
    const agent = this.agents.get(id);
    if (!agent) throw new ApiError(`智能体不存在: ${id}`, 404, "not_found");
    return { ...agent };
  }

  async createAgent(req: AgentInput): Promise<AgentDetail> {
    const id = (req.id ?? "").trim();
    if (!id) throw new ApiError("id 必填（kebab-case）", 400, "bad_request");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new ApiError("id 只能是小写字母/数字/连字符（kebab-case）", 400, "bad_request");
    }
    if (this.agents.has(id)) throw new ApiError(`智能体已存在: ${id}`, 409, "conflict");

    const tpl = req.template ? TEMPLATE_BY_ID.get(req.template) : undefined;
    const created: AgentDetail = {
      id,
      displayName: req.displayName?.trim() || tpl?.displayName || id,
      description: req.description?.trim() || tpl?.description || "",
      runtime: req.runtime ?? null,
      runtimeStatus: req.runtime ? "unprobed" : "unbound",
      runs7d: 0,
      lastRunStatus: null,
      archived: false,
      instructions: req.instructions ?? tpl?.instructions ?? "",
      model: req.model ?? "",
      env: req.env ?? {},
      envSecrets: [],
      args: req.args ?? [],
      skills: [],
      mcp: [],
      permissionMode: req.permissionMode ?? "inherit",
      visibility: "private",
    };
    this.agents.set(id, created);
    return { ...created };
  }

  async updateAgent(id: string, patch: AgentInput): Promise<AgentDetail> {
    const agent = this.agents.get(id);
    if (!agent) throw new ApiError(`智能体不存在: ${id}`, 404, "not_found");
    this.assertNotArchived(agent);

    // runtime 绑定/解绑（1:1；解绑历史保留）
    if (patch.runtime !== undefined) {
      agent.runtime = patch.runtime;
      agent.runtimeStatus = patch.runtime ? "unprobed" : "unbound";
    }
    if (patch.displayName !== undefined) agent.displayName = patch.displayName;
    if (patch.description !== undefined) agent.description = patch.description;
    if (patch.instructions !== undefined) agent.instructions = patch.instructions;
    if (patch.model !== undefined) agent.model = patch.model;
    if (patch.env !== undefined) agent.env = patch.env;
    if (patch.args !== undefined) agent.args = patch.args;
    if (patch.permissionMode !== undefined) agent.permissionMode = patch.permissionMode;
    return { ...agent };
  }

  async archiveAgent(id: string): Promise<{ ok: boolean }> {
    const agent = this.agents.get(id);
    if (!agent) throw new ApiError(`智能体不存在: ${id}`, 404, "not_found");
    agent.archived = true;
    return { ok: true };
  }

  async getAgentOverview(id: string): Promise<AgentOverview> {
    const agent = this.agents.get(id);
    if (!agent) throw new ApiError(`智能体不存在: ${id}`, 404, "not_found");
    const { runs, counters } = this.runsOf(id);
    return {
      agent: {
        id: agent.id,
        displayName: agent.displayName,
        runtime: agent.runtime,
        runtimeStatus: agent.runtimeStatus,
        probeStatus: agent.runtimeStatus === "online" ? "ok" : null,
        probedAt: agent.runtime ? new Date().toISOString() : null,
      },
      counters,
      assets: {
        skills: agent.skills.length,
        mcps: agent.mcp.length,
        integrations: 0,
        envKeys: Object.keys(agent.env).length + agent.envSecrets.length,
      },
      recentRuns: runs.slice(0, 10),
      lastError: counters.failed7d > 0
        ? { at: Date.now(), message: "最近一次运行失败（演示数据）" }
        : null,
    };
  }

  async listAgentRuns(
    id: string,
    query: { kind?: string; cursor?: string; limit?: number } = {},
  ): Promise<{ runs: AgentRun[]; nextCursor?: string }> {
    const agent = this.agents.get(id);
    if (!agent) throw new ApiError(`智能体不存在: ${id}`, 404, "not_found");
    let { runs } = this.runsOf(id);
    if (query.kind) runs = runs.filter((r) => r.kind === query.kind);
    const limit = query.limit ?? 20;
    return { runs: runs.slice(0, limit) };
  }

  async listAgentTemplates(): Promise<AgentTemplate[]> {
    return BUILTIN_AGENT_TEMPLATES.map((t) => ({ ...t }));
  }

  /** 演示运行历史（按 agent id 稳定生成） */
  private runsOf(id: string): {
    runs: AgentRun[];
    counters: AgentOverview["counters"];
  } {
    const now = Date.now();
    const kinds: AgentRun["kind"][] = ["session", "dispatch", "group"];
    const statuses = ["replied", "replied", "replied", "failed", "running"];
    const count = this.agents.get(id)?.runs7d ?? 0;
    const runs: AgentRun[] = Array.from({ length: count }, (_, i) => ({
      id: `run_${id}_${i}`,
      kind: kinds[i % kinds.length]!,
      status: statuses[i % statuses.length]!,
      title: `${["会话", "派单", "群聊"][i % 3]}任务 #${i + 1}`,
      startedAt: new Date(now - i * 3.6e6).toISOString(),
      durationMs: 12_000 + ((i * 7) % 40) * 1_000,
    }));
    const success = runs.filter((r) => r.status === "replied").length;
    const failed = runs.filter((r) => r.status === "failed").length;
    const durations = runs.filter((r) => r.durationMs !== null);
    return {
      runs,
      counters: {
        runs7d: count,
        success7d: success,
        failed7d: failed,
        avgDurationMs: durations.length
          ? Math.round(durations.reduce((s, r) => s + (r.durationMs ?? 0), 0) / durations.length)
          : 0,
        tokens7d: count * 12_800,
      },
    };
  }
}
