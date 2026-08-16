# Cordis 一等公民架构重构设计（refactor/cordis-graph-architecture）

> **状态**：本分支已完成 Phase 1–4（CLI 经 createRuntime 装配 → Server/WebUI 接
> ctx.storage/ctx.graph → /rollback、/graph + 分支可视化）。Phase 5（用户插件 profile）规划中。
> 与 `main` 分支的差异与隔离方式见 §6。

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

> **当前分支状态**：本文档只描述 `refactor/cordis-graph-architecture` 分支（新架构）。
> `main` 分支（老架构）保持独立、可随时 checkout / 编译 / 运行，功能不回归（见 §6 分支隔离）。

- **Phase 1（已合入）**：vendor cordis + `@fengagent/cordis` 运行时 + `@fengagent/graph` 机制，
  全量测试/类型检查通过（现有功能零改动、零回退）。
- **Phase 2（已合入）**：CLI 入口经 `createRuntime` 装配。
  - `packages/cli/src/create-runtime-agent.ts`：`createRuntimeAgent()` 把模型/工具/策略/存储/
    上下文/图/loop 全部经 Cordis 插件装配；`RuntimeAgent` 继承既有 `Agent` 接口（prompt /
    resume / compactSession / loadSession / listSessions / getToolNames …），
    `prompt` 经 `ctx.loop` 驱动（对话即节点、可溯源），持久化经 `ctx.storage`。
  - `packages/cli/src/create-agent.ts` 保留旧接口（`createAgent` / `reloadProvider` /
    `buildEnvForLLM`），实现委托给 `createRuntimeAgent`；`/model`、`/provider` 经
    `ctx.model.switchProvider` 切换（onSwitch 同步重建 client，热加载立即生效）。
  - `packages/cli/src/entry.ts`：`serve` 子命令改为共享 runtime + 每会话 RuntimeAgent；
    静态资源/端口等行为不变。
  - 回归：`bun run typecheck` + `bun test packages/cli packages/cordis` 全绿；
    真实 CLI 对话（print 模式）经 deepseek 模型跑通，`sessions.db` + `graph.jsonl` 正常落盘。
- **Phase 3（已合入）**：WebUI/Server 接 `ctx.storage` / `ctx.graph`。
  - `packages/server`：`SessionManager` 新增 `getGraph` / `rollbackSession` /
    `getAgent`（经 `GraphAgentLike` 扩展面读取 RuntimeAgent 的图能力）；
    `routes/sessions.ts` 新增 `GET /:id/graph`、`POST /:id/rollback`。
  - `packages/web-ui`：`api/client.ts` 新增 `getGraph` / `rollbackSession`；
    `use-session.ts` 暴露 `graph` / `refreshGraph` / `rollback` / `refreshSession`；
    会话历史渲染不变（服务端经 `ctx.storage` 持久化，跨重启可恢复）。
  - 回归：服务器 e2e —— 创建会话 → SSE 流式对话（含 graph-node 事件）→
    `GET /graph` 返回节点 → `POST /rollback` 回退（旧分支作废保留、会话截断）全部通过。
- **Phase 4（已合入）**：`/rollback`、`/graph` 命令 + 分支可视化。
  - CLI：`commands.ts` 新增 `/graph`（同步展示节点/活跃路径/溯源链）与 `/rollback
    [节点id]`（回退到父节点并自动重答，经 `RuntimeAgent.rollbackAndRetry`）；
    `/联想` 补全列表自动包含新命令。
  - WebUI：`components/graph-panel.tsx` 分支可视化（节点树 + 活跃高亮 + 回退按钮 +
    作废分支灰显保留），一键回退后自动刷新会话与图。
  - 回归：`RuntimeAgent` 单测（回退截断/重答分支/幂等/热切换）+ 服务端图端点单测全绿。
- **Phase 5（规划中）**：用户插件热装载（`cordis.yml` 风格 profile），发布
  `docs/EXTENDING-CORDIS.md`。当前已支持在 `createRuntime` 配置中以「模块路径」加载用户插件
  （`packages/cordis/src/runtime.ts` 的 `resolvePluginFactory`，测试见
  `packages/cordis/src/__tests__/fixtures/hello-plugin.ts`）。

