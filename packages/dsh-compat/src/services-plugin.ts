/**
 * @fengagent/dsh-compat — 服务面插件（P2 + P3 收尾）
 *
 * `dshCompatPlugin`（P1）只补 `ctx.tools` 的 dsh 接口面；本插件补**更高阶服务面**：
 * `ctx.sessions` / `ctx.agents` / `ctx.agentDefaultModel`（P2）、`ctx.llm`（P3），
 * 以及 `ctx.systemPrompt` / `ctx.fs` / `ctx.sessionProjections`（P3 收尾）。
 *
 * 装配顺序（runtime 插件列表）：
 * ```
 * feng.model        （可选：没有时 agentDefaultModel 用 fallback）
 * feng.storage      （必需：sessions 的事实源）
 * dsh-services      （本插件）
 * <dsh 插件…>       （inject: ['sessions'|'systemPrompt'|'fs'|'sessionProjections'…] 可解析）
 * ```
 *
 * 与 `dshCompatPlugin` 分开导出是刻意的：只想装 tools-only dsh 插件的运行时不
 * 应该凭空多出 `ctx.sessions`（那会让 `inject: ['sessions']` 的插件误以为
 * 事件溯源能力可用）。需要服务面的运行时显式装配本插件。
 *
 * 服务通过 `ctx.reflect.provide(name, instance)` 注册，随装配 fiber 卸载自动注销，
 * 不新增 `@deepseek-ai/cordis` 依赖。
 */

import type { StorageService } from "@fengagent/cordis";
import type { ToolDefinition } from "@fengagent/core";
import type { DshCapability, DshContextLike, DshToolSchema } from "./contracts.ts";
import { AgentDefaultModelCompat } from "./agent-default-model.ts";
import { AgentsCompat } from "./agents.ts";
import { LocalFileSystemCompat } from "./fs.ts";
import { LlmCompat, type DshModelLike } from "./llm.ts";
import { SessionEventLog } from "./session-events.ts";
import { SessionProjectionsCompat } from "./session-projections.ts";
import { SessionsCompat } from "./sessions.ts";
import { SystemPromptCompat } from "./system-prompt.ts";

export const name = "dsh-services";
/** 事实源：storage。model 可选，因此不进 inject（缺失时 agentDefaultModel 走 fallback） */
export const inject = ["storage"];

export interface DshServicesConfig {
  /** 模型服务缺失时的默认 provider（透传给 agentDefaultModel 的 fallback） */
  provider?: string;
  /** 模型服务缺失时的默认 model */
  model?: string;
  /** dsh JSON-Schema → FengAgentCli ToolDefinition 的转换器（`ctx.llm` 带 tools 时必需） */
  toolSchemaConverter?: (schema: DshToolSchema) => ToolDefinition;
  /**
   * 是否装配 `ctx.fs`（默认开）。关掉后 `inject: ['fs']` 的插件会在装载前被
   * loader 的 inject 预检点名拒绝，而不是装到一半才发现。
   */
  fs?: boolean;
  /** 是否装配 `ctx.systemPrompt`（默认开） */
  systemPrompt?: boolean;
  /**
   * 是否装配 `ctx.sessionProjections` + 进程内领域事件日志（默认开）。
   * 关掉后 `session.append` 与 `todo-plus` 这类插件回到「明确不支持」。
   */
  sessionProjections?: boolean;
}

/**
 * 本插件实际提供的契约能力清单（与 `docs/DSH-CONTRACT-MAP.md` 的表一一对应）。
 *
 * 用途：宿主/加载器可在装配 dsh 插件前做 preflight，按 `tier` 决定是否放行，
 * 而不是等插件跑到一半才炸。
 */
