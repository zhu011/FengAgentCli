/**
 * @fengagent/web-ui — API 类型定义
 *
 * 镜像 @fengagent/core 的类型，供前端使用。
 * 这些类型与服务端 API 返回的 JSON 结构一致。
 */

// ──────────────────────────────────────────────
// 消息类型（镜像 core/types.ts）
// ──────────────────────────────────────────────

export type Role = "user" | "assistant" | "system";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface ToolUseBlock {
  type: "tool-use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool-result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  id: string;
  role: Role;
  content: ContentBlock[];
  createdAt: number;
}

// ──────────────────────────────────────────────
// 会话类型（镜像 core/session.ts）
// ──────────────────────────────────────────────

export type SessionState = "idle" | "running" | "error";

export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  status: SessionState;
  tokenCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Session extends SessionMeta {
  messages: Message[];
}

// ──────────────────────────────────────────────
// AgentEvent（镜像 core/event.ts）
// ──────────────────────────────────────────────

export interface AgentError {
  message: string;
  code?: string;
  stack?: string;
}

export type FinishReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop"
  | "error";

export type AgentEvent =
  | { type: "session-start"; session: Session }
  | { type: "message-start"; messageId: string; role: Role }
  | { type: "text-delta"; messageId: string; text: string }
  | { type: "thinking-delta"; messageId: string; text: string }
  | {
      type: "tool-call-start";
      toolUseId: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool-call-result";
      toolUseId: string;
      result: { content: string; isError?: boolean; metadata?: unknown };
      /** 实际执行的入参 — 与模型原始入参不同时携带（用户改参后执行） */
      input?: unknown;
    }
  | { type: "message-end"; messageId: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number }
  | { type: "turn-end"; reason: FinishReason }
  | { type: "error"; error: AgentError }
  | { type: "compaction-start" }
  | { type: "compaction-end"; summary: string }
  | { type: "session-end" };

// ──────────────────────────────────────────────
// 模型
// ──────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface ModelsResponse {
  models: ModelInfo[];
}

// ──────────────────────────────────────────────
// 权限请求
// ──────────────────────────────────────────────

export interface PermissionRequest {
  reqId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  reason?: string;
}

export type PermissionResult =
  | { decision: "allow"; input?: unknown }
  | { decision: "deny"; reason?: string };

/** permissions.json 里的一条永久规则 */
export interface PermanentPermissionRule {
  tool: string;
  action: "allow" | "deny" | "ask";
  reason?: string;
}

/** 全局权限规则视图（Permissions 面板展示与撤销用） */
export interface PermissionGrants {
  permanent: PermanentPermissionRule[];
  /** 永久规则文件路径（相对 workdir） */
  path: string;
  /** 规则所属工作目录（未接规则面时为 null） */
  workdir: string | null;
}

// ──────────────────────────────────────────────
// 对话图（镜像 @fengagent/graph，Phase 3/4 分支可视化）
// ──────────────────────────────────────────────

export type ConversationNodeType =
  | "user"
  | "assistant"
  | "tool"
  | "branch-point";

export type NodeQuality = "good" | "poor" | "unrated";

/** 回退粒度：turn=轮级（既有语义）；step=步级续跑 */
export type RollbackGranularity = "turn" | "step";

/** 工具入参改写记录（改参可溯源：原始入参 → 实际执行入参） */
export interface ToolInputCorrection {
  toolUseId: string;
  toolName: string;
  originalInput: unknown;
  correctedInput: unknown;
  source?: "hitl" | "graph";
  seq?: number;
  timestamp?: string;
}

export interface ConversationNodeMeta {
  model?: string;
  toolCalls?: Array<{ id: string; name: string }>;
  tokenCount?: number;
  llmTraceId?: string;
  quality?: NodeQuality;
  qualityNote?: string;
  branch?: string;
  active?: boolean;
  rolledBack?: boolean;
  /** 该节点内的工具有过「用户改参后执行」（图上标「✏️ 已改参」） */
  userCorrectedInput?: boolean;
  /** 改参明细（改参前后可溯源） */
  inputCorrections?: ToolInputCorrection[];
  /** 分支点粒度：true=步级续跑（回退点在一轮之内） */
  stepLevel?: boolean;
}

