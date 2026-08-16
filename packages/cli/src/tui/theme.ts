/**
 * @fengagent/cli — TUI 主题（设计令牌）
 *
 * 借鉴 dsh-TUI（D:\AgentCode\dsh-TUI-repo）Gentle Mist Blue 暗色系设计语言：
 * - 品牌蓝 #7DA1DE / 边框蓝 #ABC2EC 承担品牌、焦点、交互
 * - 正文暖灰白 #E8E6E0，次级信息雾蓝灰 #8D95A6
 * - 语义色：成功 #82B89D / 错误 #DA8A93 / 警告 #D8B270
 *
 * 仅借鉴配色与组件语言，不引入 dsh 的任何依赖。
 */

/** 语义化颜色令牌（Ink color prop 支持 hex） */
export const theme = {
  /** 品牌主色（雾蓝）— 标题、焦点、链接 */
  brand: "#7DA1DE",
  /** 品牌亮蓝 — 边框、选中、强调 */
  brandBright: "#ABC2EC",
  /** 品牌深蓝 — 次级强调 */
  brandDim: "#5E88CC",
  /** 正文暖灰白 */
  text: "#E8E6E0",
  /** 次级信息（雾蓝灰）— 对应 dsh 的 inactiveShimmer */
  dim: "#8D95A6",
  /** 更暗的辅助色 */
  subtle: "#5E6673",
  /** 边框蓝灰 */
  border: "#55606F",
  /** 成功（雾绿） */
  success: "#82B89D",
  /** 错误（柔玫瑰红） */
  error: "#DA8A93",
  /** 警告（柔琥珀） */
  warning: "#D8B270",
  /** 用户消息标签色 */
  user: "#7DA1DE",
  /** 助手消息标签色 */
  assistant: "#82B89D",
  /** 工具卡片强调色 */
  tool: "#ABC2EC",
  /** 输入框提示符 */
  prompt: "#82B89D",
} as const;

/** 常用状态图标（对应 dsh design-system/StatusIcon：✓/✗/⚠/ℹ/○） */
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
