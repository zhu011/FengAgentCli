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
  rollbackTo(nodeId: string, reason?: string): RollbackResult | undefined;
  /** 把节点标记为活跃/非活跃（回退内部使用） */
  setActive(nodeId: string, active: boolean): void;
  /** 持久化（JSONL 追加写） */
  flush(): Promise<void>;
}
