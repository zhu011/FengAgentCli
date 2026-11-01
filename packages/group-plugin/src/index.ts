/**
 * @fengagent/group-plugin — 群能力 Cordis 插件（P4 合流）
 *
 * 把群域（AgentGroupService + GroupOrchestrator + 群工具）封装成 **feng 形状**
 * 插件：`apply(ctx)` 里经 `ctx.tools.register` 注册群工具（feng ToolDefinition
 * 形状）——
 * - 在 FengAgentCli：经 createRuntime 用户插件路径装载（`{ id:
 *   "@fengagent/group-plugin", config }`），工具进本仓库 agent 的注册表；
 * - 在 dsh：经 `fengagent-compat` 的 `config.plugins` 装载，工具被适配进 dsh
 *   的 ToolRuntime——群能力一次交付两端。
 *
 * 存储注入：`options.store`（server 传 SQLite `AgentGroupStore`）缺省时用
 * 便携 JSON store（`<dataRoot>/groups.json`，无原生依赖，Node 可跑）。
 */

import { AgentGroupService, GroupOrchestrator, type GroupStore } from "@fengagent/groups";
import { createGroupTools } from "@fengagent/tools";
import type { ToolDefinition } from "@fengagent/core";
import { PortableGroupStore } from "./portable-store.ts";

/** 群插件选项 */
export interface GroupPluginOptions {
  /** 存储注入（server 侧传 SQLite AgentGroupStore；缺省用便携 JSON store） */
  store?: GroupStore;
  /** 便携 store 的数据根（无 store 时生效，默认 `.fengagent/`） */
  dataRoot?: string;
  /** 协调者默认名（缺省 `fengagent`） */
  selfName?: string;
  /** runtime 卡片提供者（建群成员校验 + group_list；缺省空） */
  runtimes?: () => Array<{ name: string; enabled: boolean }>;
  /** 取消某群未终态任务（G3 关停语义；缺省无操作） */
  cancelGroupTasks?: (groupId: string) => string[];
  /** 发言预算（V2-3；free 模式，缺省 5 条 / 60s） */
  speechBudget?: { limit?: number; windowMs?: number };
  /** 发言权仲裁强度（V2-3；缺省 `enforce`） */
  arbitration?: "enforce" | "advisory";
  /** 发言权转移回调（V2-3；宿主可据此派发任务） */
  onTurn?: (groupId: string, speaker: string) => void;
  /** 装配完成回调（server 由此拿 service/orchestrator 挂 REST 路由） */
  onReady?: (instances: { service: AgentGroupService; orchestrator: GroupOrchestrator }) => void;
}

/**
 * 群能力插件工厂。返回 Cordis 函数插件（feng 形状）：
 * ```ts
 * ctx.plugin(groupPlugin({ dataRoot, runtimes }))
 * // 或经 runtime 用户插件路径：
 * { id: "@fengagent/group-plugin", config: { dataRoot, runtimes } }
 * ```
 */
export function groupPlugin(options: GroupPluginOptions = {}) {
  const entry = function groupPluginEntry(ctx: {
    tools: { register(tool: unknown): unknown };
  }) {
    const service = new AgentGroupService({
      store: options.store ?? new PortableGroupStore(options.dataRoot ?? ".fengagent"),
      ...(options.runtimes === undefined ? {} : { runtimes: options.runtimes }),
      ...(options.selfName === undefined ? {} : { defaultCoordinator: options.selfName }),
    });

    const orchestrator = new GroupOrchestrator({
      groups: service,
      ...(options.cancelGroupTasks === undefined ? {} : { cancelGroupTasks: options.cancelGroupTasks }),
      ...(options.speechBudget === undefined ? {} : { speechBudget: options.speechBudget }),
      ...(options.arbitration === undefined ? {} : { arbitration: options.arbitration }),
      ...(options.onTurn === undefined ? {} : { onTurn: options.onTurn }),
    });
    service.onMessage((groupId, message) => orchestrator.onMessage(groupId, message));
    orchestrator.start();

    const tools: ToolDefinition[] = createGroupTools(
      {
        create: async (input) => {
          const group = service.createGroup({
            name: input.name,
            ...(input.description === undefined ? {} : { description: input.description }),
            members: input.members ?? [],
            coordinator: input.coordinator ?? options.selfName ?? "fengagent",
          });
          return { id: group.id, name: group.name, members: group.members };
        },
        send: async (input) => {
          const message = service.postAgentMessage(input.groupId, {
            content: input.content,
            fromName: input.from,
          });
          return { id: message.id, seq: message.seq };
        },
        history: async (input) => {
          const group = service.getGroup(input.groupId);
          if (!group) throw new Error(`群不存在: ${input.groupId}`);
          const messages = service.listRecentMessages(input.groupId, input.limit ?? 50);
          return {
            groupId: group.id,
            name: group.name,
            lines: messages.map((m) => `#${m.seq} [${m.fromName}] ${m.content}`),
          };
        },
        conclude: async (input) => {
          const result = orchestrator.conclude(input.groupId, {
            by: "coordinator",
            reason: "协调者收口",
            conclusion: input.conclusion,
          });
          return { status: result.group.status, cancelledTasks: result.cancelledTasks.length };
        },
      },
      { selfName: () => options.selfName ?? "fengagent" },
    );

    for (const tool of tools) ctx.tools.register(tool);

    options.onReady?.({ service, orchestrator });

    return { service, orchestrator };
  };
  Object.assign(entry, { inject: ["tools"] });
  return entry;
}

export { PortableGroupStore };

/** 默认导出：函数插件形态（runtime 用户插件路径 `{ id: "@fengagent/group-plugin", config }` 直装） */
export default function groupPluginDefault(
  ctx: { tools: { register(tool: unknown): unknown } },
  config: GroupPluginOptions = {},
  ) {
    return groupPlugin(config)(ctx);
  }
  // cordis 函数插件的服务依赖声明（否则 ctx.tools 访问被 inject 门拒绝）
  Object.assign(groupPluginDefault, { inject: ["tools"] });
