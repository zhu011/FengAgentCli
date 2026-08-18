/**
 * @fengagent/cli — TUI 对话视图组件
 *
 * 渲染消息列表：用户消息、助手消息（含 Markdown 渲染）、工具调用卡片。
 * 支持流式文本实时显示。
 *
 * 长内容滚动（修复长对话布局崩坏）：
 * - Ink/Yoga 对固定高度容器会「压扁」溢出的内容（flex 收缩会把部分行压成 0 高），
 *   导致消息很长时：底部图标/输入框/状态栏被挤出屏幕、后续问答不可见、token 百分比消失。
 * - 本组件改为「切片渲染」：按行估算内容总高度，只渲染落在可视窗口
 *   [scrollTop, scrollTop+vh) 内的消息，边界消息按行裁剪，配合负 margin 偏移，
 *   保证渲染出的内容高度 ≤ 视口高度，从根上杜绝溢出与压扁。
 * - 默认贴底（stick-to-bottom）：新消息/流式文本到达时自动滚动到底部；
 *   PgUp/PgDn 手动翻阅历史，滚到最底后自动恢复贴底。
 *
 * 视觉语言借鉴 dsh-TUI：用户/助手标签用语义色，代码块品牌色边框，
 * 消息分隔用细点线，整体低调统一。
 */

import React, { useRef, useState, useMemo, useLayoutEffect } from "react";
import { Box, Text, useInput, useStdout, measureElement } from "ink";
import type { DOMElement } from "ink";
import type { Message } from "@fengagent/core";
import { ToolView, type ToolCallInfo } from "./tool-view.tsx";
import { ThinkingPet } from "./thinking-pet.tsx";
import { theme } from "./theme.ts";

export interface ChatViewProps {
  /** 已完成的消息列表 */
  messages: Message[];
  /** 当前正在流式输出的文本 */
  streamingText: string;
  /** 当前轮次的工具调用 */
  toolCalls: ToolCallInfo[];
  /** 是否正在运行 */
  isRunning: boolean;
}

// ──────────────────────────────────────────────
// 行宽估算（用于切片渲染的可视窗口计算）
// ──────────────────────────────────────────────

/** 字符显示宽度：CJK / emoji 占 2 列，其余 1 列 */
function charDisplayWidth(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (
    (c >= 0x1100 && c <= 0x115f) || // Hangul Jamo
    c === 0x2329 || c === 0x232a ||
    (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || // CJK / Yi
    (c >= 0xac00 && c <= 0xd7a3) || // Hangul Syllables
    (c >= 0xf900 && c <= 0xfaff) || // CJK Compat Ideographs
    (c >= 0xfe10 && c <= 0xfe19) || // Vertical forms
    (c >= 0xfe30 && c <= 0xfe6f) || // CJK Compat Forms
    (c >= 0xff00 && c <= 0xff60) || // Fullwidth Forms
    (c >= 0xffe0 && c <= 0xffe6) || // Fullwidth signs
    (c >= 0x1f300 && c <= 0x1faff) // Emoji
  ) {
    return 2;
  }
  return 1;
}

/** 字符串的显示宽度（CJK/emoji 按 2 列计） */
function displayWidthOf(text: string): number {
  let w = 0;
  for (const ch of text) w += charDisplayWidth(ch);
  return w;
}

/** 文本按宽度换行后的行数（含空行） */
function wrappedLineCount(text: string, width: number): number {
  if (width <= 0) return text === "" ? 1 : text.split("\n").length;
  let total = 0;
  for (const line of text.split("\n")) {
    if (line === "") {
      total += 1;
    } else {
      total += Math.max(1, Math.ceil(displayWidthOf(line) / width));
    }
  }
  return total;
}

/** 截断字符串（与 ToolView 内部一致） */
function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/** 估算工具卡片（展开态）的渲染行数 */
function estimateToolCardHeight(
  _name: string,
  input: unknown,
  result: { content: string; isError?: boolean } | undefined,
  contentWidth: number,
): number {
  let h = 3; // 上下边框 2 行 + 状态行 1 行
  const innerWidth = Math.max(1, contentWidth - 4);
  const inputText =
    typeof input === "string"
      ? input
      : input === null || input === undefined
        ? ""
        : (() => {
            try {
              return JSON.stringify(input, null, 2);
            } catch {
              return String(input);
            }
          })();
  if (input !== undefined && input !== null) {
    h += 1 + wrappedLineCount(truncateText(inputText, 200), innerWidth);
  }
  if (result !== undefined) {
    h += 1 + wrappedLineCount(truncateText(result.content, 500), innerWidth);
  }
  return h;
}

/** 估算单条消息的渲染行数（与 MessageItem 实际渲染结构一致） */
function estimateMessageHeight(message: Message, columns: number): number {
  const contentWidth =
    message.role === "user" ? Math.max(1, columns - 8) : columns;
  let h = 1; // 角色标签行
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        h += wrappedLineCount(block.text, contentWidth);
        break;
      case "thinking":
        h += 1 + wrappedLineCount(block.text, contentWidth);
        break;
      case "tool-use":
        h += estimateToolCardHeight(block.name, block.input, undefined, contentWidth);
        break;
      case "image":
        h += 1;
        break;
      case "tool-result":
        break; // 渲染为 null，不计高度
    }
  }
  h += 1; // 消息间分隔线
  return Math.max(2, h);
}