export interface ConversationNode {
  id: string;
  conversationId: string;
  type: ConversationNodeType;
  messageId: string;
  parentId: string | null;
  childrenIds: string[];
  createdAt: number;
  meta: ConversationNodeMeta;
}

export interface GraphData {
  nodes: ConversationNode[];
  activePath: ConversationNode[];
  activeHead: ConversationNode | undefined;
  chain: ConversationNode[];
}

export interface RollbackResponse {
  ok: boolean;
  message: string;
  target?: ConversationNode;
  rollbackToNode?: ConversationNode;
  truncatedToMessageId?: string;
  graph?: GraphData;
}

// ──────────────────────────────────────────────
// 可观测性（AgentLoop 观测面板）— 镜像 server/routes/observability.ts
// ──────────────────────────────────────────────

/** 单个 trace 日志文件元信息 */
export interface TraceFileMeta {
  date: string;
  path: string;
  size: number;
  records: number;
  sessions: number;
  models: string[];
  modifiedAt: string;
}

/** 调用链：工具节点 */
export interface CallChainToolNode {
  name: string;
  input: unknown;
  result: { content: string; isError?: boolean } | null;
  durationMs?: number;
  timestamp: string;
  isError?: boolean;
}

/** 调用链：LLM 调用节点 */
export interface CallChainLlmNode {
  index: number;
  model: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  finishReason?: string;
  error?: string | null;
  responseText?: string;
  hasToolCalls: boolean;
}

/** 调用链：用户消息节点 */
export interface CallChainUserNode {
  text: string;
}

/** 调用链步骤（用户消息或 LLM 调用；工具为 LLM 子节点） */
export interface CallChainStep {
  id: string;
  kind: "user" | "llm";
  timestamp: string;
  user?: CallChainUserNode;
  llm?: CallChainLlmNode;
  tools: CallChainToolNode[];
  /** 该 LLM 调用对应的助手消息 ID（用户步骤无此字段；per-message 查询用） */
  messageId?: string;
}

/** 单个会话的完整调用链 */
export interface CallChainSession {
  sessionId: string;
  model: string;
  steps: CallChainStep[];
  /** 已完成（有 response 配对）的 LLM 调用次数 */
  llmCallCount: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  toolCallCount: number;
  errorCount: number;
}

/** 序列化分析结果（server 端 Map → 普通对象） */
export interface SerializedAnalysis {
  logFile: string;
  totalRecords: number;
  sessionCount: number;
  totalLlmCalls: number;
  totalDurationMs: number;
  avgDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  /** 含工具调用的响应轮次数（与 toolCallRate 同口径） */
  toolCallCount: number;
  toolCallRate: number;
  /** 真实工具调用次数（Σ toolUsage），与「工具使用分布」同口径 */
  toolInvocationCount: number;
  toolUsage: Record<string, number>;
  errorCount: number;
  errorRate: number;
  errors: string[];
  finishReasons: Record<string, number>;
  sessions: Array<{
    sessionId: string;
    model: string;
    requests: number;
    responses: number;
    totalDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    toolCallCount: number;
    toolNames: string[];
    errors: string[];
    finishReasons: string[];
  }>;
  models: string[];
  modelComparisons: Array<{
    model: string;
    totalCalls: number;
    /** 含工具调用的响应轮次数 */
    toolCallCount: number;
    /** 真实工具调用次数（Σ toolCalls），与工具使用分布同口径 */
    toolInvocationCount: number;
    toolSuccessCount: number;
    toolFailureCount: number;
    errorCount: number;
    errorRate: number;
    finishReasons: Record<string, number>;
    avgDurationMs: number;
    avgInputTokens: number;
    avgOutputTokens: number;
    toolSuccessRate: number;
    taskCompletionRate: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    cacheHitRate: number;
  }>;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  cacheHitRate: number;
}

