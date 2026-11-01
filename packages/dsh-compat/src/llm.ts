/**
 * @fengagent/dsh-compat — `ctx.llm` 契约映射（P3）
 *
 * dsh 的 `llm` 是「适配器注册表 + 可被 `llm/stream` 瀑布拦截的流式调用」：
 * `registerAdapter(providers, adapter)` 把 provider 路由交给插件自己的适配器，
 * `stream(options)` 按 `options.provider` 选路并把 `StreamChunk` 原样吐给消费者。
 *
 * FengAgentCli 侧对应 `ctx.model`（`@fengagent/llm` 的 `ModelService`）：
 * 单条活跃路由 + `stream(LLMRequest) → LLMEvent`。因此本映射是 **adapt**：
 *
 * 1. **注册进来的 dsh 适配器直通**：`ctx.llm.stream()` 命中已注册路由时直接调用
 *    `adapter.stream(options)`，chunk 原样透传（这正是 `dsh-llm-retry`、
 *    `dsh-llm-*` 这类中间件/适配器插件要的口径）；
 * 2. **未注册的 provider 回落到 `ctx.model`**：把 `GenerateOptions`（dsh 消息/块）
 *    翻成 `LLMRequest`，再把 `LLMEvent` 翻回 `StreamChunk`（见 `messages.ts`）；
 * 3. **失败规范化**：与 dsh `LlmRuntime` 一致，适配器/模型抛错统一收敛成终态
 *    `finish { kind: 'error' | 'aborted' }`，不把异常抛给消费者；
 * 4. **准备调用**：`prepareCall()` 冻结本次 config 并只允许派发一次（`INVALID_PREPARED_CALL`
 *    语义），防止 HMR/重试路径拿旧配置复用句柄。
 *
 * 明确不支持（调用即抛 `DshContractUnsupportedError`，不假装成功）：
 * - `registerConfigurableProviders` / `registerModelDiscovery`：dsh 的「可配置 provider
 *   目录 + 端点探测」依赖 settings 命名空间与 UI 面，FengAgentCli 目前没有对应注册表。
 *
 * 已知偏差：
 * - `GenerateOptions.tools` 是 JSON Schema，FengAgentCli 的 `ToolDefinition` 要 zod
 *   schema，必须由宿主注入 `toolSchemaConverter`；没注入时带 tools 的请求直接拒绝
 *   （而不是把工具静默丢掉，让模型「看不见工具」却当成成功）；
 * - `stop` 没有对等字段（`LLMRequest` 不含 stop 序列），接受但忽略并记入文档；
 * - `reasoningEffort` 透传给 provider 适配器（注册路由时），回落到 `ctx.model` 时忽略；
 * - `providerRetryPolicy` 只**保存并回报**策略，重试执行仍由 `dsh-llm-retry` 这类插件负责。
 */

import type { LLMEvent, LLMRequest } from "@fengagent/llm";
import type { Message, ToolDefinition } from "@fengagent/core";
import {
  DshContractError,
  DshContractUnsupportedError,
  type DshAdapterRegistrationHandle,
  type DshGenerateOptions,
  type DshLlmAdapterLike,
  type DshLlmLike,
  type DshModelInfo,
  type DshPreparedCall,
  type DshProviderInfo,
  type DshResolvedModelInfo,
  type DshRetryPolicy,
  type DshStreamChunk,
  type DshTokenUsage,
  type DshToolSchema,
} from "./contracts.ts";
import { requireFengMessage } from "./messages.ts";

/** FengAgentCli `ModelService` 的结构子集（`@fengagent/cordis` 的 ModelService） */
export interface DshModelLike {
  readonly provider: string;
  readonly model: string;
  stream(request: LLMRequest): AsyncGenerator<LLMEvent> | AsyncIterable<LLMEvent>;
}

/** dsh 默认的 normal 重试策略（与 dsh 自身默认值同口径；执行仍归 llm-retry 插件） */
export const DEFAULT_DSH_RETRY_POLICY: DshRetryPolicy = Object.freeze({
  mode: "normal",
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
  retryableCodes: ["RATE_LIMIT", "TIMEOUT", "NETWORK", "SERVER"] as const,
});

/** `LlmCompat` 配置 */
export interface LlmCompatOptions {
  /** 模型服务缺失时的兜底 provider（仅用于 listProviders/currentSelection 口径） */
  provider?: string;
  /** 模型服务缺失时的兜底 model */
  model?: string;
  /**
   * dsh JSON-Schema → FengAgentCli `ToolDefinition` 的转换器。
   *
   * 宿主（`createRuntimeAgent`）可注入；未注入时带 `tools` 的请求会被拒绝。
   */
  toolSchemaConverter?: (schema: DshToolSchema) => ToolDefinition;
}

