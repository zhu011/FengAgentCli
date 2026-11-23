/**
 * @fengagent/server — 小队编排服务（P2 第一阶段：小队与队长）
 *
 * 把四块拼起来：
 *
 * ```
 *  SquadStore（小队/成员/任务/运行树） ─┐
 *  AgentRegistry（成员是不是真智能体） ─┼─▶ SquadService ─▶ /api/squads、/api/approvals
 *  AgentTaskService（真派发，非阻塞）  ─┤                     ▲
 *  ApprovalStore（负责人确认 + 审计）   ─┘                     └─ 队长的 dispatch_task / resolve_approval
 * ```
 *
 * 三条硬约束（P2 第一条验收）：
 *
 * 1. **队长只能协调**：`mode=leader` 派单只建一条 leader 任务，真正派给成员的动作由
 *    队长的 `dispatch_task` 触发（`dispatchToMember`）；
 * 2. **派活非阻塞**：`dispatchTask` / `dispatchToMember` 都只 `submit`（建任务即返回
 *    task id），队长的 turn 不会被成员的执行时长卡住；成员终态时**再派一轮队长任务**
 *    把「成员回报」交回去（本地没有评论流，用会话注入的等价形态）；
 * 3. **负责人日常确认**：成员的敏感工具调用在权限闸门处查授权（once / session /
 *    permanent），查不到就落一条 `approval_request` 并由队长裁决；队长拿不准就
 *    `escalate_approval` 上抛人类发起人；每笔请求/裁决/上抛/消费都写 `approval_audit`。
 *
 * `mode=auto`（现有 `SquadCoordinator` 算法分配）属 P2 第二阶段，本阶段显式返回
 * `mode_not_supported`，不假装支持。
 */

import {
  ApprovalStore,
  buildSquadBriefing,
  composeSquadLeaderPrompt,
  composeSquadWakePrompt,
  isTerminalTaskStatus as isTerminalAgentTaskStatus,
  type AgentRegistry,
  type ApprovalAuditEntry,
  type ApprovalRequest,
  type ApprovalScope,
  type SquadDetail,
  type SquadMember,
  type SquadRosterEntry,
  type SquadRunRecord,
  type SquadStore,
  type SquadTaskRecord,
  SquadStoreError as SquadError,
} from "@fengagent/agent";
import type { SquadTaskPriority } from "@fengagent/core/squad";
import { createLogger } from "@fengagent/shared";
import type { AgentTaskDto, AgentTaskService } from "./agent-task-service.ts";
import type { SquadAutoCoordinator, SquadAutoDispatchResult, SquadAutoStatusDto } from "./squad-auto.ts";

const log = createLogger("squads");

/** 小队服务错误码（比仓多出「编排层」几种） */
export type SquadServiceErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "cannot_remove_squad_leader"
  | "leader_not_member"
  | "squad_archived"
  | "agent_not_found"
  | "mode_not_supported";

/** 小队服务错误 */
export class SquadServiceError extends Error {
  readonly code: SquadServiceErrorCode;

  constructor(code: SquadServiceErrorCode, message: string) {
    super(message);
    this.name = "SquadServiceError";
    this.code = code;
  }
}

/** 与 WebUI `SquadMember` 契约一致 */
export interface SquadMemberDto {
  memberType: "agent" | "member";
  memberId: string;
  role: string;
}

/** 与 WebUI `SquadInfo` 契约一致 */
export interface SquadInfoDto {
  id: string;
  name: string;
  description: string;
  leaderId: string;
  mode: "leader" | "auto";
  instructions: string;
  members: SquadMemberDto[];
  archived: boolean;
}

/** 与 WebUI `SquadRunNode` 契约一致 */
export interface SquadRunNodeDto {
  id: string;
  assignee: string;
  status: string;
  title: string;
  parentRunId: string | null;
  startedAt: string;
  /** 等待原因（status = waiting_approval 时有值，UI 徽标旁的说明） */
  blockedReason: string | null;
  /** 该 run 对应的执行任务（深链到 /api/agent-tasks/:id） */
  agentTaskId: string | null;
}

/** 派单结果（前端只需要 taskId） */
export interface SquadDispatchResult {
  taskId: string;
  runId: string;
  agentTaskId: string;
  /** leader = 队长软编排；auto = 协调器算法分配 */
  mode: "leader" | "auto";
  /** 本次被分配的成员（auto「排队中」时为 null） */
  assigneeId: string | null;
  /** 派单后的小队任务状态（auto 可能停在 pending 排队） */
  status: string;
}

