/**
 * @fengagent/groups — 群聊域（G1–G3）
 *
 * 从 server 抽出的纯域层（P4 合流）：AgentGroupService（群/消息/SSE）+
 * GroupOrchestrator（轮次/静默/拍板收敛）。存储注入——server 传 SQLite
 * AgentGroupStore（@fengagent/agent），插件侧（@fengagent/group-plugin）用
 * 便携 JSON store，同一域层两端复用。
 */

export * from "./agent-group-service.ts";
export * from "./group-orchestrator.ts";