/** 一个已注册的 provider 路由 */
interface AdapterRoute {
  readonly adapter: DshLlmAdapterLike;
  readonly providers: Set<string>;
}

/** 累计中的块（finish 时补 block-end） */
interface OpenBlock {
  readonly kind: "text" | "reasoning";
  text: string;
}

/** 把未知异常压成 dsh `LlmFailure` 形状（只保留可序列化事实） */
function failureOf(err: unknown): { code: string; message: string; status?: number } {
  if (err !== null && typeof err === "object") {
    const record = err as { code?: unknown; message?: unknown; status?: unknown };
    return {
      code: typeof record.code === "string" ? record.code : "UNKNOWN",
      message: typeof record.message === "string" ? record.message : String(err),
      ...(typeof record.status === "number" ? { status: record.status } : {}),
    };
  }
  return { code: "UNKNOWN", message: String(err) };
}

/** feng 的结束原因 → dsh 的结束原因 */
function toDshFinishReason(reason: string): DshStreamChunk & { type: "finish" } {
  switch (reason) {
    case "tool_use":
    case "tool-calls":
      return { type: "finish", reason: { kind: "tool-calls" } };
    case "max_tokens":
    case "max-tokens":
      return { type: "finish", reason: { kind: "max-tokens" } };
    case "error":
      return { type: "finish", reason: { kind: "error", failure: failureOf(new Error("model returned an error finish")) } };
    default:
      return { type: "finish", reason: { kind: "stop" } };
  }
}

/** feng 的 usage 事件 → dsh `TokenUsage`（cacheCreation ↔ cacheWrite） */
function toDshUsage(event: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): DshTokenUsage {
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.cacheReadTokens === undefined ? {} : { cacheReadTokens: event.cacheReadTokens }),
    ...(event.cacheCreationTokens === undefined ? {} : { cacheWriteTokens: event.cacheCreationTokens }),
  };
}

/**
 * dsh `GenerateOptions` → FengAgentCli `LLMRequest`。
 *
 * @param options - dsh 请求
 * @param fallback - 当前模型路由（`options.provider` 未命中注册路由时用）
 * @param converter - 可选的工具 schema 转换器
 * @returns FengAgentCli 请求
 */
