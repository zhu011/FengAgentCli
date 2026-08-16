/**
 * @fengagent/cli — 思考动画宠物组件
 *
 * AI 运行期间显示动态图标：
 * - 逐帧循环 Spinner（跑马灯/帧序列，借鉴 dsh activityFrames / SpinnerGlyph）
 * - 宠物 emoji 轮播（多帧动物 + 思考气泡省略号动画）
 *
 * 全部动画由 useEffect + setInterval 驱动 React 状态切换（Ink 下实时重渲染）。
 */

import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { SpinnerGlyph, useFrameTicker } from "./spinner.tsx";
import { theme } from "./theme.ts";

/** 动物 emoji 帧序列 */
const PET_FRAMES = [
  { emoji: "🐶", label: "Doggy", color: theme.warning },
  { emoji: "🐱", label: "Kitty", color: theme.brand },
  { emoji: "🐼", label: "Panda", color: theme.text },
  { emoji: "🦊", label: "Fox", color: theme.warning },
  { emoji: "🐨", label: "Koala", color: theme.dim },
  { emoji: "🐹", label: "Hamster", color: theme.warning },
  { emoji: "🦉", label: "Owl", color: theme.brandBright },
  { emoji: "🐰", label: "Bunny", color: theme.brand },
];

/** 思考气泡帧序列（模拟动态省略号） */
const THINKING_DOTS = ["   ", "·  ", "·· ", "···"];

export interface ThinkingPetProps {
  /** 可选自定义提示文字 */
  text?: string;
  /** 是否显示宠物 emoji（默认 true；纯指示器场景可关闭） */
  showPet?: boolean;
}

/**
 * 思考动画宠物 — 在 AI 运行期间显示。
 *
 * 组合三层动态：
 * 1. SpinnerGlyph 逐帧循环动画（claude 星形帧序列）
 * 2. 宠物 emoji 每 500ms 轮播
 * 3. 思考省略号同步动画
 */
export function ThinkingPet({
  text,
  showPet = true,
}: ThinkingPetProps): React.ReactElement {
  const [petIndex, setPetIndex] = useState(0);
  const dotIndex = useFrameTicker(THINKING_DOTS.length, 400);

  useEffect(() => {
    const petTimer = setInterval(() => {
      setPetIndex((prev) => (prev + 1) % PET_FRAMES.length);
    }, 500);
    return () => clearInterval(petTimer);
  }, []);

  const frame = PET_FRAMES[petIndex]!;
  const dots = THINKING_DOTS[dotIndex]!;

  return (
    <Text>
      <SpinnerGlyph frames={["·", "✢", "*", "✶", "✻", "✽"]} intervalMs={150} color={theme.brand} withSpace={false} />
      <Text> </Text>
      {showPet && (
        <Text>
          <Text color={frame.color}>{frame.emoji}</Text>
          <Text> </Text>
        </Text>
      )}
      <Text dimColor italic>{text ?? "思考中"}</Text>
      <Text color={theme.dim}>{dots}</Text>
    </Text>
  );
}
