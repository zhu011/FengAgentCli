/**
 * @fengagent/cli — Slash 命令处理
 *
 * 解析和处理 /session、/model、/provider、/export、/compact、/clear、/restore、/tool 等命令。
 * 命令元数据集中在 COMMANDS 表中，供 handleCommand、getHelpMessage、自动补全共用。
 */

import type { Agent } from "@fengagent/agent";
import type { Config, Session } from "@fengagent/core";
import { maskApiKey, writeConfigFile } from "@fengagent/core";
import { readSync, writeFileSync, writeSync } from "node:fs";
import { reloadProvider } from "./create-agent.ts";

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
  { name: "provider", description: "查看/配置 Provider（apiKey 自动打码）", usage: "/provider show|set <type> [--api-key ..] [--base-url ..] [--model ..]", category: "模型" },
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

    case "provider":
      return handleProviderCommand(args, ctx);

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
    const config = ctx.agent.getConfig();
    return {
      handled: true,
      message:
        "用法:\n" +
        "  /model <id>   — 切换到指定模型（持久化并立即生效）\n" +
        "  /model list   — 列出当前 Provider 可用/已配置的模型\n" +
        `当前模型: ${ctx.currentModel}\n` +
        `当前 Provider: ${config.provider}`,
    };
  }

  if (args[0] === "list") {
    // 列表需要异步构建（openai-compatible 会尝试拉取真实 /models 目录），
    // 返回标记由 App 层异步处理（与 __COMPACT__ 同模式）。
    return { handled: true, message: "__MODEL_LIST__" };
  }

  return handleModelSwitch(args.join(" ").trim(), ctx);
}

/**
 * 处理 /model <id> — 真正切换模型并立即生效。
 *
 * 机制（复用 /provider 的 config + ReloadableLLMClient 热替换链路）：
 * 1. 持久化 config.model（openai-compatible 同时写入 openaiCompatibleModel）到 .fengagent/config.json
 * 2. reloadProvider 重建底层 LLM Client（新 defaultModel），原子替换，无需重建 Agent
 * 3. 返回 newModel，App 层同步更新当前会话的 session.model —
 *    Agent Loop 每次请求都读取 session.model 作为 request.model，因此后续对话真实走新模型
 */
function handleModelSwitch(modelId: string, ctx: CommandContext): CommandResult {
  if (!modelId) {
    return {
      handled: true,
      message: "用法: /model <id>\n使用 /model list 查看可用模型。",
    };
  }

  const config = ctx.agent.getConfig();
  const provider = config.provider;

  // 配置补丁：model 必写；openai-compatible 额外写 openaiCompatibleModel（与 /provider 一致）
  const patch: Record<string, unknown> = { model: modelId };
  if (provider === "openai-compatible") {
    patch.openaiCompatibleModel = modelId;
  }

  // 持久化到 ./.fengagent/config.json（deepMerge 保留其他配置键）
  const filePath = writeConfigFile(patch);

  // 立即生效：重建 LLM Client 并热替换
  let hotReloaded = false;
  try {
    hotReloaded = reloadProvider(patch) !== null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      handled: true,
      message:
        `配置已写入 ${filePath}，但热加载失败: ${message}\n请重启后生效。`,
      newModel: modelId,
    };
  }

  return {
    handled: true,
    message:
      `✅ 已切换模型: ${ctx.currentModel} → ${modelId}\n` +
      `  config: ${filePath}  (已持久化，重启后自动加载)\n` +
      (hotReloaded
        ? `  ✓ 已热加载生效 — 后续对话将使用新模型`
        : `  ⚠ 当前实例未接入热加载，请重启后生效`),
    newModel: modelId,
  };
}

// ──────────────────────────────────────────────
// /model list — 当前 Provider 实际可用/已配置的模型
// ──────────────────────────────────────────────

