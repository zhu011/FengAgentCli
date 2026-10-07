/**
 * @fengagent/agent — 任务恢复核对（未决调用 orphan 检测）
 *
 * 「加载会话 → 能不能接着跑」不能靠猜。本模块把三份事实摆在一起对账：
 *
 * 1. **消息历史**：有 tool-use 块但没有对应 tool-result 的调用（orphan）；
 * 2. **任务状态**：`pendingTools`（intent 已写、outcome 未写）里的待办工具；
 * 3. **副作用台账**：停在 `pending` / `unknown` 的操作记录。
 *
 * 三者必须一致才算「干净」：只要存在**非幂等**工具的未决记录，就判定
 * `canResumeAutomatically = false`，并把原因写进 `requiresConfirmation` ——
 * 调用方必须把这份清单摆给用户显式确认，不得自动继续（规范：结果 unknown
 * 必须显式确认，禁止静默重放）。
 *
 * 归因必须查**全量台账行**（`ledgerRows`），不能只看未决项：一条 intent 已写、
 * 步未结算的待办工具，其台账行可能是 `succeeded`（恢复会跳过）或 `failed`
 * （恢复会重跑）—— 只看未决项会把这两种情况都误报成「无台账行，重跑安全」，
 * 文案与真实恢复路径正好相反。
 */

import type {
  Message,
  OperationRecord,
  PendingToolCall,
  Session,
  TaskState,
} from "@fengagent/core";

/** 有 tool-use 无 tool-result 的调用 */
export interface OrphanToolCall {
  toolUseId: string;
  toolName: string;
  input: unknown;
  /** 发起该调用的助手消息 id */
  messageId: string;
}

/** 工具名 → 是否非幂等（缺省查不到时按「未知，需要确认」处理） */
export type SideEffectLookup = (toolName: string) =>
  | "none"
  | "idempotent"
  | "non-idempotent"
  | undefined;

/**
 * 从消息历史里找出「有 tool-use、无 tool-result」的调用。
 *
 * @param messages - 会话消息（按时间顺序）
 * @returns orphan 列表（按出现顺序）
 */
export function detectOrphanToolCalls(messages: readonly Message[]): OrphanToolCall[] {
  const resolved = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool-result") resolved.add(block.toolUseId);
    }
  }

  const orphans: OrphanToolCall[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== "tool-use") continue;
      if (resolved.has(block.id) || seen.has(block.id)) continue;
      seen.add(block.id);
      orphans.push({
        toolUseId: block.id,
        toolName: block.name,
        input: block.input,
        messageId: msg.id,
      });
    }
  }
  return orphans;
}

/** 会话恢复核对报告 */
export interface TaskRecoveryReport {
  taskId: string | null;
  sessionId: string;
  /** 任务状态（若存在） */
  state: TaskState | null;
  /** 重放 `task/*` 事件重建的状态（应与 state 零差异） */
  replayedState: TaskState | null;
  /** 有 tool-use 无 tool-result 的调用 */
  orphans: OrphanToolCall[];
  /** intent 已写、outcome 未写的待办工具 */
  pendingTools: PendingToolCall[];
  /** 台账里未结算的操作（pending / unknown） */
  unresolvedOperations: OperationRecord[];
  /** 本会话的**全量**台账行（三态归因用；含 succeeded / failed） */
  ledgerRows: OperationRecord[];
  /** 是否可自动继续 */
  canResumeAutomatically: boolean;
  /** 必须人工确认的原因（空数组 = 无需确认） */
  requiresConfirmation: string[];
  /** 无阻塞但不该静默丢弃的观察项 */
  notes: string[];
}

/** 恢复核对所需的最小存储契约（TaskStore 满足；测试可注入假实现） */
export interface RecoveryStoreLike {
  getTask(taskId: string): TaskState | null;
  getTaskBySession(sessionId: string): TaskState | null;
  replay(taskId: string): TaskState | null;
  ledger: {
    listPending(): OperationRecord[];
    listBySession(sessionId: string): OperationRecord[];
  };
}

/**
 * 生成会话恢复核对报告。
 *
 * @param store - 任务状态仓（含台账）
 * @param session - 待恢复会话
 * @param sideEffectOf - 工具副作用查询（缺省按台账记录里的工具名无法判定时保守处理）
 * @returns 核对报告
 */
