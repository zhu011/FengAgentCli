/**
 * @fengagent/web-ui — 小队的 mock 后端（AI 团队平台 P2）
 *
 * 后端（/api/squads）落地前的演示数据源：小队子视图探测失败时自动回退。
 * 契约与 client.ts 小队方法一一对齐，语义对齐 spec §5.2：
 * - leader 必须是成员（建队自动入成员；换队长要求新队长已是成员）；
 * - 移除现任队长 → 409 cannot_remove_squad_leader（先换队长再移除）；
 * - 归档软删（历史保留）；role 自由文本。
 */

import { ApiError } from "./client.ts";
import type { SquadInfo, SquadInput, SquadMember, SquadRunNode } from "./types.ts";

/** 小队数据源（client 与 mock 共同满足；页面统一走这个接口） */
export interface SquadSource {
  listSquads(): Promise<SquadInfo[]>;
  getSquad(id: string): Promise<SquadInfo>;
  createSquad(req: SquadInput): Promise<SquadInfo>;
  updateSquad(id: string, patch: SquadInput): Promise<SquadInfo>;
  archiveSquad(id: string): Promise<{ ok: boolean }>;
  addSquadMember(id: string, member: SquadMember): Promise<SquadInfo>;
  removeSquadMember(id: string, member: Pick<SquadMember, "memberType" | "memberId">): Promise<SquadInfo>;
  setSquadLeader(id: string, memberId: string): Promise<SquadInfo>;
  dispatchSquadTask(id: string, req: { content: string; mode?: "leader" | "auto" }): Promise<{ taskId: string }>;
  listSquadRuns(id: string): Promise<SquadRunNode[]>;
}

/** mock 小队仓（页面实例持有，仅演示；CRUD 内存生效） */
export class SquadsMock implements SquadSource {
  private squads = new Map<string, SquadInfo>();
  /** squadId → 运行树（演示：每次派任务产生一父一子） */
  private runs = new Map<string, SquadRunNode[]>();
  private taskSeq = 1;

  constructor() {
    // 演示种子：无（空列表起步，建队由 e2e/用户驱动）
  }

  private assertFound(id: string): SquadInfo {
    const squad = this.squads.get(id);
    if (!squad) throw new ApiError(`小队不存在: ${id}`, 404, "not_found");
    return squad;
  }

  async listSquads(): Promise<SquadInfo[]> {
    return [...this.squads.values()].filter((s) => !s.archived).map((s) => ({ ...s, members: [...s.members] }));
  }

  async getSquad(id: string): Promise<SquadInfo> {
    const squad = this.assertFound(id);
    return { ...squad, members: [...squad.members] };
  }

  async createSquad(req: SquadInput): Promise<SquadInfo> {
    // id 生成规则：显式 id 优先；否则名字 slugify（仅 [a-z0-9-]，其余剔除），空则序号兜底
    const rawId = (req.id ?? "").trim().toLowerCase();
    const slug =
      rawId === ""
        ? (req.name ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
        : rawId;
    const id = slug === "" ? `squad-${Date.now() % 100000}` : slug;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new ApiError("小队 id 必须是 kebab-case（可显式指定）", 400, "bad_request");
    }
    if (this.squads.has(id)) throw new ApiError(`小队已存在: ${id}`, 409, "conflict");
    const leaderId = (req.leaderId ?? "").trim();
    if (!leaderId) throw new ApiError("leaderId 必填（队长必须先存在）", 400, "bad_request");

    const squad: SquadInfo = {
      id,
      name: req.name?.trim() || id,
      description: req.description?.trim() ?? "",
      leaderId,
      mode: req.mode ?? "leader",
      instructions: req.instructions ?? "",
      // 队长自动成为成员（spec：leader 必须是成员之一）
      members: [{ memberType: "agent", memberId: leaderId, role: "leader" }],
      archived: false,
    };
    this.squads.set(id, squad);
    return { ...squad, members: [...squad.members] };
  }

