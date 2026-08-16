# FengAgentCli 架构设计文档（refactor/cordis-graph-architecture）

> **本文档描述 `refactor/cordis-graph-architecture` 分支（当前分支）的架构**：
> **Cordis 插件化（Plugin-as-a-First-Class）+ 对话图（Graph Engineering，可溯源/可回退）+
> 事件溯源（Event Sourcing）**。
>
> - 重构设计全过程与迁移路线见 [ARCHITECTURE-CORDIS.md](./ARCHITECTURE-CORDIS.md)；
> - 小白操作手册（照抄命令）见 [GUIDE-CORDIS.md](./GUIDE-CORDIS.md)；
> - `main` 分支为老架构（Loop 直连），数据/配置与本分支隔离，互不干扰（见 §9 分支隔离）。

---

## 目录

1. [整体架构](#1-整体架构)
2. [核心模块依赖关系](#2-核心模块依赖关系)
3. [Cordis 插件化运行时](#3-cordis-插件化运行时)
4. [对话图（Graph Engineering）](#4-对话图graph-engineering)
5. [事件溯源（Event Sourcing）](#5-事件溯源event-sourcing)
6. [数据流设计](#6-数据流设计)
7. [配置系统设计](#7-配置系统设计)
8. [关键技术方案](#8-关键技术方案)
9. [分支隔离（与 main）](#9-分支隔离与-main)
10. [运行与验证](#10-运行与验证)
11. [设计决策记录（ADR）](#11-设计决策记录adr)

---

## 1. 整体架构

### 1.1 系统全景

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          FengAgentCli 系统全景（Cordis 分支）                │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────┐    │
│  │   CLI TUI    │    │  Web Browser │    │  Multica Platform / ACP   │    │
│  │  (Ink/React) │    │   (React)    │    │     (Agent 运行时管理)      │    │
│  └──────┬───────┘    └──────┬───────┘    └───────────┬──────────────┘    │
│         │ 进程内调用          │ HTTP + SSE              │ CLI 交互            │
│         ▼                    ▼                        ▼                    │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │                 Cordis 运行时（createRuntime）                     │    │
│  │   ┌──────────────────────────────────────────────────────────┐   │    │
│  │   │ ctx.model    ctx.tools   ctx.strategy   ctx.context     │   │    │
│  │   │ ctx.storage  ctx.loop    ctx.graph      ctx.eventLog    │   │    │
│  │   │ ctx.rebuild                                            │   │    │
│  │   └───────────────┬──────────────────────────────────────────┘   │    │
│  │     插件域 = 可插拔服务（换插件即换能力）                           │    │
│  │   ┌──────────────────────────────────────────────────────────┐   │    │
│  │   │  RuntimeAgent（CLI/Server 每会话一个）                     │   │    │
│  │   │  AgentLoop 驱动 · 对话即节点 · 事件落日志                   │   │    │
│  │   └──────────────────────────────────────────────────────────┘   │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                            │
│  ┌───────────────────────────────────────────────────────────────┐        │
│  │  数据根 .fengagent-cordis/                                    │        │
│  │  sessions.db（读模型）· graph.jsonl（派生视图）· events/*.jsonl │        │
│  │  logs/（运行/会话/llm-trace）· memory/ · config.json          │        │
│  └───────────────────────────────────────────────────────────────┘        │
│                                                                            │
│  ┌───────────────────────────────────────────────────────────────┐        │
│  │  Shared / Core（类型 · Zod Schema · 工具函数 · resolveDataRoot） │        │
│  └───────────────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.2 进程模型

```
模式 1: CLI 模式（单进程）
┌─────────────────────────────────────────┐
│              Bun 进程                    │
│  ┌───────┐  ┌────────────────────────┐ │
│  │ Ink   │─►│ createRuntimeAgent()   │ │
│  │ TUI   │  │  = Cordis 运行时装配     │ │
│  └───────┘  │  (model/tools/loop/… ) │ │
│             └────────────────────────┘ │
└─────────────────────────────────────────┘

模式 2: WebUI 模式（server 进程，每会话一个 RuntimeAgent）
┌─────────────────────────────────────────┐
│           Bun 服务进程                   │
│  ┌──────────┐  ┌────────────────────┐  │
│  │ Hono     │─►│ RuntimeAgent(s)    │  │
│  │ Server   │  │ (共享 Cordis 运行时) │  │
│  │ + SSE    │  └────────────────────┘  │
│  │ + Static │                          │
│  └────┬─────┘                          │
│       │ HTTP + SSE                     │
└───────┼─────────────────────────────────┘
        │
   ┌────▼─────┐
   │ Browser  │
   │ (React)  │
   └──────────┘

模式 3: 编译二进制模式（单进程，同模式 1/2 的能力）
```

### 1.3 Monorepo 包结构

```
FengAgentCli/
├── packages/
│   ├── shared/          # 共享：类型、工具函数、常量、resolveDataRoot（数据根）
│   ├── core/            # 核心：接口定义、Zod Schema（零运行时依赖）
│   ├── llm/             # LLM：Provider 抽象、流式调用、ReloadableLLMClient
│   ├── tools/           # 工具：注册、执行、权限、内置工具、MCP、Hook
│   ├── context/         # 上下文：压缩、记忆、系统上下文
│   ├── agent/           # Agent：Loop、SessionStore、状态管理
│   ├── cordis/          # ★ Cordis 集成层：插件域类型 + 服务 + 适配器 + createRuntime
│   ├── graph/           # ★ Graph Engineering：对话即节点 / 溯源 / 回退（零运行时依赖）
│   ├── events/          # ★ 事件溯源：EventStore / 投影 / 双写 / 导出导入 / 重建 / 迁移
│   ├── cli/             # CLI：Ink TUI、命令、createRuntimeAgent 装配入口
│   ├── server/          # 服务：Hono HTTP API + SSE + /graph /rollback 端点
│   ├── eval/            # Agent 测评模块（LLM Trace 分析）
│   └── web-ui/          # WebUI：React + Vite 前端（含对话图面板）
├── docs/                # 文档（PRD、架构、操作手册、在线文档站）
├── scripts/             # 构建、开发、事件迁移（events-migrate.ts）脚本
├── .fengagent-cordis/   # 分支级数据根（运行时生成，已 gitignore）
├── package.json         # Workspace 根配置
├── tsconfig.json        # TS 配置（路径映射，含 cordis vendor paths）
└── README.md
```

> `packages/cordis/vendor/` 内置（vendored）`@deepseek-ai/cordis` + `@deepseek-ai/cosmokit` +
> `@standard-schema/spec`，离线可用（tsconfig `paths` 指向 vendor）。

---

## 2. 核心模块依赖关系

### 2.1 包依赖图

```
                ┌──────────┐
                │  shared  │  ← 零依赖（工具函数、常量、数据根）
                └────┬─────┘
                     │
                ┌────┴─────┐
                │   core   │  ← 仅依赖 shared（接口定义、Zod Schema）
                └────┬─────┘
                     │
      ┌──────────────┼──────────────┐
      │              │              │
 ┌────┴────┐   ┌────┴────┐   ┌────┴────┐
 │   llm   │   │  tools  │   │ context │  ← 各依赖 core
 └────┬────┘   └────┬────┘   └────┬────┘
      │              │              │
      └──────────────┼──────────────┘
                     │
                ┌────┴────┐
                │  agent  │  ← 依赖 llm + tools + context + core
                └────┬────┘
                     │
      ┌──────────────┼──────────────┐
      │              │              │
 ┌────┴────┐   ┌────┴────┐   ┌────┴────┐
 │ cordis  │   │  graph  │   │ events  │  ← 薄适配既有实现；graph/events 零/低依赖
 └────┬────┘   └────┬────┘   └────┬────┘
      └──────────────┼──────────────┘
                     │
              ┌──────┴──────┐
              │ cli / server│  ← 经 createRuntimeAgent 装配 Cordis 运行时
              └─────────────┘
              web-ui ← 独立（HTTP 通信）
```

### 2.2 依赖规则

- `shared` / `core` — 零外部包依赖；
- `llm` / `tools` / `context` — 仅依赖 `core` / `shared`；
- `agent` — 依赖 `core` / `shared` / `llm` / `tools` / `context`；
- `graph` — 零运行时依赖（纯图机制）；
- `events` — 依赖 `shared`（数据根）+ `agent`（读模型接口）；
- `cordis` — vendored cordis + 依赖各既有实现包；
- `server` — 依赖 `agent` / `core` / `shared` / `cordis`；
- `cli` — 依赖 `agent` / `core` / `shared` / `cordis` / `graph` / `events`；
- `web-ui` — 独立前端，通过 HTTP API 通信；
- **禁止循环依赖**。

---

## 3. Cordis 插件化运行时

Cordis 是元框架（Meta-Framework）：只负责「插件生命周期 + 依赖注入 + 事件总线 + 服务注册」，
业务全部由插件表达。本分支把 Cordis 作为**一等公民**，Agent 的模型、工具、策略、存储、
上下文、Loop、图、事件全部挂在 `ctx.*` 上，可插拔、可替换。

### 3.1 核心概念

| 概念 | 说明 |
|------|------|
| `Context` | 可继承/隔离/拦截的作用域容器 |
| `Service` | 挂在 ctx 上的具名服务（`ctx.model`、`ctx.tools`…），可被其他插件注入/替换 |
| `Plugin` | 函数/类/对象三种形态，通过 `ctx.plugin(plugin, config)` 装载 |
| `inject` | 插件声明依赖的服务，依赖就绪后才启动（声明式装配，顺序无关） |
| 生命周期 | load → start（依赖满足后）→ effect / dispose（逆序卸载） |

### 3.2 插件域（挂到 ctx 上的服务）

| 域 | 服务名 | 职责 | 适配的既有实现 |
|---|---|---|---|
| 模型 | `ctx.model` | LLM 调用、provider/model 热切换 | `@fengagent/llm`（LLMClient / ReloadableLLMClient） |
| 工具 | `ctx.tools` | 工具注册 / 查询 / 物化 / 执行 | `@fengagent/tools`（ToolRegistry） |
| 策略 | `ctx.strategy` | 压缩策略 / 工具选择策略 / 回退策略 | 既有压缩阈值逻辑 + `DefaultRollbackStrategy` |
| 存储 | `ctx.storage` | 会话持久化 + 图存储（双写） | `@fengagent/agent`（SessionStore）+ `DualWriteSessionStore` |
| 上下文 | `ctx.context` | 组装 / 压缩 / 记忆 / 系统上下文 | `@fengagent/context`（ContextManager） |
| Agent Loop | `ctx.loop` | agent loop 本身作为插件，注入上述服务驱动循环 | `@fengagent/agent`（AgentLoop） |
| 图 | `ctx.graph` | 对话可溯源 / 对话即节点 / 可回退 | `@fengagent/graph`（GraphStore）+ `EventGraphStore` |
| 事件 | `ctx.eventLog` | 事件溯源服务（事件总线由 cordis 占用 `ctx.events`） | `@fengagent/events`（EventStore） |
| 重建 | `ctx.rebuild` | 以事件为准重建读模型 | `@fengagent/events`（rebuild.ts） |

内置插件 id：`feng.model` / `feng.tools` / `feng.strategy` / `feng.storage` / `feng.context` /
`feng.loop` / `feng.graph` / `feng.events` / `feng.rebuild`。

### 3.3 配置驱动的运行时引导

```ts
// packages/cordis/src/runtime.ts — createRuntime
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
  依赖服务就绪后才启动（Cordis 声明式装配）；
- 换插件即换能力：把 `feng.loop` 换成 Graph 编排器、把 `feng.strategy` 换成 LLM-as-judge
  回退策略，其余插件不受影响。

### 3.4 CLI/Server 装配（createRuntimeAgent）

- `packages/cli/src/create-runtime-agent.ts`：`createRuntimeAgent()` 把模型/工具/策略/存储/
  上下文/图/loop/事件全部经 Cordis 插件装配；`RuntimeAgent` 继承既有 `Agent` 接口
  （prompt / resume / compactSession / loadSession / listSessions / getToolNames …），
  `prompt` 经 `ctx.loop` 驱动（对话即节点、可溯源），持久化经 `ctx.storage`（双写）。
- `packages/cli/src/create-agent.ts` 保留旧接口（`createAgent` / `reloadProvider` /
  `buildEnvForLLM`），实现委托给 `createRuntimeAgent`；`/model`、`/provider` 经
  `ctx.model.switchProvider` 切换（onSwitch 同步重建 client，热加载立即生效）。
- `packages/cli/src/entry.ts`：`serve` 子命令共享 runtime + 每会话 RuntimeAgent；
  `print` 模式走同一条链路。
- `packages/server/src/create-runtime-agent.ts`：Server 侧同样以 Cordis 运行时装配
  `RuntimeAgent`，`SessionManager` 经 `GraphAgentLike` 扩展面读取图能力。

---

## 4. 对话图（Graph Engineering）

### 4.1 数据模型

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
    llmTraceId?: string;   // 关联 LLM trace 日志
    quality?: "good" | "poor" | "unrated";
    qualityNote?: string;  // 质量/回退原因
    branch?: string;       // 分支标签
    active?: boolean;      // 是否在活跃路径上
    rolledBack?: boolean;  // 是否因回退作废（保留但不可变）
  };
}
```

### 4.2 操作

- `appendNode`：追加节点，自动维护 parent/children 链接；
- `getChain(nodeId)`：从根到任意节点的完整溯源链；
- `getActivePath(conversationId)`：当前活跃分支；
- `markQuality(nodeId, quality, note?)`：记录节点质量；
- `rollbackTo(nodeId, reason?)`：活跃路径回退到目标节点 → 目标下长出 `branch-point` →
  旧分支作废但保留；
- `RuntimeAgent.rollbackAndRetry(nodeId, reason)`：CLI `/rollback`、WebUI 回退按钮的底座。

### 4.3 回退策略（可插拔）

`RollbackStrategy` 接口：`shouldRollback(signal)` / `chooseTarget(node)`。
默认策略：用户显式负反馈、节点内工具错误 ≥ 阈值、或质量分过低 → 回退到父节点（用户提问处）重答。
未来可替换为 LLM-as-judge 自动评估（`qualityToSignal` 已提供归一化信号）。

### 4.4 持久化

- `MemoryGraphStore`（`packages/graph/src/store.ts`）支持 JSONL 落盘；
- 事件溯源分支下，`EventGraphStore`（`packages/events/src/event-graph-store.ts`）以事件日志为
  事实源，读路径每次重放投影，`flush` 把「派生视图 + 无事件会话的遗留节点」整写到
  `<数据根>/graph.jsonl`；无事件会话读 legacy 节点兼容。

### 4.5 界面

- **CLI**：`/graph`（同步展示节点/活跃路径/溯源链）、`/rollback [节点id]`（回退到父节点并
  自动重答）；`/` 联想补全列表自动包含新命令；
- **WebUI**：`components/graph-panel.tsx` 分支可视化（节点树 + 活跃高亮 + 回退按钮 +
  作废分支灰显保留），一键回退后自动刷新会话与图；
- **Server**：`GET /api/sessions/:id/graph`、`POST /api/sessions/:id/rollback`。

---

## 5. 事件溯源（Event Sourcing）

会话事实的唯一来源是事件日志：`<数据根>/events/{sessionId}.jsonl`，append-only，一行一条事件
（带 seq + hash 链）。SQLite `sessions.db` 降级为读模型，可由事件日志全量重建。

### 5.1 词汇表

| 词 | 含义 |
|---|---|
| 事件日志（event log） | 会话事实的唯一来源，`events/{sessionId}.jsonl`，append-only，每行一条事件 |
| 投影（projection） | 从事件日志派生的读模型：会话消息、graph 节点、head、token 统计等 |
| 重放（replay） | 按 seq 顺序重放事件重建投影（崩溃后自愈 = 容忍尾部半行并跳过） |
| head | 会话当前分支的链尾，由事件推导，不设可变「当前分支」指针 |
| 信封（envelope） | 每条事件的公共外壳：version/sessionId/seq/type/timestamp/hash/prevHash |

### 5.2 核心模块（packages/events）

| 文件 | 职责 |
|------|------|
| `event-store.ts` | EventStore：每会话单文件 append-only，注册表校验，seq + #5 hash 链，重放，尾部半行崩溃自愈；`importEvents` 幂等去重 |
| `types.ts` | 事件类型 + `SessionEventBase` 信封（hash/prevHash） |
| `registry.ts` | 运行时校验注册表：`registerEventType(type, validator)` + 核心事件名常量 |
| `projection.ts` | 投影：`projectSession`（#2 逻辑复现 + #3 生命周期元数据）、head 推导（#4） |
| `graph-projection.ts` | graph 投影：user/message→用户节点、step/start→助手节点、rollback/fork→分支点、node/quality→质量事实；active/rolledBack 由 head 链推导 |
| `dual-write.ts` | DualWriteSessionStore：旧存储 + 事件日志并行写，messageId 幂等，rollback/fork 截断同步 |
| `reconcile.ts` | 双写对账：事件投影 === 旧 SQLite 逐条等价（含 rollback/fork 截断会话） |
| `event-graph-store.ts` | EventGraphStore：事件日志为事实源，读路径重放投影，flush 派生视图到 graph.jsonl |
| `migration.ts` | 事件导出/导入：可移植文件（header + 逐字事件行）+ 校验链 + 幂等去重；`exportStoreEvents` / `importStoreEvents` 整库迁移 |
| `rebuild.ts` | 以事件为准重建：`rebuildSession` / `rebuildAll`（全量投影重写读模型，脱双写依赖） |
| `node-ids.ts` | 节点 id 确定性方案（`<sessionId>::<kind>::<ref>`） |
| `hash.ts` | sha-256 事件链哈希 |

### 5.3 核心决策（#1–#6）

- **#1 运行时校验注册表**：`isSessionEvent` / append 校验走运行时注册表；`declare module` 仅管编译期类型；
- **#2 复现语义**：默认逻辑复现 — `step/start` 只存请求参数 + 派生锚点，messages 由事件重放推导；
  `FENG_EVENT_FULL_REQUEST=1` 开启字节级；
- **#3 会话生命周期入词汇**：`session/created`、`session/title`、`session/status` 事件；
  事件日志 = 唯一事实源（含元数据），重建不丢标题/状态；
- **#4 head 确定式推导**：head = 该会话最大 seq 事件所属分支的链尾；回退/分叉后 = 最新
  `rollback`/`fork` 事件声明 branch 的链尾；
- **#5 信封补哈希**：`hash`/`prevHash`（sha-256(prevHash+seq+type+payload)），导出/导入直接校验；
- **#6 图导入区分事实/派生态**：`markQuality` → 事实；`active`/`rolledBack`/branch 为派生态，
  导入后由投影重算。

### 5.4 写路径 / 重建 / 迁移

- **写路径**：追加事件 → 校验（注册表）→ 计算 hash 链 → append；`turn/end` 后触发投影刷新；
  Phase 2 起生产双写（STORAGE 插件包 `DualWriteSessionStore`，loop 回合收尾整批落事件）；
- **重建**：`rebuildSession` 只读事件日志 + 写读模型，绝不追加事件；`rebuildAll --prune`
  删除事件日志中不存在的孤儿会话；重建后 `reconcileSession` 必须绿；
- **迁移**：`exportStoreEvents` → 可移植文件（机器无关：ISO-8601 时间戳、UUID sessionId、
  内容推导 hash）→ 新数据根 `importStoreEvents`（幂等去重）→ `rebuild` → 对账一致；
  CLI 入口：`bun run scripts/events-migrate.ts export|import|rebuild|verify|list`。

---

## 6. 数据流设计

### 6.1 核心数据流：用户输入 → 响应输出

```
用户输入
  │
  ▼
CLI TUI / WebUI / ACP
  │  prompt(text)
  ▼
RuntimeAgent.prompt()
  │  经 ctx.loop 驱动
  ▼
AgentLoop（ctx.loop 插件）
  │  1. ctx.context 组装上下文（系统提示 + 历史 + 记忆）
  │  2. ctx.strategy 检查压缩阈值 → 需要则压缩
  │  3. ctx.tools 准备工具列表
  │  4. ctx.model 调用 LLM（stream）
  │  5. 解析工具调用 → ctx.tools 执行（权限检查 → 执行 → 截断）
  │  6. 每回合收尾：ctx.storage（双写）落事件 + 会话
  │  7. ctx.graph 沉淀对话节点（user/assistant/tool）
  ▼
事件日志 events/{sessionId}.jsonl（事实源）
  ▼
投影 → sessions.db（读模型）· graph.jsonl（派生视图）
  ▼
响应事件流（text-delta / tool-call-* / turn-end / graph-node …）
  ▼
CLI TUI 渲染 / WebUI SSE / ACP 流式返回
```

### 6.2 流式事件序列

```
session-start → message-start → text-delta* → tool-call-* → tool-result*
→ message-end → graph-node（节点沉淀）→ usage（KV Cache 统计）→ turn-end → session-end
```

### 6.3 回退（Rollback）数据流

```
用户输入 /rollback [节点id]
  ▼
RuntimeAgent.rollbackAndRetry(nodeId, reason)
  ▼
ctx.graph.rollbackTo(nodeId)  →  目标下长出 branch-point，旧分支作废（rolledBack 保留）
  ▼
ctx.storage 截断会话消息到回退点（DualWrite 同步写 rollback 事件 + deleteMessages）
  ▼
以最后一条 rollback 事件时间戳对齐会话 updatedAt（保证对账逐条等价）
  ▼
从回退点重新驱动 ctx.loop 重答 → 新分支从 branch-point 长出（← head）
```

### 6.4 上下文压缩数据流

当对话历史 Token 数超过 `contextWindow * compactThreshold` 时触发：

```
1. 选择分割点（head 段 + recent 段）
2. 用 smallModel 摘要 head 段
3. 替换为摘要消息 + recent 段
4. 压缩事件（compaction-*）进入事件日志（可溯源）
```

---

## 7. 配置系统设计

### 7.1 配置分层

```
CLI 参数 > 环境变量（FENG_*）> 全局 ~/.fengagent/config.json
        > 项目 .fengagent/config.json（main 遗留，只读回退）
        > 分支级 .fengagent-cordis/config.json（/model /provider 只写这里）
```

### 7.2 数据根（resolveDataRoot）

```
resolveDataRoot(workdir) =
  FENG_DATA_DIR（若设置）            # 显式覆盖，优先级最高
  else 配置文件 dataDir（若自定义）    # .fengagent-cordis/config.json 中的 dataDir
  else <workdir>/.fengagent-cordis/  # 新分支默认（.gitignore 已加入）

.fengagent-cordis/
├── sessions.db            # SQLite，表结构不变（schema 层面不破坏 main）
├── graph.jsonl            # graph 投影快照（Phase 2 起为派生视图）
├── events/{sessionId}.jsonl   # 事件日志（每会话单文件，append-only）
├── logs/                  # fengagent-{date}.log / sessions-{date}.jsonl / llm-trace-{date}.jsonl
├── memory/                # 记忆写入（新分支只写这里）
└── config.json            # 分支级配置覆盖（/model /provider 只落这里）
```

### 7.3 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FENG_MODEL` | `claude-sonnet-4-20250514` | 主模型 ID |
| `FENG_PROVIDER` | `anthropic` | LLM 提供商 |
| `FENG_MAX_TOKENS` | `8192` | 单次生成最大 token 数 |
| `FENG_TEMPERATURE` | `1.0` | 生成温度（0–2） |
| `FENG_CONTEXT_WINDOW` | `200000` | 上下文窗口大小（token） |
| `FENG_COMPACT_THRESHOLD` | `0.85` | 压缩触发阈值 |
| `FENG_AUTO_APPROVE_TOOLS` | `false` | 自动批准工具调用 |
| `FENG_SERVER_PORT` | `3000` | HTTP 服务端口 |
| `FENG_SERVER_HOST` | `127.0.0.1` | 服务监听地址 |
| `FENG_LOG_LEVEL` | `info` | 日志级别（debug/info/warn/error） |
| `FENG_MAX_TURNS` | `50` | Agent 循环最大轮次 |
| `FENG_DATA_DIR` | `.fengagent-cordis` | 数据根（分支级） |
| `FENG_MAIN_DATA_DIR` | — | 显式指定 main 遗留数据根（导入源） |
| `FENG_EVENT_FULL_REQUEST` | — | 事件溯源字节级复现开关 |

---

## 8. 关键技术方案

### 8.1 Agent Loop 实现（ctx.loop 插件）

```
while (needsContinuation && step < maxTurns) {
  1. 组装上下文（系统提示 + 历史 + 记忆）
  2. 检查并执行压缩
  3. 准备工具列表
  4. 调用 LLM（stream）
  5. 解析工具调用
  6. 执行工具（权限检查 → 执行 → 截断）
  7. 注入工具结果到历史
  8. needsContinuation = 有工具调用 ? true : false
  9. 回合收尾：双写事件日志 + 沉淀 graph 节点
}
```

### 8.2 流式输出方案

- LLM Client 返回 `AsyncGenerator<LLMEvent>`，统一抽象 `stream()` / `generate()`；
- CLI：Ink 组件逐帧渲染 text-delta；WebUI：Server-Sent Events（SSE）转发；
- `usage` 事件携带 KV Cache 统计（`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`），
  WebUI 统计栏实时累计。

### 8.3 会话持久化方案

- 事件日志为准（`events/{sessionId}.jsonl`）+ SQLite 读模型（`sessions.db`）+ 图派生视图
  （`graph.jsonl`）；
- 双写对账门槛：同一批运行中「事件投影产物」与「旧日志/SQLite」逐条等价；
- 崩溃自愈：尾部半行 JSON 跳过 + 启动重放；
- `/restore` 从存储恢复会话历史。

### 8.4 权限审批方案

- `PermissionChecker`：auto / allow / deny / ask；
- CLI 弹框 / WebUI SSE 推送审批请求，用户响应回传。

### 8.5 上下文压缩实现

- `CompactionEngine`：摘要 head 段 + 保留 recent 段；`TokenCounter` 估算；
- 记忆：MEMORY.md + 分类记忆 + TF-IDF 向量检索。

### 8.6 编译二进制方案

- `bun build --compile` 生成独立可执行文件（`dist/fengagent` / `fengagent.exe`）；
- 支持 CLI 模式 / serve 模式。

---

## 9. 分支隔离（与 main）

- **改动只落在 `refactor/cordis-graph-architecture`**，禁止直接修改 `main`；
- `main`（老分支）可随时独立 checkout、可编译、可运行、功能不回归：
  - 新增文件（`packages/cordis`、`packages/graph`、`packages/events`、`create-runtime-agent.ts`、
    graph-panel 等）与 `main` 零交集；
  - 既有文件的改动均为「向后兼容的增量」（`create-agent.ts` 保留旧接口并委托、
    `entry.ts` serve 分支替换为 runtime 装配、server 新增方法/路由、web-ui 新增面板）；
- **数据根隔离**：本分支用 `.fengagent-cordis/`，main 的 `.fengagent/` / `~/.fengagent/`
  一律只读（仅作导入源、配置分层回退、记忆只读回退）；
- **单向幂等导入**：首次运行（事件日志空 + sessions.db 不存在）把 main 遗留数据
  只读、一次性、幂等导入，写 `import.marker`；自环防护 + 绝不写回 main；
- **文档隔离**：`docs/ARCHITECTURE-CORDIS.md` / `docs/GUIDE-CORDIS.md` 描述新分支；
  在线文档站（`docs/index.html`）顶部注明当前展示分支。

---

## 10. 运行与验证

```bash
bun install                # 安装依赖
bun run typecheck          # TypeScript 类型检查
bun test                   # 全量测试（既有 600+ 全部通过）

bun test packages/graph    # 图机制测试（溯源/节点/回退/策略）
bun test packages/events   # 事件溯源测试（EventStore/投影/双写对账/导出导入/重建/迁移 e2e）
bun test packages/cordis   # Cordis 运行时集成测试（插件装载/loop/工具/回退/换插件换能力）
bun test packages/cli      # CLI 测试（含 RuntimeAgent 回退/重答/热切换）
bun test packages/server   # Server 测试（含图/回退端点）

bun run packages/cli/src/entry.ts            # CLI 交互模式（Ink TUI）
bun run serve                                # WebUI 模式（http://127.0.0.1:3000）
bun run scripts/events-migrate.ts verify     # 事件链校验 + 双写对账
```

完整小白操作步骤见 [GUIDE-CORDIS.md](./GUIDE-CORDIS.md)。

---

## 11. 设计决策记录（ADR）

### ADR-001: 选择 Cordis 作为元框架（插件化一等公民）

- **背景**：参考 deepseek-harness 架构，模型/工具/策略/存储/上下文/Loop 应可插拔；
- **决策**：引入 `@deepseek-ai/cordis`（vendored），业务全部以插件表达，挂到 `ctx.*` 服务；
- **收益**：换插件即换能力；适配器薄包裹既有实现，行为不回退。

### ADR-002: 从 Loop 到 Graph（对话即节点、可回退）

- **背景**：单 Agent 反复执行是 Loop；多节点以有向图组织、可编排、可治理、可回退是下一层形态；
- **决策**：新增 `packages/graph`，每轮「提问→回答」沉淀节点，`/rollback` 回退重答；
- **收益**：对话可溯源、回答不佳可回退，旧分支保留可审计。

### ADR-003: 事件溯源（Event Sourcing）作为会话事实源

- **背景**：长周期 Agent 任务需要可恢复、可迁移、可审计的会话状态；
- **决策**：新增 `packages/events`，事件日志为准 + SQLite 读模型 + 双写对账；
  导出/导入/重建/跨机迁移端到端；
- **收益**：崩溃自愈、跨数据根/跨机迁移、以事件为准重建不丢元数据。

### ADR-004: 分支数据隔离（.fengagent-cordis vs .fengagent）

- **背景**：新老分支同机运行不能互相干扰；
- **决策**：`resolveDataRoot` 全链路收口，新分支默认 `.fengagent-cordis/`，
  main 数据只读导入、绝不写回；
- **收益**：切回 main 删目录即还原，main 零改动。
