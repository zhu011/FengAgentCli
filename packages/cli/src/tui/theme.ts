/**
 * @fengagent/cli — TUI 主题（设计令牌，双主题）
 *
 * 设计语言借鉴本地参考 TUI（D:\AgentCode\opencode 源码 + kimi-code tui.toml + claude-code 惯例）：
 * - dark（默认）：近黑分层背景 + 雾蓝品牌色（#7DA1DE 系），正文暖灰白；
 * - light：亮色终端适配（GitHub light 系配色：深字浅底、品牌蓝 #1F6FEB）。
 *
 * `theme` / `statusColors` 是按当前模式动态解析的 Proxy——`/theme` 切换后
 * 触发 App 重渲染，所有 `theme.*` 读取即时生效。偏好持久化在
 * `~/.fengagent/tui-theme`（dark | light），重启保留。
 *
 * 仅借鉴配色与组件语言，不引入任何外部依赖。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 暗色令牌（默认，「深空」） */
const DARK_TOKENS = {
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

/** 亮色令牌（GitHub light 系：深字浅底） */
const LIGHT_TOKENS = {
  brand: "#1F6FEB",
  brandBright: "#2F81F7",
  brandDim: "#44609D",
  secondary: "#0969DA",
  accent: "#8250DF",
  text: "#1F2328",
  dim: "#59636E",
  subtle: "#818B98",
  background: "#FFFFFF",
  backgroundPanel: "#F6F8FA",
  backgroundElement: "#EFF2F5",
  userBubbleBg: "#EAF1FB",
  userBubbleBorder: "#C6D9F0",
  border: "#D0D7DE",
  borderActive: "#8C959F",
  success: "#1A7F37",
  error: "#CF222E",
  warning: "#9A6700",
  info: "#0969DA",
  user: "#2F6FBA",
  assistant: "#1A7F37",
  tool: "#8250DF",
  prompt: "#1F6FEB",
  markdownCode: "#116329",
  markdownLink: "#0969DA",
  markdownQuote: "#953800",
  syntaxComment: "#6E7781",
  syntaxKeyword: "#8250DF",
  syntaxString: "#0A3069",
  syntaxNumber: "#953800",
  syntaxFunction: "#6639BA",
  syntaxVariable: "#953800",
  syntaxOperator: "#0550AE",
} as const;

/** 主题令牌类型（键取自暗色令牌，值放宽为 string 以兼容双主题字面量） */
export type ThemeTokens = Record<keyof typeof DARK_TOKENS, string>;

/** 主题模式 */
export type ThemeMode = "dark" | "light";

/** 主题偏好文件（全局，跨项目） */
const THEME_PREF_FILE = join(homedir(), ".fengagent", "tui-theme");

/** 读取持久化的主题偏好（缺失/非法回退 dark） */
export function loadThemePreference(): ThemeMode {
  try {
    const raw = readFileSync(THEME_PREF_FILE, "utf-8").trim();
    return raw === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** 持久化主题偏好（原子写；失败静默——主题不应因写盘失败崩溃 TUI） */
export function saveThemePreference(mode: ThemeMode): void {
  try {
    mkdirSync(dirname(THEME_PREF_FILE), { recursive: true });
    const tmp = `${THEME_PREF_FILE}.tmp`;
    writeFileSync(tmp, mode, "utf-8");
    renameSync(tmp, THEME_PREF_FILE);
  } catch {
    // 写不进去就算了：本次会话主题仍生效，只是不跨重启
  }
}

/** 当前激活模式（模块级，setThemeMode 切换） */
let activeMode: ThemeMode = loadThemePreference();

/** 当前主题模式 */
export function getThemeMode(): ThemeMode {
  return activeMode;
}

/** 切换主题模式（立即生效 + 持久化） */
export function setThemeMode(mode: ThemeMode): void {
  activeMode = mode;
  saveThemePreference(mode);
}

/** 当前模式的令牌集（也导出给需要整体读取的场景） */
export function activeTokens(): ThemeTokens {
  return activeMode === "light" ? LIGHT_TOKENS : DARK_TOKENS;
}

/**
 * 语义化颜色令牌 — 按当前模式动态解析的 Proxy。
 * `/theme` 切换 + App 重渲染后，所有 `theme.*` 读取即时取新值。
 */
export const theme: ThemeTokens = new Proxy({} as ThemeTokens, {
  get: (_target, key: string) => activeTokens()[key as keyof ThemeTokens],
});

/** 常用状态图标（对应 opencode StatusIcon：✓/✗/⚠/ℹ/○） */
export const statusIcons = {
  success: "✓",
  error: "✗",
  warning: "⚠",
  info: "ℹ",
  idle: "●",
  pending: "○",
} as const;

/** 状态 → 颜色映射（同样动态解析，避免模块加载时快照暗色值） */
export const statusColors: Record<keyof typeof statusIcons, string> = new Proxy(
  {} as Record<keyof typeof statusIcons, string>,
  {
    get: (_target, key: string) => {
      const t = activeTokens();
      switch (key) {
        case "success":
          return t.success;
        case "error":
          return t.error;
        case "warning":
          return t.warning;
        case "info":
          return t.brand;
        default:
          return t.dim;
      }
    },
  },
);

/** 供测试与浅色探测使用：令牌集是否就绪（文件存在性探测，幂等） */
export function themePrefFileExists(): boolean {
  return existsSync(THEME_PREF_FILE);
}
