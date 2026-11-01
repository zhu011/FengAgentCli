/**
 * @fengagent/server — 群编排器（G3：收敛 + 人在环）
 *
 * v1「协调者中转」里，真正拆任务/综合结论的是协调者（会话里的 fengagent LLM）；
 * 服务端这一层负责**止损与收口**，三条互相独立的策略，都可按群参数化：
 *
 * | 策略 | 触发 | 结果 |
 * |---|---|---|
 * | **轮次上限** `maxRounds` | 同一群内、自上次人类发言之后的协调者发言数达到上限 | 自动收口（system 消息说明原因） |
 * | **静默超时** `idleTimeoutMs` | 群 open 且最后一条消息距今超过阈值 | 自动收口 |
 * | **人类拍板** | human 发 `kind="decision"` 的消息 | 该消息落库后立即收口 |
 *
 * 收口（conclude）本身是**幂等**的：写一条 system 收口说明 → 群状态置 `concluded` →
 * （可选）取消该群所有未终态任务 —— 对应验收口径「关群后无残留任务」。
 *
 * 说明：轮次计数与最后活跃时间放在内存里；进程重启后从最后一条消息重建活跃时间，
 * 轮次从 0 重新计（收敛策略是止损闸，不是账本，重启后最坏是多给一轮）。
 */

import { AgentGroupService } from "./agent-group-service.ts";
import type { GroupInfoDto, GroupMessageDto } from "./agent-group-service.ts";
import { createLogger } from "@fengagent/shared";

const log = createLogger("group-orchestrator");

/** 收口来源 */
export type ConcludeBy = "coordinator" | "human" | "system";

/** 编排器选项 */
export interface GroupOrchestratorOptions {
  /** 群服务（唯一的数据面） */
  groups: AgentGroupService;
  /**
   * 取消某群所有未终态任务（G3「关群后无残留任务」）。
   *
   * 由 server 装配注入（`AgentTaskService`），返回被取消的任务 id。
   */
  cancelGroupTasks?: (groupId: string) => string[];
  /** 时钟（测试注入） */
  now?: () => number;
  /**
   * 静默扫描间隔（毫秒）。默认 5000；`0` = 不自动起定时器（测试手动 `sweepIdle`）。
   */
  sweepIntervalMs?: number;
}

/** 收口结果 */
export interface ConcludeResult {
  group: GroupInfoDto;
  /** 被取消的任务 id（无任务时为空数组） */
  cancelledTasks: string[];
  /** 本次是否真的收口了（false = 之前已 concluded，幂等） */
  concluded: boolean;
}

/** 轮次/活跃时间（内存态） */
interface GroupRuntimeState {
  /** 自上次人类发言以来的协调者发言数 */
  coordinatorTurns: number;
  /** 最后一条消息时间 */
  lastActivityAt: number;
}

/**
 * 群编排器。
 *
 * 用法（server 装配）：
 * ```ts
 * const orchestrator = new GroupOrchestrator({ groups, cancelGroupTasks });
 * groups.onMessage((groupId, message) => orchestrator.onMessage(groupId, message));
 * orchestrator.start();   // 静默扫描
 * ```
 */