export const DSH_SERVICE_CAPABILITIES: readonly DshCapability[] = Object.freeze([
  { path: "sessions.get", tier: "direct", mappedTo: "StorageService.loadSession" },
  {
    path: "sessions.list",
    tier: "adapt",
    mappedTo: "StorageService.listSessions",
    notes: "元信息来自 sessions 表；每条再 loadSession 取消息",
  },
  {
    path: "sessions.create",
    tier: "adapt",
    mappedTo: "StorageService.saveSession",
    notes: "仅支持空 seed；meta 只有 cwd 校验并留在内存 header",
  },
  {
    path: "sessions.fork",
    tier: "adapt",
    mappedTo: "StorageService.saveMessages",
    notes: "消息 id 必须重发（主键全局唯一）；seq 边界按投影换算",
  },
  { path: "sessions.flush", tier: "direct", mappedTo: "StorageService.flush" },
  { path: "sessions.prepare", tier: "unsupported", mappedTo: "—", notes: "无未发布创建事务" },
  { path: "sessions.enter", tier: "unsupported", mappedTo: "—", notes: "同上" },
  { path: "sessions.announce", tier: "unsupported", mappedTo: "—", notes: "同上" },
  {
    path: "session.events",
    tier: "adapt",
    mappedTo: "projection.projectSessionEvents + session-events.SessionEventLog",
    notes: "消息的有损投影 + 进程内领域事件；无 chunk/lifecycle/surfaceOp；seq 随追加位移",
  },
  {
    path: "session.append",
    tier: "adapt",
    mappedTo: "session-events.SessionEventLog.append",
    notes: "进程内日志（不落盘）；追加即驱动 sessionProjections；重启丢失领域事件",
  },
  {
    path: "session.requestHeader",
    tier: "adapt",
    mappedTo: "—",
    notes: "恒为 undefined（无 request/header 事件，dsh 侧该值合法）",
  },
  { path: "session.surface", tier: "unsupported", mappedTo: "—", notes: "没有 surfaceOp" },
  { path: "agents.get", tier: "direct", mappedTo: "AgentsCompat.entries" },
  { path: "agents.list", tier: "direct", mappedTo: "AgentsCompat.entries" },
  { path: "agents.roots", tier: "direct", mappedTo: "AgentsCompat.entries (owner=undefined)" },
  { path: "agents.register", tier: "direct", mappedTo: "AgentsCompat.entries" },
  { path: "agents.enter", tier: "direct", mappedTo: "AgentsCompat.entries" },
  { path: "agents.announce", tier: "direct", mappedTo: "AgentsCompat.entries" },
  { path: "agents.isOwnedBy", tier: "direct", mappedTo: "AgentsCompat.entries (owner)" },
  { path: "agents.setFactory", tier: "direct", mappedTo: "AgentsCompat.factory" },
  {
    path: "agents.create",
    tier: "unsupported",
    mappedTo: "—",
    notes: "未注册 factory 时抛错；loop→AgentFactory 桥在 P4",
  },
  { path: "agents.resume", tier: "unsupported", mappedTo: "—", notes: "同上" },
  { path: "agents.withInitiator", tier: "direct", mappedTo: "AsyncLocalStorage" },
  { path: "agents.withoutInitiator", tier: "direct", mappedTo: "AsyncLocalStorage.exit" },
  { path: "agents.currentInitiator", tier: "direct", mappedTo: "AsyncLocalStorage.getStore" },
  { path: "agents.requireInitiator", tier: "direct", mappedTo: "AsyncLocalStorage.getStore" },
  {
    path: "agentDefaultModel.currentSelection",
    tier: "direct",
    mappedTo: "ModelService.provider/model",
  },
  {
    path: "agentDefaultModel.saveSelection",
    tier: "adapt",
    mappedTo: "ModelService.switchProvider",
    notes: "不写 settings 层；reasoningEffort 忽略",
  },
  /* ------------------------------ P3：llm ------------------------------ */
  {
    path: "llm.stream",
    tier: "adapt",
    mappedTo: "LlmCompat.stream → ModelService.stream",
    notes: "注册适配器直通；未注册 provider 回落 ctx.model；失败收敛为终态 finish",
  },
  {
    path: "llm.registerAdapter",
    tier: "direct",
    mappedTo: "LlmCompat.registerAdapter",
    notes: "路由独占 + disposer.replace 原子换路",
  },
  { path: "llm.listProviders", tier: "direct", mappedTo: "LlmCompat.listProviders" },
  {
    path: "llm.providerRetryPolicy",
    tier: "adapt",
    mappedTo: "LlmCompat.providerRetryPolicy",
    notes: "只保存/回报策略；重试执行仍由 dsh-llm-retry 负责",
  },
  {
    path: "llm.listModels",
    tier: "adapt",
    mappedTo: "LlmCompat.listModels",
    notes: "注册适配器委托；回落路由只报当前 model，无目录",
  },
  {
    path: "llm.resolveModelInfo",
    tier: "adapt",
    mappedTo: "LlmCompat.resolveModelInfo",
    notes: "回落路由只保证 provider/model 身份，无 context/reasoning 元数据",
  },
  {
    path: "llm.prepareCall",
    tier: "adapt",
    mappedTo: "LlmCompat.prepareCall",
    notes: "冻结 config + 单次派发；adapterDefaults 不物化",
  },
  {
    path: "llm.registerConfigurableProviders",
    tier: "unsupported",
    mappedTo: "—",
    notes: "需要 settings 命名空间 + 配置 UI 面",
  },
  {
    path: "llm.registerModelDiscovery",
    tier: "unsupported",
    mappedTo: "—",
    notes: "同上（端点探测属配置面）",
  },
  {
    path: "message.fromDsh",
    tier: "adapt",
    mappedTo: "messages.fromDshMessage",
    notes: "保留 id；图片/扩展块无等价物（严格模式抛错）",
  },
  {
    path: "message.toDsh",
    tier: "adapt",
    mappedTo: "messages.toDshMessage",
    notes: "base64 图片没有 attachment 身份（严格模式抛错）",
  },
  /* ------------------------------ P3：scope ------------------------------ */
  {
    path: "scope.of",
    tier: "direct",
    mappedTo: "@deepseek-ai/dsh-scope scopeOf（重导出同一模块实例）",
  },
  {
    path: "scope.create",
    tier: "direct",
    mappedTo: "createAgentScope → dsh-scope createScope",
    notes: "同一 Cordis 4 运行时；sessionId 稳定映射同一把 key",
  },
  { path: "scope.bindParent", tier: "direct", mappedTo: "bindScopeParent（重导出）" },
  {
    path: "scope.target",
    tier: "direct",
    mappedTo: "scopeTarget（重导出）",
    notes: "事件载体可用；工具事件按 scope 路由留 P4",
  },
  /* ---------------------- P3 收尾：systemPrompt / fs / 投影 ---------------------- */
  {
    path: "systemPrompt",
    tier: "adapt",
    mappedTo: "SystemPromptCompat（section/context/variable/tools/assemble）",
    notes: "注册面与装配面同形；不按 scope 分层（同名引用计数覆盖）；complete 段落取最后一个",
  },
  {
    path: "fs",
    tier: "adapt",
    mappedTo: "LocalFileSystemCompat（node:fs 本机后端）",
    notes: "resolve/stat/read/write/edit 全量；不装沙箱（sandboxMode=undefined）；version=size:mtime",
  },
  {
    path: "sessionProjections",
    tier: "adapt",
    mappedTo: "SessionProjectionsCompat（register/snapshot/checkpoint/restore）",
    notes: "驱动来自进程内事件日志；restoreFloor 恒 0、无持久重放",
  },
]);

