/**
 * @fengagent/groups — 群编排器（G3 收敛 + 人在环；V2-3 自治发言）
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
 * ## V2-3：`speechMode`（群级字段）
 *
 * - **`coordinated`（缺省，v1 原样）**：只有协调者调度回合；成员直连发言仍可用，
 *   但**不**计轮次、不占预算、不参与仲裁（用于任务中途求助，不改变轮次模型）。
 * - **`free`（自治）**：成员之间直接发言/求助，收敛四闸：
 *   1. **轮数升级**：`maxRounds` 是**总轮数**，一轮 = 一名成员的一组连续发言
 *      （同一人连发不增轮，换人才 +1）；人类发言清零重计；
 *   2. **发言预算**：每成员每窗口最多 N 条（默认 5 条 / 60s，按成员分别计窗），
 *      超预算的发言在**落库前**被拒（`GroupError{code:"conflict"}` → HTTP 409）；
 *   3. **发言权仲裁**：消息里 `@某人`（或 `group_reply` 指向某人）→ 下一发言权归他
 *      （reply 抢占）；持权期间其他成员插话被拒；协调者/人可随时发言（主持人改派）。
 *      `arbitration:"advisory"` 时只记录不拦截，供宿主自行调度；
 *   4. `idleTimeout` / 人类拍板不变（拍板即收口）。
 *
 * `getStatus()` 把上述状态（模式 / 轮数 / 发言权归属 / 各成员预算余量）一次性暴露，
 * 前端状态条与宿主调度直接消费；`onTurn` 在发言权转移时回调，宿主可据此派发任务。
 *
 * 说明：轮次计数、发言权与预算窗口放在内存里；进程重启后从最后一条消息重建活跃时间，
 * 轮次/预算从 0 重新计（收敛策略是止损闸，不是账本，重启后最坏是多给一轮）。
 */

import type { AgentGroupStatus, GroupSpeechMode } from "@fengagent/agent";
import { AgentGroupService } from "./agent-group-service.ts";
import type {
  GroupInfoDto,
  GroupMessageAdmissionContext,
  GroupMessageAdmissionResult,
  GroupMessageDto,
} from "./agent-group-service.ts";
import { createLogger } from "@fengagent/shared";

const log = createLogger("group-orchestrator");

/** 收口来源 */
export type ConcludeBy = "coordinator" | "human" | "system";

/** 发言预算缺省值：每成员每窗口 5 条 */
export const DEFAULT_SPEECH_BUDGET_LIMIT = 5;
/** 发言预算窗口缺省值：60 秒 */
export const DEFAULT_SPEECH_BUDGET_WINDOW_MS = 60_000;

/** 发言预算参数（free 模式） */
export interface GroupSpeechBudgetOptions {
  /** 每成员在窗口内最多发言条数（默认 5） */
  limit?: number;
  /** 预算窗口（毫秒，默认 60000） */
  windowMs?: number;
}

/** 发言权仲裁强度（free 模式） */
export type GroupArbitrationMode = "enforce" | "advisory";

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
  /** 发言预算（free 模式；默认 5 条 / 60s） */
  speechBudget?: GroupSpeechBudgetOptions;
  /**
   * 发言权仲裁强度（free 模式；默认 `enforce`）：
   * - `enforce`：持权期间其他成员插话 → 落库前拒绝（409）；
   * - `advisory`：只记录 `nextSpeaker`，不拦截。
   */
  arbitration?: GroupArbitrationMode;
  /**
   * 发言权转移回调（free 模式）：被 @ 的成员获得下一发言权时触发，
   * 宿主可据此派发任务/唤醒成员（缺省不派发）。
   */
  onTurn?: (groupId: string, speaker: string) => void;
}

/** 收口结果 */
export interface ConcludeResult {
  group: GroupInfoDto;
  /** 被取消的任务 id（无任务时为空数组） */
  cancelledTasks: string[];
  /** 本次是否真的收口了（false = 之前已 concluded，幂等） */
  concluded: boolean;
}

