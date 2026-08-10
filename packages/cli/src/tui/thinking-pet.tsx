/**
 * @fengagent/cli — 思考动画宠物组件
 *
 * AI 运行期间显示彩色 emoji 动物动画，多帧轮播模拟"努力思考"效果。
 * 每 500ms 切换一个动物 emoji + 思考气泡。
 */

import React, { useEffect, useState } from "react";
import { Text } from "ink";

/** 动物 emoji 帧序列 */
const PET_FRAMES = [
  { emoji: "🐶", label: "Doggy", color: "yellow" as const },
  { emoji: "🐱", label: "Kitty", color: "cyan" as const },
  { emoji: "🐼", label: "Panda", color: "white" as const },
  { emoji: "🦊", label: "Fox", color: "yellow" as const },
  { emoji: "🐨", label: "Koala", color: "gray" as const },
  { emoji: "🐹", label: "Hamster", color: "yellow" as const },
  { emoji: "🦉", label: "Owl", color: "magenta" as const },
  { emoji: "🐰", label: "Bunny", color: "cyan" as const },
];

/** 思考气泡帧序列（模拟动态省略号） */
const THINKING_DOTS = ["  ", "· ", "··", "···"];

export interface ThinkingPetProps {
  /** 可选自定义提示文字 */
  text?: string;
}

/**
 * 思考动画宠物 — 在 AI 运行期间显示。
 *
 * 动物 emoji 每 500ms 轮播，思考省略号同步动画。
 */
export function ThinkingPet({ text }: ThinkingPetProps): React.ReactElement {
  const [petIndex, setPetIndex] = useState(0);
  const [dotIndex, setDotIndex] = useState(0);

  useEffect(() => {
    const petTimer = setInterval(() => {
      setPetIndex((prev) => (prev + 1) % PET_FRAMES.length);
    }, 500);

    const dotTimer = setInterval(() => {
      setDotIndex((prev) => (prev + 1) % THINKING_DOTS.length);
    }, 400);

    return () => {
      clearInterval(petTimer);
      clearInterval(dotTimer);
    };
  }, []);

  const frame = PET_FRAMES[petIndex]!;
  const dots = THINKING_DOTS[dotIndex]!;

  return (
    <Text>
      <Text color={frame.color}>{frame.emoji}</Text>
      {" "}
      <Text dimColor italic>
        {text ?? "思考中"}
      </Text>
      <Text color="gray">{dots}</Text>
    </Text>
  );
}
