# 模块文档

## `@fengagent/core` — 核心类型定义

零运行时依赖的核心类型包，定义所有数据结构和接口契约。

### 源文件

| 文件 | 内容 |
|------|------|
| `types.ts` | `Message`、`Role`、`ContentBlock`（TextBlock / ToolUseBlock / ToolResultBlock） |
| `tool.ts` | `ToolDefinition` 接口、`ToolResult`、`ToolContext` |
| `agent.ts` | `AgentConfig`、`AgentInfo` |
| `session.ts` | `Session`、`SessionState`（idle / running / error） |
| `event.ts` | `AgentEvent` 联合类型（session-start / message-start / text-delta / tool-call-* / message-end / turn-end / error / compaction-* / session-end） |
| `config.ts` | `ConfigSchema`（Zod）、`Config` 类型、`loadConfig()` |
| `permission.ts` | `Permission`、`PermissionResult`（allow / deny / ask） |

### 核心接口

```typescript
// 消息类型
interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  createdAt: number;
}

// 会话
interface Session {
  id: string;
  title: string;
  messages: Message[];
  model: string;
  status: "idle" | "running" | "error";
  tokenCount: number;
  createdAt: number;
  updatedAt: number;
}

// 工具定义
interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  execute(input: I, context: ToolContext): Promise<ToolResult<O>>;
  isReadOnly?(input: I): boolean;
  isDestructive?(input: I): boolean;
  isConcurrencySafe?(input: I): boolean;
  checkPermissions?(input: I, context: ToolContext): PermissionResult;
}
```

---

## `@fengagent/shared` — 共享工具函数

| 函数 | 说明 |
|------|------|
| `generateId()` | 生成 UUID v4 |
| `safeJsonParse(str)` | 安全 JSON 解析（失败返回 null） |
| `deepMerge(target, source)` | 深度合并对象 |
| `getEnv(key, defaultValue?)` | 读取环境变量（带默认值） |
| `resolveDataRoot(opts?)` | 解析数据根。main：`FENG_DATA_DIR` > `<cwd>/.fengagent`（**不探测** refactor 的 `<cwd>/.fengagent-cordis`，两分支数据隔离）；refactor：`FENG_DATA_DIR` > 配置 `dataDir` > `<workdir>/.fengagent-cordis` |
| `resolveLogsDir(opts?)` | 解析日志目录 `<数据根>/logs`（写入方与读取方共用同一优先级，避免「写一处、读另一处」） |
| `resolveSessionStoreRoot(opts?)` | 解析会话仓根（Multica 守护进程指定 `MULTICA_DSH_SESSION_ROOT` 时以它为准，否则同数据根） |

| 常量 | 值 |
|------|-----|
| `DEFAULT_MODEL` | `claude-sonnet-4-20250514` |
| `DEFAULT_SMALL_MODEL` | `claude-haiku-3` |
| `MAX_TOKENS` | `8192` |
| `CONTEXT_WINDOW` | `200000` |

---

## `@fengagent/llm` — LLM 客户端抽象

Provider 无关的 LLM 调用抽象层，支持流式输出。

### 核心接口

```typescript
interface LLMClient {
  stream(request: LLMRequest): AsyncGenerator<LLMEvent>;
  generate(request: LLMRequest): Promise<LLMResponse>;
}

interface LLMRequest {
  model: string;
  system: string | ContentBlock[];
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}
```

### Provider 实现

