# AGE-31 分支解读：模块解读与端到端参与（Part 1）

> 本文件回答 issue AGE-31 的第一部分：详细解读项目代码，介绍各个模块作用、如何使用、以及在端到端过程中怎么参与。
> 覆盖 `main` 与 `refactor/cordis-graph-architecture` 两个分支。配套文件 `AGE-31-架构对比.md` 为第二部分（架构选型对比）。

---

## 0. 项目总览

FengAgentCli 是一个基于 Bun + TypeScript 的开源本地 AI Agent CLI 工具：支持对话、工具调用、多 Agent（squad/子 Agent）、MCP、WebUI 与测评（eval）。仓库为 monorepo（`package.json` workspaces `packages/*`），入口 `bin/fengagent`。

两个分支的公共基础（分叉点 `7f28d02`）完全相同，之后各自演进：

| 分支 | 定位 | 最新状态 |
|---|---|---|
| `main` | 稳定主分支（老架构） | 6da1fef（文档站/手册增量） |
| `refactor/cordis-graph-architecture` | Cordis 插件化 + 对话图/事件溯源重构（新架构） | fc4d2e1（Phase 1–4 已落地） |

---

## 1. main 分支模块解读

### 1.1 包结构与职责（10 个包）

```
packages/
├── core/     — 领域层：零依赖类型契约（仅 Zod）
├── shared/   — 共享工具函数/常量/日志
├── llm/      — Provider 无关的 LLM 客户端抽象
├── tools/    — 工具注册/执行/权限/MCP
├── context/  — 上下文组装/压缩/记忆
├── agent/    — Agent 类 + AgentLoop 主循环 + 会话存储 + 子 Agent + Squad
├── cli/      — CLI 入口（Ink TUI / print / serve 三模式）+ 工厂装配
├── server/   — HTTP/SSE 服务 + SessionManager + ACP 服务
├── web-ui/   — React Web 前端
└── eval/     — 测评（analyzer/reporter）
```

### 1.2 各模块详解

#### `@fengagent/core` — 核心类型与契约（地基）
- 零运行时依赖（仅 Zod），所有类型 JSON 可序列化，定义全项目共享的契约：
  - `types.ts`：`Message`、`Role`、`ContentBlock`（Text/ToolUse/ToolResult/Thinking/Image）等基础类型；
  - `tool.ts`：`ToolDefinition`（含 `checkPermissions`/`isReadOnly`/`isDestructive` 等权限描述）；
  - `agent.ts` / `session.ts` / `event.ts`：`AgentConfig`、`Session`、`AgentEvent` 联合类型（session-start / text-delta / tool-call-* / compaction-* / turn-end 等）；
  - `config.ts`：`ConfigSchema`（Zod 校验）+ `loadConfig()` 分层配置加载；
  - `permission.ts`：`PermissionResult`（allow / deny / ask）。
- **如何被使用**：所有上层包 import 这些类型作为公共语言；config 驱动启动参数；AgentEvent 是 CLI/Server 流式输出的统一事件格式。

#### `@fengagent/shared` — 共享工具层
- `generateId`（UUID v4）、`deepMerge`、`safeJsonParse`、`getEnv`、`createLogger`、`session-log`、常量（`DEFAULT_MODEL`、`CONTEXT_WINDOW` 等）。
- **如何被使用**：被几乎所有包 import，无状态纯函数。

#### `@fengagent/llm` — LLM 抽象层
- `LLMClient` 接口：`stream()`（AsyncGenerator，流式）/ `generate()`（一次性）。
- Provider 实现：`anthropic.ts`、`openai.ts`、`openai-compatible.ts`、`google.ts`、`bedrock.ts`；`env.ts` 提供 `createClientFromEnv`（按 `FENG_PROVIDER`/`FENG_MODEL`/各类 `*_API_KEY` 环境变量选型）。
- `ReloadableLLMClient`：可热替换底层 client（`/provider`、`/model` 命令切换时 `setClient` 立即生效）。
- `route.ts`（路由）、`stream.ts`（流式协议转换）、`trace.ts`（LLM trace 日志）、`reloadable.ts`。
- **端到端参与**：AgentLoop 每轮通过它调用 LLM；切换 Provider/Model 只改这里，上层无感。