/** 发言预算快照 */
export interface GroupSpeechBudgetStatus {
  /** 每成员每窗口上限 */
  limit: number;
  /** 窗口长度（毫秒） */
  windowMs: number;
  /** 各成员当前窗口内已用条数 */
  used: Record<string, number>;
  /** 各成员当前窗口内剩余条数 */
  remaining: Record<string, number>;
}

/** 编排状态快照（前端状态条 / 宿主调度消费） */
export interface GroupOrchestrationStatus {
  groupId: string;
  speechMode: GroupSpeechMode;
  status: AgentGroupStatus;
  /** 轮次上限（free：总轮数；coordinated：协调者轮数） */
  maxRounds: number;
  /** free：已用轮数（发言人切换计数） */
  rounds: number;
  /** coordinated：自上次人类发言以来的协调者发言数 */
  coordinatorTurns: number;
  /** 最近一位发言人 */
  lastSpeaker?: string;
  /** 当前发言权归属（被 @ 的成员；空 = 无指向，任何人都可说） */
  nextSpeaker?: string;
  /** 发言预算（free 模式才消耗；coordinated 下恒为满额） */
  budget: GroupSpeechBudgetStatus;
  /** 静默超时（毫秒） */
  idleTimeoutMs: number;
}

/** 轮次/活跃时间/发言权/预算（内存态） */
interface GroupRuntimeState {
  /** 自上次人类发言以来的协调者发言数（v1） */
  coordinatorTurns: number;
  /** 最后一条消息时间 */
  lastActivityAt: number;
  /** free：已用轮数（发言人切换计数） */
  rounds: number;
  /** free：上一位发言人（连发不增轮） */
  lastSpeaker?: string;
  /** free：当前发言权归属 */
  nextSpeaker?: string;
  /** free：每成员窗口内的发言时间戳 */
  budget: Map<string, number[]>;
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
 *
 * 构造时自动向 `groups.onBeforeMessage` 注册发言准入（V2-3：预算 / 仲裁），
 * 因此在 free 模式下超预算/抢发言权的消息**不会落库**。
 */
export class GroupOrchestrator {
  private readonly groups: AgentGroupService;
  private readonly cancelGroupTasks: ((groupId: string) => string[]) | undefined;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private readonly budget: Required<GroupSpeechBudgetOptions>;
  private readonly arbitration: GroupArbitrationMode;
  private readonly onTurn: ((groupId: string, speaker: string) => void) | undefined;
  private readonly states = new Map<string, GroupRuntimeState>();
  private readonly disposeAdmission: () => void;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: GroupOrchestratorOptions) {
    this.groups = options.groups;
    this.cancelGroupTasks = options.cancelGroupTasks;
    this.now = options.now ?? Date.now;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 5000;
    this.budget = {
      limit: positiveInt(options.speechBudget?.limit, DEFAULT_SPEECH_BUDGET_LIMIT),
      windowMs: positiveInt(options.speechBudget?.windowMs, DEFAULT_SPEECH_BUDGET_WINDOW_MS),
    };
    this.arbitration = options.arbitration ?? "enforce";
    this.onTurn = options.onTurn;
    // V2-3：预算 / 仲裁在**落库前**拦（onMessage 是落库后观察，管不住刷屏）
    this.disposeAdmission = this.groups.onBeforeMessage((context) => this.admit(context));
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

  /** 停扫描 + 摘掉准入钩子（进程关闭/测试用；群「关停」是 `stop(groupId)`） */
  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.disposeAdmission();
  }

