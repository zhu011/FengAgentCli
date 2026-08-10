/**
 * @fengagent/cli — TUI 输入框组件
 *
 * 多行输入框，Enter 发送、Ctrl+C 退出。
 * 支持基础文本编辑（退格、方向键）。
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { ThinkingPet } from "./thinking-pet.tsx";

export interface InputProps {
  /** 提交回调 */
  onSubmit: (text: string) => void;
  /** 是否禁用输入（Agent 运行中） */
  disabled?: boolean;
  /** 占位提示文本 */
  placeholder?: string;
}

/**
 * 输入框 — 基于 Ink useInput 实现的文本输入。
 *
 * 操作：
 * - Enter → 提交
 * - Backspace → 删除最后一个字符
 * - Ctrl+C → 退出（由 App 层处理）
 * - 其他可打印字符 → 追加到输入
 */
export function Input({
  onSubmit,
  disabled = false,
  placeholder = "输入消息，按 Enter 发送...",
}: InputProps): React.ReactElement {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (disabled) return;

    // Enter → 提交
    if (key.return) {
      const trimmed = value.trim();
      if (trimmed) {
        onSubmit(trimmed);
        setValue("");
      }
      return;
    }

    // Backspace → 删除
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }

    // Ctrl+C → 由 App 层的 useInput 处理退出
    if (key.ctrl && input === "c") return;

    // 跳过 ctrl/meta 组合键
    if (key.ctrl || key.meta) return;

    // 跳过非文本输入（方向键等）
    if (
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow
    ) {
      return;
    }

    // 追加可打印字符
    if (input && input.length > 0) {
      setValue((prev) => prev + input);
    }
  });

  const promptText = disabled ? (
    <ThinkingPet />
  ) : (
    <Text color="green" bold>{">"} </Text>
  );

  return (
    <Box>
      {promptText}
      {disabled ? (
        <Text dimColor italic> {placeholder}</Text>
      ) : value ? (
        <Text>{value}<Text color="gray">█</Text></Text>
      ) : (
        <Text><Text color="gray">█</Text><Text dimColor italic> {placeholder}</Text></Text>
      )}
    </Box>
  );
}
