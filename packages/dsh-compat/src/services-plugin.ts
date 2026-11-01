/**
 * @fengagent/dsh-compat — 服务面插件（P2）
 *
 * `dshCompatPlugin`（P1）只补 `ctx.tools` 的 dsh 接口面；本插件补**更高阶服务面**：
 * `ctx.sessions` / `ctx.agents` / `ctx.agentDefaultModel`。
 *
 * 装配顺序（runtime 插件列表）：
 * ```
 * feng.model        （可选：没有时 agentDefaultModel 用 fallback）
 * feng.storage      （必需：sessions 的事实源）
 * dsh-services      （本插件）
 * <dsh 插件…>       （inject: ['sessions'|'agents'|'agentDefaultModel'] 可解析）
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
import type { DshCapability, DshContextLike } from "./contracts.ts";
import { AgentDefaultModelCompat } from "./agent-default-model.ts";
import { AgentsCompat } from "./agents.ts";
import { SessionsCompat } from "./sessions.ts";

export const name = "dsh-services";
/** 事实源：storage。model 可选，因此不进 inject（缺失时 agentDefaultModel 走 fallback） */
export const inject = ["storage"];

export interface DshServicesConfig {
  /** 模型服务缺失时的默认 provider（透传给 agentDefaultModel 的 fallback） */
  provider?: string;
  /** 模型服务缺失时的默认 model */
  model?: string;
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
    mappedTo: "projection.projectSessionEvents",
    notes: "消息的有损投影；无 chunk/lifecycle/surfaceOp；seq 随追加位移",
  },
  {
    path: "session.append",
    tier: "unsupported",
    mappedTo: "StorageService.saveMessage",
    notes: "写路径是消息而非事件",
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
]);

/**
 * 装配 `sessions` / `agents` / `agentDefaultModel` 三个服务。
 *
 * @param ctx - 已装配 `feng.storage` 的 Cordis 上下文
 * @param config - 可选 fallback 模型
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
  const sessions = new SessionsCompat(storage, defaultModel);
  const agents = new AgentsCompat(context, sessions);
  const agentDefaultModel = new AgentDefaultModelCompat(context, {
    provider: config.provider ?? resolveModel()?.provider ?? "unknown",
    model: config.model ?? defaultModel(),
  });

  context.reflect.provide("sessions", sessions);
  context.reflect.provide("agents", agents);
  context.reflect.provide("agentDefaultModel", agentDefaultModel);
}

/** 组装好的插件对象（供 `ctx.plugin(dshServicesPlugin, config)` 使用） */
export const dshServicesPlugin = { name, inject, apply };
