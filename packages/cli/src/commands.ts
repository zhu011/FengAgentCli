/**
 * @fengagent/cli — Slash 命令处理
 *
 * 解析和处理 /session、/model、/export、/clear、/help、/exit 等命令。
 */

import type { Agent } from "@fengagent/agent";
import type { Session } from "@fengagent/core";
import { writeFileSync } from "node:fs";

/** 命令处理结果 */
export interface CommandResult {
  /** 是否为已识别的命令 */
  handled: boolean;
  /** 要显示的消息（加入对话视图） */
  message?: string;
  /** 是否请求退出 */
  shouldExit?: boolean;
  /** 是否请求清屏 */
  shouldClear?: boolean;
  /** 新会话（切换/新建后） */
  newSession?: Session;
  /** 新模型（切换后） */
  newModel?: string;
}

/** 命令处理上下文 */
export interface CommandContext {
  agent: Agent;
  currentSession?: Session;
  currentModel: string;
}

/**
 * 解析并执行 slash 命令。
 *
 * 支持的命令：
 * - /help — 显示帮助
 * - /exit / /quit — 退出
 * - /clear — 清屏
 * - /session new [title] — 新建会话
 * - /session list — 列出会话
 * - /session switch <id> — 切换会话
 * - /model <id> — 切换模型
 * - /model list — 列出可用模型
 * - /export [file] — 导出当前会话
 */
export function handleCommand(
  input: string,
  ctx: CommandContext,
): CommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case "help":
      return {
        handled: true,
        message: getHelpMessage(),
      };

    case "exit":
    case "quit":
      return {
        handled: true,
        shouldExit: true,
        message: "再见！",
      };

    case "clear":
      return {
        handled: true,
        shouldClear: true,
      };

    case "session":
      return handleSessionCommand(args, ctx);

    case "model":
      return handleModelCommand(args, ctx);

    case "export":
      return handleExportCommand(args, ctx);

    default:
      return {
        handled: true,
        message: `未知命令: /${cmd}\n输入 /help 查看可用命令。`,
      };
  }
}

/** 处理 /session 命令 */
function handleSessionCommand(
  args: string[],
  ctx: CommandContext,
): CommandResult {
  const subCmd = args[0]?.toLowerCase();

  if (!subCmd || subCmd === "help") {
    return {
      handled: true,
      message:
        "用法:\n" +
        "  /session new [title]  — 新建会话\n" +
        "  /session list         — 列出所有会话\n" +
        "  /session switch <id>  — 切换到指定会话",
    };
  }

  if (subCmd === "new") {
    const title = args.slice(1).join(" ") || `Session ${new Date().toLocaleString()}`;
    const session = ctx.agent.createSession(title);
    return {
      handled: true,
      message: `已新建会话: ${session.title} (${session.id.slice(0, 8)})`,
      newSession: session,
    };
  }

  if (subCmd === "list") {
    const sessions = ctx.agent.listSessions();
    if (sessions.length === 0) {
      return {
        handled: true,
        message: "暂无保存的会话。",
      };
    }

    const lines = sessions.map((s) => {
      const time = new Date(s.updatedAt).toLocaleString();
      const current = s.id === ctx.currentSession?.id ? " ← 当前" : "";
      return `  ${s.id.slice(0, 8)}  ${s.title}  [${s.model}]  ${time}${current}`;
    });

    return {
      handled: true,
      message: `会话列表 (${sessions.length}):\n${lines.join("\n")}`,
    };
  }

  if (subCmd === "switch") {
    const id = args[1];
    if (!id) {
      return {
        handled: true,
        message: "用法: /session switch <id>\n使用 /session list 查看会话 ID。",
      };
    }
    const session = ctx.agent.loadSession(id);
    if (!session) {
      return {
        handled: true,
        message: `会话 "${id}" 未找到。使用 /session list 查看可用会话。`,
      };
    }
    return {
      handled: true,
      message: `已切换到会话: ${session.title} (${session.id.slice(0, 8)})\n消息数: ${session.messages.length}`,
      newSession: session,
    };
  }

  return {
    handled: true,
    message: `未知的 session 子命令: ${subCmd}`,
  };
}

