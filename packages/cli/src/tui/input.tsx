/**
 * @fengagent/cli — TUI 输入框组件
 *
 * 多行输入框，Enter 发送、Ctrl+C 退出。
 * 支持 / 命令自动补全（↑↓ 选择、Tab/Enter 补全、Esc 关闭）。
 *
 * 设计要点：
 * 1. 补全列表用 position="absolute" 悬浮层，不占流式布局
 * 2. 滚动窗口：selectedIdx 变化时自动调整可视范围
 * 3. useRef 避免 useInput 闭包陈旧
 * 4. 方向键转义序列兜底兼容（\x1b[A/\x1b[B/\x1bOA/\x1bOB）
 */

import React, { useState, useRef, useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { ThinkingPet } from "./thinking-pet.tsx";
import { filterCommands, COMMANDS } from "../commands.ts";

/** 可视行数 */
const MAX_VISIBLE = 10;

export interface InputProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function Input({
  onSubmit,
  disabled = false,
  placeholder = "输入消息，按 Enter 发送...",
}: InputProps): React.ReactElement {
  const { stdout } = useStdout();
  const [value, setValue] = useState("");
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  const showAutoRef = useRef(false);
  const selectedRef = useRef(0);
  const matchedRef = useRef<ReturnType<typeof filterCommands>>([]);

  const matchedCommands = useMemo(() => {
    if (showAutocomplete && value.startsWith("/")) {
      return filterCommands(value);
    }
    return [];
  }, [showAutocomplete, value]);

  showAutoRef.current = showAutocomplete;
  matchedRef.current = matchedCommands;
  selectedRef.current = selectedIdx;

  const visibleStart = scrollOffset;
  const visibleEnd = Math.min(scrollOffset + MAX_VISIBLE, matchedCommands.length);
  const visibleCommands = matchedCommands.slice(visibleStart, visibleEnd);
  // 列表高度 = 可视行数 + 指示器 + 提示行
  const listHeight = visibleCommands.length + 2;

  function updateSelected(newIdx: number) {
    setSelectedIdx(newIdx);
    selectedRef.current = newIdx;
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
      // 方向键转义序列兜底兼容：
      // Windows/Bun 下 useInput 可能没把 \x1b[A/\x1b[B 解析成 key.upArrow/downArrow
      // 而是当普通 input 传进来，导致「按两次才生效」
      // 显式识别转义序列，等价于 key.upArrow/downArrow
      const isUp = key.upArrow || input === "\x1b[A" || input === "\x1bOA";
      const isDown = key.downArrow || input === "\x1b[B" || input === "\x1bOB";

      if (isUp) {
        const cur = selectedRef.current;
        const newIdx = cur > 0 ? cur - 1 : matched.length - 1;
        updateSelected(newIdx);
        return;
      }
      if (isDown) {
        const cur = selectedRef.current;
        const newIdx = cur < matched.length - 1 ? cur + 1 : 0;
        updateSelected(newIdx);
        return;
      }
      if (key.tab) {
        const selected = matched[selectedRef.current];
        if (selected) {
          setValue(`/${selected.name} `);
          setShowAutocomplete(false);
          showAutoRef.current = false;
        }
        return;
      }
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
        setShowAutocomplete(false);
        showAutoRef.current = false;
        const trimmed = value.trim();
        if (trimmed) {
          onSubmit(trimmed);
          setValue("");
        }
        return;
      }
      if (key.escape) {
        setShowAutocomplete(false);
        showAutoRef.current = false;
        return;
      }
    }

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

    if (key.ctrl && input === "c") return;
    if (key.ctrl || key.meta) return;
    if (key.upArrow || key.downArrow) return;
    if (key.leftArrow || key.rightArrow) return;

    // 追加可打印字符（过滤转义序列）
    if (input && input.length > 0 && input !== "\x1b") {
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

  // 计算悬浮层位置：用 marginTop 偏移到终端底部上方
  const termHeight = stdout?.rows ?? 24;
  // 列表悬浮在输入框上方，用 marginTop 推到正确位置
  const marginTop = Math.max(0, termHeight - listHeight - 2);

  return (
    <Box flexDirection="column">
      {/* 补全列表 — 悬浮层，不占流式布局 */}
      {showAutocomplete && matchedCommands.length > 0 && !disabled && (
        <Box
          flexDirection="column"
          position="absolute"
          marginTop={marginTop}
          marginLeft={0}
          width="100%"
        >
          {visibleStart > 0 && (
            <Text dimColor>  ↑ 还有 {visibleStart} 个命令</Text>
          )}

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

          {visibleEnd < matchedCommands.length && (
            <Text dimColor>  ↓ 还有 {matchedCommands.length - visibleEnd} 个命令</Text>
          )}

          <Text dimColor italic>  ↑↓选择 · Tab补全 · Esc关闭 · Enter提交</Text>
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

export const TOTAL_COMMANDS = COMMANDS.length;
