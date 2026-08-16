/**
 * @fengagent/cordis — Cordis 服务实现
 *
 * 每个服务是一个 Cordis Service：挂到 ctx 上，可被其他插件注入/替换。
 * 实现上薄薄地包裹既有 @fengagent 模块，保证「重构后现有功能不回退」。
 */

import { Service, type Context } from "@deepseek-ai/cordis";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMEvent,
} from "@fengagent/llm";
import type {
  Config,
  Message,
  Session,
  SessionMeta,
  SubagentRunner,
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "@fengagent/core";
import type {
  AssembledContext,
  CompactionResult,
  ContextManager,
} from "@fengagent/context";
import type { ToolRegistry } from "@fengagent/tools";
import { AgentLoop } from "@fengagent/agent/loop";
import type {
  ConversationNode,
  GraphStore,
  RollbackStrategy,
} from "@fengagent/graph";
import { DefaultRollbackStrategy, MemoryGraphStore } from "@fengagent/graph";
import { generateId, resolveDataRoot } from "@fengagent/shared";
import { rebuildAll, rebuildSession } from "@fengagent/events";
import type {
  AnySessionEvent,
  AppendEventInput,
  EventStore,
  RebuildAllOptions,
  RebuildResult,
  RebuildSummary,
  SessionEvent,
  SessionEventRegistry,
  SessionEventValidator,
} from "@fengagent/events";
import type {
  CompactionStrategy,
  ContextService,
  EventService,
  GraphService,
  LoopEvent,
  LoopService,
  ModelService,
  RebuildService,
  SessionStoreLike,
  StorageService,
  StrategyService,
  ToolChoiceStrategy,
  ToolService,
} from "./types.ts";
import { join } from "node:path";

/* ------------------------------ 事件服务（Phase 1） ------------------------------ */

/**
 * 事件服务实现 — 包裹 EventStore，向 ctx 暴露注册表 + 写路径 + 重放 + 自愈。
 * 校验（isSessionEvent / append）走 store 的运行时注册表（#1）。
 * 命名：cordis 自带事件总线占用 `events`，故本服务注册为 `eventLog`（ctx.eventLog）。
 */
export class EventsServiceImpl extends Service implements EventService {
  constructor(
    ctx: Context,
    private readonly eventStore: EventStore,
  ) {
    super(ctx, "eventLog");
  }

  get store(): EventStore {
    return this.eventStore;
  }

  get registry(): SessionEventRegistry {
    return this.eventStore.registry;
  }

  register(type: string, validator?: SessionEventValidator): void {
    this.eventStore.registry.registerEventType(type, validator);
  }

  has(type: string): boolean {
    return this.eventStore.registry.has(type);
  }

  validate(event: SessionEvent): boolean {
    return this.eventStore.registry.validate(event);
  }

  isSessionEvent(value: unknown): value is SessionEvent {
    return this.eventStore.isSessionEvent(value);
  }

  append(input: AppendEventInput): SessionEvent {
    return this.eventStore.append(input);
  }

  replay(sessionId: string): AnySessionEvent[] {
    return this.eventStore.replay(sessionId);
  }

  healTail(sessionId: string): number {
    return this.eventStore.healTail(sessionId);
  }

  pathFor(sessionId: string): string {
    return this.eventStore.pathFor(sessionId);
  }
}

/* ------------------------------ 重建服务（Phase 3） ------------------------------ */

/**
 * 重建服务实现 — 「以事件为准重建」：SQLite（或任意旧读模型）完全降级为读模型，
 * 从事件日志全量投影重写（含 title/status/meta，#3 不丢），脱双写依赖
 * （重建只读事件日志 + 写读模型，绝不追加事件）。
 */
export class RebuildServiceImpl extends Service implements RebuildService {
  constructor(
    ctx: Context,
    private readonly eventStore: EventStore,
    private readonly sessionStore: SessionStoreLike,
  ) {
    super(ctx, "rebuild");
  }

  get store(): EventStore {
    return this.eventStore;
  }

  session(sessionId: string): RebuildResult {
    return rebuildSession(this.eventStore, this.sessionStore, sessionId);
  }

  all(options?: RebuildAllOptions): RebuildSummary {
    return rebuildAll(this.eventStore, this.sessionStore, options);
  }
}

/* ------------------------------ 模型服务 ------------------------------ */

export class ModelServiceImpl extends Service implements ModelService {
  provider: string;
  model: string;

  constructor(
    ctx: Context,
    private options: {
      provider: string;
      model: string;
      client: LLMClient;
      onSwitch?: (provider: string, model: string) => LLMClient | Promise<LLMClient>;
    },
  ) {
    super(ctx, "model");
    this.provider = options.provider;
    this.model = options.model;
  }

  get client(): LLMClient {
    return this.options.client;
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    yield* this.options.client.stream(request);
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    return this.options.client.generate(request);
  }

  /**
   * 热切换 provider/model（/model、/provider 命令的插件化底座）。
   *
   * onSwitch 支持同步返回（createClientFromEnv 是同步的）：
   * 同步完成时本方法体内的状态更新在返回前已落地，
   * 调用方无需 await 也能立即生效（CLI /model、/provider 保持同步语义）。
   */
  switchProvider(
    provider: string,
    options?: { model?: string },
  ): Promise<void> {
    if (!this.options.onSwitch) {
      return Promise.reject(
        new Error(
          `Model plugin does not support provider switching (${provider})`,
        ),
      );
    }
    const next = options?.model ?? this.model;
    const maybe = this.options.onSwitch(provider, next);
    if (maybe && typeof (maybe as Promise<LLMClient>).then === "function") {
      return (maybe as Promise<LLMClient>).then((client) => {
        this.options.client = client;
        this.provider = provider;
        this.model = next;
      });
    }
    this.options.client = maybe as LLMClient;
    this.provider = provider;
    this.model = next;
    return Promise.resolve();
  }
}

/* ------------------------------ 工具服务 ------------------------------ */

export class ToolServiceImpl extends Service implements ToolService {
  constructor(
    ctx: Context,
    private registry: ToolRegistry,
  ) {
    super(ctx, "tools");
  }

  register(tool: ToolDefinition): void {
    this.registry.register(tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.registry.get(name);
  }

  materialize(): ToolDefinition[] {
    return this.registry.materialize();
  }

  listNames(): string[] {
    return this.registry.list().map((t) => t.name);
  }

  async execute(
    calls: Array<{ tool: ToolDefinition; input: unknown }>,
    toolContext: ToolContext,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of calls) {
      try {
        const result = await call.tool.execute(call.input, toolContext);
        results.push(result);
      } catch (err) {
        results.push({
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        });
      }
    }
    return results;
  }
}

/* ------------------------------ 策略服务 ------------------------------ */

export class StrategyServiceImpl extends Service implements StrategyService {
  compaction: CompactionStrategy;
  toolChoice: ToolChoiceStrategy;
  rollback: RollbackStrategy;

  constructor(
    ctx: Context,
    options: {
      compaction?: CompactionStrategy;
      toolChoice?: ToolChoiceStrategy;
      rollback?: RollbackStrategy;
    } = {},
  ) {
    super(ctx, "strategy");
    this.compaction =
      options.compaction ?? {
        shouldCompact: (c) => c.tokenCount >= c.threshold,
      };
    this.toolChoice =
      options.toolChoice ?? {
        choose: (tools) => tools,
      };
    this.rollback = options.rollback ?? new DefaultRollbackStrategy();
  }

  setCompaction(strategy: CompactionStrategy): void {
    this.compaction = strategy;
  }

  setToolChoice(strategy: ToolChoiceStrategy): void {
    this.toolChoice = strategy;
  }

  setRollback(strategy: RollbackStrategy): void {
    this.rollback = strategy;
  }
}

/* ------------------------------ 存储服务 ------------------------------ */

export class StorageServiceImpl extends Service implements StorageService {
  graph: GraphStore;

  constructor(
    ctx: Context,
    private sessionStore: SessionStoreLike,
    options: { graph?: GraphStore } = {},
  ) {
    super(ctx, "storage");
    this.graph =
      options.graph ??
      new MemoryGraphStore({ persistPath: join(resolveDataRoot(), "graph.jsonl") });
  }

  saveSession(session: Session): void {
    this.sessionStore.saveSession(session);
  }

  loadSession(id: string): Session | null | undefined {
    return this.sessionStore.loadSession(id);
  }

  listSessions(): SessionMeta[] {
    return this.sessionStore.listSessions();
  }

  deleteSession(id: string): void {
    this.sessionStore.deleteSession(id);
  }

  saveMessage(sessionId: string, message: Message): void {
    this.sessionStore.saveMessage?.(sessionId, message);
  }

  saveMessages(sessionId: string, messages: Message[]): void {
    if (this.sessionStore.saveMessages) {
      this.sessionStore.saveMessages(sessionId, messages);
    } else {
      for (const m of messages) this.sessionStore.saveMessage?.(sessionId, m);
    }
  }

  async flush(): Promise<void> {
    await this.graph.flush();
  }
}

/* ------------------------------ 上下文服务 ------------------------------ */

export class ContextServiceImpl extends Service implements ContextService {
  constructor(
    ctx: Context,
    readonly manager: ContextManager,
  ) {
    super(ctx, "context");
  }

  assemble(session: Session): Promise<AssembledContext> {
    return this.manager.assemble(session);
  }

  shouldCompact(context: AssembledContext): boolean {
    return this.manager.shouldCompact(context);
  }

  compact(
    messages: Message[],
    options?: Parameters<ContextManager["compact"]>[1],
  ): Promise<CompactionResult> {
    return this.manager.compact(messages, options);
  }

  estimateTokens(content: string | Message[]): number {
    return this.manager.estimateTokens(content);
  }
}

/* ------------------------------ Loop 服务 ------------------------------ */

export class LoopServiceImpl extends Service implements LoopService {
  constructor(
    ctx: Context,
    private options: {
      model: ModelService;
      tools: ToolService;
      context: ContextService;
      strategy: StrategyService;
      graph: GraphService;
      config: Pick<Config, "maxTurns" | "maxTokens" | "temperature">;
      workdir: string;
      spawnSubagent?: SubagentRunner;
      agentDepth?: number;
    },
  ) {
    super(ctx, "loop");
  }

  async *run(
    session: Session,
    runOptions?: {
      requestPermission?: ToolContext["requestPermission"];
    },
  ): AsyncGenerator<LoopEvent> {
    const { model, tools, context, graph, strategy, config, workdir } =
      this.options;

    // 构造既有 AgentLoop（薄适配：行为与现状完全一致）
    const toolRegistryLike: ToolRegistry = {
      register: (t) => tools.register(t),
      get: (name) => tools.get(name),
      list: () => tools.materialize(),
      materialize: () => tools.materialize(),
      unregister: () => false,
    };
    const loop = new AgentLoop({
      llmClient: {
        stream: (req) => model.stream(req),
        generate: (req) => model.generate(req),
      },
      toolRegistry: toolRegistryLike,
      toolExecutor: {
        execute: async (tool, input, ctx) => {
          const results = await tools.execute([{ tool, input }], ctx);
          return results[0]!;
        },
        executeMany: async (calls, ctx) => {
          const results = await tools.execute(calls, ctx);
          return calls.map((call, i) => ({
            toolName: call.tool.name,
            input: call.input,
            result: results[i]!,
          }));
        },
        getHookRegistry: () =>
          ({
            register: () => {},
            unregister: () => false,
            getHandlers: () => [],
          }) as never,
      },
      contextManager: {
        assemble: (s) => context.assemble(s),
        shouldCompact: (c) => context.shouldCompact(c),
        compact: (m, o) => context.compact(m, o),
        estimateTokens: (content) => context.estimateTokens(content),
        invalidateSystemPrompt: () => {},
      },
      config: { ...config } as Config,
      workdir,
      spawnSubagent: this.options.spawnSubagent,
      agentDepth: this.options.agentDepth,
    });

    // 对话即节点：为用户输入建立节点（幂等：同一 messageId 不会重复追加）
    const conversationId = session.id;
    const lastUser = [...session.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUser) {
      graph.appendUserNode(conversationId, lastUser.id, {
        model: session.model,
      });
    }
    // 记录本回合前已有的助手节点（回合末只对新增节点发 graph-node 事件）
    const knownAssistantNodeIds = new Set(
      graph
        .listNodes(conversationId)
        .filter((n) => n.type === "assistant")
        .map((n) => n.id),
    );

    for await (const event of loop.run(session, runOptions)) {
      switch (event.type) {
        case "tool-call-result": {
          // 工具结果也沉淀为图上的事件（溯源工具链路）
          if (event.result.isError) {
            const target = graph.store.getActiveHead(conversationId);
            if (
              target &&
              strategy.rollback.shouldRollback({
                node: {
                  ...target,
                  meta: { ...target.meta, quality: "poor" },
                },
                toolErrorCount: 1,
              })
            ) {
              // 工具错误 → 触发回退策略（可插拔）
              yield {
                type: "error",
                error: {
                  message: `tool ${event.toolUseId} failed: ${String(event.result.content).slice(0, 120)}`,
                },
              };
            }
          }
          break;
        }
        default:
          break;
      }
      yield event as LoopEvent;
    }

    // Phase 2 回合收尾：先把本回合消息双写落事件（旧存储收敛到当前消息集合，
    // rollback/fork 截断同步），再把助手回答沉淀为图节点（事件投影可还原）并发出
    // graph-node 事件。graph-node 从「逐条 message-end」移到回合末：WebUI 经
    // GET /graph 取数、不依赖该事件，时序变化无消费者影响。
    this.ctx.storage.saveMessages?.(session.id, session.messages);
    const newNodes: ConversationNode[] = [];
    for (const m of session.messages) {
      if (m.role !== "assistant") continue;
      const node = graph.appendAssistantNode(conversationId, m.id, {
        model: session.model,
      });
      if (node && !knownAssistantNodeIds.has(node.id)) newNodes.push(node);
    }
    for (const node of newNodes) {
      yield {
        type: "graph-node",
        nodeId: node.id,
        parentId: node.parentId,
        kind: "assistant",
      };
    }

    // 回答质量不佳 → 可回退（CLI/WebUI 侧通过 /rollback 调用 graph.rollbackPoorAnswer）
    await graph.store.flush().catch(() => {});
  }
}

/* ------------------------------ 图服务 ------------------------------ */

export class GraphServiceImpl extends Service implements GraphService {
  constructor(ctx: Context, readonly store: GraphStore) {
    super(ctx, "graph");
  }

  appendUserNode(
    conversationId: string,
    messageId: string,
    meta: Record<string, unknown> = {},
  ): ConversationNode {
    // 幂等：同一会话同一 messageId 只追加一次（重复 run() 不再重复追加 user 节点）
    const existing = this.store
      .listNodes(conversationId)
      .find((n) => n.type === "user" && n.messageId === messageId);
    if (existing) return existing;
    const head = this.store.getActiveHead(conversationId);
    return this.store.appendNode({
      id: `gnode-${generateId()}`,
      conversationId,
      type: "user",
      messageId,
      parentId: head ? head.id : null,
      createdAt: Date.now(),
      meta: { active: true, ...meta },
    });
  }

  appendAssistantNode(
    conversationId: string,
    messageId: string,
    meta: Record<string, unknown> = {},
  ): ConversationNode {
    // 幂等：同一会话同一 messageId 只追加一次（事件溯源实现由消息事件派生，天然幂等）
    const existing = this.store
      .listNodes(conversationId)
      .find((n) => n.type === "assistant" && n.messageId === messageId);
    if (existing) return existing;
    const head = this.store.getActiveHead(conversationId);
    return this.store.appendNode({
      id: `gnode-${generateId()}`,
      conversationId,
      type: "assistant",
      messageId,
      parentId: head ? head.id : null,
      createdAt: Date.now(),
      meta: { active: true, ...meta },
    });
  }

  rollbackPoorAnswer(nodeId: string, reason?: string): boolean {
    const target = this.store.getNode(nodeId);
    if (!target || !target.parentId) return false;
    this.store.markQuality(nodeId, "poor", reason);
    const result = this.store.rollbackTo(target.parentId, reason);
    return result !== undefined;
  }

  forkBranch(parentNodeId: string, branch?: string): ConversationNode | undefined {
    const result = this.store.fork(parentNodeId, branch);
    return result?.branchPoint;
  }

  getNode(nodeId: string): ConversationNode | undefined {
    return this.store.getNode(nodeId);
  }

  listNodes(conversationId: string): ConversationNode[] {
    return this.store.listNodes(conversationId);
  }

  getChain(nodeId: string): ConversationNode[] {
    return this.store.getChain(nodeId);
  }

  getActivePath(conversationId: string): ConversationNode[] {
    return this.store.getActivePath(conversationId);
  }

  getActiveHead(conversationId: string): ConversationNode | undefined {
    return this.store.getActiveHead(conversationId);
  }
}