---

## 5. 如何运行 / 验证

```bash
bun test packages/graph     # Graph 机制测试（溯源/节点/回退/策略）
bun test packages/cordis    # Cordis 运行时集成测试（插件装载/loop/工具/回退/换插件换能力）
bun test packages/cli       # CLI 测试（含 RuntimeAgent 回退/重答/热切换）
bun test packages/server    # Server 测试（含图/回退端点）
bun run typecheck           # 全量类型检查
bun test                    # 全量测试（既有 600+ 全部通过）
```

---

## 6. 分支隔离（refactor/cordis-graph-architecture ↔ main）

- **改动只落在 `refactor/cordis-graph-architecture`**：禁止直接修改 `main`。
- `main`（老分支）可随时独立 checkout、可编译、可运行、功能不回归：
  - 新增文件（`packages/cordis`、`packages/graph`、`create-runtime-agent.ts`、
    graph-panel 等）与 `main` 零交集；`main` 不引用它们。
  - 既有文件的改动均为「向后兼容的增量」（`create-agent.ts` 保留旧接口并委托、
    `entry.ts` serve 分支替换为 runtime 装配、server 新增方法/路由、web-ui 新增面板），
    老分支上的旧实现不受影响。
- 新老分支文档相互独立：`docs/ARCHITECTURE-CORDIS.md` 仅描述新分支；
  `docs/ARCHITECTURE.md` 描述老架构；在线文档站（`docs/index.html`）顶部注明当前展示分支。
- 验收基线：`main` 检出即用；`refactor/cordis-graph-architecture` 覆盖老分支全部功能
  （CLI/WebUI 对话、记忆、上下文压缩、skill 对话、/联想、/model、/provider、测评、kvCache）
  并新增插件化（换插件换能力）与可回溯（回退到父节点重答、链路溯源）。

### 6.1 数据根隔离（Phase 0，两分支同机运行互不干扰）

**运行时数据根 `resolveDataRoot(workdir)`**（`@fengagent/shared` 提供，全链路收口）：

```
resolveDataRoot(workdir) =
  FENG_DATA_DIR（若设置）            # 显式覆盖，优先级最高
  else 配置文件 dataDir（若自定义）    # .fengagent-cordis/config.json 中的 dataDir
  else <workdir>/.fengagent-cordis/  # 新分支默认（.gitignore 已加入）

.fengagent-cordis/
├── sessions.db            # SQLite，表结构不变（schema 层面不破坏 main）
├── graph.jsonl            # graph 投影快照（Phase 2 起为派生视图，不再整写）
├── events/{sessionId}.jsonl   # 事件日志（Phase 1 起，每会话单文件，append-only）
├── logs/                  # fengagent-{date}.log / sessions-{date}.jsonl / llm-trace-{date}.jsonl
├── memory/                # 记忆写入（新分支只写这里）
└── config.json            # 分支级配置覆盖（/model /provider 只落这里）
```

**对 main 的 `.fengagent/` 与 `~/.fengagent/` 一律只读**：仅作导入源、配置分层回退、
`agents/` `skills/` `plugins/` 共享只读定义、记忆只读回退。

**环境变量**：

| 变量 | 语义 | 变更 |
|---|---|---|
| `FENG_DATA_DIR` | 数据根（沿用现有语义，已接线） | 新分支默认 `~/.fengagent` → `<workdir>/.fengagent-cordis` |
| `FENG_MAIN_DATA_DIR`（新增） | 显式指定 main 遗留数据根（导入源） | 默认按序探测：`FENG_MAIN_DATA_DIR` → `<workdir>/.fengagent` → `~/.fengagent` → `<workdir>/data`（旧 cordis 遗留），首个含 `sessions.db`/`graph.jsonl` 者胜 |

**配置读取优先级（全链）**：`.fengagent-cordis/config.json` > 项目 `.fengagent/config.json` >
全局 `~/.fengagent/config.json`（其后是环境变量 → CLI 参数）。

