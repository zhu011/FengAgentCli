/**
 * @fengagent/dsh-compat — `ctx.agentDefaultModel` 契约映射（P2）
 *
 * dsh 的 `agentDefaultModel` 是「新 Agent 的默认模型选择」服务：
 * `currentSelection()` 读、`saveSelection(next)` 写。
 *
 * FengAgentCli 对应 `ctx.model`（`ModelServiceImpl`，带 `provider` / `model` 与
 * `switchProvider()` 热切换），因此这是本批映射里保真度最高的一项：
 * - `currentSelection` → `ctx.model.provider/model`（direct）
 * - `saveSelection` → `ctx.model.switchProvider(provider, { model })`（adapt：
 *   dsh 还会写 settings 层；FengAgentCli 的持久化由调用方/配置文件负责）
 * - `reasoningEffort`：dsh 的可选推理档位，FengAgentCli 模型层暂无对应字段，
 *   接受但忽略（不静默改写 provider/model）。
 *
 * 模型服务是**可选依赖**：Cordis 4 的上下文代理在未声明 `inject` 时读 `ctx.model`
 * 会直接抛错，所以这里统一走 `ctx.reflect.get("model")`。
 */

import {
  DshContractError,
  type DshAgentDefaultModelLike,
  type DshContextLike,
  type DshModelSelection,
} from "./contracts.ts";

/** `ModelServiceImpl` 的结构子集 */
interface ModelLike {
  readonly provider: string;
  readonly model: string;
  switchProvider(provider: string, options?: { model?: string }): Promise<void>;
}

/** `ctx.agentDefaultModel` 的映射实现 */
export class AgentDefaultModelCompat implements DshAgentDefaultModelLike {
  private fallback: DshModelSelection;

  constructor(
    private readonly ctx: DshContextLike,
    fallback: DshModelSelection = { provider: "unknown", model: "unknown" },
  ) {
    this.fallback = { ...fallback };
  }

  currentSelection(): DshModelSelection {
    const model = this.modelService();
    if (!model) return { ...this.fallback };
    return {
      provider: model.provider,
      model: model.model,
    };
  }

  async saveSelection(next: DshModelSelection): Promise<void> {
    if (typeof next?.provider !== "string" || next.provider.length === 0) {
      throw new DshContractError(
        "agentDefaultModel.saveSelection",
        "provider must be a non-empty string",
      );
    }
    if (typeof next.model !== "string" || next.model.length === 0) {
      throw new DshContractError(
        "agentDefaultModel.saveSelection",
        "model must be a non-empty string",
      );
    }
    const model = this.modelService();
    if (!model) {
      this.fallback = { provider: next.provider, model: next.model };
      return;
    }
    await model.switchProvider(next.provider, { model: next.model });
  }

  /** 可选模型服务：走 reflect.get（不触发 inject 检查），缺失时用构造期 fallback */
  private modelService(): ModelLike | undefined {
    return this.ctx.reflect.get?.("model") as ModelLike | undefined;
  }
}