#### `@fengagent/tools` — 工具系统
- `registry.ts`：`ToolRegistry`（注册/查询/`materialize()` 物化为 LLM 可见的 tools 列表）；
- `executor.ts`：`ToolExecutor`（执行 + 权限回调）；
- `permission.ts` / `permission-config.ts`：权限检查器（allow / deny / ask 三态，支持自动放行白名单）；
- `hooks.ts`：`HookRegistry`（pre/post-tool-use、pre/post-compact 钩子）；
- `builtin/`：内置工具 — bash、file-read / file-write / file-edit、glob、grep、memory、skill、task（子 Agent 派遣）；
- `mcp/`：`McpClient` + `mcp-config` + `mcp-adapter`（把 MCP Server 工具适配为 `ToolDefinition` 注册进 registry）。
- **端到端参与**：AgentLoop 把 registry 物化的工具传给 LLM，LLM 返回 tool-call 后由 executor 执行并回填结果。

#### `@fengagent/context` — 上下文管理
- `manager.ts`：`ContextManager.assemble(session)`（系统提示 + 历史组装）、`shouldCompact()`（token 阈值判断）、`compact()`（摘要替换 head 段、保留 recent 段）；
- `system-context.ts`、`memory.ts` / `vector-memory.ts`（记忆）、`token-counter.ts`、`compaction.ts`。
- **端到端参与**：AgentLoop 每轮第一步调用；超过窗口阈值时自动压缩，防止上下文爆炸。

#### `@fengagent/agent` — Agent 核心层
- `loop.ts`：`AgentLoop` 主循环（详见 1.3）；
- `agent.ts`：`Agent` 类（`prompt` / `resume` / `loadSession` / `listSessions` 等公开接口）；
- `session.ts`：`SessionStore`（SQLite 持久化，`.fengagent/sessions.db`）；
- `squad.ts`：多 Agent 编排（Squad 模式）；
- `subagent-runner.ts`：子 Agent 派遣器（`task` 工具用）；
- `agent-definition.ts` + `plugin-loader.ts` / `plugin-registry.ts`：从 `.fengagent/agents/` 加载 agent 定义（声明式 Agent 配置）；
- `streaming.ts`：LLM 事件 → AgentEvent 转换。
- **端到端参与**：CLI/Server 创建 Agent 后调 `prompt()`，内部即 AgentLoop 驱动整个对话回合。

#### `@fengagent/cli` — 入口与交互
- `entry.ts`：参数解析 + 模式路由（`--help`/`--version` → 直接输出；`serve` → WebUI 服务；stdin 非 TTY 或 `--print` → print 非交互模式；默认 → Ink TUI）；
- `tui/`：Ink React 组件 — `app.tsx`（布局）、`chat-view.tsx`（流式渲染）、`input.tsx`（输入/方向键补全）、`spinner.tsx`、`status-bar.tsx`、`thinking-pet.tsx`、`tool-view.tsx`、`permission-dialog.tsx`（权限弹窗）、`theme.ts`、`win-console.ts`（Windows UTF-8 控制台修复）；
- `commands.ts`：斜杠命令 — `/help` `/exit` `/quit` `/clear` `/com`（补全）/`/compact` `/export` `/restore` `/session new|list|switch` `/tool list` `/model <id>|list` `/provider show|set ...`；
- `create-agent.ts`：**装配工厂**——把 config、LLM client、工具 registry/executor/权限、hook、MCP、context manager、session store、子 Agent 派遣器全部组装成一个 `Agent` 实例；
- `print-mode.ts`：非交互模式（管道/CI 用）；`args.ts`：参数解析；`binary-entry.ts`：二进制打包入口。
- **端到端参与**：用户启动进程的入口；TUI 渲染流式回复；`/model`、`/provider` 经 `ReloadableLLMClient` 热切换。

#### `@fengagent/server` — HTTP 服务（serve 模式）
- `server.ts`：HTTP 服务器；`sse.ts`：SSE 流式推送；`session-manager.ts`：内存 Agent 实例池（sessionId → Agent），管理创建/销毁/发消息/中断，并把权限请求经 SSE 推送、HTTP 响应回填（权限审批桥接）；`acp-server.ts`：ACP 协议服务；`routes/`：health / models / sessions。
- **端到端参与**：`serve` 子命令启动后，WebUI 通过 REST + SSE 与 CLI 同一套 Agent 能力对话。

#### `@fengagent/web-ui` — Web 前端
- React 聊天界面（`pages/chat.tsx`、`api/client.ts`、`hooks/use-session.ts`），消费 server 的 REST/SSE 接口。