  /**
   * 观察一条新消息：刷新活跃时间、计轮次、识别人类拍板 / 轮次超限 / 发言权转移。
   *
   * coordinated（缺省）走 v1 语义；free 走 V2-3 自治语义。
   *
   * @param groupId - 群 id
   * @param message - 刚落库的消息
   */
  onMessage(groupId: string, message: GroupMessageDto): void {
    const group = this.groups.getGroup(groupId);
    if (!group || group.status !== "open") return;
    const at = Date.parse(message.createdAt);
    const when = Number.isFinite(at) ? at : this.now();
    const state = this.state(groupId, when);

    if (message.fromKind === "human") {
      state.coordinatorTurns = 0;
      state.rounds = 0;
      state.lastSpeaker = undefined;
      state.nextSpeaker = undefined;
      state.budget.clear();
      state.lastActivityAt = when;
      if (message.kind === "decision") {
        this.conclude(groupId, {
          by: "human",
          reason: "人类拍板，讨论收口",
          conclusion: message.content,
        });
      }
      return;
    }

    if (message.fromKind === "system") return;

    state.lastActivityAt = when;
    if (group.speechMode === "free") {
      // 服务端代写的任务结果（G2 `task_card` / 带 agentTaskId）不是成员发言：
      // 不占轮、不占预算、不改发言权
      if (message.kind === "task_card" || message.agentTaskId !== undefined) return;
      this.onFreeMessage(group, state, message, when);
      return;
    }

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
   * 编排状态快照（V2-3）：模式 / 轮数 / 发言权归属 / 各成员预算余量。
   *
   * 已收口的群运行时态已清空（轮数/发言权归零），收口原因看末尾的 system 消息。
   *
   * @param groupId - 群 id
   * @returns 群不存在时 `null`
   */
  getStatus(groupId: string): GroupOrchestrationStatus | null {
    const group = this.groups.getGroup(groupId);
    if (!group) return null;
    const record = this.groups.store.get(groupId);
    const state = this.states.get(groupId);
    const at = this.now();
    const coordinator = record?.coordinator ?? "";
    const used: Record<string, number> = {};
    const remaining: Record<string, number> = {};
    for (const name of group.members) {
      if (name === coordinator) continue;
      const count = state === undefined ? 0 : countInWindow(state.budget.get(name), at, this.budget.windowMs);
      used[name] = count;
      remaining[name] = Math.max(0, this.budget.limit - count);
    }
    return {
      groupId,
      speechMode: group.speechMode,
      status: group.status,
      maxRounds: group.maxRounds,
      rounds: state?.rounds ?? 0,
      coordinatorTurns: state?.coordinatorTurns ?? 0,
      ...(state?.lastSpeaker === undefined ? {} : { lastSpeaker: state.lastSpeaker }),
      ...(state?.nextSpeaker === undefined ? {} : { nextSpeaker: state.nextSpeaker }),
      budget: { limit: this.budget.limit, windowMs: this.budget.windowMs, used, remaining },
      idleTimeoutMs: record?.idleTimeoutMs ?? group.idleTimeoutMs,
    };
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

  // ──────────────────────────────────────────────
  // V2-3：free 模式
  // ──────────────────────────────────────────────

  /**
   * free 模式的一轮发言：计轮（换人才 +1）→ 记预算 → 仲裁发言权 → 判轮数上限。
   *
   * @param group - 群快照（open）
   * @param state - 群运行时状态
   * @param message - 刚落库的消息
   * @param at - 消息时间
   */
  private onFreeMessage(
    group: GroupInfoDto,
    state: GroupRuntimeState,
    message: GroupMessageDto,
    at: number,
  ): void {
    const speaker = message.fromName;

    // 一轮 = 一名成员的一组连续发言：同一人连发不增轮
    if (state.lastSpeaker !== speaker) {
      state.rounds += 1;
      state.lastSpeaker = speaker;
    }

    // 预算记账（准入已在落库前判过，这里只记时间戳）
    const stamps = state.budget.get(speaker) ?? [];
    stamps.push(at);
    state.budget.set(speaker, stamps);

    // 发言权仲裁：@ 谁，下一发言权归谁；没指向就清空（协调者/人可随时改派）
    const addressed = this.mentionedMember(group, message.content, speaker);
    state.nextSpeaker = addressed;
    if (addressed !== undefined && this.onTurn) {
      try {
        this.onTurn(group.id, addressed);
      } catch (err) {
        log.warn(
          "onTurn",
          `发言权回调失败（group=${group.id}, speaker=${addressed}）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (group.maxRounds > 0 && state.rounds >= group.maxRounds) {
      this.conclude(group.id, {
        by: "system",
        reason:
          `达到轮次上限（free 模式共 ${group.maxRounds} 轮，一轮 = 一名成员的一组连续发言），` +
          "自动收口",
      });
    }
  }

  /**
   * 落库前准入（free 模式）：发言权仲裁 + 每成员发言预算。
   *
   * 只对**直接发言**（`source="agent"`）生效：coordinated 模式、人、系统提示、
   * 服务端代写的任务结果、协调者（主持人）一律放行 —— v1 零回归，任务结果不会丢。
   *
   * @param context - 待写入的消息
   * @returns 放行 / 带错误码的拒绝
   */
  private admit(context: GroupMessageAdmissionContext): GroupMessageAdmissionResult {
    if (context.source !== "agent") return { allowed: true };
    const group = this.groups.getGroup(context.groupId);
    // 群不存在 / 已关群 / coordinated：交给存储层按原语义报错
    if (!group || group.status !== "open" || group.speechMode !== "free") {
      return { allowed: true };
    }
    const coordinator = this.groups.store.get(context.groupId)?.coordinator ?? "";
    if (coordinator !== "" && context.fromName === coordinator) {
      return { allowed: true };
    }

    if (this.arbitration === "enforce") {
      const floor = this.states.get(context.groupId)?.nextSpeaker;
      if (floor !== undefined && floor !== context.fromName) {
        return {
          allowed: false,
          code: "conflict",
          reason: `发言权在 ${floor}（被上一条消息 @ 指定），等其回应或由协调者改派`,
        };
      }
    }

    const at = this.now();
    const state = this.states.get(context.groupId);
    const used = state === undefined ? 0 : countInWindow(state.budget.get(context.fromName), at, this.budget.windowMs);
    if (used >= this.budget.limit) {
      return {
        allowed: false,
        code: "conflict",
        reason:
          `发言预算已用尽（${Math.round(this.budget.windowMs / 1000)}s 内最多 ${this.budget.limit} 条），` +
          "等窗口刷新或由协调者收口",
      };
    }
    return { allowed: true };
  }

  /**
   * 从消息正文里找第一个被 @ 的**其他**成员。
   *
   * 匹配 `@名字`，且名字后面必须是边界（非字母数字 / `-` / `_`），避免
   * `@claude` 误命中成员 `claude-2`；多个命中取正文里最靠前的。
   *
   * @param group - 群快照（成员名单）
   * @param content - 消息正文
   * @param self - 发言人（@ 自己不算改派）
   */
  private mentionedMember(
    group: GroupInfoDto,
    content: string,
    self: string,
  ): string | undefined {
    let best: { index: number; name: string } | undefined;
    for (const name of group.members) {
      if (name === "" || name === self) continue;
      const needle = `@${name}`;
      let from = 0;
      for (;;) {
        const index = content.indexOf(needle, from);
        if (index === -1) break;
        if (isMentionBoundary(content, index + needle.length)) {
          if (best === undefined || index < best.index) best = { index, name };
          break;
        }
        from = index + 1;
      }
    }
    return best?.name;
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
      rounds: 0,
      budget: new Map(),
    };
    this.states.set(groupId, state);
    return state;
  }
}

/** 窗口内计数（不改变状态；时间戳在记账时清理） */
function countInWindow(stamps: readonly number[] | undefined, at: number, windowMs: number): number {
  if (stamps === undefined || stamps.length === 0) return 0;
  let count = 0;
  for (const stamp of stamps) {
    if (at - stamp < windowMs) count += 1;
  }
  return count;
}

/** `@名字` 后是否边界（末尾 / 非标识符字符） */
function isMentionBoundary(content: string, end: number): boolean {
  if (end >= content.length) return true;
  const next = content[end] ?? "";
  return !/[A-Za-z0-9_-]/.test(next);
}

/** 正整数兜底（非法值回退默认） */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
