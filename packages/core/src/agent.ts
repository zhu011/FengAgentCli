/**
 * @fengagent/core — Agent 接口定义
 *
 * AgentConfig、AgentInfo。
 */

/** Agent 配置（运行时参数） */
export interface AgentConfig {
  /** 模型 ID */
  model: string;
  /** 系统提示（覆盖默认） */
  systemPrompt?: string;
  /** 允许使用的工具列表（未指定则全部可用） */
  tools?: string[];
  /** 最大轮次 */
  maxTurns: number;
  /** 最大输出 Token */
  maxTokens: number;
  /** 生成温度 */
  temperature: number;
  /** 小模型（压缩/摘要用） */
  smallModel: string;
  /** 回退模型 */
  fallbackModel?: string;
}

/** Agent 定义信息（从 .md frontmatter 加载） */
export interface AgentInfo {
  /** Agent 名称（唯一标识） */
  name: string;
  /** 描述 */
  description: string;
  /** 使用的模型 */
  model: string;
  /** 允许的工具列表 */
  tools: string[];
  /** 最大轮次 */
  maxTurns: number;
  /** 系统提示（body 内容） */
  systemPrompt: string;
  /** 小模型 */
  smallModel?: string;
}

// ──────────────────────────────────────────────
// 子 Agent 派遣类型
// ──────────────────────────────────────────────

/** 子 Agent 派遣请求参数 */
export interface SubagentParams {
  /** 任务简述（3-5 词） */
  description: string;
  /** 传给子 Agent 的完整任务提示 */
  prompt: string;
  /** 子 Agent 类型名称 */
  subagentType: string;
  /** 恢复已有子任务时传入（否则创建新任务） */
  taskId?: string;
  /** 父会话 ID */
  parentSessionId: string;
  /** 当前 Agent 深度（0 = 顶层） */
  depth: number;
}

/** 子 Agent 执行结果 */
export interface SubagentResult {
  /** 任务 ID（子会话 ID） */
  taskId: string;
  /** 子会话 ID */
  sessionId: string;
  /** 执行状态 */
  state: "completed" | "error";
  /** 最终输出文本 */
  text: string;
  /** 摘要 */
  summary?: string;
}

/** 子 Agent 派遣函数类型（由 agent 层实现并注入到 ToolContext） */
export type SubagentRunner = (params: SubagentParams) => Promise<SubagentResult>;