#### `@fengagent/eval` — 测评
- `analyzer.ts` / `reporter.ts`：离线跑对话并分析质量、输出报告（`--eval` 用途）。

### 1.3 main 端到端流程（一次对话怎么跑）

```
用户输入
  → cli/entry.ts（模式路由：TUI / print / serve）
  → cli/create-agent.ts 装配：loadConfig → buildEnvForLLM 注入环境变量
      → llm.createClientFromEnv（按 FENG_PROVIDER 选 Provider）
      → tools.createToolRegistry + registerBuiltinTools + registerMcpTools
      → tools.createToolExecutor + createPermissionChecker + createHookRegistry
      → context.createContextManager
      → agent.SessionStore（SQLite 落盘）
      → agent.createSubagentRunner / createAgentDefinitionLoader
      → Agent 实例
  → Agent.prompt() → AgentLoop.run(session)
      循环：① contextManager.assemble 组装上下文
           ② shouldCompact ? compact（摘要替换历史头段）
           ③ toolRegistry.materialize() 物化工具列表
           ④ llmClient.stream（流式，text-delta / thinking / tool-call 累积）
           ⑤ 有 tool-call → toolExecutor.execute（先 permissionChecker 判定 allow/deny/ask）
           ⑥ 结果回填历史 → 判断是否继续（无工具调用 / maxTurns / error 退出）
  → streaming 转换为 AgentEvent 流 → TUI 实时渲染 / print 输出 / SSE 推送 WebUI
  → SessionStore 持久化会话；session-log + llm-trace 落日志
```

数据根：`<workdir>/.fengagent/`（sessions.db、logs/、memory/、agents/、skills/）。

---

## 2. refactor/cordis-graph-architecture 分支模块解读

### 2.1 新增包（13 个包 = 原 10 个 + 3 个）

```
packages/
├── cordis/   — Cordis 集成层：插件域类型 + 服务适配器 + 配置驱动运行时（vendor @deepseek-ai/cordis 等）
├── events/   — 事件溯源：EventStore / 双写 / 投影 / 重建 / 对账 / 导入导出
└── graph/    — 对话图：对话即节点 / 可溯源 / 可回退（零运行时依赖）
```

其余 10 个包与 main 同名，但内部装配方式改为 Cordis 插件化（见下）。

### 2.2 新架构核心概念

#### `@fengagent/cordis` — 插件化运行时
- 内置（vendored）`@deepseek-ai/cordis` + `cosmokit` + `standard-schema-spec`（离线可用，tsconfig `paths` 指向 vendor，网络可用后可切回 npm 依赖）；
- `runtime.ts`：`createRuntime(config)` — 创建 Cordis 根 Context，按配置逐条装载插件（`ctx.plugin(plugin)`，`start()` 后按依赖就绪、`stop()` 逆序卸载）；
- `adapters/`：薄适配既有实现为 Cordis 插件：
  - `feng.model`（模型，包 `@fengagent/llm`，支持 `ctx.model.switchProvider` 热切换）
  - `feng.tools`（工具，包 `@fengagent/tools`）
  - `feng.strategy`（压缩/回退策略）
  - `feng.storage`（会话存储 + 图存储，包 `@fengagent/agent` SessionStore + MemoryGraphStore）
  - `feng.context`（上下文，包 `@fengagent/context`）
  - `feng.loop`（AgentLoop 本身作为插件，`inject: ["model","tools","context","strategy","graph"]` 声明依赖，依赖就绪才启动）
  - `feng.graph`（对话图）、`feng.events`（事件日志）、`feng.rebuild`（重建服务）
- 插件即积木：换插件即换能力；插件顺序无关（声明式注入装配）；用户插件可用「模块路径」加载（Phase 5 规划 cordis.yml profile）。

#### `@fengagent/events` — 事件溯源
- `event-store.ts`：每会话单文件 append-only JSONL（`<数据根>/events/{sessionId}.jsonl`），seq 单调递增 + hash/prevHash 链校验（`hash.ts`），运行时注册表校验事件类型（`registry.ts`），崩溃尾部半行自愈；
- `dual-write.ts`：`DualWriteSessionStore` 包装旧 SQLite 存储 — 同一会话事实既写旧存储、也以事件追加（session/created、user/message、step/start、assistant/chunk、turn/end 等，按 messageId 幂等）；
- `projection.ts`：事件日志 → 读模型（Session）投影；`graph-projection.ts`：图投影派生视图；
- `reconcile.ts`：对账（投影 === SQLite，双写一致性校验）；
- `rebuild.ts`：以事件为准全量重建读模型（rebuildSession/rebuildAll，prune 孤儿）；
- `migration.ts` + `scripts/events-migrate.ts`：可移植事件文件导出/导入（幂等去重）、跨数据根/跨机迁移端到端。

