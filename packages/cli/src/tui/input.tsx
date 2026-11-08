/**
 * @fengagent/cli — TUI 输入框组件（claude-code 风格框状输入）
 *
 * 圆角边框输入区 + 占位提示 + ↑↓ 输入历史 recall；
 * / 命令自动补全（↑↓ 选择、Tab/Enter 补全、Esc 关闭）优先于历史。
 *
 * 设计要点：
 * 1. 输入区带圆角边框（claude-code 惯例），占位符随状态切换；
 * 2. 历史 recall：面板关闭时空输入 ↑ 召回上一条、↓ 前进；提交后指针复位；
 * 3. 补全列表用流式布局 + 显式 height，防止被 flexGrow 压缩；
 * 4. useRef 避免 useInput 闭包陈旧；
 * 5. 方向键转义序列兜底兼容（\x1b[A/\x1b[B/\x1bOA/\x1bOB）。
 */

import React, { useState, useRef, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { ThinkingPet } from "./thinking-pet.tsx";
import { filterCommands, COMMANDS } from "../commands.ts";
import { theme } from "./theme.ts";

/** 可视行数 */
const MAX_VISIBLE = 10;

/** 历史最大保留条数 */
const MAX_HISTORY = 100;

/** 输入框最多显示的行数（更长的草稿折叠，避免挤掉对话区） */
const MAX_DISPLAY_LINES = 5;


/** 折叠后单次最多显示的字符数（超长单行也会被截断显示） */
const MAX_DISPLAY_CHARS = 400;

/**
 * 计算输入框的显示文本（只影响显示，`value` 本身始终是完整内容）。
 *
 * `/skill <name>` 会把技能 prompt（12~20 行）灌进输入框，原样铺开会把对话区
 * 挤出屏幕；这里折叠成前 N 行 + 一行提示，回车发送仍是完整 prompt。
 */
function foldForDisplay(value: string): {
  text: string;
  folded: boolean;
  hiddenLines: number;
  hiddenChars: number;
} {
  const chars = [...value];
  let text = chars.slice(0, MAX_DISPLAY_CHARS).join("");
  let hiddenChars = chars.length - [...text].length;

  const lines = text.split("\n");
  let hiddenLines = 0;
  if (lines.length > MAX_DISPLAY_LINES) {
    hiddenLines = lines.length - MAX_DISPLAY_LINES;
    // 折叠掉的行里还有字符，一并计入隐藏字数
    hiddenChars += lines.slice(MAX_DISPLAY_LINES).join("\n").length;
    text = lines.slice(0, MAX_DISPLAY_LINES).join("\n");
  }

  return {
    text,
    folded: hiddenLines > 0 || hiddenChars > 0,
    hiddenLines,
    hiddenChars,
  };
}

export interface InputProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /**
   * 外部注入的输入草稿（`/skill <name>` 把技能 prompt 填进输入框）。
   *
   * 用 `id` 判断「新的一次注入」：同 id 重渲染不会覆盖用户已经改过的内容。
   */
  draft?: { text: string; id: number };
}

/**
 * 历史导航（纯函数，供测试）。
 *
 * history 为旧→新排列；index === -1 表示「当前草稿」（未在历史中）。
 * 返回新 index；越界钳制在 [-1, history.length - 1]。
 */
export function navigateHistory(
  history: string[],
  index: number,
  direction: "prev" | "next",
): number {
  if (history.length === 0) return -1;
  if (direction === "prev") {
    // 草稿态（-1）→ 最新一条；已最旧则停在 0
    if (index < 0) return history.length - 1;
    return Math.max(0, index - 1);
  }
  // next：最新一条 → 草稿态（-1）；草稿态停留
  if (index < 0) return -1;
  return index >= history.length - 1 ? -1 : index + 1;
}

