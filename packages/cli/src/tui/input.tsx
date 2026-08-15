/**
 * @fengagent/cli — TUI 输入框组件
 *
 * 多行输入框，Enter 发送、Ctrl+C 退出。
 * 支持 / 命令自动补全（↑↓ 选择、Tab/Enter 补全、Esc 关闭）。
 *
 * 修复要点：
 * 1. ↑↓ 使用 ref 避免闭包陈旧 — 按一次立即响应
 * 2. 补全列表显示全部命令（不 slice），用滚动窗口保持选中项可见
 * 3. 滚动窗口：selectedIdx 变化时自动调整可视范围
 */

import React, { useState, useRef, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { ThinkingPet } from "./thinking-pet.tsx";
import { filterCommands, COMMANDS } from "../commands.ts";

/** 可视行数（根据终端高度自适应，默认 8） */
const MAX_VISIBLE = 8;

export interface InputProps {
  /** 提交回调 */
  onSubmit: (text: string) => void;
  /** 是否禁用输入（Agent 运行中） */
  disabled?: boolean;
  /** 占位提示文本 */
  placeholder?: string;
}

export function Input({
  onSubmit,
  disabled = false,
  placeholder = "输入消息，按 Enter 发送...",
}: InputProps): React.ReactElement {
  const [value, setValue] = useState("");
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  // 用 ref 存储最新状态，避免 useInput 闭包陈旧
  const showAutoRef = useRef(false);
  const selectedRef = useRef(0);
  const matchedRef = useRef<ReturnType<typeof filterCommands>>([]);

  // 当前匹配的命令列表
  const matchedCommands = useMemo(() => {
    if (showAutocomplete && value.startsWith("/")) {
      return filterCommands(value);
    }
    return [];
  }, [showAutocomplete, value]);

  // 同步 ref
  showAutoRef.current = showAutocomplete;
  matchedRef.current = matchedCommands;
  selectedRef.current = selectedIdx;

  // 滚动窗口：计算可视范围
  const visibleStart = scrollOffset;
  const visibleEnd = Math.min(scrollOffset + MAX_VISIBLE, matchedCommands.length);
  const visibleCommands = matchedCommands.slice(visibleStart, visibleEnd);

  // 更新选中项并自动滚动
  function updateSelected(newIdx: number) {
    setSelectedIdx(newIdx);
    selectedRef.current = newIdx;

    // 自动滚动：选中项不在可视范围内时调整
    if (newIdx < scrollOffset) {
      setScrollOffset(newIdx);
    } else if (newIdx >= scrollOffset + MAX_VISIBLE) {
      setScrollOffset(newIdx - MAX_VISIBLE + 1);
    }
  }

  useInput((input, key) => {
    if (disabled) return;

    const isAuto = showAutoRef.current;
    const matched = matchedRef.current;

    // 补全模式下的导航
    if (isAuto && matched.length > 0) {
      // ↑ 选择上一个
      if (key.upArrow) {
        const cur = selectedRef.current;
        const newIdx = cur > 0 ? cur - 1 : matched.length - 1;
        updateSelected(newIdx);
        return;
      }
      // ↓ 选择下一个
      if (key.downArrow) {
        const cur = selectedRef.current;
        const newIdx = cur < matched.length - 1 ? cur + 1 : 0;
        updateSelected(newIdx);
        return;
      }
      // Tab → 补全选中的命令
      if (key.tab) {
        const selected = matched[selectedRef.current];
        if (selected) {
          setValue(`/${selected.name} `);
          setShowAutocomplete(false);
          showAutoRef.current = false;
        }
        return;
      }
      // Enter → 如果只有一条匹配则补全，否则提交
      if (key.return) {
        if (matched.length === 1) {
          const selected = matched[0];
          if (selected) {
            setValue(`/${selected.name} `);
            setShowAutocomplete(false);
            showAutoRef.current = false;
          }
          return;
        }
        // 多条匹配时提交当前输入
        setShowAutocomplete(false);
        showAutoRef.current = false;
        const trimmed = value.trim();
        if (trimmed) {
          onSubmit(trimmed);
          setValue("");
        }
        return;
      }
      // Esc → 关闭补全
      if (key.escape) {
        setShowAutocomplete(false);
        showAutoRef.current = false;
        return;
      }
    }

    // Enter → 提交（非补全模式）
    if (key.return) {
      setShowAutocomplete(false);
      showAutoRef.current = false;
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
        if (newVal.startsWith("/")) {
          setShowAutocomplete(true);
          showAutoRef.current = true;
          setSelectedIdx(0);
          selectedRef.current = 0;
          setScrollOffset(0);
        } else {
          setShowAutocomplete(false);
          showAutoRef.current = false;
        }
        return newVal;
      });
      return;
    }

    // Ctrl+C → 由 App 层处理
    if (key.ctrl && input === "c") return;

    // 跳过 ctrl/meta 组合键
    if (key.ctrl || key.meta) return;

    // 补全模式下跳过方向键（已在上面处理）
    if (key.upArrow || key.downArrow) return;
    if (key.leftArrow || key.rightArrow) return;

    // 追加可打印字符（跳过转义序列）
    if (input && input.length > 0 && input !== "\x1b") {
      // 过滤掉方向键的转义序列残留（如 [A [B [C [D）
      const cleanInput = input.replace(/\x1b\[[A-D]/g, "");
      if (!cleanInput) return;

      setValue((prev) => {
        const newVal = prev + cleanInput;
        if (newVal === "/") {
          setShowAutocomplete(true);
          showAutoRef.current = true;
          setSelectedIdx(0);
          selectedRef.current = 0;
          setScrollOffset(0);
        } else if (newVal.startsWith("/")) {
          setShowAutocomplete(true);
          showAutoRef.current = true;
          setSelectedIdx(0);
          selectedRef.current = 0;
          setScrollOffset(0);
        } else {
          setShowAutocomplete(false);
          showAutoRef.current = false;
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
      {/* 补全列表 — 滚动窗口显示 */}
      {showAutocomplete && matchedCommands.length > 0 && !disabled && (
        <Box flexDirection="column">
          {/* 滚动指示器（上方） */}
          {visibleStart > 0 && (
            <Text dimColor>  ↑ 还有 {visibleStart} 个命令</Text>
          )}

          {/* 可视区域内的命令 */}
          {visibleCommands.map((cmd, i) => {
            const realIdx = visibleStart + i;
            const isSelected = realIdx === selectedIdx;
            return (
              <Box key={cmd.name} flexDirection="row">
                <Text color={isSelected ? "cyan" : "gray"}>
                  {isSelected ? "▶ " : "  "}
                </Text>
                <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                  /{cmd.name}
                </Text>
                <Text dimColor> — {cmd.description}</Text>
              </Box>
            );
          })}

          {/* 滚动指示器（下方） */}
          {visibleEnd < matchedCommands.length && (
            <Text dimColor>  ↓ 还有 {matchedCommands.length - visibleEnd} 个命令</Text>
          )}

          <Text dimColor italic>  ↑↓ 选择 · Tab 补全 · Esc 关闭 · Enter 提交</Text>
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