/** 服务选项 */
export interface SquadServiceOptions {
  store: SquadStore;
  agentRegistry: AgentRegistry;
  tasks: AgentTaskService;
  approvals?: ApprovalStore;
  /** 成员启用中的技能名（P1 `agent_skill`；briefing roster 用） */
  skillsFor?: (agentId: string) => string[];
  /** 智能体基础 prompt（instructions + 已挂载技能，不含「本次任务」） */
  basePromptFor?: (agentId: string) => string;
  /** 人类发起人（上抛目标） */
  humanOwner?: string;
  /** 等成员终态的上限（只是后台观察，不影响派单返回） */
  waitTimeoutMs?: number;
  /** 队长最多被唤醒的轮次（防「派活→回报→再派活」自激循环） */
  maxLeaderWakes?: number;
  /**
   * auto 模式接线层（P2 第二阶段）。不传时 `mode=auto` 返回
   * `mode_not_supported`（保持老装配可用的降级行为）。
   */
  auto?: SquadAutoCoordinator;
}

/** 成员派单入参 */
export interface DispatchToMemberInput {
  squadId: string;
  leaderTaskId: string;
  memberId: string;
  content: string;
}

/** 权限闸门查询结果 */
export interface ToolPermissionDecision {
  allowed: boolean;
  /** 未放行时落下的审批请求 */
  approval?: ApprovalRequest;
}

/** 小队编排服务 */
export class SquadService {
  private readonly store: SquadStore;
  private readonly agentRegistry: AgentRegistry;
  private readonly tasks: AgentTaskService;
  private readonly approvals: ApprovalStore | null;
  private readonly skillsFor: (agentId: string) => string[];
  private readonly basePromptFor: ((agentId: string) => string) | null;
  private readonly humanOwner: string | undefined;
  private readonly waitTimeoutMs: number;
  private readonly maxLeaderWakes: number;
  private readonly auto: SquadAutoCoordinator | null;
  /** 队长任务 → 已唤醒次数 / 上次唤醒的成员终态签名（进程内，防自激） */
  private readonly wakeState = new Map<string, { count: number; signature: string }>();
  /** 已因审批唤醒过的请求 id（避免同一请求反复唤醒队长） */
  private readonly approvalWakes = new Set<string>();

  constructor(options: SquadServiceOptions) {
    this.store = options.store;
    this.agentRegistry = options.agentRegistry;
    this.tasks = options.tasks;
    this.approvals = options.approvals ?? null;
    this.skillsFor = options.skillsFor ?? (() => []);
    this.basePromptFor = options.basePromptFor ?? null;
    this.humanOwner = options.humanOwner;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30 * 60_000;
    this.maxLeaderWakes = options.maxLeaderWakes ?? 5;
    this.auto = options.auto ?? null;
  }

  // ──────────────────────────────────────────────
  // 小队实体
  // ──────────────────────────────────────────────

  /** 小队列表 */
  listSquads(options: { includeArchived?: boolean } = {}): SquadInfoDto[] {
    return this.store.listSquads(options).map(toSquadDto);
  }

  /** 小队详情 */
  getSquad(id: string): SquadInfoDto {
    return toSquadDto(this.requireSquad(id));
  }

  /** 建队（成员必须是已存在的智能体；队长自动入成员） */
  createSquad(input: {
    id?: string;
    name?: string;
    description?: string;
    leaderId?: string;
    mode?: "leader" | "auto";
    instructions?: string;
    members?: SquadMember[];
  }): SquadInfoDto {
    const leaderId = input.leaderId?.trim() ?? "";
    if (leaderId === "") throw new SquadServiceError("bad_request", "leaderId 不能为空");
    this.requireAgent(leaderId);
    const members = (input.members ?? []).map((member) => {
      this.assertMemberType(member.memberType);
      if (member.memberType === "agent") this.requireAgent(member.memberId);
      return { memberType: member.memberType, memberId: member.memberId, role: member.role };
    });
    return toSquadDto(
      this.mapStore(() =>
        this.store.createSquad({
          ...(input.id === undefined ? {} : { id: input.id }),
          name: input.name ?? "",
          ...(input.description === undefined ? {} : { description: input.description }),
          leaderId,
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          members,
        }),
      ),
    );
  }

  /** 改队 */
  updateSquad(
    id: string,
    patch: { name?: string; description?: string; instructions?: string; mode?: "leader" | "auto" },
  ): SquadInfoDto {
    return toSquadDto(this.mapStore(() => this.store.updateSquad(id, patch)));
  }

  /** 归档 */
  archiveSquad(id: string): SquadInfoDto {
    return toSquadDto(this.mapStore(() => this.store.archiveSquad(id)));
  }

  /** 加成员（agent 必须真存在） */
  addMember(squadId: string, member: SquadMember): SquadInfoDto {
    this.assertMemberType(member.memberType);
    if (member.memberType === "agent") this.requireAgent(member.memberId);
    return toSquadDto(this.mapStore(() => this.store.addMember(squadId, member)));
  }

  /** 移除成员（现任队长 → cannot_remove_squad_leader） */
  removeMember(squadId: string, memberType: "agent" | "member", memberId: string): SquadInfoDto {
    this.assertMemberType(memberType);
    return toSquadDto(this.mapStore(() => this.store.removeMember(squadId, memberType, memberId)));
  }

  /** 换队长（必须是 agent 成员） */
  setLeader(squadId: string, leaderId: string): SquadInfoDto {
    this.requireAgent(leaderId);
    return toSquadDto(this.mapStore(() => this.store.setLeader(squadId, leaderId)));
  }

