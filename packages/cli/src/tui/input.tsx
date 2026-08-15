/**
 * @fengagent/cli — TUI 输入框组件
 *
 * 多行输入框，Enter 发送、Ctrl+C 退出。
 * 支持 / 命令自动补全（↑↓ 选择、Tab/Enter 补全、Esc 关闭）。
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { ThinkingPet } from "./thinking-pet.tsx";
import { filterCommands, COMMANDS } from "../commands.ts";

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
 * - Enter → 提交（或在补全模式下选中命令）
 * - Backspace → 删除最后一个字符
 * - Ctrl+C → 退出（由 App 层处理）
 * - ↑↓ → 在 / 补全列表中选择
 * - Tab → 补全选中的命令名
 * - Esc → 关闭补全列表
 * - 其他可打印字符 → 追加到输入
 */
export function Input({
  onSubmit,
  disabled = false,
  placeholder = "输入消息，按 Enter 发送...",
}: InputProps): React.ReactElement {
  const [value, setValue] = useState("");
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);

  // 当前匹配的命令列表
  const matchedCommands = showAutocomplete && value.startsWith("/")
    ? filterCommands(value)
    : [];

  useInput((input, key) => {
    if (disabled) return;

    // 补全模式下的导航
    if (showAutocomplete && matchedCommands.length > 0) {
      // ↑ 选择上一个
      if (key.upArrow) {
        setSelectedIdx((prev) =>
          prev > 0 ? prev - 1 : matchedCommands.length - 1,
        );
        return;
      }
      // ↓ 选择下一个
      if (key.downArrow) {
        setSelectedIdx((prev) =>
          prev < matchedCommands.length - 1 ? prev + 1 : 0,
        );
        return;
      }
      // Tab 或 Enter → 补全选中的命令
      if (key.tab || (key.return && matchedCommands.length === 1)) {
        const selected = matchedCommands[selectedIdx];
        if (selected) {
          setValue(`/${selected.name} `);
          setShowAutocomplete(false);
        }
        return;
      }
      // Esc → 关闭补全
      if (key.escape) {
        setShowAutocomplete(false);
        return;
      }
    }

    // Enter → 提交（非补全模式或补全列表为空时）
    if (key.return) {
      // 如果补全列表只有一项且按 Enter，直接补全
      if (showAutocomplete && matchedCommands.length === 1) {
        const selected = matchedCommands[0];
        if (selected) {
          setValue(`/${selected.name} `);
          setShowAutocomplete(false);
          return;
        }
      }
      // 关闭补全并提交
      setShowAutocomplete(false);
      const trimmed = value.trim();
      if (trimmed) {
        onSubmit(trimmed);
        setValue("");
      }
      return;
    }

    // Backspace → 删除
    if (key.backspace || key.delete) {
      setValue((prev) => {
        const newVal = prev.slice(0, -1);
        // 如果输入仍然是 / 开头，保持补全模式
        if (newVal.startsWith("/")) {
          setShowAutocomplete(true);
          setSelectedIdx(0);
        } else {
          setShowAutocomplete(false);
        }
        return newVal;
      });
      return;
    }

    // Ctrl+C → 由 App 层处理
    if (key.ctrl && input === "c") return;

    // 跳过 ctrl/meta 组合键
    if (key.ctrl || key.meta) return;

    // 补全模式下跳过方向键（已处理）
    if (key.upArrow || key.downArrow) return;
    if (key.leftArrow || key.rightArrow) return;

    // 追加可打印字符
    if (input && input.length > 0) {
      setValue((prev) => {
        const newVal = prev + input;
        // 输入 / 时触发补全
        if (newVal === "/") {
          setShowAutocomplete(true);
          setSelectedIdx(0);
        } else if (newVal.startsWith("/")) {
          // 保持补全模式
          setShowAutocomplete(true);
          setSelectedIdx(0);
        } else {
          setShowAutocomplete(false);
        }
        return newVal;
      });
    }
  });

  const promptText = disabled ? (
    <ThinkingPet />
  ) : (
    <Text color="green" bold>{">"} </Text>
  );

  return (
    <Box flexDirection="column">
      {/* 补全列表 */}
      {showAutocomplete && matchedCommands.length > 0 && !disabled && (
        <Box flexDirection="column" marginBottom={0}>
          {matchedCommands.slice(0, 8).map((cmd, i) => (
            <Box key={cmd.name} flexDirection="row">
              <Text color={i === selectedIdx ? "cyan" : "gray"}>
                {i === selectedIdx ? "▶ " : "  "}
              </Text>
              <Text color={i === selectedIdx ? "cyan" : undefined} bold={i === selectedIdx}>
                /{cmd.name}
              </Text>
              <Text dimColor> — {cmd.description}</Text>
            </Box>
          ))}
          {matchedCommands.length > 8 && (
            <Text dimColor>  ...还有 {matchedCommands.length - 8} 个命令</Text>
          )}
          <Text dimColor italic>  ↑↓ 选择 · Tab/Enter 补全 · Esc 关闭</Text>
        </Box>
      )}

      {/* 输入行 */}
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
    </Box>
  );
}

/** 导出命令总数（供外部引用） */
export const TOTAL_COMMANDS = COMMANDS.length;
