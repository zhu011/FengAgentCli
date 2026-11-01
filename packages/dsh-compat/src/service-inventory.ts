/**
 * @fengagent/dsh-compat — dsh 服务面清单（P3）
 *
 * 来源：对 `@deepseek-ai/dsh` 0.1.x 四个 agent preset（`standard` / `cordis` / `code` /
 * `minimal`）去重出的 29 个插件包 + 25 个宿主/核心包 + 4 个市场插件，逐包读发布物
 * （`lib/index.js`）里声明的 `inject`（必需/可选）与 `ctx.get()` 软读，再按插件数聚合。
 *
 * 分级口径与 `DSH_SERVICE_CAPABILITIES` 一致：
 * - `mapped`：兼容层已有（tools / sessions / agents / agentDefaultModel）
 * - `p3`：本轮补上（llm；scope 是库级原语，不在注入表里）
 * - `trivial-shim`：一个薄注册表/适配即可（systemPrompt / fs / settings / commands）
 * - `needs-design`：需要真实状态与生命周期（sessionProjections / subagents / skills …）
 * - `out-of-scope`：宿主面（sandboxPolicy / shell / shellEnv / web / approval / terminals）
 *
 * 用途：`loadDshPlugin` 的 inject 预检可以拿这张表给出**分级诊断**（「缺 systemPrompt，
 * 属 trivial-shim，下一批补」而不是干巴巴一句「服务未提供」），也用于排期。
 *
 * 注意：npm 的 `latest` tag 对多数 `@deepseek-ai/dsh-*` 是陈旧的（停在 0.0.1-rc.1），
 * preset 实际使用 0.1.0-rc.8；采样时全部 pin 版本，否则会读到旧版的 inject 结构。
 */

/** 服务分级（与 `DshCapabilityTier` 同口径，另加「下一批」） */
export type DshServiceTier = "mapped" | "p3" | "trivial-shim" | "needs-design" | "out-of-scope";

/** 一个 dsh 服务的注入面统计 */
export interface DshServiceInventoryEntry {
  /** 服务名（`inject` 里的键） */
  readonly service: string;
  /** 硬注入（必需）的插件数 */
  readonly requiredBy: number;
  /** 可选注入的插件数 */
  readonly optionalBy: number;
  /** `ctx.get("…")` 软读的插件数 */
  readonly softReads: number;
  /** 分级 */
  readonly tier: DshServiceTier;
  /** 代表性消费者（采样里最关键的几个） */
  readonly consumers: readonly string[];
  /** 已知限制/备注 */
  readonly notes?: string;
}

/**
 * 聚合清单（按「必需 → 可选 → 软读」降序；数字来自 P3 采样，58 个被检包）。
 */
