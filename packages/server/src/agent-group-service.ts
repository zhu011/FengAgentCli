/**
 * @fengagent/server — 群聊服务（G1，对齐 KG 冻结契约 v1.0）
 *
 * 路由 / 群工具 / 前端三边共用的一层：
 * - 把存储的毫秒时间戳翻成 API 的 RFC3339 字符串；
 * - 把存储侧的富成员（human/runtime/coordinator）收敛成契约的 `members: string[]`
 *   （**runtime + 协调者**的注册名，人隐含在场、不占位）；
 * - 校验「谁能发言」并给订阅者（群 SSE）广播快照/新消息。
 *
 * v1（协调者中转）的写入边界：
 * - **人** → `POST /api/groups/:id/messages`（`fromKind="human"`，`fromName="human"`）；
 * - **协调者/成员 runtime** → `POST /api/groups/:id/agent-messages`（服务端校验
 *   `fromName ∈ members ∪ {coordinator}`，否则 403）；
 * - **外部 runtime 的产出** 由服务端代写（`postRuntimeMessage`，带 `agentTaskId` 深链；
 *   G2 的「结果回群」走它，不暴露 REST）。
 */

import { join } from "node:path";
import {
  AgentGroupStore,
  type AgentGroupRecord,
  type AgentGroupStatus,
  type GroupMessageFromKind,
  type GroupMessageKind,
  type GroupMessageRecord,
} from "@fengagent/agent";
import { createLogger } from "@fengagent/shared";
import type { RuntimeInfo } from "./agent-runtimes.ts";

const log = createLogger("agent-groups");

/** 群服务的错误码（路由据此映射 HTTP 状态） */
export type GroupErrorCode = "bad_request" | "not_found" | "forbidden" | "conflict";

/** 群服务错误 */
export class GroupError extends Error {
  constructor(message: string, readonly code: GroupErrorCode) {
    super(message);
    this.name = "GroupError";
  }
}

/** 群信息（与前端 `GroupInfo` 逐字段一致） */
export interface GroupInfoDto {
  id: string;
  name: string;
  description: string;
  /** 成员 runtime 注册名（含协调者；人隐含在场，不占位） */
  members: string[];
  status: AgentGroupStatus;
  maxRounds: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
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
  | { type: "group"; group: GroupInfoDto }
  | { type: "heartbeat" };

/** 建群请求（= 前端 `GroupCreateRequest`） */
export interface CreateGroupRequest {
  name: string;
  description?: string;
  /** 成员 runtime 注册名（未注册/未启用 → 400） */
  members?: string[];
  maxRounds?: number;
  /** 协调者名（缺省 `fengagent`；会作为成员出现在 `members` 里） */
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

/** 人发言请求（= 前端 `GroupMessageRequest`） */
export interface PostHumanMessageRequest {
  content: string;
  kind?: GroupMessageKind;
}

/** runtime/协调者发言请求（`/agent-messages`） */
export interface PostAgentMessageRequest {
  content: string;
  fromName: string;
  kind?: GroupMessageKind;
}

/** 群服务选项 */
export interface AgentGroupServiceOptions {
  /** 数据根（默认 `<数据根>/groups.db`） */
  dataRoot: string;
  /** 复用/自建存储 */
  store?: AgentGroupStore;
  /**
   * runtime 卡片提供者（列表接口的成员选择器 + 建群成员校验）。
   * 由 server 装配注入 `agentTaskService.listRuntimes`；缺省返回空数组（不校验）。
   */
  runtimes?: () => RuntimeInfo[];
  /** 协调者默认名（缺省 `fengagent`） */
  defaultCoordinator?: string;
  now?: () => number;
}

/** 群聊服务 */
export class AgentGroupService {
  readonly store: AgentGroupStore;
  private readonly subscribers = new Map<string, Set<(event: GroupStreamEvent) => void>>();
  private readonly runtimes: () => RuntimeInfo[];
  private readonly defaultCoordinator: string;

