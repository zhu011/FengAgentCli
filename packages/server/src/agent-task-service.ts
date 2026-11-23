/**
 * @fengagent/server — 外派任务服务（P1 dispatch + P2 任务面）
 *
 * 把三块拼起来：
 *
 * ```
 * 注册表（能派给谁） ──┐
 *                      ├──▶ 外派任务仓（7 态 + 事件流）──▶ /api/agent-tasks（列表/详情/SSE）
 * ACP 客户端（怎么派） ─┘            ▲
 *                                    └── 副作用台账（operation_ledger，防重复执行）
 * ```
 *
 * 一次派发的完整生命周期（每一步都落事件，SSE 同步推）：
 *
 * ```
 * created ──dispatch──▶ dispatched ──initialize+session/new──▶ (accepted 事件)
 *   └──首块输出──▶ running ──prompt 结束──▶ replied
 *                            └──错误/超时/权限拒绝──▶ failed
 *                            └──用户取消──▶ cancelled
 * ```
 *
 * 两条硬约束：
 *
 * 1. **不重复执行**：每次 dispatch 是一个 `agent-task:<id>:attempt-<n>` 的副作用操作，
 *    进 AGE-29 的 `operation_ledger`。台账里已有 succeeded → 直接回放结果；
 *    仍是 pending/unknown（上轮崩在半路）→ 拒绝重跑并要求人工核对，绝不静默重放。
 * 2. **权限请求不静默挂起**：headless 派发没有人在场审批，策略默认 `deny`，
 *    但决策一定写进事件流（`task/stream-chunk` + `[permission]` 前缀 —— 冻结的
 *    事件枚举里没有独立类型，这里复用 detail 承载，UI 时间线可见）。
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  AgentTaskStore,
  createRuntimeDriver,
  isTerminalTaskStatus,
} from "@fengagent/agent";
import type {
  AgentRegistry,
  AgentTaskClaimPolicy,
  AgentTaskEventRow,
  AgentTaskRecord,
  AgentTaskStatus,
  AcpPermissionRequest,
  GroupMessageKind,
  RuntimeDriver,
} from "@fengagent/agent";
import type { OperationLedger } from "@fengagent/core";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { digestResult } from "@fengagent/core";
import { createLogger, generateId } from "@fengagent/shared";
import { AgentRuntimeRegistry } from "./agent-runtimes.ts";
import type { RuntimeEntryInput, RuntimeInfo } from "./agent-runtimes.ts";
import {
  AgentRuntimeBindingError,
  resolveRuntimeForAgent,
} from "./agent-runtime-binding.ts";

const log = createLogger("agent-tasks");

/** 认领失败（携带 HTTP 状态与机器可读 code，路由层直接转成 `{error:{...}}`） */
export class TaskClaimError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409;

  constructor(code: string, message: string, status: 400 | 404 | 409 = 409) {
    super(message);
    this.name = "TaskClaimError";
    this.code = code;
    this.status = status;
  }

  toPayload(): { error: { message: string; code: string } } {
    return { error: { message: this.message, code: this.code } };
  }
}

/** 池任务认领上下文（P3-1）：只做「小队成员 + roster skill 标签」两道过滤，不做能力评分 */
export interface TaskPoolScope {
  /** 小队是否存在（建池任务时校验；可选，不实现则跳过） */
  hasSquad?(squadId: string): boolean;
  /** 该 agent 是否是小队成员（池范围过滤；可选） */
  hasAgentMember?(squadId: string, agentId: string): boolean;
  /** 该 agent 启用中的技能名（roster skill 标签过滤；可选） */
  skillsFor?(agentId: string): string[];
}

/** 认领相关的服务选项 */
export interface TaskPoolOptions {
  /** 过滤上下文（由 server 装配 SquadStore / SkillMountStore） */
  scope?: TaskPoolScope;
  /** 认领租约时长（毫秒；默认 10 分钟） */
  leaseMs?: number;
  /** 租约回收间隔（毫秒；0 = 不启后台回收，只在读列表/认领时惰性回收） */
  sweepIntervalMs?: number;
}

/**
 * 中立工作目录（**仓库外**）：`~/.fengagent/dispatch-workspace/<数据根指纹>`。
 *
 * 派发出去的目标 agent 会在 cwd 里读 `AGENTS.md` / `CLAUDE.md` / `.git` 来推断
 * 「我是谁、我在哪个项目」，若默认 cwd 落在本仓库里，它就会自报成别的 agent、
 * 甚至把这次外派当成在自己项目里干活（F 段 P0：身份/环境污染）。
 */
function neutralDispatchCwd(dataRoot: string): string {
  const fingerprint = createHash("sha256").update(dataRoot).digest("hex").slice(0, 8);
  return join(homedir(), ".fengagent", "dispatch-workspace", fingerprint);
}

/** 与 WebUI `AgentTask` 契约一致的任务 DTO（时间戳为 ISO 字符串） */
export interface AgentTaskDto {
  id: string;
  fromSession: string;
  runtime: string;
  /** 派单方智能体 id（P0；直接按 runtime 派发时缺省） */
  agentId?: string;
  status: AgentTaskStatus;
  content: string;
  result?: string;
  error?: string;
  createdAt: string;
  dispatchedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  acpSessionId?: string;
  /** 群内派发（G2）：任务所属群 */
  groupId?: string;
  /** 认领策略（P3-1）：默认 assigned；pool=任务池 */
  claimPolicy?: AgentTaskClaimPolicy;
  /** 池范围（小队 id；空 = 全局池） */
  poolScope?: string;
  /** 池内技能标签（roster skill 过滤提示） */
  skillTags?: string[];
  /** 认领时间（ISO；`claimed` 才有） */
  claimedAt?: string;
  /** 租约到期（ISO；过期退回池子） */
  leaseExpiresAt?: string;
}

/** 池里可认领任务的 DTO（`GET /api/agent-tasks?claimable=1`） */
export interface ClaimableTaskDto {
  id: string;
  content: string;
  claimPolicy: "pool";
  /** 池范围（小队 id；缺省 = 全局池） */
  poolScope?: string;
  /** 池内技能标签（认领人须已挂载） */
  skillTags?: string[];
  status: AgentTaskStatus;
  createdAt: string;
}

/** 池视图 DTO（`GET /api/agent-tasks?pool=1`）：含已被认领/租约态 */
export interface PoolTaskDto extends ClaimableTaskDto {
  /** 认领人（`claimed`/`dispatched`/`running` 才有） */
  claimedBy?: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  /** 租约是否已过期（前端直接显示「租约过期 · 待回收」，不用自己算时间） */
  leaseExpired: boolean;
}