#### `@fengagent/graph` — 对话图
- `types.ts`：`ConversationNode` — id、conversationId、type（user/assistant/tool/branch-point）、messageId、parentId、childrenIds、meta（model / toolCalls / tokenCount / llmTraceId / quality / branch / active / rolledBack）；
- `store.ts`：`MemoryGraphStore` — appendNode / getChain（溯源链）/ getActivePath（活跃分支）/ markQuality / rollbackTo（回退 → 目标下长 branch-point，旧分支作废保留），可选 JSONL 落盘（`graph.jsonl`）；
- `rollback.ts`：`RollbackStrategy` 接口（shouldRollback / chooseTarget），默认策略：用户显式负反馈 / 工具错误率超阈值 / 质量分过低 → 回退到父节点重答。

### 2.3 改动的既有模块（如何接入新架构）

- `cli/create-agent.ts`：保留旧接口（`createAgent` / `reloadProvider` / `buildEnvForLLM`），实现委托给 `createRuntimeAgent`（`packages/server/src/create-runtime-agent.ts`，CLI 与 server 共用同一装配）；
- `cli/entry.ts`：`serve` 子命令改为共享 runtime + 每会话 RuntimeAgent；静态资源/端口行为不变；
- `cli/commands.ts`：新增 `/graph`（节点/活跃路径/溯源链展示）与 `/rollback [节点id]`（回退到父节点自动重答）；
- `server/session-manager.ts`：新增 `getGraph` / `rollbackSession` / `getAgent`（`GraphAgentLike` 扩展面）；
- `server/routes/sessions.ts`：新增 `GET /:id/graph`、`POST /:id/rollback`；
- `web-ui`：`api/client.ts`（getGraph / rollbackSession）、`use-session.ts`（graph 状态）、`components/graph-panel.tsx`（节点树 + 活跃高亮 + 回退按钮 + 作废分支灰显保留）；
- `shared/data-root.ts`：`resolveDataRoot()` — 新数据根 `<workdir>/.fengagent-cordis/`（sessions.db、graph.jsonl、events/、logs/、memory/、config.json），与 main 的 `.fengagent/` 完全隔离（main 数据只读，作导入源/配置回退/agents-skills 共享只读定义）；`shared/main-data-import.ts`：main 数据导入。

### 2.4 refactor 端到端流程

```
用户输入（CLI TUI / print / serve）
  → cli/entry.ts → createRuntimeAgent（createRuntime 装配 feng.* 插件，与 serve 共用）
  → RuntimeAgent（继承 Agent 接口，prompt 经 ctx.loop 驱动）
      → ctx.loop（AgentLoop 原样驱动，行为与 main 一致）
      → 每轮对话：assemble → compact → LLM stream（ctx.model）
          → tool-call → ctx.tools 执行（权限检查不变）
          → 回合收尾落事件（ctx.events 双写：SQLite + 事件日志）
          → 对话沉淀为图节点（ctx.graph appendNode，含 model/工具/token 溯源 meta）
  → /graph 查看节点/溯源链；/rollback 回退 → 长新分支（旧分支作废保留）
  → WebUI：SSE 流式对话（含 graph-node 事件）+ graph-panel 可视化 + 一键回退
  → 持久化：sessions.db + graph.jsonl + events/{sessionId}.jsonl 三写
```

---

## 3. 两个分支共用/保留的能力（回归基线）

CLI/WebUI 对话、记忆、上下文压缩、skill 对话、`/联想`、`/model`、`/provider`、`/export`、`/restore`、`/session`、测评（eval）、kvCache、MCP、权限审批、子 Agent/Squad —— 新分支全部保留且行为一致（薄适配不重写，测试 600+ 全绿）。

## 4. 如何运行验证

```bash
# main
bun install && bun run typecheck && bun test
bun run dev            # CLI TUI（或 bun run dev:web-ui / bun run serve）

# refactor/cordis-graph-architecture
bun run typecheck && bun test                    # 全量（既有 600+ + 新包测试）
bun test packages/graph packages/events packages/cordis packages/cli packages/server
bun run scripts/events-migrate.ts list|verify|export|import|rebuild   # 事件溯源 CLI
```