/** 各 Provider 的常用真实模型目录（fallback：无法联网拉取时使用） */
const MODEL_CATALOG: Record<string, Array<{ id: string; note: string }>> = {
  anthropic: [
    { id: "claude-opus-4-1", note: "Claude Opus 4.1 (Anthropic)" },
    { id: "claude-sonnet-4-20250514", note: "Claude Sonnet 4 (Anthropic)" },
    { id: "claude-haiku-4-5-20251001", note: "Claude Haiku 4.5 (Anthropic)" },
    { id: "claude-3-5-sonnet-20241022", note: "Claude 3.5 Sonnet (Anthropic)" },
    { id: "claude-3-5-haiku-20241022", note: "Claude 3.5 Haiku (Anthropic)" },
  ],
  openai: [
    { id: "gpt-4o", note: "GPT-4o (OpenAI)" },
    { id: "gpt-4o-mini", note: "GPT-4o Mini (OpenAI)" },
    { id: "gpt-4.1", note: "GPT-4.1 (OpenAI)" },
    { id: "gpt-4.1-mini", note: "GPT-4.1 Mini (OpenAI)" },
    { id: "o4-mini", note: "o4-mini (OpenAI)" },
  ],
  google: [
    { id: "gemini-2.5-pro", note: "Gemini 2.5 Pro (Google)" },
    { id: "gemini-2.5-flash", note: "Gemini 2.5 Flash (Google)" },
    { id: "gemini-2.0-flash", note: "Gemini 2.0 Flash (Google)" },
    { id: "gemini-1.5-pro", note: "Gemini 1.5 Pro (Google)" },
  ],
  // openai-compatible：优先拉取服务端真实目录，失败时回退到这份常见模型
  "openai-compatible": [
    { id: "deepseek-chat", note: "DeepSeek V3 (通用对话)" },
    { id: "deepseek-reasoner", note: "DeepSeek R1 (推理)" },
  ],
};

/** 3 秒超时的 AbortSignal */
const MODEL_LIST_TIMEOUT_MS = 3000;

/**
 * 异步构建 /model list 输出。
 *
 * - openai-compatible：配置了 baseUrl + apiKey 时，尝试 GET {baseURL}/models
 *   拉取真实可用模型目录；失败/未配置时回退到 MODEL_CATALOG 并注明。
 * - 其他 Provider：使用 MODEL_CATALOG 真实模型 ID，并标注当前已配置模型。
 *
 * @param ctx - 命令上下文
 * @returns 展示用的多行文本
 */
export async function buildModelListMessage(
  ctx: CommandContext,
): Promise<string> {
  const config = ctx.agent.getConfig();
  const provider = config.provider;
  const currentModel =
    (provider === "openai-compatible"
      ? config.openaiCompatibleModel
      : undefined) ?? config.model;

  const lines: string[] = [];
  lines.push(`当前 Provider: ${provider}  当前模型: ${currentModel}`);
  lines.push("");

  if (provider === "openai-compatible") {
    const baseUrl = config.openaiCompatibleBaseUrl;
    const apiKey = config.openaiCompatibleApiKey;
    if (baseUrl && apiKey) {
      const remote = await fetchProviderModels(baseUrl, apiKey);
      if (remote.length > 0) {
        lines.push(`模型列表 (${baseUrl}/models):`);
        lines.push(...formatModelList(remote, currentModel));
        lines.push("");
        lines.push("提示: /model <id> 切换模型（持久化并立即生效）。");
        return lines.join("\n");
      }
      lines.push(`⚠ 无法连接 ${baseUrl}/models，显示常见模型目录:`);
    } else {
      lines.push("⚠ 未配置 baseUrl/apiKey，显示常见模型目录:（可用 /provider set openai-compatible 配置）");
    }
  } else {
    lines.push(`模型列表 (${provider} 常用真实模型):`);
  }

  const catalog = MODEL_CATALOG[provider] ?? MODEL_CATALOG["openai-compatible"]!;
  lines.push(...formatModelList(catalog.map((m) => m.id), currentModel));
  lines.push("");
  lines.push("提示: /model <id> 切换模型（持久化并立即生效）。");
  return lines.join("\n");
}

/** 将模型 ID 列表格式化为带「当前」标记的行 */
function formatModelList(
  modelIds: string[],
  currentModel: string,
): string[] {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const id of modelIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const isCurrent = id === currentModel;
    rows.push(`  ${id}${isCurrent ? "  ← 当前" : ""}`);
  }
  return rows;
}

/**
 * 拉取 OpenAI 兼容端点 /models 的真实模型目录。
 *
 * @param baseUrl - 服务端地址（如 https://api.deepseek.com）
 * @param apiKey - API Key
 * @returns 模型 ID 列表；失败时返回空数组
 */
