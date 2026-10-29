/**
 * @fengagent/web-ui — 群聊的 mock 后端（G1）
 *
 * 后端（agent-group-store/service/routes）落地前的演示数据源：页面探测
 * /api/groups 失败时自动回退。契约与 client.ts 群方法一一对齐。
 * 演示语义：human 发言即时上屏，1.5s 后假 coordinator（fengagent）回一句
 * 应答（引用成员名轮转），建群/结束讨论本地生效。
 */

import type {
  GroupInfo,
  GroupMessage,
  GroupStreamEvent,
} from "./types.ts";

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

let nextSeq = 1;

function makeMessage(
  groupId: string,
  fromKind: GroupMessage["fromKind"],
  fromName: string,
  content: string,
  kind: GroupMessage["kind"] = "chat",
  createdAt = nowIso(),
): GroupMessage {
  return {
    id: `msg_mock_${nextSeq++}`,
    groupId,
    seq: nextSeq,
    fromKind,
    fromName,
    content,
    kind,
    createdAt,
  };
}

const REPLY_TEMPLATES = [
  "收到。我先梳理一下这个任务的边界，然后给 kimi 和 dsh 各拆一个子任务。",
  "两位成员的产出都回来了：kimi 给了方案 A 的可行性分析，dsh 验证了方案 B 的运行成本。我来综合一下……",
  "综合结论：采纳方案 A 为主、B 的成本约束作为边界条件。我出一个汇总帖收口。",
];