  constructor(options: AgentGroupServiceOptions) {
    this.runtimes = options.runtimes ?? (() => []);
    this.defaultCoordinator = options.defaultCoordinator?.trim() || "fengagent";
    this.store = options.store ?? new AgentGroupStore(join(options.dataRoot, "groups.db"));
  }

  // ──────────────────────────────────────────────
  // 群
  // ──────────────────────────────────────────────

  /**
   * 建群。
   *
   * @param request - 群名 / 描述 / 成员 runtime 名 / 轮数上限
   * @throws {GroupError} 群名为空（bad_request）、成员未注册/未启用（bad_request）
   */
  createGroup(request: CreateGroupRequest): GroupInfoDto {
    const coordinator = request.coordinator?.trim() || this.defaultCoordinator;
    const memberNames = uniqueNames([...(request.members ?? []), coordinator]);
    this.assertKnownRuntimes(memberNames);

    const group = this.store.create({
      name: request.name,
      ...(request.description === undefined ? {} : { description: request.description }),
      members: memberNames.map((name) => ({
        kind: name === coordinator ? ("coordinator" as const) : ("runtime" as const),
        name,
        runtime: name,
      })),
      coordinator,
      ...(request.maxRounds === undefined ? {} : { maxRounds: request.maxRounds }),
      ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
    });
    // 契约：建群落一条 system 消息「群已创建」
    this.postSystemMessage(group.id, "群已创建");
    log.info("create", `群 ${group.id}（${group.name}）创建，成员 ${memberNames.join(" / ")}`);
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
   * 更新群（G1 主要用于改名/改描述/改成员；关群请用 `concludeGroup`）。
   *
   * @param id - 群 id
   * @param patch - 待更新字段
   */
  updateGroup(id: string, patch: UpdateGroupRequest): GroupInfoDto {
    const current = this.store.get(id);
    if (!current) throw new GroupError(`群不存在: ${id}`, "not_found");
    const memberNames =
      patch.members === undefined
        ? undefined
        : uniqueNames([...patch.members, current.coordinator].filter((n) => n !== ""));
    if (memberNames) this.assertKnownRuntimes(memberNames);
    const group = this.store.update(id, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(memberNames === undefined
        ? {}
        : {
            members: memberNames.map((name) => ({
              kind: name === current.coordinator ? ("coordinator" as const) : ("runtime" as const),
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

  /**
   * 关群（`POST /api/groups/:id/conclude`）：幂等，已 concluded 再调返回原样。
   *
   * @param id - 群 id
   */
  concludeGroup(id: string): GroupInfoDto {
    const current = this.store.get(id);
    if (!current) throw new GroupError(`群不存在: ${id}`, "not_found");
    if (current.status === "concluded") return this.toGroupDto(current);
    const group = this.store.update(id, { status: "concluded" });
    const dto = this.toGroupDto(group);
    this.emit(id, { type: "group", group: dto });
    return dto;
  }

  // ──────────────────────────────────────────────
  // 消息
  // ──────────────────────────────────────────────

  /** 全量消息（G1 详情接口按契约全量返回） */
  listMessages(id: string): GroupMessageDto[] {
    return this.store.allMessages(id).map(toMessageDto);
  }

  /** 增量读取（`after` / `limit`，SSE 重连同款语义） */
  listMessagesAfter(
    id: string,
    options: { after?: number; limit?: number } = {},
  ): GroupMessageDto[] {
    return this.store.messages(id, options).map(toMessageDto);
  }

  /** 最近 N 条消息（SSE 快照用；按 seq 升序） */
  listRecentMessages(id: string, limit = 50): GroupMessageDto[] {
    return this.store.recentMessages(id, limit).map(toMessageDto);
  }

  /**
   * 人发言（`fromKind=human`，`fromName=human`）。
   *
   * @param id - 群 id
   * @param request - 内容 + 种类
   */
  postHumanMessage(id: string, request: PostHumanMessageRequest): GroupMessageDto {
    return this.appendAndEmit(id, {
      content: request.content,
      fromKind: "human",
      fromName: "human",
      ...(request.kind === undefined ? {} : { kind: request.kind }),
    });
  }

  /**
   * runtime/协调者发言（`/agent-messages`）：`fromName` 必须是成员或协调者。
   *
   * @param id - 群 id
   * @param request - 内容 + 发言人 + 种类
   * @throws {GroupError} 群不存在（not_found）/ 非成员（forbidden）/ 已关群（conflict）
   */
  postAgentMessage(id: string, request: PostAgentMessageRequest): GroupMessageDto {
    const group = this.store.get(id);
    if (!group) throw new GroupError(`群不存在: ${id}`, "not_found");
    const fromName = request.fromName.trim();
    const allowed = new Set([
      ...group.members.map((member) => member.runtime ?? member.name),
      group.coordinator,
    ]);
    if (!allowed.has(fromName)) {
      throw new GroupError(`发言人不在群成员里: ${fromName}`, "forbidden");
    }
    const isCoordinator = fromName === group.coordinator;
    return this.appendAndEmit(id, {
      content: request.content,
      fromKind: isCoordinator ? "coordinator" : "runtime",
      fromName,
      ...(request.kind === undefined ? {} : { kind: request.kind }),
    });
  }

  /** 系统提示（建群、关群等），不占成员身份 */
  postSystemMessage(id: string, content: string): GroupMessageDto {
    return this.appendAndEmit(id, {
      content,
      fromKind: "system",
      fromName: "system",
      kind: "system",
    });
  }

  /**
   * 外部 runtime 的结果回群（G2 主路径，服务端代写，不暴露 REST）。
   *
   * @param id - 群 id
   * @param input - runtime 名 + 内容 + 任务深链
   */
  postRuntimeMessage(
    id: string,
    input: { runtime: string; content: string; agentTaskId?: string },
  ): GroupMessageDto {
    return this.appendAndEmit(id, {
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

  /** 写消息 + 广播（统一把存储错误翻成 GroupError） */
  private appendAndEmit(
    id: string,
    input: {
      content: string;
      fromKind: GroupMessageFromKind;
      fromName: string;
      kind?: GroupMessageKind;
      agentTaskId?: string;
    },
  ): GroupMessageDto {
    let message: GroupMessageRecord;
    try {
      message = this.store.appendMessage({ groupId: id, ...input });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (text.includes("群不存在")) throw new GroupError(text, "not_found");
      if (text.includes("已关闭")) throw new GroupError(text, "conflict");
      throw new GroupError(text, "bad_request");
    }
    const dto = toMessageDto(message);
    this.emit(id, { type: "message", message: dto });
    return dto;
  }

  /** 成员必须是已注册且启用的 runtime（没有注册表信息时跳过校验） */
  private assertKnownRuntimes(names: readonly string[]): void {
    const cards = this.runtimes();
    if (cards.length === 0) return;
    const enabled = new Set(cards.filter((card) => card.enabled).map((card) => card.name));
    const unknown = names.filter((name) => !enabled.has(name));
    if (unknown.length > 0) {
      throw new GroupError(`未注册或未启用的 runtime: ${unknown.join(", ")}`, "bad_request");
    }
  }

  private emit(id: string, event: GroupStreamEvent): void {
    for (const listener of this.subscribers.get(id) ?? []) {
      try {
        listener(event);
      } catch (err) {
        log.warn("sse", `订阅者回调失败: ${String(err)}`);
      }
    }
  }

  /** 记录 → 契约 DTO（成员收敛成 runtime 名 + 最后消息时间） */
  private toGroupDto(group: AgentGroupRecord): GroupInfoDto {
    const last = this.store.lastMessage(group.id);
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      members: group.members
        .filter((member) => member.kind === "runtime" || member.kind === "coordinator")
        .map((member) => member.runtime ?? member.name),
      status: group.status,
      maxRounds: group.maxRounds,
      createdAt: new Date(group.createdAt).toISOString(),
      updatedAt: new Date(group.updatedAt).toISOString(),
      ...(last === null ? {} : { lastMessageAt: new Date(last.createdAt).toISOString() }),
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

/** 去重保序 */
function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}
