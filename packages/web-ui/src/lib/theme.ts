/**
 * @fengagent/web-ui — 主题常量
 */

export type Theme = "dark" | "light" | "cyber";

export const THEMES: Theme[] = ["dark", "light", "cyber"];

export const THEME_ICONS: Record<Theme, string> = {
  dark: "🌙",
  light: "☀️",
  cyber: "🌈",
};

export const THEME_NAMES: Record<Theme, string> = {
  dark: "深空",
  light: "日光",
  cyber: "赛博",
};
