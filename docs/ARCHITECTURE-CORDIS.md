# Cordis 一等公民架构重构设计（refactor/cordis-graph-architecture）

> 本文档沉淀自两篇参考文章的架构要点提炼 + 本次重构的设计决策：
> - [deepseek-harness 项目深度解读 - 知乎](https://zhuanlan.zhihu.com/p/2071362726442673749)
> - [图解 Graph Engineering - 知乎](https://zhuanlan.zhihu.com/p/2065181073781298761)
>
> 官方实现参考：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（本机已安装其
> `@deepseek-ai/cordis` 运行时，作为对照实现直接借阅）。

---

## 1. 两篇文章提炼的架构要点

### 1.1 deepseek-harness 深度解读

1. **一切皆插件（Plugin-as-a-First-Class）**：模型、工具、策略、存储、上下文管理、agent loop 本身，全是可插拔积木。
   开发者可以随时拔下不满意的插件换一个，或按规则写一个新插件直接插上。
2. **Cordis 是元框架（Meta-Framework）**：cordis 只负责「插件生命周期 + 依赖注入 + 事件总线 + 服务注册」，
   业务全部由插件表达。核心概念：
   - `Context`：一个可继承/隔离/拦截的作用域容器；
   - `Service`：挂在 ctx 上的具名服务（`ctx.model`、`ctx.tools`…），可被其他插件注入/替换；
   - `Plugin`：函数/类/对象三种形态，通过 `ctx.plugin(plugin, config)` 装载；
   - `inject`：插件声明依赖的服务，依赖就绪后才启动（声明式装配，顺序无关）；
   - 生命周期：load → start（依赖满足后）→ effect/dispose（逆序卸载）。
3. **Profile / 配置即代码**：应用形态（`cordis.yml` / `cordis.patch.yml`）描述"装哪些插件、各自配置"，
   换一套 profile 就是换一个 Agent 形态。
4. **分层解耦**：llm（模型抽象）与 agent（循环）分层；工具通过 registry 注册；会话/记忆走 storage 域；
   压缩/记忆走 context 域；策略（超时、重试、权限预设）独立成域。

### 1.2 图解 Graph Engineering

1. **从 Loop 到 Graph**：单个 Agent 反复执行是 Loop；多个节点（用户提问、模型回答、工具执行、分支决策）
   以有向图组织、可编排、可治理、可回退，是下一层工程形态。
2. **对话即节点**：每一轮「用户提问 → 助手回答（可含工具调用）」沉淀为一个节点；节点之间以边相连。
3. **对话可溯源**：每个节点记录 parentId / childrenIds / 模型 / 工具 / token / 质量分，
   任意节点可还原完整溯源链（谁触发、用什么模型、调了哪些工具、结果如何）。
4. **节点回答不佳可回退（Branch & Rollback）**：节点质量差（用户负反馈 / 工具错误率 / 评分低）时，
   回退到目标节点并长出新的分支；旧分支不可变保留，作为可审计的历史。

---

## 2. 设计：Cordis 为一等公民

### 2.1 新增包

```
packages/
├── cordis/   — Cordis 集成层：插件域类型 + 服务实现 + 适配器 + 配置驱动运行时
├── graph/    — Graph Engineering 机制：对话即节点 / 可溯源 / 可回退（零运行时依赖）
```

`packages/cordis/vendor/` 内置（vendored）`@deepseek-ai/cordis` + `@deepseek-ai/cosmokit` +
`@standard-schema/spec`（离线可用，tsconfig `paths` 指向 vendor；未来网络可用后可直接改回 npm 依赖）。

### 2.2 插件域（挂到 ctx 上的服务）

| 域 | 服务名 | 职责 | 适配的既有实现 |
|---|---|---|---|
| 模型 | `ctx.model` | LLM 调用、provider/model 热切换 | `@fengagent/llm`（LLMClient / ReloadableLLMClient） |
| 工具 | `ctx.tools` | 工具注册 / 查询 / 物化 / 执行 | `@fengagent/tools`（ToolRegistry） |
| 策略 | `ctx.strategy` | 压缩策略 / 工具选择策略 / 回退策略 | 既有压缩阈值逻辑 + `DefaultRollbackStrategy` |
| 存储 | `ctx.storage` | 会话持久化 + 图存储 | `@fengagent/agent`（SessionStore）+ MemoryGraphStore(JSONL) |
| 上下文 | `ctx.context` | 组装 / 压缩 / 记忆 / 系统上下文 | `@fengagent/context`（ContextManager） |
| Agent Loop | `ctx.loop` | agent loop 本身作为插件，注入上述服务驱动循环 | `@fengagent/agent`（AgentLoop） |
| 图 | `ctx.graph` | 对话可溯源 / 对话即节点 / 可回退 | `@fengagent/graph`（GraphStore） |

内置插件 id：`feng.model` / `feng.tools` / `feng.strategy` / `feng.storage` / `feng.context` / `feng.loop` / `feng.graph`。

### 2.3 配置驱动的运行时引导

```ts
const runtime = createRuntime({
  workdir: ".",
  plugins: [
    { id: "feng.model",    config: { provider, model, createClient } },
    { id: "feng.tools",    config: { tools: [/* 内置工具 */] } },
    { id: "feng.strategy", config: { contextWindow, compactThreshold } },
    { id: "feng.context",  config: { manager } },
    { id: "feng.storage",  config: { dbPath, graphPath } },
    { id: "feng.graph" },
    { id: "feng.loop",     config: { config: { maxTurns, maxTokens, temperature }, workdir } },
    // 用户插件：id 为模块路径，动态 import
    // { id: "./.fengagent/plugins/my-plugin.ts" },
  ],
});
await runtime.start();   // 按依赖注入顺序装载全部插件
await runtime.stop();    // 逆序卸载
```

- 插件顺序无关：`feng.loop` 声明 `inject: ["model","tools","context","strategy","graph"]`，
  依赖服务就绪后才启动（Cordis 声明式装配）。
- 换插件即换能力：把 `feng.loop` 换成 Graph 编排器、把 `feng.strategy` 换成 LLM-as-judge 回退策略，
  其余插件不受影响。

### 2.4 既有功能不回退的保证

- 所有适配器（`packages/cordis/src/adapters/*`）**薄薄包裹既有实现**，不重写：
  行为与现状一致（AgentLoop 原样驱动，ContextManager 原样调用，SessionStore 原样持久化）。
- 全量测试：`bun run typecheck` + `bun test` 全绿（新包 12 个测试 + 既有 600+ 测试全部通过）。
- 重构分期进行，每期保持 CLI / WebUI / 测评 / kvCache / /联想 / /model / /provider 可用。

---

## 3. Graph 机制设计（对话可溯源 + 对话即节点 + 可回退）

### 3.1 数据模型

```ts
interface ConversationNode {
  id: string;              // 节点 id（gnode-*）
  conversationId: string;  // 所属会话
  type: "user" | "assistant" | "tool" | "branch-point";
  messageId: string;       // 关联会话历史 Message.id
  parentId: string | null; // 溯源：父节点
  childrenIds: string[];   // 子节点（按创建顺序）
  createdAt: number;
  meta: {
    model?: string;        // 用哪个模型回答的
    toolCalls?: { id: string; name: string }[];
    tokenCount?: number;
    llmTraceId?: string;   // 关联 LLM trace 日志（logs/ 中可溯源请求/响应）
    quality?: "good" | "poor" | "unrated";
    qualityNote?: string;  // 质量/回退原因
    branch?: string;       // 分支标签
    active?: boolean;      // 是否在活跃路径上
    rolledBack?: boolean;  // 是否因回退作废（保留但不可变）
  };
}
```

### 3.2 操作

- `appendNode`：追加节点，自动维护 parent/children 链接；
- `getChain(nodeId)`：从根到任意节点的完整溯源链；
- `getActivePath(conversationId)`：当前活跃分支；
- `markQuality(nodeId, quality, note?)`：记录节点质量；
- `rollbackTo(nodeId, reason?)`：活跃路径回退到目标节点 → 目标下长出 `branch-point` → 旧分支作废但保留；
- `createRuntime` 运行时中通过 `ctx.graph.rollbackPoorAnswer(nodeId, reason)` 一键回退（CLI/WebUI 的
  `/rollback` 命令底座）。

### 3.3 回退策略（可插拔）

`RollbackStrategy` 接口：`shouldRollback(signal)` / `chooseTarget(node)`。
默认策略：用户显式负反馈、节点内工具错误 ≥ 阈值、或质量分过低 → 回退到父节点（用户提问处）重答。
未来可替换为 LLM-as-judge 自动评估（`qualityToSignal` 已提供归一化信号）。

### 3.4 持久化

`MemoryGraphStore` 支持 JSONL 落盘（`./data/graph.jsonl`，已加入 .gitignore），重启后可恢复溯源图。

---

## 4. 迁移路线图（分期，每期可合入、可回退）

- **Phase 1（本次提交）**：vendor cordis + `@fengagent/cordis` 运行时 + `@fengagent/graph` 机制，
  全量测试/类型检查通过（现有功能零改动、零回退）。
- **Phase 2**：把 CLI 入口改为经 `createRuntime` 装配（模型/工具/上下文/存储走插件），行为不变；
  `/model`、`/provider` 接到 `ctx.model.switchProvider`。
- **Phase 3**：WebUI/Server 的会话管理改经 `ctx.storage`；对话历史渲染接入 `ctx.graph`（展示节点/分支）。
- **Phase 4**：`/rollback`、`/graph` 命令（CLI）与 WebUI 分支可视化；回退策略接入测评模块输出。
- **Phase 5**：用户插件热装载（`cordis.yml` 风格 profile），发布 `docs/EXTENDING-CORDIS.md`。

---

## 5. 如何运行 / 验证

```bash
bun test packages/graph     # Graph 机制测试（溯源/节点/回退/策略）
bun test packages/cordis    # Cordis 运行时集成测试（插件装载/loop/工具/回退）
bun run typecheck           # 全量类型检查
bun test                    # 全量测试（既有 600+ 全部通过）
```