/** 观测数据响应 */
export interface TraceAnalysisResponse {
  date: string;
  file: string;
  analysis: SerializedAnalysis;
  /** 因来源为测试/非生产而被排除的记录数（?includeTest=1 时为 0） */
  testRecordsExcluded?: number;
}

/** 调用链响应 */
export interface CallChainResponse {
  date: string;
  file: string;
  sessions: CallChainSession[];
  /** per-message 深链解析结果（?sessionId=X&messageId=Y 时返回） */
  focus?: {
    messageId: string;
    role: "user" | "assistant";
    resolvedMessageIds: string[];
    /** 旧格式日志（无 messageId）按文本匹配定位时为 true */
    legacyMatch?: boolean;
  } | null;
}

/** 按消息粒度的调用链摘要（/traces/:date/messages 与评测 per-message 视图消费） */
export interface MessageTraceSummary {
  messageId: string | null;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  llmCallCount: number;
  toolCallCount: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  error?: string | null;
}

/** 消息摘要响应（/traces/:date/messages?sessionId=X） */
export interface MessageTracesResponse {
  date: string;
  file: string;
  sessionId: string;
  messages: MessageTraceSummary[];
}

/** 单条消息评测响应（/eval/messages/:date?sessionId=X&messageId=Y） */
export interface MessageEvalResponse {
  date: string;
  sessionId: string;
  messageId: string;
  focus: {
    messageId: string;
    role: "user" | "assistant";
    resolvedMessageIds: string[];
    legacyMatch?: boolean;
  } | null;
  message: { role: "user" | "assistant"; text: string } | null;
  trace: {
    llmCallCount: number;
    toolCallCount: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    finishReasons: string[];
    errors: string[];
  } | null;
  /** 单条消息 LLM-judge 结果（judgeStatus=pending 时为 null，前端轮询等待） */
  judge: {
    messageId: string;
    sessionId: string;
    completionScore: number;
    correctnessScore: number;
    conclusion: string;
    note?: string;
  } | null;
  /**
   * judge 状态：
   * - cached     命中落盘缓存（未调用模型）
   * - fresh      本次请求内新评审完成
   * - pending    后台评审中（前端应轮询，稍后返回 cached）
   * - unavailable 未配置 LLM 客户端或该消息无 trace 步骤
   */
  judgeStatus: "cached" | "fresh" | "pending" | "unavailable";
}

// ──────────────────────────────────────────────
// 评测模块 — 镜像 server/routes/eval.ts
// ──────────────────────────────────────────────