/** mock 群仓（页面实例持有，仅演示） */
export class GroupsMock {
  private groups = new Map<string, GroupInfo>();
  private messages = new Map<string, GroupMessage[]>();
  private runtimesFallback = ["fengagent", "kimi", "dsh"];
  private listeners = new Map<string, Set<(ev: GroupStreamEvent) => void>>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    this.seed(
      "项目周报群",
      "每周汇总：kimi 负责摘要、dsh 负责数据核对",
      ["fengagent", "kimi", "dsh"],
      3,
    );
    this.seed("排障专项群", "一起排查 WebUI 偶发空白问题", ["fengagent", "kimi"], 5, "concluded");
  }

  private seed(name: string, description: string, members: string[], maxRounds: number, status: GroupInfo["status"] = "open") {
    const id = `grp_mock_${this.groups.size + 1}`;
    const createdAt = nowIso(-3600_000 * (this.groups.size + 1));
    const group: GroupInfo = {
      id,
      name,
      description,
      members,
      status,
      maxRounds,
      idleTimeoutMs: 600_000,
      createdAt,
      updatedAt: createdAt,
      lastMessageAt: createdAt,
    };
    this.groups.set(id, group);
    const msgs = [makeMessage(id, "system", "system", `群「${name}」已创建，成员：${members.join("、")}`, "system", createdAt)];
    msgs.push(makeMessage(id, "coordinator", "fengagent", `大家好，我是本群协调者。任务丢进来即可，我会拆分并指派成员。`, "chat", nowIso(-3600_000 * this.groups.size + 60_000)));
    this.messages.set(id, msgs);
  }

  private emit(groupId: string, ev: GroupStreamEvent) {
    for (const listener of this.listeners.get(groupId) ?? []) {
      try {
        listener(ev);
      } catch {
        // 单个订阅者异常不影响其他订阅者
      }
    }
  }

  listGroups(): Promise<{ groups: GroupInfo[]; runtimes: { name: string; enabled: boolean; agentName: string }[] }> {
    return Promise.resolve({
      groups: [...this.groups.values()].map((g) => ({ ...g })),
      runtimes: this.runtimesFallback.map((name) => ({
        name,
        enabled: true,
        agentName: name === "fengagent" ? "fengagent-acp" : name === "kimi" ? "Kimi Code CLI" : "deepseek-harness-acp",
      })),
    });
  }

  createGroup(req: {
    name: string;
    description?: string;
    members: string[];
    maxRounds?: number;
    idleTimeoutMs?: number;
  }): Promise<GroupInfo> {
    const id = `grp_mock_${this.groups.size + 1}`;
    const createdAt = nowIso();
    const group: GroupInfo = {
      id,
      name: req.name,
      description: req.description,
      members: req.members,
      status: "open",
      maxRounds: req.maxRounds ?? 3,
      idleTimeoutMs: req.idleTimeoutMs ?? 600_000,
      createdAt,
      updatedAt: createdAt,
      lastMessageAt: createdAt,
    };
    this.groups.set(id, group);
    const msg = makeMessage(id, "system", "system", `群「${req.name}」已创建，成员：${req.members.join("、")}`, "system");
    this.messages.set(id, [msg]);
    this.emit(id, { type: "group", group: { ...group } });
    this.emit(id, { type: "message", message: { ...msg } });
    return Promise.resolve({ ...group });
  }

  getGroup(groupId: string): Promise<{ group: GroupInfo; messages: GroupMessage[] }> {
    const group = this.groups.get(groupId);
    if (!group) return Promise.reject(new Error(`group not found: ${groupId}`));
    return Promise.resolve({
      group: { ...group },
      messages: (this.messages.get(groupId) ?? []).map((m) => ({ ...m })),
    });
  }

  sendGroupMessage(
    groupId: string,
    req: { content: string; kind?: "chat" | "decision" },
  ): Promise<GroupMessage> {
    const group = this.groups.get(groupId);
    if (!group) return Promise.reject(new Error(`group not found: ${groupId}`));
    if (group.status === "concluded") {
      return Promise.reject(new Error("群已结束讨论（concluded）"));
    }
    const msg = makeMessage(groupId, "human", "human", req.content, req.kind ?? "chat");
    const list = this.messages.get(groupId) ?? [];
    list.push(msg);
    this.messages.set(groupId, list);
    group.lastMessageAt = msg.createdAt;
    group.updatedAt = msg.createdAt;
    this.emit(groupId, { type: "message", message: { ...msg } });

    // decision（拍板）：立即收口，不再回函
    if ((req.kind ?? "chat") === "decision") {
      group.status = "concluded";
      const sysMsg = makeMessage(groupId, "system", "system", "【收口】人类拍板", "system");
      list.push(sysMsg);
      this.emit(groupId, { type: "group", group: { ...group } });
      this.emit(groupId, { type: "message", message: { ...sysMsg } });
      return Promise.resolve({ ...msg });
    }

    // 假协调者回复（1.5s）
    const reply = makeMessage(
      groupId,
      "coordinator",
      "fengagent",
      REPLY_TEMPLATES[(list.length - 2) % REPLY_TEMPLATES.length] ?? REPLY_TEMPLATES[0]!,
    );
    const t = setTimeout(() => {
      list.push(reply);
      group.lastMessageAt = reply.createdAt;
      group.updatedAt = reply.createdAt;
      this.emit(groupId, { type: "message", message: { ...reply } });
    }, 1500);
    this.timers.push(t);
    return Promise.resolve({ ...msg });
  }

  concludeGroup(groupId: string): Promise<GroupInfo> {
    const group = this.groups.get(groupId);
    if (!group) return Promise.reject(new Error(`group not found: ${groupId}`));
    group.status = "concluded";
    group.updatedAt = nowIso();
    const msg = makeMessage(groupId, "system", "system", "【收口】讨论已结束（人工收口）", "system");
    (this.messages.get(groupId) ?? []).push(msg);
    this.emit(groupId, { type: "group", group: { ...group } });
    this.emit(groupId, { type: "message", message: { ...msg } });
    return Promise.resolve({ ...group });
  }

  /** 关停（G3 mock）：收口 + 取消「在途」任务（演示：返回假 id 列表） */
  stopGroup(groupId: string): Promise<{ group: GroupInfo; cancelledTasks: string[] }> {
    const group = this.groups.get(groupId);
    if (!group) return Promise.reject(new Error(`group not found: ${groupId}`));
    group.status = "concluded";
    group.updatedAt = nowIso();
    const cancelled = ["t_mock_stop1", "t_mock_stop2"].slice(0, (this.messages.get(groupId) ?? []).length > 3 ? 2 : 1);
    const msg = makeMessage(
      groupId,
      "system",
      "system",
      `【收口】人类中途关停（取消 ${cancelled.length} 个在途任务）`,
      "system",
    );
    (this.messages.get(groupId) ?? []).push(msg);
    this.emit(groupId, { type: "group", group: { ...group } });
    this.emit(groupId, { type: "message", message: { ...msg } });
    return Promise.resolve({ group: { ...group }, cancelledTasks: cancelled });
  }

  /** 订阅群流（快照 + 后续增量）；演示实现直接轮询内部状态变化 */
  async *streamGroup(groupId: string, after = 0): AsyncGenerator<GroupStreamEvent> {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`group not found: ${groupId}`);
    const list = this.messages.get(groupId) ?? [];
    yield {
      type: "snapshot",
      group: { ...group },
      messages: list.filter((m) => m.seq > after).map((m) => ({ ...m })),
      lastSeq: list[list.length - 1]?.seq ?? 0,
    };
    let lastCount = list.length;
    let lastStatus = group.status;
    while (true) {
      await new Promise((r) => setTimeout(r, 400));
      const current = this.messages.get(groupId) ?? [];
      const g = this.groups.get(groupId);
      if (!g) return;      for (const m of current.slice(lastCount)) {
        if (m.seq > after) yield { type: "message", message: { ...m } };
      }
      if (g.status !== lastStatus) {
        yield { type: "group", group: { ...g } };
        lastStatus = g.status;
        if (g.status === "concluded") return;
      }
      lastCount = current.length;
    }
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