### 6.2 两分支数据关系清单

| 数据 | 共用 | 隔离（新分支） | 切回 main |
|---|---|---|---|
| `sessions.db` | ❌ | `.fengagent-cordis/sessions.db`（表结构不变） | 删 cordis 目录即回 main |
| `graph.jsonl` | ❌ | `.fengagent-cordis/graph.jsonl` | 同上 |
| 事件日志 `events/*.jsonl` | ❌（新格式，main 无） | `.fengagent-cordis/events/` | 同上 |
| 日志 / llm-trace / session-log | ❌ | `.fengagent-cordis/logs/` | 同上 |
| 记忆 `memory/` | 读共用（main 只读回退） | 写 `.fengagent-cordis/memory/` | 同上 |
| `config.json` | 读共用（分层回退） | 写 `.fengagent-cordis/config.json` | 同上 |
| `agents/` `skills/` `plugins/` | ✅ 共享只读（定义非数据） | — | — |
| main 的 `.fengagent/`、`~/.fengagent/` | 只读（导入源） | 从不写入 | 原样保留 |

### 6.3 单向幂等导入（首次运行，一次性、只读、幂等）

1. **触发**：数据根内 `events/` 为空 且 `sessions.db` 不存在 → 执行导入；成功后写
   `import.marker`（来源根 + 时间 + 导入文件数），后续启动跳过。
2. **导入源探测**：见 6.1 环境变量表。**自环防护**：当 `FENG_DATA_DIR` 被显式指向任一
   main 数据根时，导入器把 `resolveDataRoot` 自身从探测候选里排除（防自导成环），
   此时直接跳过导入、绝不写入 main 目录。
3. **单向兼容（明确写死）**：旧格式 → 新数据根，**只读 main 目录、绝不写回**；
   main 无需反向读新数据（`sessions.db` 表结构不变、`graph.jsonl` 老读取方由投影可再生成快照兼容）。
4. **切回 main**：删除/改名 `.fengagent-cordis/`（或清除 `FENG_DATA_DIR`）即回到 main 数据；
   main 目录零改动，随时独立 checkout/运行。

---

## 7. 事件溯源（Event Sourcing，Phase 0 定稿）

> **Phase 0 状态**：`packages/events` 提供事件类型 + 事件名常量 + 运行时注册表接口，零运行时行为变化。
> **Phase 1 状态（已落地）**：EventStore（每会话单文件 append-only `events/{sessionId}.jsonl`，注册表校验，seq + #5 hash 链，重放，尾部半行崩溃自愈）+ 投影（#2 逻辑复现 / #3 生命周期）+ 双写映射（DualWriteSessionStore）+ 双写对账门槛（reconcile：投影 === 旧 SQLite 逐条等价，绿了才进 Phase 2）+ cordis `ctx.eventLog` 服务（`feng.events` 插件，server 已装配）。
> **Phase 2 状态（已落地）**：生产双写（`create-runtime-agent.ts` 把 `DualWriteSessionStore` 挂进 `ctx.storage`，STORAGE 插件装配）；分支感知消息投影（rollback/fork 截断语义）；graph 投影（#4 head 确定式推导、#6 active/rolledBack 派生态重算，`graph.jsonl` 转为派生视图不再整写内存态）；对账门槛扩到含分支/回退会话。
> **Phase 3 状态（已落地）**：事件导出/导入（可移植文件 + `verifyEventChain` #5 hash/prevHash 链校验 + 注册表校验 #1 + 幂等去重）；「以事件为准重建」（`rebuild.ts` + cordis `ctx.rebuild` 服务，SQLite 完全降级为读模型，重建走全量投影重写含 title/status/meta #3，脱双写依赖）；跨数据根/跨机迁移端到端（导出 → 新根导入 → 重建 → 投影与对账一致，见 §7.4）。

### 7.1 词汇表