export class GroupOrchestrator {
  private readonly groups: AgentGroupService;
  private readonly cancelGroupTasks: ((groupId: string) => string[]) | undefined;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private readonly states = new Map<string, GroupRuntimeState>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: GroupOrchestratorOptions) {
    this.groups = options.groups;
    this.cancelGroupTasks = options.cancelGroupTasks;
    this.now = options.now ?? Date.now;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 5000;
  }

  /** 起静默扫描（幂等；`sweepIntervalMs <= 0` 时不起） */
  start(): void {
    if (this.timer !== undefined || this.sweepIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      try {
        this.sweepIdle();
      } catch (err) {
        log.warn("sweep", `静默扫描失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, this.sweepIntervalMs);
    // 不阻止进程退出
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** 停扫描（进程关闭/测试用；群「关停」是 `stop(groupId)`） */
  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 观察一条新消息：刷新活跃时间、计轮次、识别人类拍板 / 轮次超限。
   *
   * @param groupId - 群 id
   * @param message - 刚落库的消息
   */
  onMessage(groupId: string, message: GroupMessageDto): void {
    const group = this.groups.getGroup(groupId);
    if (!group || group.status !== "open") return;
    const at = Date.parse(message.createdAt);
    const state = this.state(groupId, Number.isFinite(at) ? at : this.now());

    if (message.fromKind === "human") {
      state.coordinatorTurns = 0;
      state.lastActivityAt = Number.isFinite(at) ? at : this.now();
      if (message.kind === "decision") {
        this.conclude(groupId, {
          by: "human",
          reason: "人类拍板，讨论收口",
          conclusion: message.content,
        });
      }
      return;
    }

    state.lastActivityAt = Number.isFinite(at) ? at : this.now();
    if (message.fromKind === "coordinator") {
      state.coordinatorTurns += 1;
      if (group.maxRounds > 0 && state.coordinatorTurns >= group.maxRounds) {
        this.conclude(groupId, {
          by: "system",
          reason: `达到轮次上限（maxRounds=${group.maxRounds}），自动收口`,
        });
      }
    }
  }

  /**
   * 静默超时扫描：把「open 且静默超过 idleTimeoutMs」的群收口。
   *
   * @param now - 判定时刻（默认 `now()`；测试注入）
   * @returns 本次被收口的群 id
   */
  sweepIdle(now?: number): string[] {
    const at = now ?? this.now();
    const concluded: string[] = [];
    for (const group of this.groups.listGroups({ status: "open" })) {
      // 活跃时间：优先内存态，其次库里的最后一条消息，都没有就用群的 updatedAt
      const state = this.states.get(group.id);
      const record = this.groups.store.get(group.id);
      if (!record) continue;
      const last =
        state?.lastActivityAt ??
        (group.lastMessageAt === undefined
          ? Date.parse(group.updatedAt)
          : Date.parse(group.lastMessageAt));
      if (!Number.isFinite(last)) continue;
      if (at - last >= record.idleTimeoutMs) {
        this.conclude(group.id, {
          by: "system",
          reason: `静默超时（idleTimeoutMs=${record.idleTimeoutMs}），自动收口`,
        });
        concluded.push(group.id);
      }
    }
    return concluded;
  }

  /**
   * 收口（幂等）：写收口说明 → 置 concluded → 取消群内未终态任务。
   *
   * 顺序很关键：消息只能在 `open` 群写入，所以 system 说明必须在改状态**之前**落库。
   *
   * @param groupId - 群 id
   * @param opts - 来源 / 原因 / 协调者的结论正文（有正文时先落一条 `decision`）
   */
  conclude(
    groupId: string,
    opts: { by?: ConcludeBy; reason?: string; conclusion?: string } = {},
  ): ConcludeResult {
    const group = this.groups.getGroup(groupId);
    if (!group) throw new Error(`群不存在: ${groupId}`);
    if (group.status === "concluded") {
      return { group, cancelledTasks: [], concluded: false };
    }
    const by = opts.by ?? "system";

    // 协调者的结论正文先以 decision 消息落库（人类拍板的正文已经由 human 那条消息承载）
    const conclusion = opts.conclusion?.trim() ?? "";
    if (by === "coordinator" && conclusion !== "") {
      const record = this.groups.store.get(groupId);
      this.groups.postAgentMessage(groupId, {
        content: conclusion,
        fromName: record?.coordinator || "fengagent",
        kind: "decision",
      });
    }
    const reason = opts.reason ?? "讨论已收口";
    this.groups.postSystemMessage(groupId, `【收口】${reason}`);

    // 关群前先把在跑任务收掉（「关群后无残留任务」），并把数量留在群里
    let cancelledTasks: string[] = [];
    if (this.cancelGroupTasks) {
      try {
        cancelledTasks = this.cancelGroupTasks(groupId);
      } catch (err) {
        log.warn(
          "conclude",
          `取消群任务失败（group=${groupId}）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (cancelledTasks.length > 0) {
      this.groups.postSystemMessage(groupId, `已取消 ${cancelledTasks.length} 个在跑任务`);
    }

    const closed = this.groups.concludeGroup(groupId);
    this.states.delete(groupId);
    log.info(
      "conclude",
      `群 ${groupId} 收口（by=${by}）：取消任务 ${cancelledTasks.length} 个`,
    );
    return { group: closed, cancelledTasks, concluded: true };
  }

  /**
   * 中途关停（人类操作）：收口 + 取消群内未终态任务。
   *
   * @param groupId - 群 id
   */
  stop(groupId: string): ConcludeResult {
    return this.conclude(groupId, { by: "human", reason: "人类中途关停" });
  }

  /** 取（或初始化）内存态 */
  private state(groupId: string, at: number): GroupRuntimeState {
    const existing = this.states.get(groupId);
    if (existing) return existing;
    const group = this.groups.getGroup(groupId);
    const seeded =
      group?.lastMessageAt === undefined ? at : Date.parse(group.lastMessageAt);
    const state: GroupRuntimeState = {
      coordinatorTurns: 0,
      lastActivityAt: Number.isFinite(seeded) ? seeded : at,
    };
    this.states.set(groupId, state);
    return state;
  }
}
