/**
 * @fengagent/cli — Slash 命令处理
 *
 * 解析和处理 /session、/model、/export、/compact、/clear、/restore、/tool 等命令。
 * 命令元数据集中在 COMMANDS 表中，供 handleCommand、getHelpMessage、自动补全共用。
 */

import type { Agent } from "@fengagent/agent";
import type { Session } from "@fengagent/core";
import { writeFileSync } from "node:fs";

/** 命令元数据 */
export interface CommandMeta {
  /** 命令名（不含 /） */
  name: string;
  /** 简短描述 */
  description: string;
  /** 用法示例 */
  usage: string;
  /** 分类 */
  category: "基础" | "会话" | "模型" | "上下文" | "工具" | "导出";
}

/** 所有命令的元数据表（集中维护，供 handleCommand / help / 补全共用） */
export const COMMANDS: CommandMeta[] = [
  { name: "help", description: "显示帮助", usage: "/help", category: "基础" },
  { name: "exit", description: "退出程序", usage: "/exit", category: "基础" },
  { name: "quit", description: "退出程序", usage: "/quit", category: "基础" },
  { name: "clear", description: "清屏（/clear context 清空上下文）", usage: "/clear [context]", category: "上下文" },
  { name: "compact", description: "手动压缩上下文", usage: "/compact", category: "上下文" },
  { name: "restore", description: "从存储恢复会话历史", usage: "/restore", category: "上下文" },
  { name: "session", description: "会话管理", usage: "/session new|list|switch", category: "会话" },
  { name: "model", description: "模型切换", usage: "/model <id>|list", category: "模型" },
  { name: "export", description: "导出会话为 Markdown", usage: "/export [file]", category: "导出" },
  { name: "tool", description: "工具列表", usage: "/tool list", category: "工具" },
];

/** 命令处理结果 */
export interface CommandResult {
  /** 是否为已识别的命令 */
  handled: boolean;
  /** 要显示的消息 */
  message?: string;
  /** 是否请求退出 */
  shouldExit?: boolean;
  /** 是否请求清屏 */
  shouldClear?: boolean;
  /** 是否请求清空上下文 */
  shouldClearContext?: boolean;
  /** 是否请求恢复会话 */
  shouldRestore?: boolean;
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
      return { handled: true, message: getHelpMessage() };

    case "exit":
    case "quit":
      return { handled: true, shouldExit: true, message: "再见！" };

    case "clear":
      if (args[0]?.toLowerCase() === "context") {
        return { handled: true, shouldClearContext: true, message: "已清空当前会话上下文（消息历史已清空，会话 ID 保留）。使用 /restore 恢复。" };
      }
      return { handled: true, shouldClear: true };

    case "compact":
      return handleCompactCommand(ctx);

    case "restore":
      return handleRestoreCommand(ctx);

    case "session":
      return handleSessionCommand(args, ctx);

    case "model":
      return handleModelCommand(args, ctx);

    case "export":
      return handleExportCommand(args, ctx);

    case "tool":
      return handleToolCommand(args, ctx);

    default:
      return {
        handled: true,
        message: `未知命令: /${cmd}\n输入 /help 查看可用命令。`,
      };
  }
}

/** 处理 /compact 命令 */
function handleCompactCommand(ctx: CommandContext): CommandResult {
  if (!ctx.currentSession) {
    return { handled: true, message: "没有活动会话可压缩。" };
  }
  if (ctx.currentSession.messages.length === 0) {
    return { handled: true, message: "当前会话没有消息，无需压缩。" };
  }
  // 异步命令 — 返回标记，由 App 层执行
  return { handled: true, message: "__COMPACT__" };
}

/** 处理 /restore 命令 */
function handleRestoreCommand(ctx: CommandContext): CommandResult {
  if (!ctx.currentSession) {
    return { handled: true, message: "没有活动会话。" };
  }
  // 尝试从 sessionStore 重新加载
  const loaded = ctx.agent.loadSession(ctx.currentSession.id);
  if (loaded && loaded.messages.length > 0) {
    return {
      handled: true,
      message: `已恢复会话历史: ${loaded.messages.length} 条消息`,
      newSession: loaded,
    };
  }
  return {
    handled: true,
    message: "无法恢复会话历史（SessionStore 未启用或无历史数据）。",
  };
}

