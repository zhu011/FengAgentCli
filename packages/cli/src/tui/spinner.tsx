/**
 * @fengagent/cli — 动态活动指示器（Spinner）
 *
 * 借鉴 dsh-TUI 的 SpinnerGlyph / activityFrames / WorkingSpinner：
 * - 逐帧循环动画：帧序列 + 每帧间隔（useEffect + setInterval 驱动 React 状态切换）
 * - 多套预设：claude（· ✢ * ✶ ✻ ✽ 正反播放）、moon、dots、braille、aesthetic（跑马灯）等
 * - 供「AI 思考中 / 运行中」指示器、状态栏、输入框禁用态复用
 *
 * 仅借鉴帧序列设计，不引入 dsh 依赖。
 */

import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { theme } from "./theme.ts";

/** 文本变体选择符：Windows 下强制按文本渲染，避免 emoji 化导致宽度抖动 */
const TE = "\uFE0E";

/** 一帧动画预设：帧序列 + 每帧间隔 */
export interface FramePreset {
  /** 帧字符序列 */
  frames: readonly string[];
  /** 每帧切换间隔（毫秒） */
  intervalMs: number;
}

/** 动画帧预设表（借鉴 dsh activityFrames 的常用预设，取前 6 个高可读性预设） */
export const FRAME_PRESETS: Record<string, FramePreset> = {
  // Claude Code 真实序列：· ✢ * ✶ ✻ ✽ 正向 + 反向
  claude: {
    frames: ["·", `✢${TE}`, "*", `✶${TE}`, `✻${TE}`, `✽${TE}`, `✻${TE}`, `✶${TE}`, "*", `✢${TE}`],
    intervalMs: 150,
  },
  // 月亮盈亏
  moon: { frames: ["◐", "◓", "◑", "◒"], intervalMs: 240 },
  // Braille 旋转
  dots: { frames: ["⣾", "⣷", "⣯", "⣟", "⡿", "⢿", "⣻", "⣽"], intervalMs: 140 },
  // Braille 经典
  braille: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 120 },
  // 跑马灯填充条
  aesthetic: {
    frames: ["▰▱▱▱▱▱▱", "▰▰▱▱▱▱▱", "▰▰▰▱▱▱▱", "▰▰▰▰▱▱▱", "▰▰▰▰▰▱▱", "▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰", "▰▱▱▱▱▱▱"],
    intervalMs: 140,
  },
  // 呼吸条
  breathe: { frames: ["▁", "▃", "▅", "▇", "▅", "▃"], intervalMs: 210 },
  // 圆点扫过（彗星）
  comet: {
    frames: ["●    ", " ●   ", "  ●  ", "   ● ", "    ●", "   ● ", "  ●  ", " ●   "],
    intervalMs: 160,
  },
};

/** 默认预设名 */
export const DEFAULT_PRESET = "claude";

/** 按名称解析预设（未知名回退默认） */
export function resolvePreset(name: string | undefined): FramePreset {
  return FRAME_PRESETS[name ?? ""] ?? FRAME_PRESETS[DEFAULT_PRESET]!;
}

/**
 * 逐帧动画 Hook：以固定间隔推进帧索引。
 *
 * 借鉴 dsh use-animation-frame / use-interval 的思路，
 * 用 useEffect + setInterval 驱动 React 状态更新（Ink 下即重渲染新帧）。
 *
 * @param frameCount - 帧总数
 * @param intervalMs - 每帧间隔（毫秒）
 * @returns 当前帧索引（0 ~ frameCount-1 循环）
 */
export function useFrameTicker(frameCount: number, intervalMs: number): number {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (frameCount <= 1) {
      setFrame(0);
      return;
    }
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % frameCount);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [frameCount, intervalMs]);

  return frame;
}

export interface SpinnerGlyphProps {
  /** 预设名（默认 claude）或自定义帧数组 */
  frames?: readonly string[];
  /** 每帧间隔（毫秒） */
  intervalMs?: number;
  /** 帧颜色（Ink 颜色名或 hex） */
  color?: string;
  /** 是否在帧间附带一个尾部空格（对齐用） */
  withSpace?: boolean;
  /** 静态文本变体选择符（默认追加，Windows 防 emoji 化） */
  textVariant?: boolean;
}

/**
 * 动态帧图标 — 逐帧循环动画的活动指示器。
 *
 * 用法：
 * ```tsx
 * <SpinnerGlyph preset="moon" color="#7DA1DE" />
 * ```
 */
export function SpinnerGlyph({
  frames,
  intervalMs,
  color = theme.brand,
  withSpace = true,
  textVariant = true,
}: SpinnerGlyphProps): React.ReactElement {
  const preset = resolvePreset(undefined);
  const seq = frames ?? preset.frames;
  const ms = intervalMs ?? preset.intervalMs;
  const frame = useFrameTicker(seq.length, ms);
  const char = seq[frame % seq.length]!;
  const rendered = textVariant && !char.includes(TE) ? `${char}${TE}` : char;

  return (
    <Text color={color}>
      {rendered}
      {withSpace ? " " : ""}
    </Text>
  );
}

export interface ActivityBarProps {
  /** 是否运行中（非运行时不渲染） */
  active: boolean;
  /** 提示文本 */
  label?: string;
  /** 帧颜色 */
  color?: string;
  /** 预设名 */
  preset?: string;
}

/**
 * 运行指示条 — 「AI 思考中 / 运行中」逐帧动画 + 文案。
 * 在 ThinkingPet、状态栏、输入框禁用态共用。
 */
export function ActivityBar({
  active,
  label = "思考中",
  color = theme.brand,
  preset = "claude",
}: ActivityBarProps): React.ReactElement | null {
  if (!active) return null;
  const p = resolvePreset(preset);
  const frame = useFrameTicker(p.frames.length, p.intervalMs);
  const char = p.frames[frame % p.frames.length]!;

  return (
    <Text>
      <Text color={color}>{char}</Text>
      <Text dimColor> {label}</Text>
    </Text>
  );
}

// 供测试/调试使用：帧数
export const SPINNER_FRAME_COUNT = Object.keys(FRAME_PRESETS).length;
