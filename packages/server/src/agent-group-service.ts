/**
 * @fengagent/server — 群聊服务（G1，对齐 KG 冻结的契约 v1.0）
 *
 * 路由 / 群工具 / 前端三边共用的一层：
 * - 把 {@link AgentGroupStore} 的毫秒时间戳翻成 API 的 ISO 字符串；
 * - 把存储侧的富成员（human/runtime/coordinator）收敛成契约的 `members: string[]`
 *   （**runtime 注册名**，人隐含在场）；
 * - 给订阅者（群 SSE）广播快照/新消息。
 *
 * v1（协调者中转）的边界写在这里而不是路由里：
 * - **人**可以随时发言（`postMessage` 默认 `fromKind="human"`）；
 * - **外部 runtime** 不能自己发 —— 产出由服务端代写（`postRuntimeMessage`，
 *   带 `agentTaskId` 深链；G2 的「结果回群」也走它）；
 * - **协调者**（群内 fengagent 成员）通过群工具发言，落 `fromKind="coordinator"`。
 */

import { join } from "node:path";
import {
  AgentGroupStore,
  type AgentGroupRecord,
  type AgentGroupStatus,
  type GroupMember,
  type GroupMessageFromKind,
  type GroupMessageKind,
  type GroupMessageRecord,
} from "@fengagent/agent";
import { createLogger } from "@fengagent/shared";
import type { RuntimeInfo } from "./agent-runtimes.ts";

const log = createLogger("agent-groups");

/** 群信息（与前端 `GroupInfo` 逐字段一致；`messageCount`/`lastMessagePreview` 为附加字段） */
export interface GroupInfoDto {
  id: string;
  name: string;
  description: string;
  /** 成员 runtime 注册名（人隐含在场） */
  members: string[];
  status: AgentGroupStatus;
  maxRounds: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  /** 附加：消息总数（列表页角标） */
  messageCount: number;
  /** 附加：最后一条消息预览 */
  lastMessagePreview?: string;
}

/** 群消息（与前端 `GroupMessage` 逐字段一致） */
export interface GroupMessageDto {
  id: string;
  groupId: string;
  seq: number;
  fromKind: GroupMessageFromKind;
  fromName: string;
  content: string;
  kind: GroupMessageKind;
  agentTaskId?: string;
  createdAt: string;
}

/** 群 SSE 帧（与前端 `GroupStreamEvent` 逐字段一致） */
export type GroupStreamEvent =
  | { type: "snapshot"; group: GroupInfoDto; messages: GroupMessageDto[]; lastSeq: number }
  | { type: "message"; message: GroupMessageDto }
  | { type: "group"; group: GroupInfoDto };

/** 建群请求（= 前端 `GroupCreateRequest`） */
export interface CreateGroupRequest {
  name: string;
  description?: string;
  /** 成员 runtime 注册名 */
  members?: string[];
  maxRounds?: number;
  /** 协调者名（缺省 fengagent；不进契约 DTO，只用于发言署名） */
  coordinator?: string;
  createdBy?: string;
}

/** 更新群请求 */
export interface UpdateGroupRequest {
  name?: string;
  description?: string;
  status?: AgentGroupStatus;
  members?: string[];
  maxRounds?: number;
}

/** 发言请求（= 前端 `GroupMessageRequest`） */
export interface PostGroupMessageRequest {
  content: string;
  kind?: GroupMessageKind;
  /** 以下为服务端内部用法（API 路径不暴露） */
  fromKind?: GroupMessageFromKind;
  fromName?: string;
  agentTaskId?: string;
}

/** 群服务选项 */
export interface AgentGroupServiceOptions {
  /** 数据根（默认 `<数据根>/groups.db`） */
  dataRoot: string;
  /** 复用/自建存储 */
  store?: AgentGroupStore;
  /**
   * runtime 卡片提供者（列表接口的成员选择器用）。
   * 由 server 装配注入 `agentTaskService.listRuntimes`；缺省返回空数组。
   */
  runtimes?: () => RuntimeInfo[];
  now?: () => number;
}