/** 处理 /tool 命令 */
function handleToolCommand(
  args: string[],
  ctx: CommandContext,
): CommandResult {
  const subCmd = args[0]?.toLowerCase();

  if (!subCmd || subCmd === "list") {
    const tools = ctx.agent.getToolNames();
    if (tools.length === 0) {
      return { handled: true, message: "当前没有注册的工具。" };
    }
    return {
      handled: true,
      message: `已注册工具 (${tools.length}):\n${tools.map((t) => `  ${t}`).join("\n")}`,
    };
  }

  return { handled: true, message: `未知的 tool 子命令: ${subCmd}\n用法: /tool list` };
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
      message: "用法:\n  /session new [title]  — 新建会话\n  /session list         — 列出所有会话\n  /session switch <id>  — 切换到指定会话",
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
      return { handled: true, message: "暂无保存的会话。" };
    }
    const lines = sessions.map((s) => {
      const time = new Date(s.updatedAt).toLocaleString();
      const current = s.id === ctx.currentSession?.id ? " ← 当前" : "";
      return `  ${s.id.slice(0, 8)}  ${s.title}  [${s.model}]  ${time}${current}`;
    });
    return { handled: true, message: `会话列表 (${sessions.length}):\n${lines.join("\n")}` };
  }

  if (subCmd === "switch") {
    const id = args[1];
    if (!id) {
      return { handled: true, message: "用法: /session switch <id>\n使用 /session list 查看会话 ID。" };
    }
    const session = ctx.agent.loadSession(id);
    if (!session) {
      return { handled: true, message: `会话 "${id}" 未找到。使用 /session list 查看可用会话。` };
    }
    return {
      handled: true,
      message: `已切换到会话: ${session.title} (${session.id.slice(0, 8)})\n消息数: ${session.messages.length}`,
      newSession: session,
    };
  }

  return { handled: true, message: `未知的 session 子命令: ${subCmd}` };
}

/** 处理 /model 命令 */
function handleModelCommand(
  args: string[],
  ctx: CommandContext,
): CommandResult {
  if (args.length === 0 || args[0] === "help") {
    return {
      handled: true,
      message: "用法:\n  /model <id>   — 切换到指定模型\n  /model list   — 列出常见模型\n当前模型: " + ctx.currentModel,
    };
  }

  if (args[0] === "list") {
    const models = [
      "claude-sonnet-4-20250514    — Claude Sonnet 4 (Anthropic)",
      "claude-haiku-3               — Claude Haiku 3 (Anthropic)",
      "gpt-4o                       — GPT-4o (OpenAI)",
      "gpt-4o-mini                  — GPT-4o Mini (OpenAI)",
      "deepseek-v4-pro              — DeepSeek V4 Pro (OpenAI-Compatible)",
    ];
    return { handled: true, message: `常见模型:\n${models.map((m) => `  ${m}`).join("\n")}` };
  }

  const modelId = args.join(" ");
  return { handled: true, message: `已切换模型: ${ctx.currentModel} → ${modelId}`, newModel: modelId };
}

/** 处理 /export 命令 */
function handleExportCommand(
  args: string[],
  ctx: CommandContext,
): CommandResult {
  if (!ctx.currentSession) {
    return { handled: true, message: "没有活动会话可导出。" };
  }

  const filename = args[0] ?? `fengagent-export-${ctx.currentSession.id.slice(0, 8)}-${Date.now()}.md`;

  try {
    const content = sessionToMarkdown(ctx.currentSession);
    writeFileSync(filename, content, "utf-8");
    return { handled: true, message: `已导出 ${ctx.currentSession.messages.length} 条消息到: ${filename}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { handled: true, message: `导出失败: ${message}` };
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

/** 获取帮助消息文本（从 COMMANDS 元数据生成） */
export function getHelpMessage(): string {
  const categories: Record<string, CommandMeta[]> = {};
  for (const cmd of COMMANDS) {
    const cat = categories[cmd.category];
    if (!cat) {
      categories[cmd.category] = [];
    }
    categories[cmd.category]!.push(cmd);
  }

  const lines: string[] = ["可用命令:"];
  for (const [category, cmds] of Object.entries(categories)) {
    lines.push("");
    lines.push(`${category}:`);
    for (const cmd of cmds) {
      lines.push(`  ${cmd.usage.padEnd(24)} — ${cmd.description}`);
    }
  }
  lines.push("");
  lines.push("直接输入文本并按 Enter 发送消息。");
  lines.push("输入 / 可查看命令补全列表。");
  return lines.join("\n");
}

/**
 * 按前缀过滤命令列表（供自动补全用）。
 *
 * @param prefix - 已输入的 / 前缀（如 "/com"）
 * @returns 匹配的命令元数据列表
 */
export function filterCommands(prefix: string): CommandMeta[] {
  const q = prefix.startsWith("/") ? prefix.slice(1).toLowerCase() : prefix.toLowerCase();
  if (!q) return COMMANDS;
  return COMMANDS.filter(
    (cmd) =>
      cmd.name.toLowerCase().startsWith(q) ||
      cmd.description.toLowerCase().includes(q),
  );
}