async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  try {
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/models`;
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const json = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };
    const ids = (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return ids;
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────
// /provider 命令
// ──────────────────────────────────────────────

/** 支持的 Provider 类型 */
const PROVIDER_TYPES = ["anthropic", "openai", "openai-compatible", "google"] as const;
type ProviderType = (typeof PROVIDER_TYPES)[number];

/** Provider 与 Config 字段 / 环境变量的映射 */
interface ProviderFieldMap {
  label: string;
  /** Config 中存放 apiKey 的键（如 openaiCompatibleApiKey） */
  apiKeyKey: keyof Config;
  /** Config 中存放 baseUrl 的键 */
  baseUrlKey: keyof Config;
  /** Config 中存放 model 的键（仅 openai-compatible 有独立字段） */
  modelKey?: keyof Config;
  /** 对应的环境变量名（用于读取/回显当前值） */
  envApiKey: string;
  envBaseUrl: string;
  envModel?: string;
  /** 未配置 baseUrl 时的官方默认地址（openai-compatible 无默认，必须用户提供） */
  defaultBaseUrl: string;
  requireBaseUrl: boolean;
  requireModel: boolean;
}

const PROVIDER_FIELD_MAP: Record<ProviderType, ProviderFieldMap> = {
  anthropic: {
    label: "Anthropic",
    apiKeyKey: "anthropicApiKey",
    baseUrlKey: "anthropicBaseUrl",
    envApiKey: "ANTHROPIC_API_KEY",
    envBaseUrl: "ANTHROPIC_BASE_URL",
    defaultBaseUrl: "https://api.anthropic.com",
    requireBaseUrl: false,
    requireModel: false,
  },
  openai: {
    label: "OpenAI",
    apiKeyKey: "openaiApiKey",
    baseUrlKey: "openaiBaseUrl",
    envApiKey: "OPENAI_API_KEY",
    envBaseUrl: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
    requireBaseUrl: false,
    requireModel: false,
  },
  "openai-compatible": {
    label: "OpenAI-Compatible",
    apiKeyKey: "openaiCompatibleApiKey",
    baseUrlKey: "openaiCompatibleBaseUrl",
    modelKey: "openaiCompatibleModel",
    envApiKey: "OPENAI_COMPATIBLE_API_KEY",
    envBaseUrl: "OPENAI_COMPATIBLE_BASE_URL",
    envModel: "OPENAI_COMPATIBLE_MODEL",
    defaultBaseUrl: "",
    requireBaseUrl: true,
    requireModel: true,
  },
  google: {
    label: "Google Gemini",
    apiKeyKey: "googleApiKey",
    baseUrlKey: "googleBaseUrl",
    envApiKey: "GOOGLE_API_KEY",
    envBaseUrl: "GOOGLE_BASE_URL",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    requireBaseUrl: false,
    requireModel: false,
  },
};

const PROVIDER_HELP =
  "用法:\n" +
  "  /provider show                                   — 查看当前 Provider 配置（apiKey 打码）\n" +
  "  /provider set <type> [--api-key X] [--base-url Y] [--model Z]\n" +
  "      type: anthropic | openai | openai-compatible | google\n" +
  "      未通过参数提供的项会逐项提示输入（apiKey 输入时不回显）。";

/** 处理 /provider 命令 */
function handleProviderCommand(
  args: string[],
  ctx: CommandContext,
): CommandResult {
  const subCmd = args[0]?.toLowerCase();

  if (!subCmd || subCmd === "help") {
    return { handled: true, message: PROVIDER_HELP };
  }

  if (subCmd === "show") {
    return handleProviderShow(ctx);
  }

  if (subCmd === "set") {
    return handleProviderSet(args.slice(1), ctx);
  }

  return {
    handled: true,
    message: `未知的 provider 子命令: ${subCmd}\n${PROVIDER_HELP}`,
  };
}

/** 处理 /provider show — 显示当前 provider / baseUrl / model / 打码 apiKey */
function handleProviderShow(ctx: CommandContext): CommandResult {
  const config = ctx.agent.getConfig();
  const type = (PROVIDER_TYPES as readonly string[]).includes(config.provider)
    ? (config.provider as ProviderType)
    : "anthropic";
  const map = PROVIDER_FIELD_MAP[type];

  const apiKey =
    (config[map.apiKeyKey] as string | undefined) ??
    process.env[map.envApiKey];
  const baseUrl =
    (config[map.baseUrlKey] as string | undefined) ??
    process.env[map.envBaseUrl] ??
    (map.defaultBaseUrl || "未配置");
  const model =
    (map.modelKey ? (config[map.modelKey] as string | undefined) : undefined) ??
    config.model ??
    "未配置";
  const apiKeyFrom = config[map.apiKeyKey]
    ? "config 文件"
    : process.env[map.envApiKey]
      ? "环境变量"
      : "未配置";

  return {
    handled: true,
    message:
      `当前 Provider 配置:\n` +
      `  provider: ${type} (${map.label})\n` +
      `  baseUrl:  ${baseUrl}\n` +
      `  model:    ${model}\n` +
      `  apiKey:   ${maskApiKey(apiKey)}  (来源: ${apiKeyFrom})\n` +
      `\n提示: /provider set <type> 可修改配置；apiKey 不回显明文。`,
  };
}

/** 处理 /provider set <type> [--api-key] [--base-url] [--model] */
function handleProviderSet(
  args: string[],
  ctx: CommandContext,
): CommandResult {
  const typeArg = (PROVIDER_TYPES as readonly string[]).includes(
    args[0]?.toLowerCase() ?? "",
  )
    ? args[0]
    : args.find((a) =>
        (PROVIDER_TYPES as readonly string[]).includes(a.toLowerCase()),
      );
  const type = (typeArg?.toLowerCase() ?? "") as ProviderType;
  if (!(PROVIDER_TYPES as readonly string[]).includes(type)) {
    return {
      handled: true,
      message: `无效的 Provider 类型: "${typeArg ?? ""}"\n可用类型: ${PROVIDER_TYPES.join(" / ")}\n\n${PROVIDER_HELP}`,
    };
  }

  const flags = parseProviderFlags(args);
  const map = PROVIDER_FIELD_MAP[type];
  const config = ctx.agent.getConfig();

  // 当前值（配置文件 > 环境变量 > 官方默认）
  const currentBaseUrl =
    (config[map.baseUrlKey] as string | undefined) ??
    process.env[map.envBaseUrl] ??
    map.defaultBaseUrl;
  const currentModel =
    (map.modelKey ? (config[map.modelKey] as string | undefined) : undefined) ??
    config.model ??
    "";

  // 1) apiKey（必填）— 优先 --api-key，否则逐项提示输入（不回显明文）
  let apiKey = flags.apiKey ?? "";
  if (!apiKey) {
    apiKey = promptProviderField(`请输入 ${map.label} API Key`, {
      secret: true,
      defaultValue: "",
    });
    if (!apiKey) {
      return { handled: true, message: "已取消：API Key 不能为空。" };
    }
  }

  // 2) baseUrl — 优先 --base-url，否则提示输入（留空使用当前值/官方默认）
  let baseUrl = flags.baseUrl ?? "";
  if (!baseUrl) {
    baseUrl = promptProviderField(`请输入 ${map.label} Base URL`, {
      secret: false,
      defaultValue: currentBaseUrl,
    });
  }
  if (!baseUrl && map.requireBaseUrl) {
    return {
      handled: true,
      message: "已取消：openai-compatible 必须提供 Base URL。",
    };
  }

  // 3) model — 优先 --model，否则提示输入
  let model = flags.model ?? "";
  if (!model) {
    model = promptProviderField("请输入模型 ID", {
      secret: false,
      defaultValue: currentModel,
    });
  }
  if (!model && map.requireModel) {
    return {
      handled: true,
      message: "已取消：openai-compatible 必须提供模型 ID。",
    };
  }

  const effectiveModel = model || currentModel || config.model;

  // 构建配置补丁（provider + apiKey/baseUrl + model）
  const patch: Record<string, unknown> = {
    provider: type,
    model: effectiveModel,
    [map.apiKeyKey]: apiKey,
  };
  if (baseUrl) {
    patch[map.baseUrlKey] = baseUrl;
  }
  if (map.modelKey && model) {
    patch[map.modelKey] = model;
  }

  // 持久化到 ./.fengagent/config.json（项目级，deepMerge 保留其他配置键）
  const filePath = writeConfigFile(patch);

  // 立即生效：重建 LLM Client 并热替换（Agent 无需重建）
  let hotReloaded = false;
  try {
    hotReloaded = reloadProvider(patch) !== null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      handled: true,
      message:
        `配置已写入 ${filePath}，但热加载失败: ${message}\n` +
        `请重启后生效。`,
    };
  }

  return {
    handled: true,
    message:
      `✅ Provider 已配置: ${type} (${map.label})\n` +
      `  apiKey:   ${maskApiKey(apiKey)}  (已保存，不回显明文)\n` +
      `  baseUrl:  ${baseUrl || "(未设置)"}\n` +
      `  model:    ${effectiveModel}\n` +
      `  config:   ${filePath}  (已持久化，重启后自动加载)\n` +
      (hotReloaded
        ? `  ✓ 已热加载生效 — 直接发消息即可使用新 Provider`
        : `  ⚠ 当前实例未接入热加载，请重启后生效`),
    newModel: effectiveModel,
  };
}

/** 解析 /provider set 的 --api-key / --base-url / --model 参数（支持 = 或空格两种形式） */
function parseProviderFlags(args: string[]): {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
} {
  const result: { apiKey?: string; baseUrl?: string; model?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const m = arg.match(/^--(api-key|base-url|model)(?:=(.*))?$/);
    if (!m) continue;
    const field = m[1] as "api-key" | "base-url" | "model";
    let value = m[2];
    if (value === undefined) {
      value = args[i + 1];
      i++;
    }
    if (!value) continue;
    if (field === "api-key") result.apiKey = value;
    else if (field === "base-url") result.baseUrl = value;
    else result.model = value;
  }
  return result;
}

// ──────────────────────────────────────────────
// 交互式逐项输入（同步，供 TUI 内 /provider set 使用）
// ──────────────────────────────────────────────

/** 向 stderr 同步写提示（绕过 TUI 渲染层，不污染 stdout） */
function writeStderr(text: string): void {
  try {
    writeSync(2, text);
  } catch {
    process.stderr.write(text);
  }
}

/** 暂停/恢复 Ink 的 stdin 监听，避免输入串扰 */
function pauseStdin(): void {
  try {
    (process.stdin as { pause?: () => void }).pause?.();
  } catch {
    // 忽略
  }
}

function resumeStdin(): void {
  try {
    (process.stdin as { resume?: () => void }).resume?.();
  } catch {
    // 忽略
  }
}

/** 切换 stdin 原始模式（Ink TUI 使用 raw mode，提示输入前需临时切换） */
function setStdinRawMode(raw: boolean): void {
  const stdin = process.stdin as { setRawMode?: (b: boolean) => unknown; isRaw?: boolean };
  if (typeof stdin.setRawMode === "function") {
    try {
      stdin.setRawMode(raw);
    } catch {
      // 非 TTY 时忽略
    }
  }
}

/** 同步读取一行（cooked 模式，带行编辑；无输入返回空串） */
function readLineSync(): string {
  const chunks: string[] = [];
  const buf = new Uint8Array(256);
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, buf.length, null as unknown as number);
    } catch {
      break;
    }
    if (n <= 0) break;
    const chunk = new TextDecoder().decode(buf.subarray(0, n));
    chunks.push(chunk);
    if ((chunks.join("")).includes("\n") || (chunks.join("")).includes("\r")) {
      break;
    }
  }
  return chunks.join("").replace(/[\r\n]+$/, "").trim();
}

/** 同步读取密文（raw mode 逐字符，回显 *，支持退格；Ctrl+C 取消返回空串） */
function readSecretSync(): string {
  let result = "";
  const buf = new Uint8Array(16);
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, buf.length, null as unknown as number);
    } catch {
      break;
    }
    if (n <= 0) continue;
    const text = new TextDecoder().decode(buf.subarray(0, n));
    for (const ch of text) {
      if (ch === "\r" || ch === "\n") {
        writeStderr("\n");
        return result;
      }
      if (ch === "\u0003") {
        writeStderr("\n(已取消)\n");
        return "";
      }
      if (ch === "\b" || ch === "\u007f") {
        if (result.length > 0) {
          result = result.slice(0, -1);
          writeStderr("\b \b");
        }
        continue;
      }
      result += ch;
      writeStderr("*");
    }
  }
  return result;
}

/**
 * 交互式提示输入单个字段。
 *
 * @param prompt - 提示文本
 * @param opts.secret - true 时输入不回显（apiKey）；false 为普通行输入
 * @param opts.defaultValue - 留空回车时使用的默认值
 */
function promptProviderField(
  prompt: string,
  opts: { secret: boolean; defaultValue: string },
): string {
  const suffix = opts.defaultValue ? ` (留空使用: ${opts.defaultValue})` : "";
  writeStderr(
    `\n${prompt}${suffix}${opts.secret ? " [输入不回显]:" : ":"} `,
  );

  pauseStdin();
  const stdin = process.stdin as { isRaw?: boolean };
  const prevRaw = stdin.isRaw;
  try {
    if (opts.secret) {
      setStdinRawMode(true);
      return readSecretSync();
    }
    setStdinRawMode(false);
    return readLineSync();
  } finally {
    setStdinRawMode(prevRaw ?? true);
    resumeStdin();
  }
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
