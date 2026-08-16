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
import { generateId } from "@fengagent/shared/utils";
import type {
  CompactionStrategy,
  ContextService,
  GraphService,
  LoopEvent,
  LoopService,
  ModelService,
  SessionStoreLike,
  StorageService,
  StrategyService,
  ToolChoiceStrategy,
  ToolService,
} from "./types.ts";

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
      new MemoryGraphStore({ persistPath: "./data/graph.jsonl" });
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

    for await (const event of loop.run(session, runOptions)) {
      switch (event.type) {
        case "message-end": {
          // 对话即节点：每轮助手回答沉淀为图节点（可溯源）
          const node = graph.appendAssistantNode(conversationId, event.messageId, {
            model: session.model,
          });
          yield {
            type: "graph-node",
            nodeId: node.id,
            parentId: node.parentId,
            kind: "assistant",
          };
          break;
        }
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