/** 估算流式输出区（助手标签 + 文本 + 工具卡片）的渲染行数 */
function estimateStreamingHeight(
  streamingText: string,
  toolCalls: ToolCallInfo[],
  isRunning: boolean,
  columns: number,
): number {
  if (!isRunning && streamingText === "" && toolCalls.length === 0) return 0;
  let h = 1; // "FengAgentCli:" 标签
  if (streamingText !== "") {
    h += wrappedLineCount(streamingText, columns);
  } else {
    h += 1; // ThinkingPet
  }
  for (const tc of toolCalls) {
    h += estimateToolCardHeight(tc.name, tc.input, tc.result, columns);
  }
  return h;
}

/**
 * 按「显示行」裁剪文本：返回渲染后占据 [skipRows, skipRows+maxRows) 行的文本片段。
 * 逐逻辑行累计换行行数，跳过窗口上方的行，边界行按显示宽度做字符级截断。
 */
function sliceTextToRows(
  text: string,
  skipRows: number,
  maxRows: number,
  width: number,
): string {
  if (skipRows <= 0 && maxRows === Infinity) return text;
  if (maxRows <= 0) return "";
  const lines = text.split("\n");
  const out: string[] = [];
  let consumed = 0; // 已跳过的行数
  let emitted = 0; // 已输出的行数（显示行）
  let done = false;

  for (const line of lines) {
    if (done) break;
    const rows = line === "" ? 1 : Math.max(1, Math.ceil(displayWidthOf(line) / Math.max(1, width)));

    // 整行在窗口上方：跳过
    if (consumed + rows <= skipRows) {
      consumed += rows;
      continue;
    }
    // 行内起始位置（该行被窗口从中间切入时）
    const lineStart = Math.max(0, skipRows - consumed);
    consumed += rows;

    // 该行可见的显示行数
    const visibleRows = Math.min(rows - lineStart, maxRows - emitted);
    if (visibleRows <= 0) {
      done = true;
      break;
    }
    emitted += visibleRows;

    if (lineStart === 0 && visibleRows === rows) {
      // 整行可见
      out.push(line);
    } else {
      // 部分可见：按显示宽度截断字符
      const charBudget = visibleRows * Math.max(1, width);
      let w = 0;
      let slice = "";
      for (const ch of line) {
        const cw = charDisplayWidth(ch);
        if (w + cw > charBudget) break;
        w += cw;
        slice += ch;
      }
      out.push(slice);
    }
    if (emitted >= maxRows) done = true;
  }
  return out.join("\n");
}

// ──────────────────────────────────────────────
// 渲染组件
// ──────────────────────────────────────────────

