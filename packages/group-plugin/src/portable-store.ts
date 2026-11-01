/**
 * @fengagent/group-plugin — 便携群存储（JSON 文件，无原生依赖）
 *
 * 实现 `@fengagent/groups` 的 `GroupStore` 结构接口，供插件在非 Bun 运行时
 * （如 dsh 的 Node）使用；语义对齐 SQLite 版 `AgentGroupStore`
 * （`packages/agent/src/agent-group-store.ts`）。量小整文件重写，够用即可。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentGroupRecord,
  AppendGroupMessageInput,
  CreateAgentGroupInput,
  GroupMessageRecord,
  ListAgentGroupsFilter,
  ListGroupMessagesOptions,
  UpdateAgentGroupInput,
} from "@fengagent/agent";
import type { GroupStore } from "@fengagent/groups";

interface PortableState {
  groups: AgentGroupRecord[];
  messages: GroupMessageRecord[];
}

/** 生成短 id（无 crypto 依赖面差异） */
function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeMembers(members: CreateAgentGroupInput["members"]): NonNullable<CreateAgentGroupInput["members"]> {
  const seen = new Set<string>();
  const result: NonNullable<CreateAgentGroupInput["members"]> = [];
  for (const m of members ?? []) {
    if (!m || seen.has(m.name)) continue;
    seen.add(m.name);
    result.push(m);
  }
  return result;
}

/** 便携 JSON 群存储：`<dataRoot>/groups.json` 整文件读写 */
export class PortableGroupStore implements GroupStore {
  private state: PortableState;
  private readonly file: string;
  private readonly now: () => number;

  constructor(dataRoot: string, options?: { now?: () => number }) {
    this.file = join(dataRoot, "groups.json");
    this.now = options?.now ?? Date.now;
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as PortableState;
        this.state = { groups: parsed.groups ?? [], messages: parsed.messages ?? [] };
      } catch {
        this.state = { groups: [], messages: [] };
      }
    } else {
      this.state = { groups: [], messages: [] };
    }
  }

  private persist(): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state));
  }

  create(input: CreateAgentGroupInput): AgentGroupRecord {
    const name = input.name.trim();
    if (name === "") throw new Error("群名不能为空");
    const at = input.at ?? this.now();
    const record: AgentGroupRecord = {
      id: `grp_${generateId()}`,
      name,
      description: input.description ?? "",
      status: "open",
      members: normalizeMembers(input.members),
      coordinator: input.coordinator?.trim() || "fengagent",
      maxRounds: input.maxRounds ?? 20,
      idleTimeoutMs: input.idleTimeoutMs ?? 600_000,
      createdAt: at,
      updatedAt: at,
      createdBy: input.createdBy ?? "unknown",
    };
    this.state.groups.push(record);
    this.persist();
    return { ...record };
  }

  get(id: string): AgentGroupRecord | null {
    const record = this.state.groups.find((g) => g.id === id);
    return record ? { ...record, members: [...record.members] } : null;
  }

  list(filter: ListAgentGroupsFilter = {}): AgentGroupRecord[] {
    let rows = [...this.state.groups].sort((a, b) => b.createdAt - a.createdAt);
    if (filter.status && filter.status.length > 0) {
      const set = new Set(filter.status);
      rows = rows.filter((g) => set.has(g.status));
    }
    if (filter.limit !== undefined && filter.limit > 0) rows = rows.slice(0, filter.limit);
    return rows.map((g) => ({ ...g, members: [...g.members] }));
  }

  update(id: string, patch: UpdateAgentGroupInput): AgentGroupRecord {
    const idx = this.state.groups.findIndex((g) => g.id === id);
    if (idx === -1) throw new Error(`群不存在: ${id}`);
    const current = this.state.groups[idx]!;
    const next: AgentGroupRecord = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.members !== undefined ? { members: normalizeMembers(patch.members) } : {}),
      ...(patch.coordinator !== undefined ? { coordinator: patch.coordinator } : {}),
      ...(patch.maxRounds !== undefined ? { maxRounds: patch.maxRounds } : {}),
      ...(patch.idleTimeoutMs !== undefined ? { idleTimeoutMs: patch.idleTimeoutMs } : {}),
      updatedAt: patch.at ?? this.now(),
    };
    this.state.groups[idx] = next;
    this.persist();
    return { ...next, members: [...next.members] };
  }

  appendMessage(input: AppendGroupMessageInput): GroupMessageRecord {
    const group = this.state.groups.find((g) => g.id === input.groupId);
    if (!group) throw new Error(`群不存在: ${input.groupId}`);
    if (group.status === "concluded") throw new Error(`群已关闭，不能继续发言: ${group.id}`);
    const content = input.content.trim();
    if (content === "") throw new Error("消息内容不能为空");

    const record: GroupMessageRecord = {
      id: `gm_${generateId()}`,
      groupId: input.groupId,
      seq: this.lastSeq(input.groupId) + 1,
      fromKind: input.fromKind ?? "human",
      fromName: input.fromName ?? "human",
      content,
      kind: input.kind ?? "chat",
      ...(input.agentTaskId === undefined ? {} : { agentTaskId: input.agentTaskId }),
      createdAt: input.at ?? this.now(),
    };
    this.state.messages.push(record);
    group.updatedAt = record.createdAt;
    this.persist();
    return { ...record };
  }

  messages(groupId: string, options: ListGroupMessagesOptions = {}): GroupMessageRecord[] {
    let rows = this.state.messages.filter((m) => m.groupId === groupId);
    if (options.after !== undefined && options.after > 0) {
      rows = rows.filter((m) => m.seq > (options.after as number));
    }
    if (options.limit !== undefined && options.limit > 0) rows = rows.slice(0, options.limit);
    return rows.map((m) => ({ ...m }));
  }

  allMessages(groupId: string): GroupMessageRecord[] {
    return this.state.messages
      .filter((m) => m.groupId === groupId)
      .map((m) => ({ ...m }));
  }

  recentMessages(groupId: string, limit = 50): GroupMessageRecord[] {
    const rows = this.state.messages.filter((m) => m.groupId === groupId);
    return rows.slice(Math.max(0, rows.length - limit)).map((m) => ({ ...m }));
  }

  messageCount(groupId: string): number {
    return this.state.messages.filter((m) => m.groupId === groupId).length;
  }

  lastMessage(groupId: string): GroupMessageRecord | null {
    const rows = this.state.messages.filter((m) => m.groupId === groupId);
    return rows.length > 0 ? { ...rows[rows.length - 1]! } : null;
  }

  lastSeq(groupId: string): number {
    let max = 0;
    for (const m of this.state.messages) {
      if (m.groupId === groupId && m.seq > max) max = m.seq;
    }
    return max;
  }

  close(): void {
    this.persist();
  }
}