  // ──────────────────────────────────────────────
  // 派单（leader 模式，全程非阻塞）
  // ──────────────────────────────────────────────

  /**
   * 派一次小队任务。
   *
   * - `mode=leader`：建 leader 任务 + run，然后把「briefing + 任务」交给队长（建完即返回）；
   * - `mode=auto`：交给 `SquadCoordinator` 按优先级/失败冷却算法分配，**不需要队长在场**；
   *   没有空闲成员时任务停在 `pending`（排队），返回空 runId/agentTaskId。
   *
   * @returns 建完即返回（不等待队长/成员执行）
   */
  async dispatchTask(
    squadId: string,
    request: { content: string; mode?: "leader" | "auto"; priority?: SquadTaskPriority },
  ): Promise<SquadDispatchResult> {
    const squad = this.requireSquad(squadId);
    if (squad.archivedAt !== undefined) {
      throw new SquadServiceError("squad_archived", `小队「${squadId}」已归档，不能派单`);
    }
    const content = request.content?.trim() ?? "";
    if (content === "") throw new SquadServiceError("bad_request", "content 不能为空");
    const mode = request.mode ?? squad.mode;
    if (mode === "auto") return this.dispatchAuto(squadId, content, request.priority);
    const leaderTask = this.mapStore(() =>
      this.store.createTask({
        squadId,
        isLeader: true,
        assigneeId: squad.leaderId,
        title: titleOf(content),
        content,
        status: "assigned",
      }),
    );
    const run = this.mapStore(() =>
      this.store.createRun({
        squadId,
        squadTaskId: leaderTask.id,
        agentId: squad.leaderId,
        title: titleOf(content),
      }),
    );
    this.store.updateTask(leaderTask.id, { runId: run.id });

    let agentTask: AgentTaskDto;
    try {
      agentTask = await this.tasks.submit({
        agent: squad.leaderId,
        content: this.composeLeaderPrompt(squad, leaderTask.id, content),
      });
    } catch (err) {
      this.finishLeaderBeforeStart(leaderTask.id, run.id, err);
      throw this.wrapDispatchError(err, squad.leaderId);
    }
    this.store.updateTask(leaderTask.id, { agentTaskId: agentTask.id, status: "running" });
    this.store.updateRun(run.id, { status: "running" });
    this.track(leaderTask.id);
    log.info("dispatch", `小队 ${squadId} 派单 ${leaderTask.id} → 队长 ${squad.leaderId}`);
    return {
      taskId: leaderTask.id,
      runId: run.id,
      agentTaskId: agentTask.id,
      mode: "leader",
      assigneeId: squad.leaderId,
      status: "running",
    };
  }

  /** auto 模式派单：队长缺席也能跑（协调器算法分配） */
  private async dispatchAuto(
    squadId: string,
    content: string,
    priority?: SquadTaskPriority,
  ): Promise<SquadDispatchResult> {
    const auto = this.auto;
    if (!auto) {
      throw new SquadServiceError(
        "mode_not_supported",
        "auto 模式未装配（SquadAutoCoordinator 未注入），当前装配只支持 leader 模式",
      );
    }
    let result: SquadAutoDispatchResult;
    try {
      result = await auto.dispatch(squadId, {
        content,
        ...(priority === undefined ? {} : { priority }),
      });
    } catch (err) {
      throw this.wrapDispatchError(err, "auto");
    }
    return {
      taskId: result.taskId,
      runId: result.runId,
      agentTaskId: result.agentTaskId,
      mode: "auto",
      assigneeId: result.assigneeId,
      status: result.status,
    };
  }