/**
 * 渲染单条消息。
 *
 * @param skipRows 从消息顶部跳过的显示行数（该消息部分位于窗口上方时）
 * @param maxRows  最多渲染的显示行数（该消息部分位于窗口下方时截断）
 */
function MessageItem({
  message,
  skipRows = 0,
  maxRows = Infinity,
}: {
  message: Message;
  skipRows?: number;
  maxRows?: number;
}): React.ReactElement | null {
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const isUser = message.role === "user";
  const roleLabel = isUser ? "你" : "FengAgentCli";
  const roleColor = isUser ? theme.user : theme.assistant;
  const contentWidth = isUser ? Math.max(1, columns - 8) : columns;

  let row = 0; // 当前已遍历的消息内行号
  const windowEnd = skipRows + maxRows;
  const isRowVisible = (rows: number): boolean => {
    const s = row;
    row += rows;
    return s + rows > skipRows && s < windowEnd;
  };
  const visibleTextRows = (text: string, width: number): string => {
    const s = row;
    const rows = wrappedLineCount(text, width);
    row += rows;
    if (s + rows <= skipRows || s >= windowEnd) return "";
    const vf = Math.max(0, skipRows - s);
    const vt = Math.min(rows, windowEnd - s);
    return sliceTextToRows(text, vf, vt - vf, width);
  };

  let labelPart: React.ReactNode = null;
  const contentParts: React.ReactNode[] = [];

  // 角色标签行
  if (isRowVisible(1)) {
    labelPart = (
      <Box key="label" flexDirection="row" justifyContent={isUser ? "flex-end" : "flex-start"}>
        <Text color={roleColor} bold>
          {isUser ? "▸ " : ""}{roleLabel}{isUser ? "" : ":"}
        </Text>
      </Box>
    );
  }

  // 内容块
  message.content.forEach((block, i) => {
    switch (block.type) {
      case "text": {
        const sliced = visibleTextRows(block.text, contentWidth);
        if (sliced !== "") {
          contentParts.push(<Box key={`b${i}`} flexDirection="column"><MarkdownText text={sliced} /></Box>);
        }
        break;
      }
      case "thinking": {
        const sliced = visibleTextRows(block.text, contentWidth);
        if (sliced !== "") {
          contentParts.push(
            <Box key={`b${i}`} flexDirection="column">
              <Text color={theme.dim} italic>💭 {sliced}</Text>
            </Box>,
          );
        }
        break;
      }
      case "tool-use": {
        const rows = estimateToolCardHeight(block.name, block.input, undefined, contentWidth);
        if (isRowVisible(rows)) {
          contentParts.push(
            <Box key={`b${i}`} flexDirection="column">
              <ToolView info={{ id: block.id, name: block.name, input: block.input }} />
            </Box>,
          );
        }
        break;
      }
      case "image": {
        if (isRowVisible(1)) {
          contentParts.push(<Text key={`b${i}`} color={theme.dim}>[image]</Text>);
        }
        break;
      }
      case "tool-result":
        break; // 渲染为 null
    }
  });

  // 消息间细点线分隔
  if (isRowVisible(1)) {
    contentParts.push(
      <Text key="sep" color={theme.subtle} dimColor>· · · · · · · · · · · · · · · · · · · · · · · · · · · ·</Text>,
    );
  }

  if (labelPart === null && contentParts.length === 0) return null;

  return (
    <Box flexDirection="column" width="100%" marginY={0}>
      <Box flexDirection="row" width="100%" justifyContent={isUser ? "flex-end" : "flex-start"}>
        <Box flexDirection="column" width="100%">
          {labelPart}
          {/* 用户消息内容缩进（与原布局一致） */}
          <Box flexDirection="column" paddingLeft={isUser ? 8 : 0} width="100%">
            {contentParts}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * 简易 Markdown 渲染。
 *
 * 支持：
 * - 代码块 (```)
 * - 行内代码 (`)
 * - 粗体 (**)
 * - 标题 (#, ##, ###)
 * - 列表项 (-, *)
 * - 普通段落
 */
function MarkdownText({ text }: { text: string }): React.ReactElement {
  const blocks = parseMarkdown(text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <MarkdownBlock key={i} block={block} />
      ))}
    </Box>
  );
}