/** 认领结果（`POST /api/agent-tasks/:id/claim`） */
export interface ClaimResultDto {
  ok: true;
  status: "claimed";
  /** 租约到期（epoch ms，与 WebUI `ClaimResult` 对齐） */
  leaseExpiresAt: number;
  task: AgentTaskDto;
}

/** 与 WebUI `AgentTaskEvent` 契约一致的事件 DTO */
export interface AgentTaskEventDto {
  seq: number;
  at: string;
  type: AgentTaskEventRow["type"];
  detail?: string;
}

/** SSE 推送帧（与 WebUI `AgentTaskStreamEvent` 契约一致） */
export type AgentTaskStreamEvent =
  | { type: "status"; task: AgentTaskDto }
  | { type: "chunk"; text: string }
  | { type: "event"; event: AgentTaskEventDto };

/** 建任务请求（与 WebUI `AgentTaskCreateRequest` 契约一致） */
export interface CreateAgentTaskRequest {
  /** 目标 runtime 注册名（与 `agent` 二选一；`agent` 优先） */
  runtime?: string;
  /** 目标智能体 id（P0：由绑定关系解析 runtime；保留 `runtime` 兼容旧调用方） */
  agent?: string;
  content: string;
  /** 界面发起的任务不传；会话内派发传会话 id */
  fromSession?: string;
  /** 覆盖目标工作目录（默认服务数据根下的 `dispatch-workspace`） */
  cwd?: string;
  /** 群内派发（G2）：结果会自动以 `task_card` 写回这个群 */
  groupId?: string;
  idempotencyKey?: string;
  /**
   * 认领策略（P3-1，opt-in）：缺省 / `assigned` = 点名派发（原语义不变）；
   * `pool` = 只建任务进池，`created` 等认领，**不派发**。
   */
  claimPolicy?: AgentTaskClaimPolicy;
  /** 池范围（小队 id；空 = 全局池）——`claimPolicy='pool'` 时生效 */
  poolScope?: string;
  /** 池内技能标签（认领人须已挂载这些技能；空 = 不限制） */
  skillTags?: string[];
}

/**
 * 结果回群的下沉口（由 `AgentGroupService` 实现，避免 agent-tasks 反向依赖群模块）。
 */
export interface TaskGroupSink {
  postRuntimeMessage(
    groupId: string,
    input: {
      runtime: string;
      content: string;
      agentTaskId?: string;
      kind?: GroupMessageKind;
    },
  ): unknown;
  /**
   * 群是否存在（可选）：`submit()` 带 `groupId` 时先校验，避免任务结果无处可回。
   * 不实现则跳过校验（保持旧行为）。
   */
  hasGroup?(groupId: string): boolean;
}

/** 外派任务服务选项 */
export interface AgentTaskServiceOptions {
  /** 数据根（任务库 / runtimes.json / 默认工作目录都在它下面） */
  dataRoot: string;
  /** 任务仓（默认 `<dataRoot>/agent-tasks.db`） */
  store?: AgentTaskStore;
  /** 运行时注册表（默认 `<dataRoot>/runtimes.json`） */
  registry?: AgentRuntimeRegistry;
  /**
   * 智能体仓（P0）：提供时 `submit({agent})` 按绑定关系解析 runtime，
   * 并在真正 spawn 前二次校验绑定未变（改绑立即生效）。
   */
  agentRegistry?: AgentRegistry;
  /** 副作用台账（传 `taskStore.ledger` 即复用 AGE-29 的防重复执行） */
  ledger?: OperationLedger;
  /**
   * 结果回群下沉口（G2）：任务终态时把结果以 `task_card` 写回 `task.groupId` 指向的群。
   * 由 server 装配注入 `agentGroupService`；不传则只在任务侧收尾。
   */
  groupSink?: TaskGroupSink;
  /**
   * P1：按智能体装配执行上下文（instructions + 已挂载技能）。
   *
   * 只在 `{agent}` 派单时调用；返回空串 / 不传则原样发送任务正文（零回归）。
   * 装配失败由注入方降级（记录并返回正文），不能因为技能读不到而拒单。
   */
  composePrompt?: (agentId: string, content: string) => string;
  /** 未指定 cwd 时的默认工作目录（默认 `<dataRoot>/dispatch-workspace`） */
  defaultCwd?: string;
  /** 握手/建会话超时（默认 120000） */
  requestTimeoutMs?: number;
  /** 单次 prompt 超时（默认 600000） */
  promptTimeoutMs?: number;
  /** 权限策略（默认 deny；决策都会落事件） */
  permissionPolicy?: (ctx: {
    taskId: string;
    runtime: string;
    request: AcpPermissionRequest;
  }) => "allow" | "deny";
  /** 启动时后台探测一次全部 runtime（默认 true；测试建议关掉） */
  autoProbe?: boolean;
  /** 启动时把上一进程遗留的非终态任务收尾（默认 true） */
  recoverOnStart?: boolean;
  /** P3-1：任务池认领（过滤上下文 / 租约时长 / 回收间隔） */
  pool?: TaskPoolOptions;
  now?: () => number;
}

/** 单次任务的在飞句柄 */
interface ActiveRun {
  driver: RuntimeDriver;
  /** 用户是否已取消（用关闭驱动打断 prompt） */
  cancelled: boolean;
}

/**
 * 外派任务服务。
 *
 * 用法：
 * ```ts
 * const service = new AgentTaskService({ dataRoot, ledger: taskStore.ledger });
 * const task = await service.submit({ runtime: "kimi", content: "你好" });
 * const done = await service.waitForTerminal(task.id, 60_000);
 * ```
 */