  async updateSquad(id: string, patch: SquadInput): Promise<SquadInfo> {
    const squad = this.assertFound(id);
    if (squad.archived) throw new ApiError(`小队「${id}」已归档`, 409, "conflict");
    if (patch.name !== undefined) squad.name = patch.name;
    if (patch.description !== undefined) squad.description = patch.description;
    if (patch.mode !== undefined) squad.mode = patch.mode;
    if (patch.instructions !== undefined) squad.instructions = patch.instructions;
    return { ...squad, members: [...squad.members] };
  }

  async archiveSquad(id: string): Promise<{ ok: boolean }> {
    const squad = this.assertFound(id);
    squad.archived = true;
    return { ok: true };
  }

  async addSquadMember(id: string, member: SquadMember): Promise<SquadInfo> {
    const squad = this.assertFound(id);
    if (squad.archived) throw new ApiError(`小队「${id}」已归档`, 409, "conflict");
    const memberId = member.memberId.trim();
    if (!memberId) throw new ApiError("memberId 必填", 400, "bad_request");
    if (squad.members.some((m) => m.memberId === memberId)) {
      throw new ApiError(`成员已在小队: ${memberId}`, 409, "conflict");
    }
    squad.members.push({
      memberType: member.memberType,
      memberId,
      role: member.role.trim(),
    });
    return { ...squad, members: [...squad.members] };
  }

  async removeSquadMember(id: string, member: Pick<SquadMember, "memberType" | "memberId">): Promise<SquadInfo> {
    const squad = this.assertFound(id);
    if (member.memberId === squad.leaderId) {
      throw new ApiError(
        `不能移除现任队长「${member.memberId}」——先换队长（POST /leader）再移除`,
        409,
        "cannot_remove_squad_leader",
      );
    }
    const idx = squad.members.findIndex(
      (m) => m.memberType === member.memberType && m.memberId === member.memberId,
    );
    if (idx === -1) throw new ApiError(`成员不在小队: ${member.memberId}`, 404, "not_found");
    squad.members.splice(idx, 1);
    return { ...squad, members: [...squad.members] };
  }

  async setSquadLeader(id: string, memberId: string): Promise<SquadInfo> {
    const squad = this.assertFound(id);
    const target = squad.members.find((m) => m.memberId === memberId && m.memberType === "agent");
    if (!target) {
      throw new ApiError(`新队长「${memberId}」必须已是小队成员（agent）`, 400, "bad_request");
    }
    // 旧队长 role 摘掉 leader 标记；新队长标 leader
    squad.members = squad.members.map((m) => ({
      ...m,
      role: m.memberId === squad.leaderId ? m.role.replace(/^队长[:：]?\s*/, "").trim() : m.role,
    }));
    const leader = squad.members.find((m) => m.memberId === memberId)!;
    leader.role = leader.role === "" ? "leader" : leader.role;
    squad.leaderId = memberId;
    return { ...squad, members: [...squad.members] };
  }

  async dispatchSquadTask(id: string, req: { content: string; mode?: "leader" | "auto" }): Promise<{ taskId: string }> {
    const squad = this.assertFound(id);
    if (squad.archived) throw new ApiError(`小队「${id}」已归档`, 409, "conflict");
    if (!squad.members.some((m) => m.memberId === squad.leaderId)) {
      throw new ApiError("队长不在成员列表（数据异常）", 409, "conflict");
    }
    const taskId = `sq-task-${this.taskSeq++}`;
    const now = new Date().toISOString();
    const list = this.runs.get(id) ?? [];
    // leader 模式：leader 父 run + 第一个非队长成员子 run（演示树形）
    list.push(
      { id: `${taskId}-leader`, assignee: squad.leaderId, status: "running", title: req.content.slice(0, 40), parentRunId: null, startedAt: now, blockedReason: null, agentTaskId: null },
      { id: `${taskId}-w1`, assignee: squad.members.find((m) => m.memberId !== squad.leaderId)?.memberId ?? squad.leaderId, status: "queued", title: `子任务：${req.content.slice(0, 24)}`, parentRunId: `${taskId}-leader`, startedAt: now, blockedReason: null, agentTaskId: null },
    );
    this.runs.set(id, list);
    return { taskId };
  }

  async listSquadRuns(id: string): Promise<SquadRunNode[]> {
    this.assertFound(id);
    return [...(this.runs.get(id) ?? [])];
  }
}