| Provider | 文件 | 环境变量 |
|----------|------|----------|
| Anthropic | `providers/anthropic.ts` | `ANTHROPIC_API_KEY` |
| OpenAI | `providers/openai.ts` | `OPENAI_API_KEY` |
| OpenAI-Compatible | `providers/openai-compatible.ts` | `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` |
| Google | `providers/google.ts` | `GOOGLE_API_KEY` |
| Bedrock | `providers/bedrock.ts` | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_BEDROCK_REGION` |

### Provider 选择

通过 `FENG_PROVIDER` 环境变量选择，默认 `anthropic`。

---

## `@fengagent/tools` — 工具系统

工具注册、执行、权限管理、Hook 系统。

### 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| `ToolRegistry` | `registry.ts` | 工具注册/查询/过滤 |
| `ToolExecutor` | `executor.ts` | 并行/串行调度、超时控制 |
| `PermissionChecker` | `permission.ts` | 权限检查（auto/allow/deny/ask） |
| `HookRegistry` | `hooks.ts` | 生命周期 Hook（pre/post-tool-use, pre/post-compact） |
| `truncate` | `truncate.ts` | 输出截断（超长结果溢出到文件） |

### 内置工具

| 工具 | 文件 | 只读 | 权限 |
|------|------|------|------|
| `file-read` | `builtin/file-read.ts` | ✅ | allow |
| `file-write` | `builtin/file-write.ts` | ❌ | ask |
| `file-edit` | `builtin/file-edit.ts` | ❌ | ask |
| `bash` | `builtin/bash.ts` | ❌ | ask |
| `glob` | `builtin/glob.ts` | ✅ | allow |
| `grep` | `builtin/grep.ts` | ✅ | allow |
| `task` | `builtin/task.ts` | ❌ | ask |
| `memory-save` | `builtin/memory.ts` | ❌ | ask |
| `memory-search` | `builtin/memory.ts` | ✅ | allow |
| `skill` | `builtin/skill.ts` | ✅ | allow |

#### `bash` 工具的解释器（方言契约）

工具名叫 `bash` 是历史命名，**真正执行命令的解释器按平台解析**，且工具描述由同一份
解析结果生成，保证「名字 / 描述 / 实现」三方一致：

| 平台 | 解析顺序 | 参数 | 方言 |
|------|----------|------|------|
| Windows | `pwsh.exe`（PowerShell 7+）→ `powershell.exe`（Windows PowerShell 5.1）→ `ComSpec`（cmd.exe） | `-NoLogo -NoProfile -NonInteractive -Command` / `/c` | PowerShell 语法（原生 cmdlet + `ls`/`cat`/`pwd` 别名） |
| Linux / macOS | `$SHELL` → `/bin/sh` | `-c` | POSIX shell |

解析是**纯文件系统探测**（PATH + 常见安装位置），不起探针进程；`metadata.shell` 回带
实际解释器（`pwsh` / `powershell` / `cmd` / `sh`），工具卡片前缀也据此显示
（`powershell: Get-ChildItem -Name`）。

Windows PowerShell 5.1 不支持 `&&`，描述里显式提示改用 `;`。每次调用都是新 shell，
`cd` 与变量不跨调用保留。

### MCP 集成

`mcp/mcp-client.ts` — 连接 MCP Server（stdio / SSE），自动发现工具并注册。MCP 工具名前缀：`mcp__<server>__<tool>`。

---

## `@fengagent/context` — 上下文管理

| 组件 | 文件 | 职责 |
|------|------|------|
| `ContextManager` | `manager.ts` | 上下文组装（系统提示 + 历史）、压缩触发 |
| `CompactionEngine` | `compaction.ts` | 摘要 head 段 + 保留 recent 段 |
| `TokenCounter` | `token-counter.ts` | Token 估算（chars / 4 启发式） |
| `SystemContextLoader` | `system-context.ts` | 加载 AGENTS.md、日期、MEMORY.md |
| `MemoryManager` | `memory.ts` | MEMORY.md 加载/注入 + `.fengagent/memory/` 目录 |
| `VectorMemory` | `vector-memory.ts` | 向量化存储 + 检索 |

### 压缩策略

当对话历史 Token 数超过 `contextWindow * compactThreshold` 时触发：
1. 选择分割点（head 段 + recent 段）
2. 用 smallModel 摘要 head 段
3. 替换为摘要消息 + recent 段

---

## `@fengagent/agent` — Agent 运行时

| 组件 | 文件 | 职责 |
|------|------|------|
| `AgentLoop` | `loop.ts` | 核心循环（上下文组装 → LLM → 工具 → 循环判断） |
| `Agent` | `agent.ts` | Agent 类：状态管理、事件发射、会话生命周期 |
| `SessionStore` | `session.ts` | SQLite 会话持久化（`bun:sqlite`） |
| `AgentDefinition` | `agent-definition.ts` | 从 `.fengagent/agents/*.md` 加载 Agent 定义 |
| `PluginLoader` | `plugin-loader.ts` | 从 `.fengagent/plugins/` 加载插件 |

### Agent Loop 流程

```
while (needsContinuation && step < maxTurns) {
  1. 组装上下文（系统提示 + 历史）
  2. 检查并执行压缩
  3. 准备工具列表
  4. 调用 LLM（stream）
  5. 解析工具调用
  6. 执行工具（权限检查 → 执行 → 截断）
  7. 注入工具结果到历史
  8. needsContinuation = 有工具调用 ? true : false
}
```

### 内置 Agent 定义

| Agent | 描述 | 工具 |
|-------|------|------|
| `default` | 通用 Agent | 全部工具 |
| `coder` | 代码编写 | file-read/write/edit + bash |
| `researcher` | 研究 | file-read + glob + grep |

---

## `@fengagent/cli` — CLI 终端交互

| 组件 | 文件 | 职责 |
|------|------|------|
| 入口 | `entry.ts` | 参数解析、模式路由（TUI / print / serve / acp / runtime） |
| ACP 模式 | `acp-mode.ts` | `startAcpMode()`：ACP 模式装配（配置/凭据/工具/上下文/Agent 工厂 + 传输选择），支持注入内存流做端到端测试 |
| TUI App | `tui/app.tsx` | Ink 主应用 |
| Chat View | `tui/chat-view.tsx` | 对话视图（Markdown + 代码高亮） |
| Tool View | `tui/tool-view.tsx` | 工具调用卡片 |
| Input | `tui/input.tsx` | 多行输入框 |
| Status Bar | `tui/status-bar.tsx` | 状态栏（模型、Token、压缩状态） |

### CLI 命令

| 命令 | 说明 |
|------|------|
| `/session` | 管理会话（新建、切换、列出） |
| `/model` | 切换当前模型 |
| `/export` | 导出当前会话 |
| `/clear` | 清屏 |
| `/help` | 帮助菜单 |

---

## `@fengagent/server` — HTTP API 服务

| 组件 | 文件 | 职责 |
|------|------|------|
| Server | `server.ts` | Hono 应用创建、端口监听、静态文件 |
| Session Routes | `routes/sessions.ts` | 会话 CRUD + 消息 SSE + 权限 |
| Model Routes | `routes/models.ts` | 模型列表 |
| Observability Routes | `routes/observability.ts` | 观测面板数据源：trace 日志清单 / 日期分析（AnalysisResult）/ 调用链重建（四层树；per-message 过滤 + focus 解析；旧日志文本回退） |
| Eval Routes | `routes/eval.ts` | 评测页数据：概览清单 / 报告与自优化建议（含 `POST /reports` 一键生成）/ 测试集 / 单条消息评测（trace 指标 + `judge`） |
| SSE | `sse.ts` | AgentEvent → SSE 帧转换 |
| SessionManager | `session-manager.ts` | Agent 实例池、权限桥接 |
| ACP（HTTP） | `acp-server.ts` | 旧 HTTP + SSE 传输的 ACP 兼容层（`fengagent acp --acp-http`） |
| ACP（stdio） | `acp-stdio.ts` | **Multica 守护进程面向的传输**：stdin/stdout 上的 ACP JSON-RPC（`initialize` / `authenticate` / `session/new` / `session/prompt` / `session/cancel`），stdout 专用于协议帧，并提供 `redirectConsoleToStderr()` 把日志改道 stderr |

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/sessions` | 创建会话 |
| GET | `/api/sessions` | 列出会话 |
| GET | `/api/sessions/:id` | 获取会话详情 |
| POST | `/api/sessions/:id/messages` | 发送消息（先订阅后启动 run，返回 SSE 流；已有运行中任务 → 409 JSON） |
| GET | `/api/sessions/:id/events` | 订阅会话事件（SSE：回放缓冲 + 实时转发 + 心跳；重连 / 多客户端附加） |
| POST | `/api/sessions/:id/interrupt` | 中断当前运行 |
| POST | `/api/sessions/:id/permissions/:reqId` | 权限响应（allow 可携带修改后的工具入参 — human-in-the-loop 改参） |
| GET | `/api/sessions/:id/permissions` | 获取待处理权限请求 |
| GET | `/api/sessions/:id/export` | 导出会话 |
| DELETE | `/api/sessions/:id` | 销毁会话 |
| GET | `/api/observability/traces` | 列出 trace 日志文件（日期 / 规模 / 会话数） |
| GET | `/api/observability/traces/:date` | 指定日期的分析结果（指标聚合） |
| GET | `/api/observability/traces/:date/callchain` | 完整调用链（会话 → 消息 → LLM 调用 → 工具调用）；带 `sessionId` + `messageId` 时过滤到该轮并返回 `focus` 解析结果 |
| GET | `/api/observability/traces/:date/messages` | 指定会话的按消息粒度摘要（deep-link 消息选择器；会话信息不全时按 trace 补齐） |
| GET | `/api/eval/overview` | 评测清单三合一（报告 / 自优化建议 / 测试集） |
| POST | `/api/eval/reports` | 生成评测报告（等价再跑一次 `bun run eval`；body `{ date?, optimize? }`） |
| GET | `/api/eval/reports/:date` | 读取 `eval-report-{date}.md` |
| GET | `/api/eval/optimizations/:date` | 读取 `optimization-{date}.md` |
| GET | `/api/eval/testsets/:name` | 读取测试集 JSON |
| GET | `/api/eval/messages/:date` | 单条消息评测：trace 指标摘要 + `judge`（`sessionId` + `messageId`；默认异步 + 落盘缓存，见 EVALUATION.md） |
| GET | `/api/models` | 获取可用模型列表 |

---

## `@fengagent/web-ui` — Web 前端

| 组件 | 文件 | 职责 |
|------|------|------|
| App | `app.tsx` | 应用入口、主题切换、顶栏导航（对话 / 观测 / 评测三页切换）+ deep-link URL 解析（`?view=&sessionId=&messageId=`） |
| Chat Page | `pages/chat.tsx` | 聊天页面、模型选择、Inspector 面板 |
| Observability Page | `pages/observability.tsx` | 观测页：日期切换、汇总指标卡、调用链树、图表与模型对比表 |
| Eval Page | `pages/eval.tsx` | 评测页：测试集清单 / 报告与建议浏览导出 / 一键生成报告（+ 自优化）/ 单条消息评测 |
| Trace Tree | `components/trace-tree.tsx` | 四层调用链树（会话 → 消息 → LLM 调用 → 工具调用），节点展开 / 折叠 |
| Metric Charts | `components/metric-charts.tsx` | 观测图表（模型耗时 / token 对比、工具使用分布、完成原因）+ 模型对比表 |
| Message Picker | `components/message-picker.tsx` | 会话消息选择器（deep-link 后按消息定位调用链 / 评测结果） |
| Message List | `components/message-list.tsx` | 消息列表（Markdown 渲染、流式指示器） |
| Message Input | `components/message-input.tsx` | 多行输入框 |
| Tool Call Card | `components/tool-call-card.tsx` | 工具调用卡片（展开/折叠） |
| Markdown Renderer | `components/markdown-renderer.tsx` | Markdown + 代码高亮 |
| Model Selector | `components/model-selector.tsx` | 模型下拉选择 |
| Session Sidebar | `components/session-sidebar.tsx` | 会话列表侧边栏 |

### Hooks

| Hook | 文件 | 职责 |
|------|------|------|
| `useSession` | `hooks/use-session.ts` | 会话 CRUD + 消息状态管理 |
| `useSse` | `hooks/use-sse.ts` | SSE 事件流消费 |
| `useModels` | `hooks/use-models.ts` | 模型列表加载 |

### API 客户端

`api/client.ts` — `ApiClient` 类封装所有 HTTP 交互（fetch + ReadableStream 手动解析 SSE），
含观测（`listTraces` / `getTraceAnalysis` / `getCallChains` / `getCallChainForMessage` / `getMessageTraces`）与
评测（`getEvalOverview` / `generateEvalReport` / `getEvalReport` / `getOptimizationReport` / `getTestSet` / `getMessageEval`）方法。

### 构建

- Vite 6+ 构建配置
- Dev 模式：Vite proxy 转发 `/api` 到后端 server
- Prod 模式：构建产物由 server 静态托管

---

## `@fengagent/eval` — Agent 测评模块

读取 LLM Trace 日志（`<数据根>/logs/llm-trace-{date}.jsonl`）自动分析：

| 指标 | 说明 |
|------|------|
| 工具调用成功率 / 任务完成率 / 错误率 | 模型工具选择质量 |
| Token 用量（输入/输出） | 成本分析 |
| KV Cache 命中率 | 缓存复用效率（读取/创建 token） |
| 模型对比表 | 不同模型/提示词版本横向对比 |

### 源文件

| 文件 | 职责 |
|------|------|
| `analyzer.ts` | trace 解析 + 指标聚合（`AnalysisResult`；含 `JudgeResult` 类型） |
| `reporter.ts` | Markdown 评测报告生成（`eval-report-{生成日}.md`，8–9 块） |
| `self-optimize.ts` | 规则 + judge 诊断（`diagnose` / `DEFAULT_THRESHOLDS`），建议落盘 `optimizations/optimization-{日志日期}.md` |
| `testset.ts` | 测试集加载（`<数据根>/testsets/*.json`，AgentBench / DeepEval 风格宽容解析） |
| `judge.ts` | LLM-judge（`judgeMessage()` 单条消息评判：完成度 / 正确性 / 结论 note） |
| `index.ts` | 包导出 + `runEval()` 编排（CLI 入口） |

命令：`bun run eval`（`--date` / `--all` / `--file` / `--exclude-model` / `--optimize` / `--judge`，详见 [CONFIGURATION.md](./CONFIGURATION.md) 与 [EVALUATION.md](./EVALUATION.md)）。