/** Markdown 块类型 */
type Mdblock =
  | { type: "code"; content: string; lang?: string }
  | { type: "heading"; level: number; content: string }
  | { type: "list"; items: string[] }
  | { type: "paragraph"; content: string }
  | { type: "blank" };

/** 解析 Markdown 文本为块 */
function parseMarkdown(text: string): Mdblock[] {
  const lines = text.split("\n");
  const blocks: Mdblock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 空行
    if (line.trim() === "") {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    // 代码块
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim() || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // 跳过结束 ```
      blocks.push({ type: "code", content: codeLines.join("\n"), lang });
      continue;
    }

    // 标题
    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1]!.length,
        content: headingMatch[2]!,
      });
      i++;
      continue;
    }

    // 列表项
    if (/^[\s]*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[\s]*[-*]\s+/.test(lines[i]!)) {
        const item = lines[i]!.replace(/^[\s]*[-*]\s+/, "");
        items.push(item);
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    // 普通段落（合并连续非空行）
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.trim().startsWith("```") &&
      !/^(#{1,3})\s+/.test(lines[i]!) &&
      !/^[\s]*[-*]\s+/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    blocks.push({ type: "paragraph", content: paraLines.join(" ") });
  }

  return blocks;
}

/** 渲染 Markdown 块 */
function MarkdownBlock({ block }: { block: Mdblock }): React.ReactElement | null {
  switch (block.type) {
    case "code":
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.brandDim} paddingX={1}>
          {block.lang && (
            <Text color={theme.dim} italic>{block.lang}</Text>
          )}
          <Text color={theme.brand}>{block.content}</Text>
        </Box>
      );

    case "heading": {
      const sizes = {
        1: { bold: true, color: theme.text },
        2: { bold: true, color: theme.brandBright },
        3: { bold: false, color: theme.dim },
      };
      const style = sizes[block.level as 1 | 2 | 3] ?? sizes[3]!;
      return (
        <Text bold={style.bold} color={style.color}>
          {block.content}
        </Text>
      );
    }

    case "list":
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Text key={i}>
              <Text color={theme.dim}>  • </Text>
              <InlineFormatted text={item} />
            </Text>
          ))}
        </Box>
      );

    case "paragraph":
      return <InlineFormatted text={block.content} />;

    case "blank":
      return <Text> </Text>;

    default:
      return null;
  }
}

/** 渲染行内格式（粗体、行内代码） */
function InlineFormatted({ text }: { text: string }): React.ReactElement {
  // 分割行内代码和粗体
  const parts = splitInline(text);
  return (
    <Text>
      {parts.map((part, i) => {
        if (part.type === "code") {
          return (
            <Text key={i} color={theme.brandBright} backgroundColor={theme.border}>
              {` ${part.content} `}
            </Text>
          );
        }
        if (part.type === "bold") {
          return (
            <Text key={i} bold>
              {part.content}
            </Text>
          );
        }
        return <Text key={i}>{part.content}</Text>;
      })}
    </Text>
  );
}

/** 行内格式片段 */
type InlinePart =
  | { type: "text"; content: string }
  | { type: "code"; content: string }
  | { type: "bold"; content: string };