export const DSH_SERVICE_INVENTORY: readonly DshServiceInventoryEntry[] = Object.freeze([
  {
    service: "tools",
    requiredBy: 23,
    optionalBy: 0,
    softReads: 1,
    tier: "mapped",
    consumers: ["dsh-tool-fs", "dsh-tool-bash", "dsh-tool-web", "dsh-tool-todo", "writing-guard", "dsh-notes"],
    notes: "绝对门槛：23 个插件硬注入",
  },
  {
    service: "systemPrompt",
    requiredBy: 15,
    optionalBy: 2,
    softReads: 0,
    tier: "trivial-shim",
    consumers: ["dsh-persona", "dsh-tool-fs", "dsh-tool-bash", "dsh-tool-subagent", "dsh-tools", "better-edit"],
    notes: "第二大门槛；只需按 order 插入/替换段落的注册表（含 getSectionOrder 可选方法）",
  },
  {
    service: "sandboxPolicy",
    requiredBy: 2,
    optionalBy: 0,
    softReads: 6,
    tier: "out-of-scope",
    consumers: ["dsh-tool-bash", "dsh-fs-sandbox"],
    notes: "宿主沙箱策略；FengAgentCli 用自己的权限/沙箱栈，不映射",
  },
  {
    service: "agents",
    requiredBy: 4,
    optionalBy: 1,
    softReads: 2,
    tier: "mapped",
    consumers: ["dsh-tool-skill", "dsh-tool-goal", "dsh-llm-retry"],
  },
  {
    service: "fs",
    requiredBy: 3,
    optionalBy: 0,
    softReads: 3,
    tier: "trivial-shim",
    consumers: ["dsh-tool-fs", "dsh-tool-str-replace-editor", "better-edit"],
    notes: "read/write/stat/glob 映射到 FengAgentCli 文件层即可",
  },
  {
    service: "sessionProjections",
    requiredBy: 1,
    optionalBy: 5,
    softReads: 0,
    tier: "needs-design",
    consumers: ["dsh-tool-todo-plus", "dsh-plan-mode", "dsh-tool-todo", "dsh-token-meter", "dsh-goal"],
    notes: "市场插件第一道真门槛（todo-plus 硬依赖）；需要按会话的投影注册表",
  },
  {
    service: "sessions",
    requiredBy: 2,
    optionalBy: 0,
    softReads: 2,
    tier: "mapped",
    consumers: ["dsh-compaction-basic", "dsh-session-persistence-jsonl"],
  },
  {
    service: "subagents",
    requiredBy: 4,
    optionalBy: 0,
    softReads: 0,
    tier: "needs-design",
    consumers: ["dsh-tool-subagent", "dsh-tool-subagent-control", "dsh-tool-ralph"],
  },
  {
    service: "jobs",
    requiredBy: 1,
    optionalBy: 0,
    softReads: 3,
    tier: "needs-design",
    consumers: ["dsh-tool-jobs"],
  },
  {
    service: "skills",
    requiredBy: 2,
    optionalBy: 0,
    softReads: 0,
    tier: "needs-design",
    consumers: ["dsh-tool-skill", "dsh-skill-filesystem"],
  },
  {
    service: "tokenMeter",
    requiredBy: 2,
    optionalBy: 0,
    softReads: 0,
    tier: "needs-design",
    consumers: ["dsh-compaction-basic", "dsh-compaction-tool-result-pruner"],
  },
  {
    service: "workflowEngine",
    requiredBy: 2,
    optionalBy: 0,
    softReads: 0,
    tier: "needs-design",
    consumers: ["dsh-tool-workflow", "dsh-tool-ralph"],
  },
  {
    service: "terminals",
    requiredBy: 2,
    optionalBy: 0,
    softReads: 0,
    tier: "needs-design",
    consumers: ["dsh-terminal-bash", "dsh-tool-bash-persistent"],
  },
  {
    service: "llm",
    requiredBy: 1,
    optionalBy: 0,
    softReads: 1,
    tier: "p3",
    consumers: ["dsh-compaction-basic", "dsh-tool-fs"],
    notes: "本轮映射 ctx.llm；唯一硬依赖是 compaction-basic（它同时要 tokenMeter+sessions）",
  },
  {
    service: "commands",
    requiredBy: 1,
    optionalBy: 1,
    softReads: 0,
    tier: "trivial-shim",
    consumers: ["dsh-command-compact", "dsh-plan-mode"],
  },
  {
    service: "settings",
    requiredBy: 0,
    optionalBy: 1,
    softReads: 1,
    tier: "trivial-shim",
    consumers: ["dsh-agent-presets"],
    notes: "YAML/JSON 读写 + 热更新通知即可",
  },
  {
    service: "attachments",
    requiredBy: 0,
    optionalBy: 1,
    softReads: 2,
    tier: "trivial-shim",
    consumers: ["dsh-tool-fs", "dsh-commands"],
  },
  {
    service: "shell / shellEnv / subprocess / web / approval / userQuestions / typert / ptcRuntime",
    requiredBy: 0,
    optionalBy: 0,
    softReads: 0,
    tier: "out-of-scope",
    consumers: ["dsh-tool-bash", "dsh-tool-pwsh", "dsh-web", "dsh-sandbox-policy"],
    notes: "宿主面（进程/网络/审批），兼容层不模拟",
  },
]);

/** `scope` 的说明（它不是 ctx 服务，是库级原语） */
export const DSH_SCOPE_NOTE =
  "scope 不是 ctx 服务：0 个插件 inject 它；它是 @deepseek-ai/dsh-scope 的库级原语" +
  "（createScope/scopeOf/scopeTarget/ScopedLayers），被 tools/skills/sessionProjections 等" +
  "按 scope 分层的注册表使用。兼容层直接重导出上游模块（同一 Cordis 4 运行时），保证标签 symbol 一致。";

/**
 * 按分级汇总清单（给 preflight 诊断/README 用）。
 *
 * @returns 每个分级下的服务名，以及本轮已映射的比例
 */
export function summarizeServiceInventory(): {
  readonly byTier: Readonly<Record<DshServiceTier, readonly string[]>>;
  readonly mappedCount: number;
  readonly total: number;
} {
  const byTier: Record<DshServiceTier, string[]> = {
    mapped: [],
    p3: [],
    "trivial-shim": [],
    "needs-design": [],
    "out-of-scope": [],
  };
  for (const entry of DSH_SERVICE_INVENTORY) byTier[entry.tier].push(entry.service);
  return {
    byTier,
    mappedCount: byTier.mapped.length + byTier.p3.length,
    total: DSH_SERVICE_INVENTORY.length,
  };
}