/** 处理 /model 命令 */
function handleModelCommand(
  args: string[],
  ctx: CommandContext,
): CommandResult {
  if (args.length === 0 || args[0] === "help") {
    return {
      handled: true,
      message:
        "用法:\n" +
        "  /model <id>   — 切换到指定模型\n" +
        "  /model list   — 列出常见模型\n" +
        `当前模型: ${ctx.currentModel}`,
    };
  }

  if (args[0] === "list") {
    const models = [
      "claude-sonnet-4-20250514    — Claude Sonnet 4 (Anthropic)",
      "claude-haiku-3               — Claude Haiku 3 (Anthropic)",
      "gpt-4o                       — GPT-4o (OpenAI)",
      "gpt-4o-mini                  — GPT-4o Mini (OpenAI)",
      "claude-3-5-sonnet-20241022   — Claude 3.5 Sonnet (Anthropic)",
    ];
    return {
      handled: true,
      message: `常见模型:\n${models.map((m) => `  ${m}`).join("\n")}`,
    };
  }

  const modelId = args.join(" ");
  return {
    handled: true,
    message: `已切换模型: ${ctx.currentModel} → ${modelId}`,
    newModel: modelId,
  };
}

/** 处理 /export 命令 */
function handleExportCommand(
  args: string[],
  ctx: CommandContext,
): CommandResult {
  if (!ctx.currentSession) {
    return {
      handled: true,
      message: "没有活动会话可导出。",
    };
  }

  const filename =
    args[0] ??
    `fengagent-export-${ctx.currentSession.id.slice(0, 8)}-${Date.now()}.md`;

  try {
    const content = sessionToMarkdown(ctx.currentSession);
    writeFileSync(filename, content, "utf-8");
    return {
      handled: true,
      message: `已导出 ${ctx.currentSession.messages.length} 条消息到: ${filename}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      handled: true,
      message: `导出失败: ${message}`,
    };
  }
}

/** 将会话转换为 Markdown 格式 */
function sessionToMarkdown(session: Session): string {
  const lines: string[] = [];
  lines.push(`# ${session.title}`);
  lines.push("");
  lines.push(`- **Session ID:** ${session.id}`);
  lines.push(`- **Model:** ${session.model}`);
  lines.push(`- **Created:** ${new Date(session.createdAt).toISOString()}`);
  lines.push(`- **Updated:** ${new Date(session.updatedAt).toISOString()}`);
  lines.push(`- **Messages:** ${session.messages.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const msg of session.messages) {
    const role = msg.role === "user" ? "🧑 User" : msg.role === "assistant" ? "🤖 Assistant" : "⚙️ System";
    const time = new Date(msg.createdAt).toISOString();
    lines.push(`## ${role}`);
    lines.push(`*${time}*`);
    lines.push("");

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          lines.push(block.text);
          lines.push("");
          break;
        case "tool-use":
          lines.push("```json");
          lines.push(JSON.stringify({ tool: block.name, input: block.input }, null, 2));
          lines.push("```");
          lines.push("");
          break;
        case "tool-result":
          lines.push(`> Tool result (${block.isError ? "error" : "success"}):`);
          lines.push("```");
          lines.push(block.content);
          lines.push("```");
          lines.push("");
          break;
        case "thinking":
          lines.push("> 💭 *Thinking:*");
          lines.push(`> ${block.text}`);
          lines.push("");
          break;
        case "image":
          lines.push("[image content]");
          lines.push("");
          break;
      }
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/** 获取帮助消息文本 */
function getHelpMessage(): string {
  return (
    "可用命令:\n" +
    "  /help                — 显示此帮助\n" +
    "  /exit, /quit         — 退出\n" +
    "  /clear               — 清屏\n" +
    "\n" +
    "会话管理:\n" +
    "  /session new [title] — 新建会话\n" +
    "  /session list        — 列出会话\n" +
    "  /session switch <id> — 切换会话\n" +
    "\n" +
    "模型:\n" +
    "  /model <id>          — 切换模型\n" +
    "  /model list          — 列出常见模型\n" +
    "\n" +
    "导出:\n" +
    "  /export [file]       — 导出当前会话为 Markdown\n" +
    "\n" +
    "直接输入文本并按 Enter 发送消息。"
  );
}
