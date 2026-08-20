/**
 * @fengagent/cli — TUI 主题（设计令牌）
 *
 * 设计语言借鉴本地参考 TUI（D:\AgentCode\opencode 源码 + kimi-code tui.toml + claude-code 惯例）：
 * - opencode 默认主题：近黑分层背景（#0a0a0a / #141414 / #1e1e1e…）、暖橙主强调色、
 *   语义色（绿 #7fd88f / 红 #e06c75 / 橙 #f5a742 / 青 #56b6c2 / 黄 #e5c07b）、
 *   markdown / 语法着色令牌齐全，状态栏极简（左上下文 · 右状态，space-between）。
 * - 本项目保留「雾蓝」品牌色（#7DA1DE 系）作为身份色，正文暖灰白 #E8E6E0 不变。
 *
 * 仅借鉴配色与组件语言，不引入任何外部依赖。
 */

/** 语义化颜色令牌（Ink color prop 支持 hex） */
export const theme = {
  /** 品牌主色（雾蓝）— 标题、焦点、链接 */
  brand: "#7DA1DE",
  /** 品牌亮蓝 — 边框、选中、强调 */
  brandBright: "#A8C5F2",
  /** 品牌深蓝 — 次级强调 */
  brandDim: "#5A80C4",
  /** 次级强调色（opencode secondary） */
  secondary: "#5C9CF5",
  /** 强调紫（opencode accent）— 工具卡片、标题 */
  accent: "#9D7CD8",
  /** 正文暖灰白 */
  text: "#E8E6E0",
  /** 次级信息（雾蓝灰） */
  dim: "#8D95A6",
  /** 更暗的辅助色 */
  subtle: "#565E6E",
  /** 背景（近黑，opencode darkStep1） */
  background: "#0B0B10",
  /** 面板背景（opencode darkStep2） */
  backgroundPanel: "#12121A",
  /** 元素背景（输入框内联代码等，opencode darkStep3） */
  backgroundElement: "#191922",
  /** 用户消息气泡背景（Round 1 设计：右对齐浅色气泡） */
  userBubbleBg: "#1B2230",
  /** 用户消息气泡边框 */
  userBubbleBorder: "#2E3A52",
  /** 边框蓝灰 */
  border: "#2E2E3D",
  /** 激活边框 */
  borderActive: "#4A4A5E",
  /** 成功（雾绿，opencode green） */
  success: "#7FD88F",
  /** 错误（opencode red） */
  error: "#E06C75",
  /** 警告（opencode orange） */
  warning: "#F5A742",
  /** 信息（opencode cyan） */
  info: "#56B6C2",
  /** 用户消息标签色 */
  user: "#6C9BD8",
  /** 助手消息标签色 */
  assistant: "#7FD88F",
  /** 工具卡片强调色 */
  tool: "#9D7CD8",
  /** 输入框提示符 */
  prompt: "#7DA1DE",
  /** markdown 行内代码 / 代码内容 */
  markdownCode: "#7FD88F",
  /** markdown 链接文字 */
  markdownLink: "#56B6C2",
  /** markdown 引用 */
  markdownQuote: "#E5C07B",
  /** 语法：注释 */
  syntaxComment: "#565E6E",
  /** 语法：关键字 */
  syntaxKeyword: "#9D7CD8",
  /** 语法：字符串 */
  syntaxString: "#7FD88F",
  /** 语法：数字 */
  syntaxNumber: "#F5A742",
  /** 语法：函数名 */
  syntaxFunction: "#7DA1DE",
  /** 语法：变量 */
  syntaxVariable: "#E06C75",
  /** 语法：运算符 */
  syntaxOperator: "#56B6C2",
} as const;

/** 常用状态图标（对应 opencode StatusIcon：✓/✗/⚠/ℹ/○） */
export const statusIcons = {
  success: "✓",
  error: "✗",
  warning: "⚠",
  info: "ℹ",
  idle: "●",
  pending: "○",
} as const;

/** 状态 → 颜色映射 */
export const statusColors = {
  success: theme.success,
  error: theme.error,
  warning: theme.warning,
  info: theme.brand,
  idle: theme.dim,
  pending: theme.dim,
} as const;