/** 分割行内格式 */
function splitInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  // 匹配 `code` 或 **bold**
  const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // 前面的普通文本
    if (match.index > lastIndex) {
      parts.push({
        type: "text",
        content: text.slice(lastIndex, match.index),
      });
    }

    if (match[1] !== undefined) {
      // 行内代码（去掉反引号）
      parts.push({
        type: "code",
        content: match[1].slice(1, -1),
      });
    } else if (match[2] !== undefined) {
      // 粗体（去掉 **）
      parts.push({
        type: "bold",
        content: match[2].slice(2, -2),
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // 剩余的普通文本
  if (lastIndex < text.length) {
    parts.push({ type: "text", content: text.slice(lastIndex) });
  }

  return parts.length > 0 ? parts : [{ type: "text", content: text }];
}

/** 可视区域高度缺失时的估算兜底（终端行数 - 头部/宠物/输入/状态栏等固定 UI） */
const FALLBACK_CHROME_ROWS = 6;

/** 底部裁剪的安全余量：换行估算偏差时避免渲染内容超出视口 */
const BOTTOM_CUT_SAFETY = 2;

/** 流式输出区切片渲染（按行裁剪） */
function StreamingSection({
  streamingText,
  toolCalls,
  isRunning,
  skipRows = 0,
  maxRows = Infinity,
}: {
  streamingText: string;
  toolCalls: ToolCallInfo[];
  isRunning: boolean;
  skipRows?: number;
  maxRows?: number;
}): React.ReactElement | null {
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  let row = 0;
  const windowEnd = skipRows + maxRows;
  const visibleText = (text: string, width: number): string => {
    const s = row;
    const rows = wrappedLineCount(text, width);
    row += rows;
    if (s + rows <= skipRows || s >= windowEnd) return "";
    const vf = Math.max(0, skipRows - s);
    const vt = Math.min(rows, windowEnd - s);
    return sliceTextToRows(text, vf, vt - vf, width);
  };

  const parts: React.ReactNode[] = [];

  // "FengAgentCli:" 标签
  if (row < windowEnd && row + 1 > skipRows) {
    parts.push(<Text key="label" color={theme.assistant} bold>FengAgentCli:</Text>);
  }
  row += 1;

  if (streamingText !== "") {
    const sliced = visibleText(streamingText, columns);
    if (sliced !== "") {
      parts.push(<Box key="text" flexDirection="column"><MarkdownText text={sliced} /></Box>);
    }
  } else if (isRunning && row <= windowEnd && row > skipRows) {
    parts.push(<ThinkingPet key="pet" />);
    row += 1;
  }

  for (const tc of toolCalls) {
    const rows = estimateToolCardHeight(tc.name, tc.input, tc.result, columns);
    if (row + rows > skipRows && row < windowEnd) {
      parts.push(<Box key={tc.id} flexDirection="column"><ToolView info={tc} /></Box>);
    }
    row += rows;
  }

  if (parts.length === 0) return null;
  return <Box flexDirection="column">{parts}</Box>;
}

/**
 * 对话视图 — 渲染消息列表和流式输出。
 *
 * 视口策略：
 * - 根 Box 撑满父容器（flexGrow），其实际高度通过 measureElement 测量；
 * - 内容按行估算总高度，仅渲染落在 [scrollTop, scrollTop+vh] 内的消息，
 *   边界消息按行裁剪 + 负 margin 偏移，渲染内容高度 ≤ 视口高度；
 * - 默认贴底（stick-to-bottom）：新消息/流式文本到达时自动滚动到底部；
 * - PgUp/PgDn 手动翻阅，滚到最底后自动恢复贴底。
 */
export function ChatView({
  messages,
  streamingText,
  toolCalls,
  isRunning,
}: ChatViewProps): React.ReactElement {
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;

  const viewportRef = useRef<DOMElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const stickRef = useRef(true);

  // 测量视口实际高度（每帧渲染后执行，值不变时避免多余 setState）
  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const { height } = measureElement(node);
    setViewportHeight((prev) => (prev === height ? prev : height));
  });

  const vh = viewportHeight ?? Math.max(10, (stdout.rows ?? 24) - FALLBACK_CHROME_ROWS);

  // 内容总高度 = 各消息高度 + 流式输出区高度
  const itemHeights = useMemo(
    () => messages.map((m) => estimateMessageHeight(m, columns)),
    [messages, columns],
  );
  const streamingHeight = estimateStreamingHeight(
    streamingText,
    toolCalls,
    isRunning,
    columns,
  );
  const totalHeight =
    itemHeights.reduce((a, b) => a + b, 0) + streamingHeight;
  const maxScroll = Math.max(0, totalHeight - vh);

  // 贴底：新内容到达时自动滚到底；用户上翻时解除贴底
  useLayoutEffect(() => {
    if (stickRef.current) {
      setScrollTop(maxScroll);
    } else if (scrollTop > maxScroll) {
      setScrollTop(maxScroll);
    }
  });

  const clampedScrollTop = Math.min(Math.max(0, scrollTop), maxScroll);
  const windowStart = clampedScrollTop;
  const windowEnd = clampedScrollTop + vh;

  // 内容块序列：消息 + 流式输出区
  const blocks = useMemo(() => {
    const list: { kind: "message" | "streaming"; message?: Message; rows: number }[] = [];
    messages.forEach((m, i) => {
      list.push({ kind: "message", message: m, rows: itemHeights[i]! });
    });
    if (streamingHeight > 0) {
      list.push({ kind: "streaming", rows: streamingHeight });
    }
    return list;
  }, [messages, itemHeights, streamingHeight]);

  // 底部指示器：未在底部时保留 1 行
  const showBelowIndicator = clampedScrollTop < maxScroll;
  const contentEnd = windowEnd - (showBelowIndicator ? 1 : 0);

  // 计算落在可视窗口内的块区间
  const slice = useMemo(() => {
    let first = -1;
    let last = -1;
    let cursor = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      if (cursor + b.rows > windowStart && cursor < contentEnd) {
        if (first === -1) first = i;
        last = i;
      }
      cursor += b.rows;
    }
    const belowLines = Math.max(0, totalHeight - windowEnd);
    return { first, last, belowLines };
  }, [blocks, windowStart, contentEnd, totalHeight]);

  // PgUp/PgDn 翻阅历史
  useInput((_input, key) => {
    if (key.pageUp) {
      const step = Math.max(1, Math.floor(vh * 0.8));
      setScrollTop((prev) => {
        const next = Math.max(0, prev - step);
        if (next < maxScroll) stickRef.current = false;
        return next;
      });
      return;
    }
    if (key.pageDown) {
      const step = Math.max(1, Math.floor(vh * 0.8));
      setScrollTop((prev) => {
        const next = Math.min(maxScroll, prev + step);
        if (next >= maxScroll) stickRef.current = true;
        return next;
      });
      return;
    }
  });

  // 渲染内容块
  const rendered: React.ReactNode[] = [];
  if (slice.first !== -1 && slice.last !== -1) {
    for (let i = slice.first; i <= slice.last; i++) {
      const b = blocks[i]!;
      const blockStart = (() => {
        let c = 0;
        for (let j = 0; j < i; j++) c += blocks[j]!.rows;
        return c;
      })();
      const skipRows = Math.max(0, windowStart - blockStart);
      const isLast = i === slice.last;
      const lastEnd = Math.min(blockStart + b.rows, contentEnd);
      const maxRows =
        isLast && blockStart + b.rows > contentEnd
          ? Math.max(1, lastEnd - blockStart - BOTTOM_CUT_SAFETY)
          : Infinity;

      if (b.kind === "message" && b.message) {
        rendered.push(
          <MessageItem
            key={b.message.id ?? i}
            message={b.message}
            skipRows={skipRows}
            maxRows={maxRows}
          />,
        );
      } else if (b.kind === "streaming") {
        rendered.push(
          <StreamingSection
            key="streaming"
            streamingText={streamingText}
            toolCalls={toolCalls}
            isRunning={isRunning}
            skipRows={skipRows}
            maxRows={maxRows}
          />,
        );
      }
    }
  }

  return (
    <Box
      ref={viewportRef}
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      width="100%"
      overflowY="hidden"
    >
      <Box flexDirection="column" width="100%">
        {rendered}
        {showBelowIndicator && (
          <Text color={theme.dim} dimColor>
            ↓ 还有 {slice.belowLines} 行 · PgUp/PgDn 滚动
          </Text>
        )}
      </Box>
    </Box>
  );
}
