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
| 入口 | `entry.ts` | 参数解析、模式路由（TUI / print / serve） |
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
| SSE | `sse.ts` | AgentEvent → SSE 帧转换 |
| SessionManager | `session-manager.ts` | Agent 实例池、权限桥接 |

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/sessions` | 创建会话 |
| GET | `/api/sessions` | 列出会话 |
| GET | `/api/sessions/:id` | 获取会话详情 |
| POST | `/api/sessions/:id/messages` | 发送消息（返回 SSE 流） |
| POST | `/api/sessions/:id/interrupt` | 中断当前运行 |
| POST | `/api/sessions/:id/permissions/:reqId` | 权限响应 |
| GET | `/api/sessions/:id/permissions` | 获取待处理权限请求 |
| GET | `/api/sessions/:id/export` | 导出会话 |
| DELETE | `/api/sessions/:id` | 销毁会话 |
| GET | `/api/models` | 获取可用模型列表 |

---

## `@fengagent/web-ui` — Web 前端

| 组件 | 文件 | 职责 |
|------|------|------|
| App | `app.tsx` | 应用入口、主题切换、SessionSidebar + ChatPage |
| Chat Page | `pages/chat.tsx` | 聊天页面、模型选择、Inspector 面板 |
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

`api/client.ts` — `ApiClient` 类封装所有 HTTP 交互（fetch + ReadableStream 手动解析 SSE）。

### 构建

- Vite 6+ 构建配置
- Dev 模式：Vite proxy 转发 `/api` 到后端 server
- Prod 模式：构建产物由 server 静态托管