| 词 | 含义 |
|---|---|
| 事件日志（event log） | 会话事实的唯一来源，`events/{sessionId}.jsonl`，append-only，每行一条事件 |
| 投影（projection） | 从事件日志派生的读模型：会话消息、graph 节点、head、token 统计等 |
| 重放（replay） | 按 seq 顺序重放事件重建投影（崩溃后自愈 = 容忍尾部半行并跳过） |
| head | 会话当前分支的链尾，由事件推导，**不设可变「当前分支」指针**（#4） |
| 信封（envelope） | 每条事件的公共外壳：version/sessionId/seq/type/timestamp/hash/prevHash（#5） |

### 7.2 核心决策（#1–#6 定稿）

- **#1 运行时校验注册表**：`packages/events` 提供核心事件名常量数组 + `registerEventType(type, validator)` 契约；`isSessionEvent`/append 校验走运行时注册表；`declare module` 仅管编译期类型（两者解耦）。cordis 复用 service 注入：`ctx.eventLog.register()`（cordis 框架自带事件总线占用 `ctx.events`，事件溯源服务以 `ctx.eventLog` 暴露，语义即原方案「ctx.events.register()」）。
- **#2 复现语义**：默认 **(a) 逻辑复现** — `step/start` 只存请求参数（model/tools/maxTokens/temperature）+ 派生锚点，messages 由事件重放推导；`assistant/message` 不再单独落事实，由 `assistant/chunk` 投影组装；`FENG_EVENT_FULL_REQUEST=1` 开启字节级（`step/start` 附组装上下文、`turn/end` 落 assembled message）。
- **#3 会话生命周期入词汇**：新增 `session/created`（含初始 title/status）、`session/title`、`session/status` 事件；事件日志 = 唯一事实源（含元数据），DB 降级为读模型，「以事件为准重建」不丢标题/状态。
- **#4 head 确定式推导**：`head(session) = 该会话最大 seq 事件所属分支的链尾`；回退/分叉后 = 最新 `rollback`/`fork` 事件声明 branch 的链尾；不设可变「当前分支」指针，`conversationHeads` 可变态从投影中消失。
- **#5 信封补哈希**：`SessionEventBase` 携带 `hash`/`prevHash`（sha-256(prevHash+seq+type+payload)），Phase 3 导出/导入校验直接可用，不留空项。
- **#6 图导入区分事实/派生态**：`markQuality` → `node/quality` 事件（事实）；`active`/`rolledBack`/branch 为派生态，导入后由投影重算，不字面写入 meta。

### 7.3 写路径 / 投影 / 重放 / 迁移

- **写路径**：追加事件 → 校验（注册表）→ 计算 hash 链 → append 到 `events/{sessionId}.jsonl`；`turn/end` 后触发投影刷新（读模型）。**Phase 2 生产双写**：`create-runtime-agent.ts` 的 STORAGE 插件包一层 `DualWriteSessionStore`（旧存储 + 事件日志并行写，messageId 幂等）；loop 回合收尾把本回合消息整批落事件（旧存储同步收敛到当前消息集合，rollback/fork 截断同步走 `SessionStore.deleteMessages`）；rollback 以最后一条事件（rollback 事件）时间戳对齐会话 `updatedAt`，保证对账逐条等价。
- **投影**：会话消息（#2 逻辑复现 + **Phase 2 分支感知**：rollback/fork 事件按「节点 → 消息」截断历史，旧分支消息从读模型移除、事件不可变保留）、graph 节点（**Phase 2 `projectGraph`**：user/message → 用户节点、step/start → 助手节点、rollback/fork → 分支点、node/quality → 质量事实；#6 active/rolledBack 由 head 链推导）、head（#4：最新 rollback/fork 事件声明分支的链尾，无可变指针）。节点 id 采用确定性方案（`<sessionId>::<kind>::<ref>`，`packages/events/src/node-ids.ts`），同一事实重放得到同一节点。
- **graph.jsonl 派生视图（Phase 2）**：`EventGraphStore`（`packages/events/src/event-graph-store.ts`）以事件日志为事实源，读路径每次重放投影；`flush` 把「派生视图 + 无事件会话的遗留节点」整写到 graph.jsonl（不再整写内存可变态）。无事件会话（导入的 main 遗留数据）读 legacy 节点兼容；一旦产生事件即切换为派生视图。
- **重放**：启动时按 seq 重放；崩溃残留的尾部半行 JSON 跳过 + 启动自愈；双写对账门槛（Phase 1 末尾，**Phase 2 扩到分支/回退会话**）：同一批运行中「事件投影产物」与「旧日志/SQLite」逐条等价，绿了才进 Phase 2（含 rollback 截断、fork 分叉、回退后重答分支）。
- **迁移**：main 的 `sessions.db` / `graph.jsonl` → 事件（单向、幂等、只读，见 §6.3）；sessions.db 表结构不变；graph 投影快照 `graph.jsonl` 保持旧读取方兼容（由投影再生成）。

