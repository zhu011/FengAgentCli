/**
 * @fengagent/events — 确定性节点 id 方案（Phase 2）
 *
 * graph 投影（projectGraph）与运行时图存储（EventGraphStore）共用同一套
 * 确定性 id：`<sessionId>::<kind>::<ref>`。
 * - kind: u=用户节点 / a=助手节点 / b=分支点（branch-point）
 * - ref: 用户/助手节点 = messageId；分支点 = 触发它的 rollback/fork 事件 seq
 *
 * 同一事实（同一消息 / 同一回退事件）在任何时刻重放都得到同一节点 id，
 * 保证「graph.jsonl 派生视图」与运行内存图一致、跨重启可重建。
 * `::` 分隔符不会出现在 UUID（sessionId / messageId）中，可无损解析回会话 id。
 */

/** 用户节点 id（由 user/message 事件派生） */
export function userNodeId(sessionId: string, messageId: string): string {
  return `${sessionId}::u::${messageId}`;
}

/** 助手节点 id（由 step/start 事件派生） */
export function assistantNodeId(sessionId: string, messageId: string): string {
  return `${sessionId}::a::${messageId}`;
}

/** 分支点 id（由 rollback/fork 事件派生，ref = 事件 seq） */
export function branchPointNodeId(sessionId: string, eventSeq: number): string {
  return `${sessionId}::b::${eventSeq}`;
}

export interface ParsedNodeId {
  sessionId: string;
  kind: "u" | "a" | "b";
  ref: string;
}

/** 从确定性节点 id 解析（非确定性/遗留 id 返回 null） */
export function parseNodeId(nodeId: string): ParsedNodeId | null {
  const parts = nodeId.split("::");
  if (parts.length !== 3) return null;
  const [sessionId, kind, ref] = parts;
  if (!sessionId || !ref) return null;
  if (kind !== "u" && kind !== "a" && kind !== "b") return null;
  return { sessionId, kind, ref };
}