/** 群聊服务 */
export class AgentGroupService {
  readonly store: AgentGroupStore;
  private readonly subscribers = new Map<string, Set<(event: GroupStreamEvent) => void>>();
  private readonly runtimes: () => RuntimeInfo[];

  constructor(options: AgentGroupServiceOptions) {
    this.runtimes = options.runtimes ?? (() => []);
    this.store = options.store ?? new AgentGroupStore(join(options.dataRoot, "groups.db"));
  }

  // ──────────────────────────────────────────────
  // 群
  // ──────────────────────────────────────────────

  /**
   * 建群。
   *
   * @param request - 群名 / 描述 / 成员 runtime 名 / 轮数上限
   */
  createGroup(request: CreateGroupRequest): GroupInfoDto {
    const coordinator = request.coordinator?.trim() ?? "";
    const members: GroupMember[] = (request.members ?? []).map((name) => ({
      kind: "runtime",
      name,
      runtime: name,
    }));
    if (coordinator !== "" && !members.some((m) => m.name === coordinator)) {
      members.push({ kind: "coordinator", name: coordinator });
    }
    const group = this.store.create({
      name: request.name,
      ...(request.description === undefined ? {} : { description: request.description }),
      members,
      ...(coordinator === "" ? {} : { coordinator }),
      ...(request.maxRounds === undefined ? {} : { maxRounds: request.maxRounds }),
      ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
    });
    log.info("create", `群 ${group.id}（${group.name}）创建，成员 ${group.members.length} 个`);
    const dto = this.toGroupDto(group);
    this.emit(group.id, { type: "group", group: dto });
    return dto;
  }

  /** 群列表 */
  listGroups(
    filter: { status?: AgentGroupStatus | AgentGroupStatus[]; limit?: number } = {},
  ): GroupInfoDto[] {
    return this.store.list(filter).map((group) => this.toGroupDto(group));
  }

  /** runtime 卡片（列表接口的成员选择器） */
  listRuntimes(): RuntimeInfo[] {
    return this.runtimes();
  }

  /** 取群 */
  getGroup(id: string): GroupInfoDto | null {
    const group = this.store.get(id);
    return group ? this.toGroupDto(group) : null;
  }