export interface EvalReportMeta {
  date: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export interface OptimizationMeta {
  date: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export interface TestSetMeta {
  name: string;
  path: string;
  size: number;
  records: number;
  valid: boolean;
  shape: string;
}

export interface EvalOverview {
  reports: EvalReportMeta[];
  optimizations: OptimizationMeta[];
  testsets: TestSetMeta[];
}

export interface MarkdownReport {
  date: string;
  path: string;
  content: string;
}

// ──────────────────────────────────────────────
// Agents 外派能力（P2 API 契约 — 参见 AGE-35 方案）
// ──────────────────────────────────────────────

/** 外派任务状态机（7 态；终态：replied / failed / cancelled / expired） */
export type AgentTaskStatus =
  | "created"
  | "dispatched"
  | "running"
  | "replied"
  | "failed"
  | "cancelled"
  | "expired";

/** 已注册的外部 agent 运行时 */
export interface RuntimeInfo {
  /** 注册名（dispatch_task 的 agent 参数） */
  name: string;
  /** 启动命令（含参数，卡片展示用） */
  command: string;
  /** 纯命令（编辑表单回填用；后端未带时回退到 command） */
  executable?: string;
  /** 启动参数（编辑表单用；后端列表未带时缺省） */
  args?: string[];
  /** 启动协议（acp / claude-stream-json；编辑表单用） */
  protocol?: string;
  /** 追加环境变量（编辑表单用；后端列表未带时缺省） */
  env?: Record<string, string>;
  /** initialize 握手返回的 agentInfo */
  agentName: string;
  agentVersion: string;
  /** 能力（来自 initialize.agentCapabilities） */
  capabilities: {
    resume: boolean;
    loadSession: boolean;
    image: boolean;
  };
  /** 最近一次探测结果与时间 */
  probeStatus: "ok" | "unreachable" | "unprobed";
  probeError?: string;
  probedAt?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 最近 24h 任务数 */
  recentTaskCount: number;
}

/** runtime 注册条目的写入载荷（创建/编辑共用） */
export interface RuntimeEntryInput {
  /** 注册名（创建必填；编辑时以路径名为准不可改） */
  name: string;
  /** 可执行文件 */
  command: string;
  /** 参数 */
  args?: string[];
  /** 启动协议（默认 acp） */
  protocol?: "acp" | "claude-stream-json";
  /** 追加环境变量（凭据放这里） */
  env?: Record<string, string>;
  /** 是否启用 */
  enabled?: boolean;
}

/** 表单「探测验证」的候选项探测结果（不落盘） */
export interface RuntimeProbeResult {
  probeStatus: "ok" | "unreachable";
  /** 失败原因（后端返回什么就显示什么：命令不存在 / spawn 失败 / 协议不支持 / 凭据缺失…） */
  probeError?: string;
  agentName?: string;
  agentVersion?: string;
  capabilities?: {
    resume: boolean;
    loadSession: boolean;
    image: boolean;
  };
}

/* ─── 智能体（AI 团队平台 P0：agent 实体化，spec §5.1） ─── */

/** 智能体卡片（GET /api/agents 列表项） */
export interface AgentCard {
  /** 稳定 id（= agents/<id> 目录名，kebab-case） */
  id: string;
  /** 展示名 */
  displayName: string;
  description: string;
  /** 绑定的 runtime 注册名（未绑定 = null，可编辑但不能执行） */
  runtime: string | null;
  /** runtime 探测状态（未绑定时 unbound） */
  runtimeStatus: "online" | "offline" | "unprobed" | "unbound";
  /** 近 7 天 run 计数（列表快速口径） */
  runs7d: number;
  /** 近一次运行的状态摘要 */
  lastRunStatus: string | null;
  archived: boolean;
}

/** 概览指标（GET /api/agents/:id/overview） */
export interface AgentOverview {
  agent: {
    id: string;
    displayName: string;
    runtime: string | null;
    runtimeStatus: "online" | "offline" | "unprobed" | "unbound";
    probeStatus: string | null;
    probedAt: string | null;
  };
  counters: {
    runs7d: number;
    success7d: number;
    failed7d: number;
    avgDurationMs: number;
    tokens7d: number;
  };
  assets: { skills: number; mcps: number; integrations: number; envKeys: number };
  recentRuns: AgentRun[];
  lastError: { at: number; message: string } | null;
}

/** 运行历史条目（三路统一读模型：session / dispatch / group） */
export interface AgentRun {
  id: string;
  kind: "session" | "dispatch" | "group" | "squad";
  status: string;
  title: string;
  startedAt: string;
  durationMs: number | null;
}

/** 智能体详情（GET /api/agents/:id：配置聚合） */
export interface AgentDetail extends AgentCard {
  /** agent.md 正文（= instructions / system prompt） */
  instructions: string;
  model: string;
  env: Record<string, string>;
  envSecrets: Array<{ key: string; masked: string }>;
  args: string[];
  skills: string[];
  mcp: string[];
  permissionMode: "inherit" | "ask" | "allow" | "deny";
  visibility: "private" | "workspace";
}

/** 内置模板（P0：一键创建 agent） */
export interface AgentTemplate {
  id: string;
  displayName: string;
  description: string;
  instructions: string;
}

/** 创建/编辑载荷（POST/PATCH /api/agents） */
export interface AgentInput {
  id?: string;
  displayName?: string;
  description?: string;
  /** runtime 注册名；null = 解绑（历史保留） */
  runtime?: string | null;
  instructions?: string;
  model?: string;
  env?: Record<string, string>;
  args?: string[];
  permissionMode?: "inherit" | "ask" | "allow" | "deny";
  /** 从内置模板一键创建时后端用模板预填 instructions */
  template?: string;
}

/* ─── 负责人确认（P2：审批裁决面板，spec §5.2 负责人确认 + 上抛 + 审计） ─── */

/** 审批状态 */
export type ApprovalStatus = "pending" | "approved" | "denied" | "escalated" | "expired";

/** 授权范围（三档） */
export type ApprovalScope = "once" | "session" | "permanent";

/** 审批请求（GET /api/approvals 列表项） */
export interface ApprovalRequest {
  id: string;
  squadId?: string;
  squadTaskId?: string;
  /** 发起请求的成员（agent id） */
  agentId: string;
  toolName: string;
  /** 工具调用入参摘要（截断） */
  toolInput: string;
  reason: string;
  status: ApprovalStatus;
  /** 该找谁裁决：leader（队长）| human（人类发起人） */
  targetType: "leader" | "human";
  targetId?: string;
  createdAt: number;
  resolvedAt?: number;
  resolvedByType?: "agent" | "member" | "system";
  resolvedById?: string;
  note?: string;
}

/** 审计动作 */
export type ApprovalAuditAction = "request" | "approve" | "deny" | "escalate" | "consume" | "expire";

/** 审计行（谁、批哪次、scope） */
export interface ApprovalAuditEntry {
  id: string;
  approvalId: string;
  action: ApprovalAuditAction;
  actorType: "agent" | "member" | "system";
  actorId: string;
  scope?: ApprovalScope;
  note?: string;
  at: number;
}

/** 审批详情（GET /api/approvals/:id：请求 + 审计时间线；键为 request，对齐后端 squad-service.approvalDetail） */
export interface ApprovalDetail {
  request: ApprovalRequest;
  audit: ApprovalAuditEntry[];
}

/* ─── 小队（AI 团队平台 P2，spec §5.2） ─── */

/** 小队成员（agent 或人占位；role 自由文本） */
export interface SquadMember {
  /** agent | member（"member" 留给"人"占位） */
  memberType: "agent" | "member";
  memberId: string;
  role: string;
}

/** 小队（GET /api/squads/:id；列表为同形摘要） */
export interface SquadInfo {
  /** 稳定 id（kebab-case） */
  id: string;
  name: string;
  description: string;
  /** 队长（必须是成员之一；移除队长需先换） */
  leaderId: string;
  /** leader = 队长软编排（默认）；auto = 算法分配 */
  mode: "leader" | "auto";
  /** 小队级指令（briefing 追加在各成员指令后，不覆盖） */
  instructions: string;
  members: SquadMember[];
  archived: boolean;
}

/** 小队运行树节点（GET /api/squads/:id/runs；leader 父 + worker 子） */
export interface SquadRunNode {
  id: string;
  /** 执行成员（agent id） */
  assignee: string;
  status: string;
  title: string;
  /** 父 run（worker → leader）；根为 null */
  parentRunId: string | null;
  startedAt: string;
  /** 等待原因（status = waiting_approval 时有值，徽标旁说明） */
  blockedReason: string | null;
  /** 该 run 对应的执行任务 id（深链 /api/agent-tasks/:id） */
  agentTaskId: string | null;
}

/** 创建/编辑小队载荷 */
export interface SquadInput {
  id?: string;
  name?: string;
  description?: string;
  leaderId?: string;
  mode?: "leader" | "auto";
  instructions?: string;
}

/* ─── Skill 导入与挂载（AI 团队平台 P1，spec §5.3） ─── */

/** 导入来源类型（四路导入的后三路；手动创建走既有 POST /api/skills） */
export type SkillImportType = "local" | "url" | "runtime_copy";

/** 导入载荷 */
export interface SkillImportInput {
  type: SkillImportType;
  /** local：文件路径；url：https 地址 */
  path?: string;
  url?: string;
  /** runtime_copy：runtime 注册名 + 该 runtime skills 根里的技能名 */
  runtime?: string;
  name?: string;
  /** 同名冲突策略（url/local 导入） */
  onConflict?: "fail" | "overwrite" | "rename" | "skip";
}

/** 导入结果 */
export interface SkillImportResult {
  /** 落库的技能名（rename 冲突时与请求名不同） */
  name: string;
  /** 来源台账（skill-sources.json 里的一条） */
  source: {
    type: SkillImportType;
    url?: string;
    path?: string;
    runtime?: string;
    sha256: string;
    importedAt: string;
  };
}

/** agent 的 skill 挂载条目（GET /api/agents/:id/skills） */
export interface AgentSkillMount {
  name: string;
  enabled: boolean;
  /** 挂载来源（导入/创建时的来源类型） */
  source: string;
  /** 是否被更高优先层 shadow */
  shadowed: boolean;
}

/* ─── 团队级技能库（对齐 DSH 后端 4c67aca 契约；后端未落地时页面回退 mock） ─── */

/** 技能来源层（后端把内部 project 层对外统一叫 workdir） */
export type SkillSourceLayer = "builtin" | "team" | "workdir";

/** 被覆盖/覆盖了哪些层的明细（合并视图标注用） */
export interface SkillShadowedLayer {
  source: SkillSourceLayer;
  path?: string;
}

/** 技能条目（列表 / 合并视图 / 详情共用；详情另带 prompt 正文） */
export interface SkillInfo {
  name: string;
  description: string;
  /** 触发条件（给 LLM 的使用时机说明） */
  trigger: string;
  /** Prompt 模板正文（详情 / 「填入输入框」用；列表不带） */
  prompt?: string;
  /** 来源层（合并视图标注） */
  source: SkillSourceLayer;
  /** 是否启用（停用 = agent 侧不可见：skill 工具与 /skill 都不含） */
  enabled: boolean;
  /** 是否可在 UI 直接编辑（后端标 only-team；内置走「同名覆盖」、本目录走本地文件） */
  editable?: boolean;
  /** 团队层文件路径 */
  path?: string;
  /** 被哪个更高优先级层覆盖（逐层明细里用） */
  overriddenBy?: SkillSourceLayer;
  /** 当前条目覆盖了哪些低优先级层（合并视图里用） */
  shadowed?: SkillShadowedLayer[];
  bytes?: number;
  updatedAt?: string;
}

/** 技能库列表响应（GET /api/skills[?merge=1]） */
export interface SkillListView {
  /** 各层根目录（管理面展示「技能从哪来」） */
  roots: { team: string; project: string[] };
  /** 合并视图：每个名字一条胜出项（含已停用）；不带 merge 时只回团队层 */
  skills: SkillInfo[];
  /** 逐层明细：所有层定义（被覆盖的带 overriddenBy）——管理面主列表 */
  layers: SkillInfo[];
  /** 解析失败的文件 */
  errors: Array<{ path: string; message: string }>;
}

/** 技能写入载荷（创建/编辑共用；frontmatter .md 由后端拼装落盘） */
export interface SkillEntryInput {
  name: string;
  description: string;
  trigger: string;
  prompt: string;
  enabled?: boolean;
}

/** 外派任务事件（task_events 流的一行；对应 anet 任务详情的时间线） */
export interface AgentTaskEvent {
  seq: number;
  at: string;
  type:
    | "task/created"
    | "task/dispatched"
    | "task/accepted"
    | "task/running"
    | "task/stream-chunk"
    | "task/replied"
    | "task/failed"
    | "task/cancelled"
    | "task/expired"
    | "task/retried";
  detail?: string;
}

/** 外派任务（列表/详情共用；详情附事件流与流式输出） */
export interface AgentTask {
  id: string;
  /** 派发来源：本机会话 id（或 "dashboard" 表示界面发起） */
  fromSession: string;
  /** 目标 runtime 注册名 */
  runtime: string;
  status: AgentTaskStatus;
  content: string;
  /** 最终回复（replied 后有值） */
  result?: string;
  error?: string;
  createdAt: string;
  dispatchedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  /** 耗时（ms，终态后有值） */
  durationMs?: number;
  /** 目标侧 ACP sessionId（跨进程 resume 用） */
  acpSessionId?: string;
  /** 群内派发（G2）：任务所属群（团队上下文派单时带上） */
  groupId?: string;
}

export interface AgentTaskListResponse {
  tasks: AgentTask[];
  runtimes: RuntimeInfo[];
}

export interface AgentTaskDetailResponse {
  task: AgentTask;
  events: AgentTaskEvent[];
}

export interface AgentTaskCreateRequest {
  runtime: string;
  content: string;
  /** 可选：绑定本机会话（From 列显示） */
  fromSession?: string;
  /** 可选：群内派发（G2）——结果以 task_card 自动回群 */
  groupId?: string;
}

/** 任务流式进度（SSE：状态推进 + 输出块） */
export type AgentTaskStreamEvent =
  | { type: "status"; task: AgentTask }
  | { type: "chunk"; text: string }
  | { type: "event"; event: AgentTaskEvent };

export interface AgentTaskStreamRequest {
  taskId: string;
  signal?: AbortSignal;
}

// ──────────────────────────────────────────────
// 群聊（G1 契约 v1.0 — AGE-35）
// ──────────────────────────────────────────────

/** 群状态（G1 只有两种；后续阶段扩展） */
export type GroupStatus = "open" | "concluded";

/** 群信息（与后端 agent_groups 对外驼峰形状一致） */
export interface GroupInfo {
  id: string;
  name: string;
  description?: string;
  /** 成员 runtime 注册名（人隐含在场） */
  members: string[];
  status: GroupStatus;
  /** 发言模式（V2-3）：coordinated 协调者调度（缺省，v1）| free 自治直连 */
  speechMode?: "coordinated" | "free";
  /** 编排轮上限（G3 消费） */
  maxRounds: number;
  /** 静默超时（毫秒，G3）：超过即自动收口 */
  idleTimeoutMs: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
}

/** 群消息 */
export interface GroupMessage {
  id: string;
  groupId: string;
  /** 群内单调递增（SSE ?after= 依据） */
  seq: number;
  fromKind: "human" | "runtime" | "coordinator" | "system";
  fromName: string;
  content: string;
  kind: "chat" | "task_card" | "decision" | "system";
  /** 任务卡深链（G2 填） */
  agentTaskId?: string;
  createdAt: string;
}

export interface GroupListResponse {
  groups: GroupInfo[];
  /** 成员选择器用（复用 agent-runtimes 卡片形状） */
  runtimes: RuntimeInfo[];
}

export interface GroupDetailResponse {
  group: GroupInfo;
  messages: GroupMessage[];
}

export interface GroupCreateRequest {
  name: string;
  description?: string;
  members: string[];
  maxRounds?: number;
  /** 静默超时毫秒（默认 600000） */
  idleTimeoutMs?: number;
}

export interface GroupMessageRequest {
  content: string;
  /** `decision` = 拍板（群立即收口）；缺省 chat */
  kind?: "chat" | "decision";
}

/** 关停响应（G3）：群 + 被取消的任务 id 列表 */
export interface GroupStopResponse {
  group: GroupInfo;
  cancelledTasks: string[];
}

/** 群 SSE 事件（/api/groups/:id/stream?after=<seq>） */
export type GroupStreamEvent =
  | { type: "snapshot"; group: GroupInfo; messages: GroupMessage[]; lastSeq: number }
  | { type: "message"; message: GroupMessage }
  | { type: "group"; group: GroupInfo }
  | { type: "heartbeat" };

/* ══════════════════ 插件管理 / 插件市场（/api/plugins） ══════════════════ */

/** 已装插件条目（GET /api/plugins，docs/PLUGINS.md 契约） */
export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  source: string;
  installedAt?: string;
  entry?: string;
  bundleUrl?: string;
  assetsBase?: string;
  slots?: string[];
  hasWebui?: boolean;
  /** 展示用来源（市场安装为 `market:<name>`） */
  sourceLabel?: string;
  /** 协议探测结果（webui / dsh / cordis / unknown） */
  protocol?: string;
  error?: string;
}

/** GET /api/plugins 响应 */
export interface PluginsListResponse {
  plugins: PluginListEntry[];
  errors: Array<{ id: string; error: string }>;
  pluginsRoot: string;
  revision: number;
  restartRequired: boolean;
}

/** install / enable / disable / uninstall 的统一响应 */
export interface PluginMutationResult {
  plugin: PluginListEntry;
  revision: number;
  restartRequired: boolean;
  warnings?: string[];
}

/**
 * 市场目录条目（GET /api/plugins/market，对齐 cordis `MarketPluginEntry`）。
 * `compat` 三档：`"A"` 即装即渲染 / `"B"` dsh host 侧试装 + 需重启 / `"C"` 界面
 * 不渲染（对照组，`installable` 为 false）。列表档位是 hint（`compatSource:
 * "catalog"`），安装时服务端会用 registry 元数据复核——徽标 tooltip 用
 * `compatReason`，别把列表 hint 当最终结论。
 */
export interface MarketEntry {
  /** npm 包名（可带 scope），安装 spec 由服务端从 catalog 策展解析 */
  name: string;
  title: string;
  /** 描述（优先中文） */
  description?: string;
  /** 双语描述（catalog 提供时） */
  descriptionI18n?: { zh?: string; en?: string };
  /** 分类 id（缺省空串 = 未分类） */
  category: string;
  repository?: string;
  homepage?: string;
  /** 展示用版本（catalog 策展版本；缺省空串） */
  version: string;
  /** catalog 里的最新版本（可能缺省） */
  latestVersion?: string;
  /** `engines.dsh` 之类的宿主要求 */
  engines?: Record<string, string>;
  compat: "A" | "B" | "C";
  /** 档位说明（徽标 tooltip） */
  compatReason: string;
  /** 档位依据：catalog（hint）/ registry（已确认）/ local（已装插件本地包） */
  compatSource: "catalog" | "registry" | "local";
  /** 能否一键安装（C 档 false） */
  installable: boolean;
}

/** 市场分类（catalog `metadata.categories` 投影；单语时另一语回退同一文本） */
export interface MarketCategory {
  id: string;
  title: { zh: string; en: string };
}

/** GET /api/plugins/market 查询参数（服务端搜索分页） */
export interface MarketQuery {
  q?: string;
  category?: string;
  limit?: number;
  offset?: number;
}

/** GET /api/plugins/market 响应（catalog 全量不进浏览器） */
export interface MarketCatalogResponse {
  plugins: MarketEntry[];
  /** 过滤后的总数（分页前） */
  total: number;
  limit: number;
  offset: number;
  /** 目录来源（抓取 URL） */
  source?: string;
  fetchedAt?: string;
  /** true = 本次用的是过期缓存（抓取失败） */
  stale?: boolean;
  /** 抓取失败原因 */
  error?: string;
  /** 值得重试（网络类错误） */
  retryable?: boolean;
  /** 分类 chips：只含本次结果集里出现的分类 */
  categories: MarketCategory[];
}