export class AgentTaskService {
  readonly store: AgentTaskStore;
  readonly registry: AgentRuntimeRegistry;
  /** 智能体仓（P0；未装配时 `{agent}` 派单不可用） */
  readonly agentRegistry: AgentRegistry | undefined;
  private readonly ledger: OperationLedger | undefined;
  private readonly defaultCwd: string;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly permissionPolicy: NonNullable<AgentTaskServiceOptions["permissionPolicy"]>;
  private readonly groupSink: TaskGroupSink | undefined;
  private readonly composePrompt: ((agentId: string, content: string) => string) | undefined;
  private readonly now: () => number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly subscribers = new Map<string, Set<(event: AgentTaskStreamEvent) => void>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  /** 在飞的派发（close() 要等它们收尾） */
  private readonly inflight = new Map<string, Promise<void>>();
  /** P3-1：池过滤上下文 */
  private readonly poolScope: TaskPoolScope | undefined;
  /** P3-1：认领租约时长 */
  private readonly leaseMs: number;
  /** P3-1：租约回收定时器（unref，不拖住进程退出） */
  private leaseTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AgentTaskServiceOptions) {
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 600_000;
    this.defaultCwd = options.defaultCwd ?? neutralDispatchCwd(options.dataRoot);
    this.ledger = options.ledger;
    this.agentRegistry = options.agentRegistry;
    this.permissionPolicy = options.permissionPolicy ?? (() => "deny");
    this.groupSink = options.groupSink;
    this.composePrompt = options.composePrompt;
    this.poolScope = options.pool?.scope;
    this.leaseMs = Math.max(1_000, options.pool?.leaseMs ?? 10 * 60_000);
    mkdirSync(this.defaultCwd, { recursive: true });

    this.store =
      options.store ?? new AgentTaskStore(join(options.dataRoot, "agent-tasks.db"));
    this.registry =
      options.registry ?? new AgentRuntimeRegistry({ dataRoot: options.dataRoot });

    if (options.recoverOnStart ?? true) this.recoverInterrupted();
    const sweepIntervalMs = options.pool?.sweepIntervalMs ?? 60_000;
    if (sweepIntervalMs > 0) {
      this.leaseTimer = setInterval(() => {
        try {
          this.sweepLeases();
        } catch (err) {
          log.warn(
            "pool",
            `租约回收失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }, sweepIntervalMs);
      // 后台回收不该成为进程退不掉的最后一个理由
      (this.leaseTimer as { unref?: () => void }).unref?.();
    }
    if (options.autoProbe ?? true) {
      // 后台探测一次，让 Agents 页首屏就有探测结果；失败不影响服务可用性。
      void this.registry.probeAll(this.taskCounts()).catch((err: unknown) => {
        log.warn("probe", `启动探测失败: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  // ──────────────────────────────────────────────
  // 读
  // ──────────────────────────────────────────────

  /** runtime 卡片（含近 24h 任务数） */
  listRuntimes(): RuntimeInfo[] {
    return this.registry.list(this.taskCounts());
  }

  /** 显式探测全部 runtime */
  async probeRuntimes(): Promise<RuntimeInfo[]> {
    return this.registry.probeAll(this.taskCounts());
  }

  /** 探测单个 runtime（失败原因落在卡片的 probeError / probeErrorCode 上） */
  async probeRuntime(name: string): Promise<RuntimeInfo> {
    return this.registry.probe(name, this.taskCounts().get(name) ?? 0);
  }

  /**
   * 新增 runtime（`probe: true` 时先真探测，失败则不落盘并把原因抛给路由）。
   *
   * @param input - 表单载荷
   * @param options - 探测开关
   */
  async createRuntime(
    input: RuntimeEntryInput,
    options: { probe?: boolean } = {},
  ): Promise<RuntimeInfo[]> {
    await this.registry.create(input, options);
    return this.listRuntimes();
  }

  /** 编辑 runtime（注册名不可改；改连接参数会作废旧探测结果） */
  updateRuntime(name: string, patch: RuntimeEntryInput): RuntimeInfo[] {
    this.registry.update(name, patch);
    return this.listRuntimes();
  }

  /** 删除 runtime */
  deleteRuntime(name: string): RuntimeInfo[] {
    this.registry.remove(name);
    return this.listRuntimes();
  }

  /** 表单「探测验证」：不落盘，失败原因原样回给前端 */
  async probeRuntimeCandidate(
    input: RuntimeEntryInput,
  ): Promise<Awaited<ReturnType<AgentRuntimeRegistry["probeCandidate"]>>> {
    return this.registry.probeCandidate(input);
  }

  /** 取任务 */
  getTask(id: string): AgentTaskDto | null {
    const record = this.store.get(id);
    return record ? toTaskDto(record) : null;
  }

  /** 列表（首页 + cursor） */
  listTasks(
    filter: {
      status?: AgentTaskStatus | AgentTaskStatus[];
      runtime?: string;
      /** 只看某个智能体的任务（P0） */
      agentId?: string;
      /** 只看某个群派出的任务（G2） */
      groupId?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): { tasks: AgentTaskDto[]; nextCursor?: string } {
    const limit = filter.limit ?? 50;
    const rows = this.store.list({ ...filter, limit });
    const tasks = rows.map(toTaskDto);
    const last = rows[rows.length - 1];
    if (rows.length < limit || !last) return { tasks };
    return { tasks, nextCursor: last.id };
  }

  /** 事件日志 */
  listEvents(id: string, afterSeq = 0): AgentTaskEventDto[] {
    return this.store.events(id, afterSeq).map(toEventDto);
  }

  // ──────────────────────────────────────────────
  // 读：任务池（P3-1）
  // ──────────────────────────────────────────────

  /**
   * 池里可认领的任务。
   *
   * 传 `agent` 时按「小队成员 + roster skill 标签」过滤（先只做这两道，
   * 不做能力评分）：不在小队里、或缺少任务要求的技能的，不出现在它的候选里。
   *
   * 读之前先做一次惰性租约回收 —— 前端看到的「可认领」不会包含刚过期的死租约。
   *
   * @param filter.squad - 只看某个小队的池
   * @param filter.agent - 认领人（用于成员/技能过滤）
   * @param filter.limit - 条数上限
   */
  listClaimableTasks(
    filter: { squad?: string; agent?: string; limit?: number } = {},
  ): ClaimableTaskDto[] {
    this.sweepLeases();
    return this.store
      .listClaimable({
        ...(filter.squad === undefined ? {} : { squad: filter.squad }),
        ...(filter.limit === undefined ? {} : { limit: filter.limit }),
      })
      .filter((task) => this.canAgentTake(task, filter.agent) === null)
      .map(toClaimableDto);
  }

  /**
   * 池视图：某个池里的全部任务（含已被认领/租约中的），供前端展示「谁在什么时候领的」。
   *
   * @param filter.squad - 池范围
   * @param filter.limit - 条数上限
   */
  listPoolTasks(filter: { squad?: string; limit?: number } = {}): PoolTaskDto[] {
    this.sweepLeases();
    const now = this.now();
    return this.store
      .listPool({
        ...(filter.squad === undefined ? {} : { squad: filter.squad }),
        ...(filter.limit === undefined ? {} : { limit: filter.limit }),
      })
      .map((task) => toPoolTaskDto(task, now));
  }

  /**
   * 某个 agent 能不能拿这条池任务（成员 + 技能两道过滤）。
   *
   * @returns 不能拿时返回原因（code 给 409 分类、message 给人看），能拿返回 null
   */
  private canAgentTake(
    task: AgentTaskRecord,
    agentId: string | undefined,
  ): { code: "not_member" | "skill_mismatch"; message: string } | null {
    if (agentId === undefined || agentId === "") return null;
    const scope = this.poolScope;
    if (task.poolScope !== undefined && scope?.hasAgentMember !== undefined) {
      if (!scope.hasAgentMember(task.poolScope, agentId)) {
        return {
          code: "not_member",
          message: `agent ${agentId} 不是小队 ${task.poolScope} 的成员，不能认领该池任务`,
        };
      }
    }
    const required = task.skillTags ?? [];
    if (required.length === 0) return null;
    const owned = new Set(
      (scope?.skillsFor?.(agentId) ?? []).map((name) => name.trim().toLowerCase()),
    );
    const missing = required.filter((tag) => !owned.has(tag.trim().toLowerCase()));
    return missing.length === 0
      ? null
      : {
          code: "skill_mismatch",
          message: `agent ${agentId} 缺少任务要求的技能: ${missing.join(", ")}`,
        };
  }

  // ──────────────────────────────────────────────
  // 写：任务池认领（P3-1）
  // ──────────────────────────────────────────────

  /**
   * 认领一条池任务（原子；输家 409）。
   *
   * 顺序刻意是「先做不该写库的校验，再一条条件 UPDATE 定胜负」：
   * 成员/技能/runtime 这些读校验放前面只影响「谁能赢」，真正的并发裁决在
   * `store.claim()` 的那条 UPDATE 里（`changes === 1` 才算赢），不会出现
   * 「两个人都读到 created 都以为自己赢了」。
   *
   * @param id - 任务 id
   * @param agentId - 认领人
   * @returns 认领后的任务 + 租约
   * @throws {TaskClaimError} 404（不存在）/ 409（已被认领、agent 忙、范围或技能不符）
   */
  claimTask(id: string, agentId: string): ClaimResultDto {
    const agent = agentId.trim();
    if (agent === "") throw new TaskClaimError("bad_request", "agent 必填", 400);
    this.sweepLeases();
    const task = this.store.get(id);
    if (!task) throw new TaskClaimError("not_found", `任务不存在: ${id}`, 404);
    if (task.claimPolicy !== "pool") {
      throw new TaskClaimError(
        "not_pool",
        `任务 ${id} 不是池任务（claim_policy=${task.claimPolicy}），按点名派发执行`,
      );
    }

    // ① 智能体必须真实存在且未归档（与派单同一道围栏）
    if (this.agentRegistry) {
      const record = this.agentRegistry.get(agent);
      if (!record) throw new TaskClaimError("agent_not_found", `智能体不存在: ${agent}`, 404);
      if (record.archivedAt !== undefined) {
        throw new TaskClaimError("agent_archived", `智能体已归档，不能认领: ${agent}`);
      }
    }

    // ② 池范围过滤：小队成员 + roster skill 标签
    const rejected = this.canAgentTake(task, agent);
    if (rejected !== null) {
      throw new TaskClaimError(rejected.code, rejected.message);
    }

    // ③ runtime：池任务可以不写死 runtime，认领时按认领人的绑定解析
    let runtime: string | undefined;
    if (task.runtime === "") {
      const record = this.agentRegistry?.get(agent);
      if (!record) {
        throw new TaskClaimError(
          "agent_not_found",
          `池任务未写死 runtime，认领需按智能体绑定解析，但智能体不存在: ${agent}`,
          404,
        );
      }
      const resolution = resolveRuntimeForAgent(record, this.listRuntimes());
      if (!resolution.ok) {
        throw new TaskClaimError(resolution.code, resolution.message);
      }
      runtime = resolution.runtime.name;
    }

    // ④ 原子认领（一条条件 UPDATE；输家拿不到 changes=1）
    const claimed = this.store.claim(id, agent, {
      leaseMs: this.leaseMs,
      ...(runtime === undefined ? {} : { runtime }),
    });
    if (!claimed.ok) {
      const status = claimed.code === "not_found" ? 404 : 409;
      throw new TaskClaimError(claimed.code, claimed.message, status);
    }
    log.info(
      "claim",
      `任务 ${id} 被 ${agent} 认领（租约 ${Math.round(this.leaseMs / 1000)}s${
        runtime === undefined ? "" : `，runtime=${runtime}`
      }）`,
    );
    this.emit(id, { type: "event", event: toEventDto(claimed.event) });
    this.emit(id, { type: "status", task: toTaskDto(claimed.task) });

    // ⑤ 认领即派发（不阻塞 HTTP；进度照旧走 SSE）
    this.startDispatch(id);
    const latest = this.store.get(id) ?? claimed.task;
    return {
      ok: true,
      status: "claimed",
      leaseExpiresAt: claimed.task.leaseExpiresAt ?? this.now() + this.leaseMs,
      task: toTaskDto(latest),
    };
  }

  /**
   * 租约回收（P3-1 第二道保险）：把过期未派发的认领退回池子并推事件。
   *
   * 过期退回的是 `created`（回池等别人捡），**不是 failed/expired** —— 池任务没派出去
   * 就不算失败，这和 assigned 任务的恢复口径刻意不同。
   *
   * @returns 本次被退回的任务 id
   */
  sweepLeases(): string[] {
    const requeued = this.store.requeueExpired(this.now());
    for (const item of requeued) {
      log.warn("pool", `任务 ${item.task.id} 租约过期，已退回任务池`);
      this.emit(item.task.id, { type: "event", event: toEventDto(item.event) });
      this.emit(item.task.id, { type: "status", task: toTaskDto(item.task) });
    }
    return requeued.map((item) => item.task.id);
  }

  // ──────────────────────────────────────────────
  // 写：建 / 派 / 取消 / 重试
  // ──────────────────────────────────────────────

  /**
   * 建任务并立即派发（不等待结果）。
   *
   * @param request - 派发请求
   * @returns 已进入 `dispatched`（或失败/复用）的任务
   */
  async submit(request: CreateAgentTaskRequest): Promise<AgentTaskDto> {
    // 群内派发先验群存在：否则任务跑完才发现结果无处可回（只 warn 一遍更难查）
    if (
      request.groupId !== undefined &&
      request.groupId !== "" &&
      this.groupSink?.hasGroup !== undefined &&
      !this.groupSink.hasGroup(request.groupId)
    ) {
      throw new Error(`群不存在: ${request.groupId}`);
    }
    if (request.claimPolicy === "pool") return this.submitToPool(request);
    const target = this.resolveDispatchTarget(request);
    const { task, reused } = this.store.create({
      runtime: target.runtime,
      ...(target.agentId === undefined ? {} : { agentId: target.agentId }),
      content: request.content,
      cwd: request.cwd ?? this.defaultCwd,
      ...(request.fromSession === undefined ? {} : { fromSession: request.fromSession }),
      ...(request.groupId === undefined ? {} : { groupId: request.groupId }),
      ...(request.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: request.idempotencyKey }),
    });
    if (reused) {
      log.info("submit", `幂等键命中，复用任务 ${task.id}（${task.status}）`);
      return toTaskDto(task);
    }
    // 不阻塞 HTTP：派发在后台跑，进度经事件流 / SSE 推给调用方
    this.startDispatch(task.id);
    return toTaskDto(this.store.get(task.id) ?? task);
  }

  /**
   * 把任务放进池子（P3-1）：只落库，不派发。
   *
   * 与点名派发刻意不同：池任务允许不指定 `agent` / `runtime` —— 谁来干、在哪跑，
   * 由认领时按认领人的绑定解析（`claimTask()`）。指定了 `runtime` 就是「限定这类
   * 运行时」，认领时不会再改。
   *
   * @param request - 建池任务请求
   * @returns `created` 状态的池任务
   */
  private submitToPool(request: CreateAgentTaskRequest): AgentTaskDto {
    const poolScope = request.poolScope?.trim() ?? "";
    if (poolScope !== "") {
      const hasSquad = this.poolScope?.hasSquad;
      if (hasSquad !== undefined && !hasSquad(poolScope)) {
        throw new TaskClaimError("squad_not_found", `小队不存在: ${poolScope}`, 404);
      }
    }
    const runtime = request.runtime?.trim() ?? "";
    if (runtime !== "" && !this.registry.get(runtime)) {
      throw new TaskClaimError("runtime_not_found", `未注册的 runtime: ${runtime}`, 404);
    }
    const { task, reused } = this.store.create({
      runtime,
      content: request.content,
      cwd: request.cwd ?? this.defaultCwd,
      claimPolicy: "pool",
      ...(poolScope === "" ? {} : { poolScope }),
      ...((request.skillTags ?? []).length === 0 ? {} : { skillTags: request.skillTags }),
      ...(request.fromSession === undefined ? {} : { fromSession: request.fromSession }),
      ...(request.groupId === undefined ? {} : { groupId: request.groupId }),
      ...(request.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: request.idempotencyKey }),
    });
    if (reused) log.info("submit", `幂等键命中，复用池任务 ${task.id}（${task.status}）`);
    return toTaskDto(task);
  }

  /**
   * 解析派单目标：`agent` 优先（按绑定关系），否则退回 `runtime`（旧契约）。
   *
   * @throws {AgentRuntimeBindingError} agent 不存在/已归档/未绑 runtime/无可用 runtime
   */
  private resolveDispatchTarget(request: CreateAgentTaskRequest): {
    runtime: string;
    agentId?: string;
  } {
    const agentId = request.agent?.trim() ?? "";
    if (agentId !== "") {
      if (!this.agentRegistry) {
        throw new AgentRuntimeBindingError(
          "agent_not_found",
          "智能体能力未装配（缺少 agentRegistry）",
          404,
        );
      }
      const agent = this.agentRegistry.get(agentId);
      if (!agent) {
        throw new AgentRuntimeBindingError("agent_not_found", `智能体不存在: ${agentId}`);
      }
      const resolution = resolveRuntimeForAgent(agent, this.listRuntimes());
      if (!resolution.ok) {
        throw new AgentRuntimeBindingError(resolution.code, resolution.message);
      }
      return { runtime: resolution.runtime.name, agentId: agent.id };
    }
    const runtime = request.runtime?.trim() ?? "";
    if (runtime === "") throw new Error("runtime 或 agent 必填");
    return { runtime };
  }

  /**
   * 起一次后台派发并登记在飞表（`close()` 会等它们收尾，避免关库后还有写入）。
   *
   * @param id - 任务 id
   */
  private startDispatch(id: string): void {
    const running = this.dispatch(id)
      .catch((err: unknown) => {
        log.error(
          "dispatch",
          `任务 ${id} 派发异常: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.inflight.delete(id);
      });
    this.inflight.set(id, running);
  }

  /**
   * 建任务并等它到终态（`dispatch_task` 工具用：结果要回流到当前会话）。
   *
   * @param request - 派发请求
   * @param timeoutMs - 等待上限（默认 10 分钟）
   * @returns 终态任务（超时返回当前状态，不抛错）
   */
  async dispatchAndWait(
    request: CreateAgentTaskRequest,
    timeoutMs = this.promptTimeoutMs,
  ): Promise<AgentTaskDto> {
    const created = await this.submit(request);
    if (isTerminalTaskStatus(created.status)) return created;
    return this.waitForTerminal(created.id, timeoutMs);
  }

  /**
   * 取消（非终态才可取消）：先通知目标侧 `session/cancel`，再关闭客户端打断等待。
   *
   * @param id - 任务 id
   */
  cancel(id: string): AgentTaskDto {
    const task = this.store.get(id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`任务 ${id} 已是终态（${task.status}），不能取消`);
    }
    const active = this.active.get(id);
    if (active) {
      active.cancelled = true;
      active.driver.cancel();
      // 关闭驱动打断在飞的 prompt 请求（否则要等目标侧回 stopReason）
      void active.driver.close(300).catch(() => undefined);
    }
    const next = this.transit(id, "cancelled", { detail: "用户取消" });
    this.notifyTerminal(id);
    // 与 replied/failed 一致：取消也要回群一张卡（否则群里只看到任务派过、看不到被停）
    const finished = this.store.get(id);
    if (finished) this.publishToGroup(finished);
    return toTaskDto(next);
  }

  /**
   * 重试：终态任务 → 新 attempt（同一 taskId，事件流留痕 `task/retried`）。
   *
   * @param id - 任务 id
   */
  retry(id: string): AgentTaskDto {
    const task = this.store.get(id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    const reset = this.store.resetForRetry(id);
    // resetForRetry 已经写了 `task/retried`（旁路事件，不是状态转移）—— 这里补推事件帧，
    // 再看实时时间线的客户端不会漏掉「重试」这一条。
    const events = this.store.events(id);
    const retriedEvent = events[events.length - 1];
    if (retriedEvent && retriedEvent.type === "task/retried") {
      this.emit(id, { type: "event", event: toEventDto(retriedEvent) });
    }
    this.emit(id, { type: "status", task: toTaskDto(reset) });
    // 池任务重试 = 重新回池等认领，**不是**替它派发（那会绕过认领与 owner 归属）
    if (reset.claimPolicy === "pool") {
      log.info("retry", `池任务 ${id} 已退回任务池（attempt=${reset.attempt}）`);
      return toTaskDto(reset);
    }
    this.startDispatch(id);
    return toTaskDto(this.store.get(id) ?? reset);
  }

  /**
   * 等任务到终态。
   *
   * @param id - 任务 id
   * @param timeoutMs - 等待上限
   */
  async waitForTerminal(id: string, timeoutMs = 60_000): Promise<AgentTaskDto> {
    const current = this.store.get(id);
    if (!current) throw new Error(`任务不存在: ${id}`);
    if (isTerminalTaskStatus(current.status)) return toTaskDto(current);
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(id) ?? new Set<() => void>();
      const done = (): void => {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        set.delete(done);
        resolve();
      }, timeoutMs);
      set.add(done);
      this.waiters.set(id, set);
    });
    const latest = this.store.get(id);
    return toTaskDto(latest ?? current);
  }

  /** 订阅某任务的实时进度（SSE） */
  subscribe(id: string, listener: (event: AgentTaskStreamEvent) => void): () => void {
    const set = this.subscribers.get(id) ?? new Set();
    set.add(listener);
    this.subscribers.set(id, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.subscribers.delete(id);
    };
  }

  /**
   * 旁路事件：任务进入等待审批（`task/blocked`）。
   *
   * 不改 7 态状态机（执行侧本来就是「这一轮照常结束」），只让时间线/SSE 能看到
   * 「它在等哪一笔裁决」；裁决回来后配一条 {@link noteUnblocked}。
   */
  noteBlocked(id: string, reason: string, ref?: string): void {
    if (!this.store.get(id)) return;
    this.appendEvent(
      id,
      "task/blocked",
      ref === undefined ? reason : `${reason}（approval=${ref}）`,
    );
  }

  /** 旁路事件：等待解除、续跑（`task/unblocked`） */
  noteUnblocked(id: string, note?: string): void {
    if (!this.store.get(id)) return;
    this.appendEvent(id, "task/unblocked", note);
  }

  /**
   * 收尾上一进程遗留的非终态任务（服务启动时调用一次）。
   *
   * - `created`（从未派发）→ `expired`：它已经错过了自己的派发窗口；
   * - **`created` 的池任务不动**：它本来就该在池子里等着被认领，不是遗留残局；
   * - `claimed`（认领了但没派出去）→ **`task/requeued` 退回池子**（`created`），
   *   不判死 —— 这是池任务与 assigned 任务恢复口径的关键差别；
   * - `dispatched` / `running` → `failed`：目标进程随服务一起没了，**不自动重跑**
   *   （重跑必须是显式 retry，副作用次数才可控）。
   *
   * @returns 被收尾的任务 id
   */
  recoverInterrupted(): string[] {
    const recovered: string[] = [];
    for (const task of this.store.listNonTerminal()) {
      if (task.claimPolicy === "pool" && task.status === "created") continue;
      if (task.status === "claimed") {
        const requeued = this.store.requeue(
          task.id,
          "服务重启时尚未派发（认领租约失效），退回任务池等重新认领",
        );
        if (requeued !== null) {
          recovered.push(task.id);
          log.info("recover", `池任务 ${task.id} claimed → created（退回池子）`);
        }
        continue;
      }
      const next: AgentTaskStatus = task.status === "created" ? "expired" : "failed";
      const detail =
        task.status === "created"
          ? "服务重启时尚未派发（转入 expired，可 retry）"
          : "服务重启，执行中断（未自动重跑，可 retry）";
      try {
        this.store.setStatus(task.id, next, { detail });
        recovered.push(task.id);
        log.info("recover", `任务 ${task.id} ${task.status} → ${next}`);
      } catch (err) {
        log.warn("recover", `任务 ${task.id} 收尾失败: ${String(err)}`);
      }
    }
    return recovered;
  }

  /** 关闭：回收所有在飞子进程、等在飞派发收尾，再关 SQLite 连接 */
  async close(): Promise<void> {
    if (this.leaseTimer !== undefined) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = undefined;
    }
    for (const [id, run] of this.active) {
      log.warn("close", `回收任务 ${id} 的子进程`);
      await run.driver.close(300).catch(() => undefined);
    }
    // 等在飞派发把 catch/finally 跑完，否则它们会在关库之后再写一次
    await Promise.all([...this.inflight.values()]);
    this.active.clear();
    this.subscribers.clear();
    this.store.close();
  }

  // ──────────────────────────────────────────────
  // 派发实现
  // ──────────────────────────────────────────────

  /**
   * 派发一个已存在的任务（`created` / 重试重置后）到终态。
   *
   * `submit()` 会自动调用它；单独暴露是给「恢复/补派」用（也便于测试直接驱动）。
   *
   * @param id - 任务 id
   */
  async dispatch(id: string): Promise<void> {
    const task = this.store.get(id);
    if (!task || isTerminalTaskStatus(task.status)) return;
    // 池任务在没人认领前不派发：它可能没写死 runtime、也没有归属 agent，
    // 直接 spawn 会把「谁领的活」这件事绕过去。
    if (task.claimPolicy === "pool" && task.status === "created") {
      log.debug("dispatch", `池任务 ${id} 尚未认领，跳过派发`);
      return;
    }

    const entry = this.registry.get(task.runtime);
    if (!entry) {
      this.fail(id, `未注册的 runtime: ${task.runtime}`);
      return;
    }
    if (!entry.enabled) {
      this.fail(id, `runtime 已停用: ${task.runtime}`);
      return;
    }

    // ① 绑定围栏（P0）：派单时把 runtime 写死进任务；执行前再校验一次。
    //    改绑后旧任务不会跑到新配置上 —— 直接 failed(runtime_rebound)，提示重派。
    if (task.agentId !== undefined) {
      const agent = this.agentRegistry?.get(task.agentId);
      if (!agent) {
        this.fail(id, `智能体不存在: ${task.agentId}`);
        return;
      }
      if (agent.archivedAt !== undefined) {
        this.fail(id, `智能体已归档，不能派单: ${task.agentId}`);
        return;
      }
      const allowed = new Set(
        [agent.runtime, ...agent.runtimeFallbacks].filter(
          (name): name is string => typeof name === "string" && name !== "",
        ),
      );
      if (!allowed.has(task.runtime)) {
        this.fail(
          id,
          `runtime 已改绑（任务 ${task.runtime} → 智能体 ${agent.id} 现绑 ${agent.runtime ?? "未绑定"}），请重新派单`,
        );
        return;
      }
    }

    // ② 幂等闸：同一 attempt 只允许真正执行一次
    const operationKey = `agent-task:${task.id}:attempt-${task.attempt}`;
    const operationId = generateId();
    if (this.ledger) {
      const existing = this.ledger.begin({
        operationId,
        operationKey,
        toolName: "dispatch_task",
        sessionId: task.fromSession,
        taskId: task.id,
        input: { runtime: task.runtime, content: task.content, attempt: task.attempt },
        startedAt: this.now(),
      });
      if (existing.operationId !== operationId) {
        if (existing.status === "succeeded") {
          const replayed =
            typeof existing.resultJson === "object" && existing.resultJson !== null
              ? (existing.resultJson as { text?: unknown }).text
              : undefined;
          // 上一轮真的派过（否则台账里不会有 succeeded）→ 补一条 dispatched 再收尾，
          // 事件流才与 7 态表一致（created → dispatched → replied）。
          this.transit(id, "dispatched", {
            detail: "幂等台账命中（该 attempt 已派发过）",
          });
          this.finish(id, "replied", {
            result: typeof replayed === "string" ? replayed : "",
            detail: "幂等台账命中（该 attempt 已执行过），直接回放结果",
          });
          return;
        }
        this.fail(
          id,
          `副作用未决（台账 ${existing.status}）：该 attempt 可能已执行过，需人工核对后再 retry`,
        );
        return;
      }
    }

    // ③ 派发（可用性由这一次真 spawn 验证，不额外探测 —— dsh 冷启 13s，翻倍不划算）
    this.transit(id, "dispatched", {
      detail: `command=${entry.command} ${(entry.args ?? []).join(" ")} protocol=${entry.protocol ?? "acp"}`,
    });

    const driver = createRuntimeDriver(entry, {
      cwd: task.cwd,
      requestTimeoutMs: this.requestTimeoutMs,
      promptTimeoutMs: this.promptTimeoutMs,
      ...(entry.env ? { env: entry.env } : {}),
      ...(entry.args ? { extraArgs: entry.args } : {}),
      onLog: (level, message) => log[level]("dispatch", `${task.id}: ${message}`),
    });
    const run: ActiveRun = { driver, cancelled: false };
    this.active.set(id, run);

    let text = "";
    try {
      const handshake = await driver.initialize();
      // 建会话：上一 attempt 留下 acpSessionId 且目标声明了 resume 能力 → 续聊同一个
      // 目标会话（ACP 带全参；claude 带 --resume）；否则新建。
      const opened = await driver.openSession(task.acpSessionId);
      this.appendEvent(
        id,
        "task/accepted",
        `握手成功 agent=${handshake.agentName || "?"} v${handshake.agentVersion || "?"}` +
          ` resume=${handshake.capabilities.resume}；会话 ${opened.mode}=${opened.sessionId || "(pending)"}` +
          (opened.fallbackReason === undefined ? "" : `（resume 回退：${opened.fallbackReason}）`),
      );
      this.transit(id, "running", {
        ...(opened.sessionId === "" ? {} : { acpSessionId: opened.sessionId }),
      });

      // 权限：ACP 按每次请求回调；claude 在 prompt 开始时合成一次「本运行内全部工具」
      // 的审批（同一 onPermission 通道）—— 两条路的决策口径因此完全一致。
      const entryPolicy = entry.permissionPolicy;

      const result = await driver.prompt(
        // P1：智能体派单先注入 instructions + 挂载技能；按 runtime 直派保持原样
        task.agentId === undefined
          ? task.content
          : (this.composePrompt?.(task.agentId, task.content) ?? task.content),
        {
        onChunk: (chunk) => {
          text += chunk;
          this.emit(id, { type: "chunk", text: chunk });
        },
        onPermission: (request) => {
          const decision: "allow" | "deny" =
            entryPolicy ??
            this.permissionPolicy({ taskId: id, runtime: task.runtime, request });
          this.appendEvent(
            id,
            "task/stream-chunk",
            `[permission] ${request.title ?? request.toolCallId ?? "tool"} → ${decision}`,
          );
          return decision;
        },
      });

      // claude 这类「跑完才知道 session_id」的协议：补记到任务上，供下次 retry 续聊
      const finalSessionId = driver.lastSessionId;
      if (finalSessionId !== undefined && finalSessionId !== task.acpSessionId) {
        this.store.setAcpSessionId(id, finalSessionId);
      }

      text = result.text.length > 0 ? result.text : text;
      if (run.cancelled || result.stopReason === "cancelled") {
        this.finish(id, "cancelled", { detail: "目标侧回报 cancelled" });
        return;
      }
      if (this.ledger) {
        this.ledger.complete(operationId, {
          digest: digestResult(text, false),
          json: { text, stopReason: result.stopReason },
          finishedAt: this.now(),
        });
      }
      this.finish(id, "replied", { result: text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.ledger) this.ledger.fail(operationId, message, this.now());
      const current = this.store.get(id);
      if (current && !isTerminalTaskStatus(current.status)) {
        if (run.cancelled) {
          this.finish(id, "cancelled", { detail: "用户取消（驱动已关闭）" });
        } else {
          const tail = driver.stderrTail();
          this.fail(id, tail === "" ? message : `${message}；stderr: ${tail}`);
        }
      }
    } finally {
      // 只清自己这一条：retry 会在同一个 taskId 上起新 run，别把新的删掉
      if (this.active.get(id) === run) this.active.delete(id);
      await driver.close(1000).catch(() => undefined);
    }
  }

  /** 收尾为 replied / cancelled（写结果 + 终态事件 + 终态状态 + 回群 + 唤醒等待者） */
  private finish(
    id: string,
    status: Extract<AgentTaskStatus, "replied" | "cancelled">,
    patch: { result?: string; detail?: string },
  ): void {
    const current = this.store.get(id);
    if (!current || isTerminalTaskStatus(current.status)) return;
    this.transit(id, status, patch);
    this.notifyTerminal(id);
    const finished = this.store.get(id);
    if (finished) this.publishToGroup(finished);
  }

  /** 收尾为 failed */
  private fail(id: string, error: string): void {
    const current = this.store.get(id);
    if (!current || isTerminalTaskStatus(current.status)) return;
    log.warn("dispatch", `任务 ${id} 失败: ${error.slice(0, 300)}`);
    this.transit(id, "failed", { error, detail: error.slice(0, 200) });
    this.notifyTerminal(id);
    const finished = this.store.get(id);
    if (finished) this.publishToGroup(finished);
  }

  /**
   * 结果回群（G2）：任务终态时把结果以 `task_card` 写回 `task.groupId` 指向的群。
   *
   * 由服务端代写（`fromKind=runtime` + `agentTaskId` 深链），不依赖目标 agent 自觉；
   * 群侧失败只 warn，不影响任务本身已经收尾的事实。
   *
   * @param task - 已到终态的任务
   */
  private publishToGroup(task: AgentTaskRecord): void {
    const groupId = task.groupId;
    if (groupId === undefined || groupId === "" || this.groupSink === undefined) return;
    const content = groupCardContent(task);
    try {
      this.groupSink.postRuntimeMessage(groupId, {
        runtime: task.runtime,
        content,
        agentTaskId: task.id,
        kind: "task_card",
      });
    } catch (err) {
      log.warn(
        "group",
        `任务 ${task.id} 结果回群失败（group=${groupId}）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 推进状态并**按顺序推两帧**：先 `event`（`task/<status>`），再 `status`。
   *
   * SSE 路由收到终态 `status` 帧就会结束流，所以终态事件帧必须在它之前发出去 ——
   * 否则实时时间线里只有状态没有事件（F 段 P0：终态事件不推送）。
   */
  private transit(
    id: string,
    next: AgentTaskStatus,
    patch: {
      detail?: string;
      result?: string;
      error?: string;
      acpSessionId?: string;
      attempt?: number;
    } = {},
  ): AgentTaskRecord {
    const { task, event } = this.store.transition(id, next, patch);
    if (event) this.emit(id, { type: "event", event: toEventDto(event) });
    this.emit(id, { type: "status", task: toTaskDto(task) });
    return task;
  }

  /** 写一条旁路事件并推送 */
  private appendEvent(id: string, type: AgentTaskEventRow["type"], detail?: string): void {
    const row = this.store.appendEvent(id, type, detail);
    this.emit(id, { type: "event", event: toEventDto(row) });
  }

  private emit(id: string, event: AgentTaskStreamEvent): void {
    for (const listener of this.subscribers.get(id) ?? []) {
      try {
        listener(event);
      } catch (err) {
        log.warn("sse", `订阅者回调失败: ${String(err)}`);
      }
    }
  }

  private notifyTerminal(id: string): void {
    for (const waiter of this.waiters.get(id) ?? []) waiter();
    this.waiters.delete(id);
  }

  /** runtime → 近 24h 任务数 */
  private taskCounts(): Map<string, number> {
    const since = this.now() - 24 * 60 * 60 * 1000;
    const counts = new Map<string, number>();
    for (const entry of this.registry.entries()) {
      counts.set(entry.name, this.store.countSince(entry.name, since));
    }
    return counts;
  }
}

/** 任务记录 → API DTO（毫秒时间戳转 ISO） */
export function toTaskDto(task: AgentTaskRecord): AgentTaskDto {
  const durationMs =
    task.finishedAt === undefined ? undefined : task.finishedAt - task.createdAt;
  return {
    id: task.id,
    fromSession: task.fromSession,
    runtime: task.runtime,
    ...(task.agentId === undefined ? {} : { agentId: task.agentId }),
    status: task.status,
    content: task.content,
    ...(task.result === undefined ? {} : { result: task.result }),
    ...(task.error === undefined ? {} : { error: task.error }),
    createdAt: new Date(task.createdAt).toISOString(),
    ...(task.dispatchedAt === undefined
      ? {}
      : { dispatchedAt: new Date(task.dispatchedAt).toISOString() }),
    ...(task.startedAt === undefined
      ? {}
      : { startedAt: new Date(task.startedAt).toISOString() }),
    ...(task.finishedAt === undefined
      ? {}
      : { finishedAt: new Date(task.finishedAt).toISOString() }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(task.acpSessionId === undefined ? {} : { acpSessionId: task.acpSessionId }),
    ...(task.groupId === undefined ? {} : { groupId: task.groupId }),
    claimPolicy: task.claimPolicy,
    ...(task.poolScope === undefined ? {} : { poolScope: task.poolScope }),
    ...(task.skillTags === undefined ? {} : { skillTags: task.skillTags }),
    ...(task.claimedAt === undefined
      ? {}
      : { claimedAt: new Date(task.claimedAt).toISOString() }),
    ...(task.leaseExpiresAt === undefined
      ? {}
      : { leaseExpiresAt: new Date(task.leaseExpiresAt).toISOString() }),
  };
}

/** 池任务 → 可认领视图（`GET ?claimable=1`） */
export function toClaimableDto(task: AgentTaskRecord): ClaimableTaskDto {
  return {
    id: task.id,
    content: task.content,
    claimPolicy: "pool",
    ...(task.poolScope === undefined ? {} : { poolScope: task.poolScope }),
    ...(task.skillTags === undefined ? {} : { skillTags: task.skillTags }),
    status: task.status,
    createdAt: new Date(task.createdAt).toISOString(),
  };
}

/** 池任务 → 池视图（`GET ?pool=1`，含已被认领/租约态） */
export function toPoolTaskDto(task: AgentTaskRecord, now: number): PoolTaskDto {
  return {
    ...toClaimableDto(task),
    ...(task.agentId === undefined ? {} : { claimedBy: task.agentId }),
    ...(task.claimedAt === undefined
      ? {}
      : { claimedAt: new Date(task.claimedAt).toISOString() }),
    ...(task.leaseExpiresAt === undefined
      ? {}
      : { leaseExpiresAt: new Date(task.leaseExpiresAt).toISOString() }),
    leaseExpired:
      task.leaseExpiresAt !== undefined &&
      task.leaseExpiresAt <= now &&
      task.status === "claimed",
  };
}

/**
 * 群卡片正文（G2）：任务终态时写进群的那条 `task_card` 消息。
 *
 * @param task - 已收尾的任务
 */
export function groupCardContent(task: AgentTaskRecord): string {
  const head = `任务 ${task.id.slice(0, 8)}（${task.runtime}）`;
  if (task.status === "replied") {
    const result = (task.result ?? "").trim();
    const body = result === "" ? "（空回复）" : result;
    return `${head}已完成：\n${truncate(body, 2000)}`;
  }
  if (task.status === "failed") {
    return `${head}失败：${truncate((task.error ?? "未知错误").trim(), 1500)}`;
  }
  if (task.status === "cancelled") {
    return `${head}已取消`;
  }
  return `${head}${task.status}`;
}

/** 截断（保留尾部提示，避免长输出刷屏群聊） */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…（已截断 ${text.length - limit} 字）`;
}

/** 事件行 → API DTO */
export function toEventDto(row: AgentTaskEventRow): AgentTaskEventDto {
  return {
    seq: row.seq,
    at: new Date(row.at).toISOString(),
    type: row.type,
    ...(row.detail === undefined ? {} : { detail: row.detail }),
  };
}