  /**
   * 更新群（`status:"concluded"` 即关群）。
   *
   * @param id - 群 id
   * @param patch - 待更新字段
   */
  updateGroup(id: string, patch: UpdateGroupRequest): GroupInfoDto {
    const group = this.store.update(id, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.members === undefined
        ? {}
        : {
            members: patch.members.map((name) => ({
              kind: "runtime" as const,
              name,
              runtime: name,
            })),
          }),
      ...(patch.maxRounds === undefined ? {} : { maxRounds: patch.maxRounds }),
    });
    const dto = this.toGroupDto(group);
    this.emit(id, { type: "group", group: dto });
    return dto;
  }

  /** 关群（G1 的「结束讨论」入口；G3 会补 group_conclude 工具走同一条） */
  concludeGroup(id: string): GroupInfoDto {
    return this.updateGroup(id, { status: "concluded" });
  }

  // ──────────────────────────────────────────────
  // 消息
  // ──────────────────────────────────────────────

  /** 读群消息（seq 升序，`after` 用于重连补齐） */
  listMessages(
    id: string,
    options: { after?: number; limit?: number } = {},
  ): GroupMessageDto[] {
    return this.store.messages(id, options).map(toMessageDto);
  }

  /** 最近 N 条消息（详情页首屏；按 seq 升序返回） */
  listRecentMessages(id: string, limit = 50): GroupMessageDto[] {
    return this.store.recentMessages(id, limit).map(toMessageDto);
  }

  /**
   * 发言（默认人发言）。
   *
   * @param id - 群 id
   * @param request - 内容 + 种类（缺省 chat）
   */
  postMessage(id: string, request: PostGroupMessageRequest): GroupMessageDto {
    const fromKind = request.fromKind ?? "human";
    const fromName = request.fromName?.trim() || defaultNameFor(fromKind);
    const message = this.store.appendMessage({
      groupId: id,
      content: request.content,
      fromKind,
      fromName,
      ...(request.kind === undefined ? {} : { kind: request.kind }),
      ...(request.agentTaskId === undefined ? {} : { agentTaskId: request.agentTaskId }),
    });
    const dto = toMessageDto(message);
    this.emit(id, { type: "message", message: dto });
    return dto;
  }

  /** 系统提示（建群、关群等），不占成员身份 */
  postSystemMessage(id: string, content: string): GroupMessageDto {
    return this.postMessage(id, { content, fromKind: "system", fromName: "system", kind: "system" });
  }

  /**
   * 外部 runtime 的结果回群（G2 主路径，G1 先留好入口）。
   *
   * @param id - 群 id
   * @param input - runtime 名 + 内容 + 任务深链
   */
  postRuntimeMessage(
    id: string,
    input: { runtime: string; content: string; agentTaskId?: string },
  ): GroupMessageDto {
    return this.postMessage(id, {
      content: input.content,
      fromKind: "runtime",
      fromName: input.runtime,
      ...(input.agentTaskId === undefined ? {} : { agentTaskId: input.agentTaskId }),
    });
  }

  /** 订阅群事件（SSE） */
  subscribe(id: string, listener: (event: GroupStreamEvent) => void): () => void {
    const set = this.subscribers.get(id) ?? new Set();
    set.add(listener);
    this.subscribers.set(id, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.subscribers.delete(id);
    };
  }

  /** 关闭（SSE 订阅清空 + 关库） */
  close(): void {
    this.subscribers.clear();
    this.store.close();
  }

  // ──────────────────────────────────────────────
  // 内部
  // ──────────────────────────────────────────────

  private emit(id: string, event: GroupStreamEvent): void {
    for (const listener of this.subscribers.get(id) ?? []) {
      try {
        listener(event);
      } catch (err) {
        log.warn("sse", `订阅者回调失败: ${String(err)}`);
      }
    }
  }

  /** 记录 → 契约 DTO（成员收敛成 runtime 名 + 列表摘要） */
  private toGroupDto(group: AgentGroupRecord): GroupInfoDto {
    const last = this.store.lastMessage(group.id);
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      members: group.members
        .filter((member) => member.kind === "runtime")
        .map((member) => member.runtime ?? member.name),
      status: group.status,
      maxRounds: group.maxRounds,
      createdAt: new Date(group.createdAt).toISOString(),
      updatedAt: new Date(group.updatedAt).toISOString(),
      ...(last === null ? {} : { lastMessageAt: new Date(last.createdAt).toISOString() }),
      messageCount: this.store.messageCount(group.id),
      ...(last === null ? {} : { lastMessagePreview: last.content.slice(0, 120) }),
    };
  }
}

/** 消息记录 → 契约 DTO */
export function toMessageDto(message: GroupMessageRecord): GroupMessageDto {
  return {
    id: message.id,
    groupId: message.groupId,
    seq: message.seq,
    fromKind: message.fromKind,
    fromName: message.fromName,
    content: message.content,
    kind: message.kind,
    ...(message.agentTaskId === undefined ? {} : { agentTaskId: message.agentTaskId }),
    createdAt: new Date(message.createdAt).toISOString(),
  };
}

/** 各来源的默认署名 */
function defaultNameFor(kind: GroupMessageFromKind): string {
  switch (kind) {
    case "human":
      return "user";
    case "runtime":
      return "runtime";
    case "coordinator":
      return "coordinator";
    default:
      return "system";
  }
}
