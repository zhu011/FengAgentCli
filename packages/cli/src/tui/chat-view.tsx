/**
 * @fengagent/cli — TUI 对话视图组件
 *
 * 渲染消息列表：用户消息、助手消息（含 Markdown 渲染）、工具调用卡片。
 * 支持流式文本实时显示。
 */

import React from "react";
import { Box, Text } from "ink";
import type { Message, ContentBlock } from "@fengagent/core";
import { ToolView, type ToolCallInfo } from "./tool-view.tsx";

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

/** 渲染单条消息 */
function MessageItem({ message }: { message: Message }): React.ReactElement {
  const isUser = message.role === "user";
  const roleLabel = isUser ? "你" : "AI";
  const roleColor = isUser ? "cyan" : "green";

  return (
    <Box flexDirection="column" marginY={0}>
      <Text color={roleColor} bold>
        {roleLabel}:
      </Text>
      <Box flexDirection="column">
        {message.content.map((block, i) => (
          <ContentBlockView key={i} block={block} />
        ))}
      </Box>
    </Box>
  );
}

/** 渲染单个内容块 */
function ContentBlockView({
  block,
}: {
  block: ContentBlock;
}): React.ReactElement | null {
  switch (block.type) {
    case "text":
      return <MarkdownText text={block.text} />;

    case "tool-use":
      return (
        <ToolView
          info={{
            id: block.id,
            name: block.name,
            input: block.input,
          }}
        />
      );

    case "tool-result":
      // 工具结果在 tool-use 块中通过 ToolView 展示
      // 这里不重复渲染（tool-result 作为独立 user 消息时跳过）
      return null;

    case "thinking":
      return (
        <Box flexDirection="column">
          <Text dimColor italic>
            💭 {block.text}
          </Text>
        </Box>
      );

    case "image":
      return <Text dimColor>[image]</Text>;

    default:
      return null;
  }
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
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          {block.lang && (
            <Text dimColor italic>{block.lang}</Text>
          )}
          <Text color="cyan">{block.content}</Text>
        </Box>
      );

    case "heading": {
      const sizes = {
        1: { bold: true, color: "white" as const },
        2: { bold: true, color: "gray" as const },
        3: { bold: false, color: "gray" as const },
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
              <Text color="gray">  • </Text>
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
            <Text key={i} color="cyan" backgroundColor="gray">
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

/** 对话视图 — 渲染消息列表和流式输出 */
export function ChatView({
  messages,
  streamingText,
  toolCalls,
  isRunning,
}: ChatViewProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {/* 已完成的消息 */}
      {messages.map((msg, i) => (
        <MessageItem key={msg.id ?? i} message={msg} />
      ))}

      {/* 流式输出中的助手文本 */}
      {(streamingText || isRunning) && (
        <Box flexDirection="column">
          <Text color="green" bold>AI:</Text>
          {streamingText ? (
            <MarkdownText text={streamingText} />
          ) : (
            <Text dimColor italic>...</Text>
          )}
        </Box>
      )}

      {/* 工具调用卡片 */}
      {toolCalls.length > 0 && (
        <Box flexDirection="column" marginY={0}>
          {toolCalls.map((tc) => (
            <ToolView key={tc.id} info={tc} />
          ))}
        </Box>
      )}
    </Box>
  );
}