export function toLlmRequest(
  options: DshGenerateOptions,
  fallback: { provider: string; model: string },
  converter?: (schema: DshToolSchema) => ToolDefinition,
): LLMRequest {
  if (!Array.isArray(options.messages)) {
    throw new DshContractError("llm.stream", "options.messages must be an array");
  }
  const systemParts: string[] = [];
  if (typeof options.system === "string" && options.system.length > 0) {
    systemParts.push(options.system);
  }
  const messages: Message[] = [];
  for (const message of options.messages) {
    if (message.role === "system") {
      let text = "";
      for (const block of message.content) {
        if (block.type === "text") text += String((block as { text?: unknown }).text ?? "");
      }
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    messages.push(requireFengMessage(message));
  }
  let tools: ToolDefinition[] | undefined;
  if (options.tools && options.tools.length > 0) {
    if (!converter) {
      throw new DshContractUnsupportedError(
        "llm.stream",
        "tools are JSON Schema in dsh but zod schemas in FengAgentCli; " +
          "pass LlmCompatOptions.toolSchemaConverter (or drop tools from the request)",
      );
    }
    tools = options.tools.map((schema) => converter(schema));
  }
  return {
    model: options.model || fallback.model,
    system: systemParts.join("\n\n"),
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  };
}

/**
 * dsh `ctx.llm` 的映射实现。
 *
 * 装配：`dsh-services` 插件在 `ctx.model` 可用时 `provide("llm", new LlmCompat(...))`；
 * 也可手工 `ctx.reflect.provide("llm", llm)`。
 */
export class LlmCompat implements DshLlmLike {
  private readonly routes = new Map<string, AdapterRoute>();
  private readonly converter: ((schema: DshToolSchema) => ToolDefinition) | undefined;

  constructor(
    private readonly model: DshModelLike | undefined,
    private readonly options: LlmCompatOptions = {},
  ) {
    this.converter = options.toolSchemaConverter;
  }

  /* ------------------------------ 适配器注册表 ------------------------------ */

  registerAdapter(providers: string[], adapter: DshLlmAdapterLike): DshAdapterRegistrationHandle {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new DshContractError("llm.registerAdapter", "providers must be a non-empty array");
    }
    if (adapter === null || typeof adapter !== "object" || typeof adapter.stream !== "function") {
      throw new DshContractError("llm.registerAdapter", "adapter must implement stream(options)");
    }
    this.assertRoutesAvailable(providers, undefined);
    const route: AdapterRoute = { adapter, providers: new Set(providers) };
    for (const provider of providers) this.routes.set(provider, route);

    let disposed = false;
    const dispose = (() => {
      if (disposed) return;
      disposed = true;
      for (const provider of route.providers) {
        if (this.routes.get(provider) === route) this.routes.delete(provider);
      }
    }) as DshAdapterRegistrationHandle;
    dispose.replace = (next: string[]) => {
      if (disposed) {
        throw new DshContractError(
          "llm.registerAdapter",
          "REGISTRATION_DISPOSED: this registration was already released",
        );
      }
      if (!Array.isArray(next)) {
        throw new DshContractError("llm.registerAdapter", "replace(providers) needs an array");
      }
      // 先全量校验，再一次性换（all-or-nothing，失败时旧路由原样保留）
      this.assertRoutesAvailable(next, route);
      for (const provider of route.providers) {
        if (this.routes.get(provider) === route) this.routes.delete(provider);
      }
      route.providers.clear();
      for (const provider of next) {
        route.providers.add(provider);
        this.routes.set(provider, route);
      }
    };
    return dispose;
  }

  /** 校验候选路由未被别的注册占用（本次注册自己的路由视为可用） */
  private assertRoutesAvailable(providers: readonly string[], self: AdapterRoute | undefined): void {
    const seen = new Set<string>();
    for (const provider of providers) {
      if (typeof provider !== "string" || provider.length === 0) {
        throw new DshContractError("llm.registerAdapter", "provider ids must be non-empty strings");
      }
      if (seen.has(provider)) {
        throw new DshContractError("llm.registerAdapter", `duplicate provider "${provider}" in one registration`);
      }
      seen.add(provider);
      const owner = this.routes.get(provider);
      if (owner !== undefined && owner !== self) {
        throw new DshContractError(
          "llm.registerAdapter",
          `DUPLICATE_ADAPTER: provider "${provider}" already has an adapter`,
        );
      }
    }
  }

  /* ------------------------------ 只读查询 ------------------------------ */

  listProviders(): DshProviderInfo[] {
    const providers = new Map<string, DshProviderInfo>();
    const model = this.model;
    const fallbackProvider = model?.provider ?? this.options.provider;
    const fallbackName = model?.model ?? this.options.model;
    if (fallbackProvider) providers.set(fallbackProvider, { id: fallbackProvider, name: fallbackName ?? fallbackProvider });
    for (const [provider, route] of this.routes) {
      const info = route.adapter.providerInfo?.(provider);
      providers.set(provider, info ?? { id: provider, name: provider });
    }
    return [...providers.values()];
  }

  providerRetryPolicy(provider: string): DshRetryPolicy {
    const route = this.routes.get(provider);
    return route?.adapter.providerRetryPolicy?.(provider) ?? { ...DEFAULT_DSH_RETRY_POLICY };
  }

  async listModels(provider: string): Promise<readonly DshModelInfo[]> {
    const route = this.routes.get(provider);
    if (route?.adapter.listModels) return route.adapter.listModels(provider);
    if (this.model && provider === this.model.provider && this.model.model.length > 0) {
      return [{ provider, id: this.model.model, name: this.model.model }];
    }
    return [];
  }

  async resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<DshResolvedModelInfo> {
    const route = this.routes.get(provider);
    if (route?.adapter.resolveModel) return route.adapter.resolveModel(provider, model, signal);
    return { provider, id: model, name: model };
  }

  /* ------------------------------ 流式调用 ------------------------------ */

  stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk> {
    const route = this.routes.get(options.provider);
    if (route) return this.normalize(route.adapter.stream(options), options.signal);
    return this.streamFromModel(options);
  }

  prepareCall(options: DshGenerateOptions): DshPreparedCall {
    const config = {
      provider: options.provider,
      model: options.model,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    };
    let used = false;
    return {
      config,
      stream: (next: DshGenerateOptions) => {
        if (used) {
          throw new DshContractError("llm.prepareCall", "INVALID_PREPARED_CALL: this prepared call was already dispatched");
        }
        if (
          next.provider !== config.provider ||
          next.model !== config.model ||
          next.temperature !== config.temperature ||
          next.maxTokens !== config.maxTokens
        ) {
          throw new DshContractError(
            "llm.prepareCall",
            "INVALID_PREPARED_CALL: request call-config differs from the prepared config",
          );
        }
        used = true;
        return this.stream(next);
      },
    };
  }

  registerConfigurableProviders(entries: readonly unknown[]): never {
    throw new DshContractUnsupportedError(
      "llm.registerConfigurableProviders",
      `the configurable-provider directory needs a settings namespace surface (${entries.length} entr${entries.length === 1 ? "y" : "ies"} refused)`,
    );
  }

  registerModelDiscovery(settingsNs: string, discover: unknown): never {
    void discover;
    throw new DshContractUnsupportedError(
      "llm.registerModelDiscovery",
      `model discovery is configuration-surface work (settings namespace "${settingsNs}") with no FengAgentCli registry`,
    );
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 把注册适配器的异常收敛成终态 finish（与 dsh `LlmRuntime` 一致） */
  private async *normalize(
    source: AsyncIterable<DshStreamChunk>,
    signal?: AbortSignal,
  ): AsyncGenerator<DshStreamChunk> {
    try {
      for await (const chunk of source) yield chunk;
    } catch (err) {
      yield {
        type: "finish",
        reason: signal?.aborted
          ? { kind: "aborted", failure: failureOf(err) }
          : { kind: "error", failure: failureOf(err) },
      };
    }
  }

  /** 回落到 `ctx.model`：LLMEvent → StreamChunk */
  private async *streamFromModel(options: DshGenerateOptions): AsyncGenerator<DshStreamChunk> {
    const model = this.model;
    if (!model) {
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            code: "NO_ADAPTER",
            message: `no adapter registered for provider "${options.provider}" and ctx.model is unavailable`,
          },
        },
      };
      return;
    }
    // 单路由模型服务：请求了别的 provider 又不注册适配器 → 明确拒绝，不静默用错模型
    if (options.provider !== model.provider) {
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            code: "NO_ADAPTER",
            message:
              `no adapter registered for provider "${options.provider}"; ` +
              `FengAgentCli's model service is pinned to "${model.provider}"`,
          },
        },
      };
      return;
    }

    let request: LLMRequest;
    try {
      request = toLlmRequest(options, { provider: model.provider, model: model.model }, this.converter);
    } catch (err) {
      yield { type: "finish", reason: { kind: "error", failure: failureOf(err) } };
      return;
    }

    const open = new Map<number, OpenBlock>();
    let nextIndex = 0;
    let textIndex: number | undefined;
    let reasoningIndex: number | undefined;

    const closeAll = function* (): Generator<DshStreamChunk> {
      for (const [index, block] of open) {
        yield {
          type: "block-end",
          index,
          block:
            block.kind === "text"
              ? { type: "text", text: block.text }
              : { type: "reasoning", text: block.text },
        };
      }
      open.clear();
    };

    try {
      for await (const event of model.stream(request)) {
        switch (event.type) {
          case "text-delta": {
            const index = (textIndex ??= nextIndex++);
            let block = open.get(index);
            if (!block) {
              block = { kind: "text", text: "" };
              open.set(index, block);
              yield { type: "block-start", index, blockType: "text" };
            }
            block.text += event.text;
            if (event.text.length > 0) yield { type: "text-delta", index, text: event.text };
            break;
          }
          case "thinking-delta": {
            const index = (reasoningIndex ??= nextIndex++);
            let block = open.get(index);
            if (!block) {
              block = { kind: "reasoning", text: "" };
              open.set(index, block);
              yield { type: "block-start", index, blockType: "reasoning" };
            }
            block.text += event.text;
            if (event.text.length > 0) yield { type: "reasoning-delta", index, text: event.text };
            break;
          }
          case "tool-call": {
            const index = nextIndex++;
            const args = JSON.stringify(event.input ?? {});
            yield { type: "block-start", index, blockType: "tool-call" };
            yield { type: "tool-call-delta", index, id: event.id, name: event.name, argumentsDelta: args };
            yield {
              type: "block-end",
              index,
              block: { type: "tool-call", id: event.id, name: event.name, arguments: args },
            };
            break;
          }
          case "tool-result":
            // FengAgentCli 的 tool-result 事件是 loop 内部回填，dsh 的流协议没有对应 chunk
            break;
          case "usage":
            yield { type: "usage", usage: toDshUsage(event) };
            break;
          case "finish": {
            for (const chunk of closeAll()) yield chunk;
            yield toDshFinishReason(event.reason);
            return;
          }
          case "error": {
            for (const chunk of closeAll()) yield chunk;
            yield { type: "finish", reason: { kind: "error", failure: failureOf(event.error) } };
            return;
          }
        }
      }
      // 流在没发 finish 的情况下结束：补一个 stop，避免消费者悬挂
      for (const chunk of closeAll()) yield chunk;
      yield { type: "finish", reason: { kind: "stop" } };
    } catch (err) {
      yield {
        type: "finish",
        reason: options.signal?.aborted
          ? { kind: "aborted", failure: failureOf(err) }
          : { kind: "error", failure: failureOf(err) },
      };
    }
  }
}