### 7.4 Phase 3：导出/导入 + 以事件为准重建 + 跨数据根迁移

**事件导出/导入**（`packages/events/src/migration.ts`）——会话事件 ↔ 可移植文件：

- **可移植文件格式**（JSONL）：首行 header（`type:"fengagent-export"` / `format:"fengagent-event-export"` / `version:1` / `sessionId` / `eventCount` / `lastSeq` / `lastHash`），其后逐条事件行与事件日志**逐字一致**（保留 seq/hash/timestamp 信封，不重算）。
- **机器无关**：事件时间戳为 ISO-8601、sessionId 为 UUID、hash 链由内容推导（canonical JSON）——不含本机路径/进程态，同一文件可在另一数据根或另一台机器原样导入（测试含「导出文件不含本机路径」断言）。
- **导入校验链**（`importSessionEvents`，任一步失败即拒绝且目标日志不动）：
  1. header 形状/版本；
  2. 事件行解析 + 与 header 的 sessionId / eventCount / lastHash 一致性；
  3. `verifyEventChain`（#5：seq 连续 + hash/prevHash 链完整）——篡改 payload/seq/header 均红；
  4. 运行时注册表校验（#1，`EventStore.importEvents` 逐条校验）——未注册类型拒绝；
  5. 幂等去重（`EventStore.importEvents` 与目标日志逐条 hash 对齐）：完全相同/已包含 → `noop`；目标日志为前缀 → `appended` 增量续写；链分叉 → `ImportConflictError` 拒绝。
- **整库导出/导入**：`exportStoreEvents(store, dir)`（每会话一个 `<sanitized>.fengevents.jsonl`）/ `importStoreEvents(store, dir)`（逐文件幂等，单文件失败不影响其余）。

**「以事件为准重建」**（`packages/events/src/rebuild.ts` + cordis `ctx.rebuild` 服务，插件 `feng.rebuild`）：

- `rebuildSession(events, legacy, sessionId)`：事件日志 → 全量投影（`projectSession`，含 title/status/model/tokenCount/createdAt/updatedAt + messages，#3 元数据不丢）→ 整写读模型（saveSession + saveMessages + deleteMessages 收敛截断）。
- **脱双写依赖**：重建只读事件日志 + 写读模型，**绝不追加事件**（测试断言事件文件字节级不变）；`create-runtime-agent.ts` 的 REBUILD 插件传「裸读模型」（SessionStore），不传 DualWrite 包装。
- `rebuildAll(events, legacy, { prune })`：重建全部有事件的会话；`prune=true` 时删除事件日志中不存在的遗留孤儿会话（读模型完全以事件为准）。
- **重建即对账**：重建后 `reconcileSession` 必须绿（投影 === 读模型），含 rollback/fork 截断会话。

**跨数据根 / 跨机迁移端到端**（`packages/events/src/__tests__/migration-e2e.test.ts`）：

```
源根 A（双写产生事件）→ exportSessionEvents / exportStoreEvents
  → 可移植文件（机器无关）
新根 B（事件日志 + SQLite 全新）→ importSessionEvents / importStoreEvents（幂等去重）
  → rebuildSession / rebuildAll（以事件为准重建读模型）
  → reconcile 绿 + 两根读模型/投影全等 + 迁移后新根可继续写（事件链 seq 无缝续接）
```