export function Input({
  onSubmit,
  disabled = false,
  placeholder = "发消息 · / 命令 · ↑ 历史 · Tab 补全",
  draft,
}: InputProps): React.ReactElement {
  const [value, setValue] = useState("");
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  /** 已提交输入历史（旧→新） */
  const historyRef = useRef<string[]>([]);
  /** 当前历史指针（-1 = 草稿态）；草稿内容在进入历史浏览时暂存 */
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");

  const showAutoRef = useRef(false);
  const selectedRef = useRef(0);
  const matchedRef = useRef<ReturnType<typeof filterCommands>>([]);

  // 外部草稿注入：只在 id 变化时应用（不覆盖用户后续编辑）
  const appliedDraftId = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!draft || appliedDraftId.current === draft.id) return;
    appliedDraftId.current = draft.id;
    setValue(draft.text);
    setShowAutocomplete(false);
    showAutoRef.current = false;
    setSelectedIdx(0);
    selectedRef.current = 0;
    setScrollOffset(0);
  }, [draft]);

  const matchedCommands = useMemo(() => {
    if (showAutocomplete && value.startsWith("/")) {
      return filterCommands(value);
    }
    return [];
  }, [showAutocomplete, value]);

  const display = useMemo(() => foldForDisplay(value), [value]);

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

  function submitCurrent() {
    setShowAutocomplete(false);
    showAutoRef.current = false;
    const trimmed = value.trim();
    if (trimmed) {
      // 入历史（去重：与最新一条相同则不重复压栈）
      const history = historyRef.current;
      if (history[history.length - 1] !== trimmed) {
        history.push(trimmed);
        if (history.length > MAX_HISTORY) history.shift();
      }
      historyIndexRef.current = -1;
      draftRef.current = "";
      onSubmit(trimmed);
      setValue("");
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
        submitCurrent();
        return;
      }
      if (key.escape) {
        setShowAutocomplete(false);
        showAutoRef.current = false;
        return;
      }
    }

    if (key.return) {
      submitCurrent();
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

    // ↑↓ 历史召回（补全面板关闭时；正在浏览草稿优先保存）
    const isUpSeq = key.upArrow || input === "\x1b[A" || input === "\x1bOA";
    const isDownSeq = key.downArrow || input === "\x1b[B" || input === "\x1bOB";
    if (isUpSeq || isDownSeq) {
      const history = historyRef.current;
      if (history.length === 0) return;
      if (isUpSeq) {
        // 进入历史浏览前暂存草稿
        if (historyIndexRef.current === -1) draftRef.current = value;
        const next = navigateHistory(history, historyIndexRef.current, "prev");
        if (next >= 0) {
          historyIndexRef.current = next;
          setValue(history[next]!);
          setShowAutocomplete(false);
          showAutoRef.current = false;
        }
      } else {
        const next = navigateHistory(history, historyIndexRef.current, "next");
        historyIndexRef.current = next;
        if (next === -1) {
          setValue(draftRef.current);
        } else {
          setValue(history[next]!);
        }
      }
      return;
    }
    if (key.leftArrow || key.rightArrow) return;
    // 翻页/跳转键由对话视图（ChatView）处理，不应进入输入框内容
    // （同时兼容 Windows/Bun 下未解析成 key 标志的原始转义序列）
    if (key.pageUp || key.pageDown) return;
    if (
      input === "\x1b[5~" || input === "\x1b[6~" ||
      input === "\x1b[5;5~" || input === "\x1b[6;5~" ||
      input === "[5~" || input === "[6~" ||
      input === "[5;5~" || input === "[6;5~"
    ) {
      return;
    }

    // 追加可打印字符（过滤转义序列）；任何编辑都退出历史浏览回到草稿态
    if (input && input.length > 0 && input !== "\x1b") {
      const cleanInput = input.replace(/\x1b\[[A-D]/g, "");
      if (!cleanInput) return;

      setValue((prev) => {
        const newVal = prev + cleanInput;
        historyIndexRef.current = -1;
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

  return (
    <Box flexDirection="column">
      {/* 补全列表 — 流式布局，输入框正上方，显式 height 防止被压缩 */}
      {showAutocomplete && matchedCommands.length > 0 && !disabled && (
        <Box flexDirection="column" height={listHeight}>
          {visibleStart > 0 && (
            <Text dimColor>  ↑ 还有 {visibleStart} 个命令</Text>
          )}

          {visibleCommands.map((cmd, i) => {
            const realIdx = visibleStart + i;
            const isSelected = realIdx === selectedIdx;
            return (
              <Box key={cmd.name} flexDirection="row">
                <Text color={isSelected ? theme.brand : theme.subtle}>
                  {isSelected ? "▶ " : "  "}
                </Text>
                <Text color={isSelected ? theme.brand : undefined} bold={isSelected}>
                  /{cmd.name}
                </Text>
                <Text dimColor> — {cmd.description}</Text>
              </Box>
            );
          })}

          {visibleEnd < matchedCommands.length && (
            <Text dimColor>  ↓ 还有 {matchedCommands.length - visibleEnd} 个命令</Text>
          )}

          <Text color={theme.dim} italic>  ↑↓选择 · Tab补全 · Esc关闭 · Enter提交</Text>
        </Box>
      )}

      {/* 输入区 — claude-code 风格圆角边框 + 状态化占位符 */}
      <Box
        borderStyle="round"
        borderColor={disabled ? theme.border : theme.brandDim}
        paddingX={1}
        flexShrink={0}
      >
        <Box flexDirection="row">
          {disabled ? (
            <ThinkingPet />
          ) : (
            <Text color={theme.prompt} bold>{"❯ "}</Text>
          )}
          <Box flexGrow={1}>
            {disabled ? (
              <Text dimColor italic>{placeholder}（生成中，Esc 中断）</Text>
            ) : value ? (
              <Text>{display.text}<Text color={theme.brand}>█</Text></Text>
            ) : (
              <Text dimColor italic>{placeholder}</Text>
            )}
          </Box>
        </Box>
      </Box>

      {/* 折叠提示行 — 在输入框下方；只影响显示，Enter 发送仍是完整内容 */}
      {!disabled && display.folded && (
        <Text dimColor italic>
          {"  "}… 已折叠 {display.hiddenLines} 行 / {display.hiddenChars} 字（Enter 发送时完整带上）
        </Text>
      )}
    </Box>
  );
}

export const TOTAL_COMMANDS = COMMANDS.length;