  /**
   * 队长把一个子任务派给成员（`dispatch_task` 的 squad 分支）。
   *
   * **建完即返回**：不 await 成员跑完，队长的 turn 照常结束；成员终态会回头唤醒队长。
   */
  async dispatchToMember(input: DispatchToMemberInput): Promise<SquadDispatchResult> {
    const squad = this.requireSquad(input.squadId);
    if (squad.archivedAt !== undefined) {
      throw new SquadServiceError("squad_archived", `小队「${input.squadId}」已归档，不能派单`);
    }
    const leaderTask = this.mapStore(() => this.store.getTask(input.leaderTaskId));
    if (!leaderTask) throw new SquadServiceError("not_found", `队长任务不存在: ${input.leaderTaskId}`);
    if (!leaderTask.isLeader) {
      throw new SquadServiceError("bad_request", `任务 ${input.leaderTaskId} 不是队长任务`);
    }
    const memberId = input.memberId?.trim() ?? "";
    if (!this.store.hasAgentMember(input.squadId, memberId)) {
      throw new SquadServiceError("not_found", `成员不在小队里: ${memberId}`);
    }
    const content = input.content?.trim() ?? "";
    if (content === "") throw new SquadServiceError("bad_request", "task 不能为空");

    const child = this.mapStore(() =>
      this.store.createTask({
        squadId: input.squadId,
        parentId: leaderTask.id,
        isLeader: false,
        assigneeId: memberId,
        title: titleOf(content),
        content,
        status: "assigned",
      }),
    );
    const parentRunId = leaderTask.runId;
    const run = this.mapStore(() =>
      this.store.createRun({
        squadId: input.squadId,
        squadTaskId: child.id,
        agentId: memberId,
        ...(parentRunId === undefined ? {} : { parentRunId }),
        title: titleOf(content),
      }),
    );
    this.store.updateTask(child.id, { runId: run.id });

    let agentTask: AgentTaskDto;
    try {
      agentTask = await this.tasks.submit({
        agent: memberId,
        content: this.composeMemberPrompt(memberId, content),
      });
    } catch (err) {
      this.mapStore(() =>
        this.store.updateTask(child.id, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          finishedAt: Date.now(),
        }),
      );
      this.store.updateRun(run.id, { status: "failed", endedAt: Date.now() });
      throw this.wrapDispatchError(err, memberId);
    }
    this.store.updateTask(child.id, { agentTaskId: agentTask.id, status: "running" });
    this.store.updateRun(run.id, { status: "running" });
    this.track(child.id);
    return {
      taskId: child.id,
      runId: run.id,
      agentTaskId: agentTask.id,
      mode: "leader",
      assigneeId: memberId,
      status: "running",
    };
  }

  /** 小队运行树（leader 父 + worker 子，按开始时间升序） */
  listRuns(squadId: string): SquadRunNodeDto[] {
    this.requireSquad(squadId);
    const tasks = new Map(this.store.listTasks(squadId).map((task) => [task.id, task]));
    return this.store
      .listRuns(squadId)
      .map((run) => toRunDto(run, tasks.get(run.squadTaskId)));
  }

  /** 小队任务台账（路由/测试/排障用） */
  listTasks(squadId: string): SquadTaskRecord[] {
    this.requireSquad(squadId);
    return this.store.listTasks(squadId);
  }

  /** auto 协调器状态（成员运行态 / 任务计数 / 事件流） */
  coordinatorStatus(squadId: string): SquadAutoStatusDto {
    this.requireSquad(squadId);
    if (!this.auto) {
      throw new SquadServiceError("bad_request", "auto 模式未装配（SquadAutoCoordinator 未注入）");
    }
    return this.auto.status(squadId);
  }

  /** 推进 auto 协调器一格：冷却到期成员恢复 + 补派排队任务 */
  async tickCoordinator(
    squadId: string,
  ): Promise<{ reactivated: string[]; launched: SquadAutoDispatchResult[] }> {
    this.requireSquad(squadId);
    if (!this.auto) {
      throw new SquadServiceError("bad_request", "auto 模式未装配（SquadAutoCoordinator 未注入）");
    }
    return this.auto.tick(squadId);
  }

  // ──────────────────────────────────────────────
  // 负责人确认（审批）
  // ──────────────────────────────────────────────

  /**
   * 权限闸门：成员能不能执行某工具。
   *
   * 命中授权（once/session/permanent）→ 放行；否则落一条待裁决请求（队长），
   * 并把该成员的小队任务切到**非终态** `waiting_approval`（带原因）—— 等待期间
   * 不判死整轮；裁决后由 {@link resolveApproval} 续跑。**没有审批仓时一律拒绝**
   * （与既有默认策略一致）。
   */
  checkToolPermission(input: {
    agentId: string;
    toolName: string;
    toolInput?: string;
    reason?: string;
    agentTaskId?: string;
  }): ToolPermissionDecision {
    if (!this.approvals) return { allowed: false };
    const task = input.agentTaskId === undefined ? undefined : this.findTaskByAgentTaskId(input.agentTaskId);
    const sessionRef = task?.id;
    if (this.approvals.allows(input.agentId, input.toolName, sessionRef === undefined ? {} : { sessionRef })) {
      return { allowed: true };
    }
    const squadOfMember = this.findSquadForMember(input.agentId, task?.squadId);
    const reason = input.reason ?? "";
    const approval = this.approvals.request({
      ...(squadOfMember === undefined ? {} : { squadId: squadOfMember.id }),
      ...(task === undefined ? {} : { squadTaskId: task.id }),
      agentId: input.agentId,
      toolName: input.toolName,
      ...(input.toolInput === undefined ? {} : { toolInput: input.toolInput }),
      ...(reason === "" ? {} : { reason }),
      targetType: "leader",
      ...(squadOfMember === undefined ? {} : { targetId: squadOfMember.leaderId }),
    });
    if (task) this.enterWaitingApproval(task, { approval, toolName: input.toolName, reason });
    if (squadOfMember !== undefined) this.wakeLeaderForApproval(squadOfMember.id, approval);
    return { allowed: false, approval };
  }

  /**
   * 把成员任务切到 `waiting_approval`（非终态），原因写进 `blocked_reason`。
   *
   * run 同步切等待态（运行树徽标才不会还显示 running），执行侧补一条
   * `task/blocked` 事件（SSE 时间线可见）。
   */
  private enterWaitingApproval(
    task: SquadTaskRecord,
    info: { approval: ApprovalRequest; toolName: string; reason: string },
  ): void {
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return;
    const reason = `等待裁决：${info.toolName}${info.reason === "" ? "" : `（${info.reason}）`}`;
    this.mapStore(() =>
      this.store.updateTask(task.id, {
        status: "waiting_approval",
        blockedReason: reason,
        finishedAt: null,
      }),
    );
    if (task.runId !== undefined) {
      this.store.updateRun(task.runId, { status: "waiting_approval", endedAt: null });
    }
    if (task.agentTaskId !== undefined) {
      this.tasks.noteBlocked(task.agentTaskId, reason, info.approval.id);
    }
  }

  /**
   * 裁决后**续跑**（不是判死整轮）：清掉等待态、回到 running；
   * 若成员这一轮已经结束，就补一轮「裁决结果 + 继续」的续跑任务并重新挂观察。
   */
  private leaveWaitingApproval(
    request: ApprovalRequest,
    decision: { decision: "approve" | "deny"; note?: string },
  ): void {
    const taskId = request.squadTaskId;
    if (taskId === undefined) return;
    const task = this.store.getTask(taskId);
    if (!task) return;
    // 只处理「真的在等」的任务：已终态/已在跑的不复活
    if (task.status !== "waiting_approval") return;
    const note =
      decision.decision === "approve"
        ? `已批准 ${request.toolName}`
        : `已拒绝 ${request.toolName}`;
    this.mapStore(() =>
      this.store.updateTask(task.id, {
        status: "running",
        blockedReason: null,
        finishedAt: null,
      }),
    );
    if (task.runId !== undefined) {
      this.store.updateRun(task.runId, { status: "running", endedAt: null });
    }
    void this.resumeAfterApproval(task, request, decision, note);
  }

  /** 裁决后的续跑：还在跑就补事件；已经停了就补一轮续跑任务 */
  private async resumeAfterApproval(
    task: SquadTaskRecord,
    request: ApprovalRequest,
    decision: { decision: "approve" | "deny"; note?: string },
    note: string,
  ): Promise<void> {
    const running =
      task.agentTaskId === undefined ? null : this.tasks.getTask(task.agentTaskId);
    if (running && !isTerminalAgentTaskStatus(running.status)) {
      // 成员这一轮还在跑（下一次同类工具调用会命中授权）—— 只补事件，不重派
      this.tasks.noteUnblocked(running.id, note);
      return;
    }
    const hint =
      decision.decision === "approve"
        ? `负责人已批准你对 \`${request.toolName}\` 的调用（scope 见审计）。请继续把没做完的部分做完。`
        : `负责人拒绝了 \`${request.toolName}\` 的调用。请换一条不需要它的路径继续完成原任务。`;
    const body = [
      `## 审批结果：${decision.decision === "approve" ? "批准" : "拒绝"}`,
      hint,
      decision.note === undefined || decision.note.trim() === ""
        ? ""
        : `裁决附言：${decision.note.trim()}`,
    ]
      .filter((line) => line !== "")
      .join("\n");
    try {
      const sent = await this.tasks.submit({
        agent: task.assigneeId,
        content: this.composeMemberPrompt(task.assigneeId, body),
      });
      this.mapStore(() =>
        this.store.updateTask(task.id, {
          status: "running",
          agentTaskId: sent.id,
          attempt: task.attempt + 1,
          blockedReason: null,
          finishedAt: null,
        }),
      );
      this.tasks.noteUnblocked(sent.id, note);
      this.track(task.id);
    } catch (err) {
      log.warn(
        "approval",
        `任务 ${task.id} 裁决后续跑失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.mapStore(() =>
        this.store.updateTask(task.id, {
          status: "waiting_approval",
          blockedReason: `${note}，但续跑派单失败，需人工重试`,
        }),
      );
    }
  }

  /** 待裁决列表 */
  listApprovals(
    filter: { status?: ApprovalRequest["status"]; squadId?: string; agentId?: string } = {},
  ): ApprovalRequest[] {
    return this.approvals?.list(filter) ?? [];
  }

  /** 审批详情 + 审计 */
  approvalDetail(id: string): { request: ApprovalRequest; audit: ApprovalAuditEntry[] } {
    if (!this.approvals) throw new SquadServiceError("not_found", `审批请求不存在: ${id}`);
    const request = this.approvals.get(id);
    if (!request) throw new SquadServiceError("not_found", `审批请求不存在: ${id}`);
    return { request, audit: this.approvals.auditFor(id) };
  }

  /**
   * 裁决一笔审批（队长工具 / 人类 REST 共用）。
   *
   * 队长裁决后，若成员任务仍在跑，下一次同类工具调用就会命中授权；若成员任务已因
   * 「审批缺失」结束，由队长（或人类）决定是否重派。
   */
  resolveApproval(
    id: string,
    input: { decision: "approve" | "deny"; scope?: ApprovalScope; actor: { type: "agent" | "member" | "system"; id: string }; note?: string },
  ): ApprovalRequest {
    if (!this.approvals) throw new SquadServiceError("not_found", `审批请求不存在: ${id}`);
    try {
      const resolved = this.approvals.resolve(id, {
        decision: input.decision,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        actor: input.actor,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      log.info("approval", `${id} ${resolved.status} by ${input.actor.type}:${input.actor.id}`);
      // 等裁决的任务续跑（不进 failed）：这是「任务等审批」与「整轮判死」的分水岭
      this.leaveWaitingApproval(resolved, {
        decision: input.decision,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      return resolved;
    } catch (err) {
      throw wrapApprovalError(err);
    }
  }

  /** 最近审计（治理页/排障） */
  listRecentAudit(limit = 100): ApprovalAuditEntry[] {
    return this.approvals?.recentAudit(limit) ?? [];
  }

  /** 收回授权（permanent 收回；不传 toolName = 收回该成员全部） */
  revokeApprovals(agentId: string, toolName?: string): { revoked: number } {
    const id = agentId?.trim() ?? "";
    if (id === "") throw new SquadServiceError("bad_request", "agentId 不能为空");
    return { revoked: this.approvals?.revoke(id, toolName) ?? 0 };
  }

  /** 上抛人类发起人（队长拿不准） */
  escalateApproval(
    id: string,
    input: { actor: { type: "agent" | "member" | "system"; id: string }; note?: string },
  ): ApprovalRequest {
    if (!this.approvals) throw new SquadServiceError("not_found", `审批请求不存在: ${id}`);
    try {
      return this.approvals.escalate(id, {
        actor: input.actor,
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(this.humanOwner === undefined ? {} : { humanId: this.humanOwner }),
      });
    } catch (err) {
      throw wrapApprovalError(err);
    }
  }

  // ──────────────────────────────────────────────
  // 内部：终态跟踪与唤醒
  // ──────────────────────────────────────────────

  /** 后台观察一条小队任务的执行（不阻塞调用方） */
  private track(squadTaskId: string): void {
    const task = this.store.getTask(squadTaskId);
    if (!task?.agentTaskId) return;
    const agentTaskId = task.agentTaskId;
    void this.tasks
      .waitForTerminal(agentTaskId, this.waitTimeoutMs)
      .then((done) => {
        this.finishSquadTask(squadTaskId, done);
      })
      .catch((err: unknown) => {
        log.warn("track", `小队任务 ${squadTaskId} 跟踪失败: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** 把执行终态写回小队任务/运行树，并按需唤醒队长 */
  private finishSquadTask(squadTaskId: string, done: AgentTaskDto): void {
    const task = this.store.getTask(squadTaskId);
    if (!task) return;
    if (task.agentTaskId !== undefined && done.id !== task.agentTaskId) return;
    // 等裁决：成员这一轮停了也不能判死整轮，状态留 waiting_approval，裁决后由
    // leaveWaitingApproval 续跑（run 同样保持等待态，UI 才不会闪成 failed）。
    if (task.status === "waiting_approval") {
      if (task.runId !== undefined) {
        this.store.updateRun(task.runId, { status: "waiting_approval", endedAt: null });
      }
      return;
    }
    const status = mapAgentTaskStatus(done.status);
    const finishedAt = Date.now();
    this.mapStore(() =>
      this.store.updateTask(squadTaskId, {
        status,
        ...(done.result === undefined ? {} : { result: done.result }),
        ...(done.error === undefined ? {} : { error: done.error }),
        blockedReason: null,
        finishedAt,
      }),
    );
    if (task.runId !== undefined) {
      this.store.updateRun(task.runId, {
        status: status === "completed" ? "completed" : status,
        endedAt: finishedAt,
      });
    }
    if (task.isLeader) return;
    if (task.parentId !== undefined) this.maybeWakeLeader(task.parentId);
  }

  /**
   * 全部子任务终态（或存在待裁决审批）时，再派一轮队长任务。
   *
   * 这就是「成员终态唤醒队长」的本地形态：本地没有评论流，改成一跳新的队长任务，
   * 把回报/待裁决清单塞进任务正文；`wakeState` 用「成员终态签名」去重 + 次数上限，
   * 防止「派活 → 回报 → 再派活」自激。
   */
  private maybeWakeLeader(leaderTaskId: string): void {
    const leader = this.store.getTask(leaderTaskId);
    if (!leader || !leader.isLeader) return;
    const squad = this.store.getSquad(leader.squadId);
    if (!squad) return;
    if (squad.archivedAt !== undefined) return;

    const children = this.store.listChildren(leaderTaskId);
    // waiting_approval 不算「在跑」：它正等着队长裁决，队长必须被叫起来
    const active = children.filter(
      (child) =>
        child.status === "pending" || child.status === "assigned" || child.status === "running",
    );
    if (active.length > 0) return;

    const pendingApprovals =
      this.approvals?.list({ status: "pending", squadId: squad.id }) ?? [];
    const pendingForLeader = pendingApprovals.filter((approval) => approval.targetType === "leader");
    if (children.length === 0 && pendingForLeader.length === 0) return;

    const signature = [
      ...children.map((child) => `${child.id}:${child.status}`),
      ...pendingForLeader.map((approval) => `approval:${approval.id}`),
    ].join("|");
    const state = this.wakeState.get(leaderTaskId) ?? { count: 0, signature: "" };
    if (state.signature === signature) return;
    if (state.count >= this.maxLeaderWakes) {
      log.warn("wake", `队长任务 ${leaderTaskId} 已达唤醒上限（${this.maxLeaderWakes}），不再唤醒`);
      this.mapStore(() => this.store.updateTask(leaderTaskId, { status: "completed", finishedAt: Date.now() }));
      return;
    }

    const reports = children.map((child) => ({
      memberId: child.assigneeId,
      status: child.status,
      body: child.result ?? child.error ?? "",
    }));
    const prompt = this.composeWakePrompt(squad, leaderTaskId, reports, pendingForLeader);
    const next = { count: state.count + 1, signature };
    this.wakeState.set(leaderTaskId, next);

    void this.tasks
      .submit({ agent: leader.assigneeId, content: prompt })
      .then((agentTask) => {
        this.mapStore(() =>
          this.store.updateTask(leaderTaskId, {
            agentTaskId: agentTask.id,
            status: "running",
            attempt: leader.attempt + 1,
            finishedAt: null,
          }),
        );
        if (leader.runId !== undefined) {
          this.store.updateRun(leader.runId, { status: "running", endedAt: null });
        }
        for (const approval of pendingForLeader) this.approvalWakes.add(approval.id);
        this.track(leaderTaskId);
      })
      .catch((err: unknown) => {
        log.warn("wake", `唤醒队长 ${leaderTaskId} 失败: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** 新审批到达：队长没在跑就顺手唤醒它（不阻塞审批落库） */
  private wakeLeaderForApproval(squadId: string, approval: ApprovalRequest): void {
    if (this.approvalWakes.has(approval.id)) return;
    const leaderTask = this.store
      .listTasks(squadId)
      .filter((task) => task.isLeader)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!leaderTask) return;
    if (leaderTask.status === "running" || leaderTask.status === "assigned") {
      // 队长这一轮还在跑：等它收口时由 maybeWakeLeader 带出待裁决清单
      return;
    }
    this.maybeWakeLeader(leaderTask.id);
  }

  // ──────────────────────────────────────────────
  // 内部：prompt 装配
  // ──────────────────────────────────────────────

  private composeLeaderPrompt(squad: SquadDetail, leaderTaskId: string, task: string): string {
    const base = this.basePrompt(squad.leaderId);
    return composeSquadLeaderPrompt(base, this.briefingFor(squad, leaderTaskId), task);
  }

  private composeMemberPrompt(agentId: string, task: string): string {
    const base = this.basePrompt(agentId);
    return base === "" ? task.trim() : `${base}\n\n---\n\n## 本次任务\n${task.trim()}`;
  }

  private composeWakePrompt(
    squad: SquadDetail,
    leaderTaskId: string,
    reports: Array<{ memberId: string; status: string; body: string }>,
    approvals: readonly ApprovalRequest[],
  ): string {
    const base = this.basePrompt(squad.leaderId);
    const reportsText = composeSquadWakePrompt(base, this.briefingFor(squad, leaderTaskId), reports);
    if (approvals.length === 0) return reportsText;
    const lines = [
      "",
      "## 待裁决审批",
      "成员在等你的裁决（每笔都要落审计）：",
      ...approvals.map(
        (approval) =>
          `- ${approval.id} | 成员 ${approval.agentId} 请求执行 \`${approval.toolName}\`${approval.reason === "" ? "" : `（${approval.reason}）`}`,
      ),
      "",
      "用 `resolve_approval(approval_id, decision=approve|deny, scope=once|session|permanent)` 裁决；拿不准用 `escalate_approval(approval_id, reason)` 上抛人类发起人。",
    ];
    return `${reportsText}\n${lines.join("\n")}`;
  }

  private briefingFor(squad: SquadDetail, leaderTaskId?: string) {
    return buildSquadBriefing({
      squad: { id: squad.id, name: squad.name, instructions: squad.instructions },
      leaderId: squad.leaderId,
      members: this.roster(squad),
      ...(leaderTaskId === undefined ? {} : { squadTaskId: leaderTaskId }),
    });
  }

  /** roster：agent 成员 + 各自启用中的技能 */
  private roster(squad: SquadDetail): SquadRosterEntry[] {
    return squad.members
      .filter((member) => member.memberType === "agent")
      .map((member) => ({
        memberId: member.memberId,
        role: member.role,
        skills: this.safeSkills(member.memberId),
      }));
  }

  private safeSkills(agentId: string): string[] {
    try {
      return this.skillsFor(agentId);
    } catch {
      return [];
    }
  }

  /** 智能体基础 prompt：优先用装配好的（instructions + 技能），否则回落 agent.md 正文 */
  private basePrompt(agentId: string): string {
    if (this.basePromptFor) {
      try {
        const composed = this.basePromptFor(agentId).trim();
        if (composed !== "") return composed;
      } catch {
        // 装配失败回落 instructions（技能是增强，不能成为派单失败的新原因）
      }
    }
    return this.agentRegistry.get(agentId)?.instructions?.trim() ?? "";
  }

  // ──────────────────────────────────────────────
  // 内部：校验与错误映射
  // ──────────────────────────────────────────────

  private requireSquad(id: string): SquadDetail {
    const squad = this.store.getSquad(id);
    if (!squad) throw new SquadServiceError("not_found", `小队不存在: ${id}`);
    return squad;
  }

  private requireAgent(agentId: string): void {
    const agent = this.agentRegistry.get(agentId);
    if (!agent) throw new SquadServiceError("agent_not_found", `智能体不存在: ${agentId}`);
    if (agent.archivedAt !== undefined) {
      throw new SquadServiceError("agent_not_found", `智能体已归档: ${agentId}`);
    }
  }

  private assertMemberType(memberType: string): void {
    if (memberType !== "agent" && memberType !== "member") {
      throw new SquadServiceError("bad_request", "memberType 只能是 agent 或 member");
    }
  }

  /** 成员所属小队（优先用任务里记录的小队，否则取第一个包含它的队） */
  private findSquadForMember(agentId: string, squadId?: string): SquadDetail | undefined {
    if (squadId !== undefined) {
      const squad = this.store.getSquad(squadId);
      if (squad && this.store.hasAgentMember(squad.id, agentId)) return squad;
    }
    return this.store
      .listSquads()
      .find((squad) => this.store.hasAgentMember(squad.id, agentId));
  }

  /** 执行任务 id → 小队任务（审批会话归属用） */
  private findTaskByAgentTaskId(agentTaskId: string): SquadTaskRecord | undefined {
    for (const squad of this.store.listSquads({ includeArchived: true })) {
      const task = this.store.listTasks(squad.id).find((item) => item.agentTaskId === agentTaskId);
      if (task) return task;
    }
    return undefined;
  }

  /** 派单前置失败（队长根本没起来）也要留痕，避免运行树里挂一条永远的 running */
  private finishLeaderBeforeStart(leaderTaskId: string, runId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.mapStore(() =>
      this.store.updateTask(leaderTaskId, { status: "failed", error: message, finishedAt: Date.now() }),
    );
    this.store.updateRun(runId, { status: "failed", endedAt: Date.now() });
  }

  private wrapDispatchError(err: unknown, agentId: string): SquadServiceError {
    if (err instanceof SquadServiceError) return err;
    const code = (err as { code?: unknown }).code;
    if (code === "agent_not_found" || code === "runtime_not_bound" || code === "runtime_not_found") {
      return new SquadServiceError("agent_not_found", `智能体 ${agentId} 无法派单：${(err as Error).message}`);
    }
    return new SquadServiceError("bad_request", err instanceof Error ? err.message : String(err));
  }

  /** 仓错误 → 服务错误（保留 code） */
  private mapStore<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof SquadError) {
        const code = err.code as SquadServiceErrorCode;
        throw new SquadServiceError(code, err.message);
      }
      throw err;
    }
  }
}

/** AgentTask 状态 → 小队任务状态 */
function mapAgentTaskStatus(status: AgentTaskDto["status"]): SquadTaskRecord["status"] {
  switch (status) {
    case "replied":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "expired":
      return "failed";
    default:
      return "running";
  }
}

/** 审批仓错误 → 服务错误 */
function wrapApprovalError(err: unknown): SquadServiceError {
  const code = (err as { code?: unknown }).code;
  if (code === "not_found") return new SquadServiceError("not_found", (err as Error).message);
  if (code === "conflict") return new SquadServiceError("conflict", (err as Error).message);
  return new SquadServiceError("bad_request", err instanceof Error ? err.message : String(err));
}

/** 任务标题 = 正文首行，截断避免 UI 撑爆 */
function titleOf(content: string): string {
  const first = content.trim().split(/\r?\n/, 1)[0] ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

function toSquadDto(squad: SquadDetail): SquadInfoDto {
  return {
    id: squad.id,
    name: squad.name,
    description: squad.description,
    leaderId: squad.leaderId,
    mode: squad.mode,
    instructions: squad.instructions,
    members: squad.members.map((member) => ({
      memberType: member.memberType,
      memberId: member.memberId,
      role: member.role,
    })),
    archived: squad.archivedAt !== undefined,
  };
}

function toRunDto(run: SquadRunRecord, task?: SquadTaskRecord): SquadRunNodeDto {
  return {
    id: run.id,
    assignee: run.agentId,
    // 等裁决时以任务状态为准：run 可能已经收尾，但任务还在等审批
    status: task?.status === "waiting_approval" ? "waiting_approval" : run.status,
    title: run.title,
    parentRunId: run.parentRunId ?? null,
    startedAt: new Date(run.startedAt).toISOString(),
    blockedReason: task?.blockedReason ?? null,
    agentTaskId: task?.agentTaskId ?? null,
  };
}