export function buildTaskRecoveryReport(
  store: RecoveryStoreLike,
  session: Session,
  sideEffectOf?: SideEffectLookup,
): TaskRecoveryReport {
  const state = store.getTaskBySession(session.id);
  const replayedState = state ? store.replay(state.taskId) : null;
  const orphans = detectOrphanToolCalls(session.messages);
  const pendingTools = state?.pendingTools ?? [];
  const unresolvedOperations = store.ledger
    .listBySession(session.id)
    .filter((op) => op.status === "pending" || op.status === "unknown");
  // 三态归因必须看全量台账行：只看未决项会把已 succeeded / failed 的行误判成
  // 「无台账行」，文案与真实恢复路径反向。
  const ledgerRows = store.ledger.listBySession(session.id);

  const requiresConfirmation: string[] = [];
  const notes: string[] = [];

  for (const op of unresolvedOperations) {
    const kind = sideEffectOf?.(op.toolName);
    if (kind === "idempotent") continue; // 幂等：可安全重放，不打扰用户
    if (kind === "none") continue; // 无副作用：重放无外部效果
    requiresConfirmation.push(
      `副作用操作 ${op.toolName}（operation_key=${op.operationKey}）结果 unknown` +
        `（status=${op.status}）：可能已生效，需人工核对后再决定跳过或重放。`,
    );
  }

  // pending_tools 里有、但台账没有任何记录的调用：台账在 executor 里紧挨着
  // 副作用之前写，因此「有 intent、无台账行」只能说明进程**在开始这一步的
  // 副作用之前**就死了 —— 安全，重跑一次即可，不作为阻塞项，但要留痕。
  //
  // 台账**有行**时按三态归因，绝不套用「无台账行」的文案：
  //   succeeded → 已成功，恢复跳过；failed → 上次失败，恢复重跑；
  //   pending / unknown → 上面 unresolvedOperations 已经写过确认项。
  for (const pending of pendingTools) {
    if (pending.sideEffect === "none") continue;
    const ledgerRow = pending.operationKey
      ? latestLedgerRow(ledgerRows, pending.operationKey)
      : null;
    if (ledgerRow) {
      if (ledgerRow.status === "succeeded") {
        notes.push(
          `待办工具 ${pending.toolName}（operation_key=${pending.operationKey}）台账已 succeeded：` +
            `副作用的最终结果已记录，恢复时命中台账**跳过**重复执行（不重跑）。`,
        );
      } else if (ledgerRow.status === "failed") {
        notes.push(
          `待办工具 ${pending.toolName}（operation_key=${pending.operationKey}）台账上次 failed：` +
            `失败不等于已生效，恢复时**重跑**该步。`,
        );
      }
      continue;
    }
    notes.push(
      `待办工具 ${pending.toolName}（stepId=${pending.stepId}）已写入 intent 但无台账行：` +
        `判定为「副作用开始前中断」，重跑安全。`,
    );
  }

  // 有 orphan 且是写外部系统的工具，但台账里连记录都没有：
  // 说明调用方没走台账（工具未声明副作用 / 未注入台账），恢复时无从判断，
  // 同样需要显式确认，绝不自动重放。
  for (const orphan of orphans) {
    const kind = sideEffectOf?.(orphan.toolName);
    if (kind === "none" || kind === "idempotent") continue;
    const tracked = ledgerRows.some((op) => op.toolName === orphan.toolName);
    if (tracked) continue;
    requiresConfirmation.push(
      `orphan 工具调用 ${orphan.toolName}（toolUseId=${orphan.toolUseId}）无对应工具结果，` +
        `且副作用类别未声明 —— 结果未知，需人工核对该调用是否已生效。`,
    );
  }

  return {
    taskId: state?.taskId ?? null,
    sessionId: session.id,
    state,
    replayedState,
    orphans,
    pendingTools,
    unresolvedOperations,
    ledgerRows,
    canResumeAutomatically: requiresConfirmation.length === 0,
    requiresConfirmation,
    notes,
  };
}

/**
 * 按幂等键取最新一条台账行（与 `SqliteOperationLedger.lookup` 同口径：
 * `started_at` 降序取首条）。
 *
 * @param rows - 会话全量台账行
 * @param operationKey - 幂等键
 * @returns 命中的最新一行；无命中返回 null
 */
function latestLedgerRow(
  rows: readonly OperationRecord[],
  operationKey: string,
): OperationRecord | null {
  let latest: OperationRecord | null = null;
  for (const row of rows) {
    if (row.operationKey !== operationKey) continue;
    if (!latest || row.startedAt >= latest.startedAt) latest = row;
  }
  return latest;
}
