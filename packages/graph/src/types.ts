/**
 * @fengagent/graph — 图类型定义
 *
 * 对话即节点（conversation-as-node）：
 * - 每一轮「用户提问 → 助手回答」（可含工具调用）沉淀为一个 ConversationNode；
 * - 节点之间通过 parentId / childrenIds 构成有向图；
 * - 每次回退（rollback）都会在原节点上长出新的分支，旧分支保持不可变（可溯源）。
 */

/** 节点质量评分 — 用于判断「节点回答不佳可回退」 */
export type NodeQuality = "good" | "poor" | "unrated";

/** 节点类型 */
export type ConversationNodeType = "user" | "assistant" | "tool" | "branch-point";

/** 回退粒度：turn=回退到该节点所属轮次的提问处（既有语义）；step=精确到一轮内的某一步 */
export type RollbackGranularity = "turn" | "step";

/**
 * 工具入参改写记录（改参可溯源）。
 *
 * 一条记录 = 一次「用户改参后执行」的事实：模型给出的原始入参 + 用户改写后
 * 实际执行的入参。同一条工具调用的多次改写按事件序排列。
 */
export interface ToolInputCorrection {
  /** 工具调用 id（同一条 assistant 消息内唯一） */
  toolUseId: string;
  /** 工具名 */
  toolName: string;
  /** 模型给出的原始入参 */
  originalInput: unknown;
  /** 用户改写后实际执行的入参 */
  correctedInput: unknown;
  /** 改参来源：hitl=审批弹窗改参；graph=图上改参重放 */
  source?: "hitl" | "graph";
  /** 对应事件序号（溯源） */
  seq?: number;
  /** 事件时间戳（ISO-8601） */
  timestamp?: string;
}

/** 节点元数据 — 溯源信息 */
export interface ConversationNodeMeta {
  /** 使用的模型（assistant 节点） */
  model?: string;
  /** 本轮工具调用摘要 */
  toolCalls?: Array<{ id: string; name: string }>;
  /** token 统计 */
  tokenCount?: number;
  /** LLM trace 日志关联 id（可在 logs/ 中溯源请求/响应） */
  llmTraceId?: string;
  /** 质量评分（assistant 节点） */
  quality?: NodeQuality;
  /** 质量评分原因 / 回退原因 */
  qualityNote?: string;
  /** 分支标签（同一父节点下的并行分支） */
  branch?: string;
  /** 该节点是否处于活跃路径上 */
  active?: boolean;
  /** 是否因回退而作废 */
  rolledBack?: boolean;
  /** 该节点内的工具有过「用户改参后执行」（图上标「✏️ 已改参」） */
  userCorrectedInput?: boolean;
  /** 改参明细（改参前后可溯源，按事件序） */
  inputCorrections?: ToolInputCorrection[];
  /** 分支点粒度：true=步级续跑（回退点在一轮之内），缺省=轮级回退 */
  stepLevel?: boolean;
}

/** 对话图节点 — 一个会话中的一轮对话（或一个分支点） */
export interface ConversationNode {
  /** 节点 id */
  id: string;
  /** 所属会话 id */
  conversationId: string;
  /** 节点类型 */
  type: ConversationNodeType;
  /** 关联的 Message.id（会话消息历史） */
  messageId: string;
  /** 溯源：父节点 id（根节点为 null） */
  parentId: string | null;
  /** 子节点 id（按创建顺序） */
  childrenIds: string[];
  /** 创建时间戳 */
  createdAt: number;
  /** 溯源元数据 */
  meta: ConversationNodeMeta;
}

/** 边 — 节点之间的关系 */
export interface ConversationEdge {
  /** 源节点 id */
  from: string;
  /** 目标节点 id */
  to: string;
  /** 边类型：next=线性延续 branch=回退分支 retry=重试 */
  kind: "next" | "branch" | "retry";
  /** 创建时间戳 */
  createdAt: number;
}

/** 回退结果 */
export interface RollbackResult {
  /** 回退到的目标节点 */
  target: ConversationNode;
  /** 回退后新建的分支点节点（父节点 = target） */
  branchPoint: ConversationNode;
  /** 被作废的旧分支节点 id 列表 */
  superseded: string[];
  /** 新的活跃路径（target → branchPoint → 后续 append） */
  activePath: ConversationNode[];
}

/** 图存储接口 — 可插拔存储（内存 / JSONL / 数据库） */
export interface GraphStore {
  /** 追加节点（自动维护 parent/children 链接） */
  appendNode(node: Omit<ConversationNode, "childrenIds">): ConversationNode;
  /** 获取节点 */
  getNode(id: string): ConversationNode | undefined;
  /** 获取会话全部节点 */
  listNodes(conversationId: string): ConversationNode[];
  /** 获取某节点的直接子节点 */
  getChildren(id: string): ConversationNode[];
  /** 溯源链：从根到某节点的路径（可溯源） */
  getChain(nodeId: string): ConversationNode[];
  /** 当前活跃路径（根 → … → head） */
  getActivePath(conversationId: string): ConversationNode[];
  /** 当前活跃 head 节点 */
  getActiveHead(conversationId: string): ConversationNode | undefined;
  /** 记录节点质量评分 */
  markQuality(nodeId: string, quality: NodeQuality, note?: string): void;
  /** 回退：把活跃路径回退到 target，旧分支作废，新建分支点 */
  rollbackTo(
    nodeId: string,
    reason?: string,
    /** 回退上下文（增量）：粒度与续跑语义，用于图上区分「回退重答 / 步级续跑」 */
    context?: { granularity?: RollbackGranularity; mode?: "replay" | "resume" },
  ): RollbackResult | undefined;
  /**
   * 分叉（Phase 2）：从某节点长出新分支（不动质量评分），旧分支作废但保留。
   * @returns 分叉结果（branchPoint 为新 head）；节点不存在/不在活跃路径时 undefined
   */
  fork(nodeId: string, branch?: string): RollbackResult | undefined;
  /** 把节点标记为活跃/非活跃（回退内部使用；事件溯源实现为派生态 no-op） */
  setActive(nodeId: string, active: boolean): void;
  /** 持久化（JSONL 追加写） */
  flush(): Promise<void>;
}