/**
 * 装配 `sessions` / `agents` / `agentDefaultModel` / `llm` /
 * `systemPrompt` / `fs` / `sessionProjections`。
 *
 * @param ctx - 已装配 `feng.storage` 的 Cordis 上下文
 * @param config - 可选 fallback 模型与三个 P3 服务面的开关
 */
export function apply(ctx: unknown, config: DshServicesConfig = {}): void {
  const context = ctx as DshContextLike & { storage?: StorageService };
  const storage = context.storage;
  if (!storage || typeof storage.listSessions !== "function") {
    throw new Error("dsh-services: ctx.storage 不可用——请先装配 feng.storage");
  }
  if (typeof context.reflect?.provide !== "function") {
    throw new Error("dsh-services: ctx.reflect.provide 不可用——需要 Cordis 4 宿主");
  }

  // 模型服务是可选依赖：不能直接读 ctx.model（未 inject 时 Cordis 代理会抛错）
  const resolveModel = (): { provider?: string; model?: string } | undefined =>
    context.reflect.get?.("model") as { provider?: string; model?: string } | undefined;
  const defaultModel = (): string => resolveModel()?.model ?? config.model ?? "unknown";
  // 投影 + 事件日志：`session.append` 写入日志后驱动投影（todo-plus 的面板状态源）
  const withProjections = config.sessionProjections !== false;
  const sessionEvents = withProjections ? new SessionEventLog() : undefined;
  const sessionProjections = withProjections ? new SessionProjectionsCompat() : undefined;
  const sessions = new SessionsCompat(storage, defaultModel, {
    ...(sessionEvents === undefined ? {} : { events: sessionEvents }),
    ...(sessionProjections === undefined ? {} : { projections: sessionProjections }),
  });
  const agents = new AgentsCompat(context, sessions);
  const agentDefaultModel = new AgentDefaultModelCompat(context, {
    provider: config.provider ?? resolveModel()?.provider ?? "unknown",
    model: config.model ?? defaultModel(),
  });
  // ctx.llm：模型服务可选（缺失时 stream 以 NO_ADAPTER 终态失败，而不是装载期抛错）
  const llm = new LlmCompat(
    context.reflect.get?.("model") as DshModelLike | undefined,
    {
      ...(config.provider === undefined ? {} : { provider: config.provider }),
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.toolSchemaConverter === undefined
        ? {}
        : { toolSchemaConverter: config.toolSchemaConverter }),
    },
  );

  context.reflect.provide("sessions", sessions);
  context.reflect.provide("agents", agents);
  context.reflect.provide("agentDefaultModel", agentDefaultModel);
  context.reflect.provide("llm", llm);
  if (config.systemPrompt !== false) {
    context.reflect.provide("systemPrompt", new SystemPromptCompat());
  }
  if (config.fs !== false) {
    context.reflect.provide("fs", new LocalFileSystemCompat());
  }
  if (sessionProjections !== undefined) {
    context.reflect.provide("sessionProjections", sessionProjections);
  }
}

/** 组装好的插件对象（供 `ctx.plugin(dshServicesPlugin, config)` 使用） */
export const dshServicesPlugin = { name, inject, apply };
