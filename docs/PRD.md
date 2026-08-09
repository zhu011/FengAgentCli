# FengAgentCli 产品需求文档（PRD）

> 版本：1.0  
> 日期：2026-08-09  
> 状态：草案

---

## 目录

1. [项目定位与目标用户](#1-项目定位与目标用户)
2. [核心功能列表及优先级](#2-核心功能列表及优先级)
3. [技术选型及理由](#3-技术选型及理由)
4. [模块划分](#4-模块划分)
5. [各模块间接口定义](#5-各模块间接口定义)
6. [环境变量设计](#6-环境变量设计)
7. [里程碑计划](#7-里程碑计划)
8. [后续开发阶段拆分建议](#8-后续开发阶段拆分建议)

---

## 1. 项目定位与目标用户

### 1.1 项目定位

FengAgentCli 是一个**开源的本地 AI Agent CLI 工具**，具备主流 Agent 能力（对话、工具调用、上下文管理、记忆、多 Agent 协作），同时提供本地 WebUI 进行网页对话。项目使用 TypeScript 编写，以 Bun 作为运行时和构建工具，可编译为独立可执行文件（`.cli`）。

**核心设计理念：**

- **集百家之长**：借鉴 opencode（Effect 架构、Route/Protocol LLM 抽象）、Hummingbird（cc-bridge + WebUI 模式、bun 编译）、pi（40+ 模型提供商、扩展系统）、codex（多 Agent 层级、权限沙箱）、hermes-agent（自注册工具、Mixture-of-Agents）、openclaw（事件流 Agent Loop、ACP 协议）等优秀项目的设计
- **模块化优先**：每个核心能力独立成包，支持按需组合
- **开发者友好**：完善的文档、清晰的扩展点、环境变量驱动配置
- **可被 Multica 管理**：原生支持 Multica 平台的 Agent 管理协议

### 1.2 目标用户

| 用户类型 | 使用场景 |
|---------|---------|
| 个人开发者 | 本地 CLI 对话编码、文件操作、代码搜索 |
| 开发团队 | 多 Agent 协作处理复杂开发任务 |
| Agent 研究者 | 扩展 Agent 能力、实验新工具和新模型 |
| Multica 平台用户 | 通过 Multica 分配任务、管理 Agent 开发流程 |

### 1.3 与参考项目的差异化

| 能力 | opencode | Hummingbird | pi | codex | **FengAgentCli** |
|------|----------|-------------|----|-------|-----------------|
| 语言 | TS/Bun | TS/Bun | TS/Node | Rust | **TS/Bun** |
| WebUI | ✅ SolidJS | ✅ React | ❌ | ❌ | **✅ React** |
| 编译二进制 | ❌ | ✅ bun build | ✅ | ✅ | **✅ bun build** |
| 多模型支持 | ✅ 10+ | ✅ 4通道 | ✅ 40+ | ✅ 2 | **✅ 10+** |
| 多Agent | ✅ task工具 | ❌ | ❌ | ✅ | **✅** |
| 上下文压缩 | ✅ 锚定摘要 | ✅ 多级管线 | ✅ | ✅ | **✅** |
| 扩展系统 | ✅ 插件 | ❌ | ✅ jiti | ✅ 插件 | **✅ 插件** |
| 权限系统 | ✅ | ✅ Hook | ❌ | ✅ 沙箱 | **✅** |
| Multica 兼容 | ❌ | ❌ | ❌ | ❌ | **✅ 原生** |

---

## 2. 核心功能列表及优先级

### 2.1 功能优先级矩阵

#### P0 — 必须有（MVP 核心）

| 编号 | 功能 | 描述 |
|------|------|------|
| F-01 | Agent Loop | 多轮对话循环：用户输入 → LLM 调用 → 工具执行 → 响应输出 |
| F-02 | 流式输出 | LLM 响应实时流式输出（SSE / WebSocket） |
| F-03 | 工具系统 | 内置工具：文件读写、Bash 执行、Glob/Grep 搜索 |
| F-04 | 模型集成 | 支持 OpenAI / Anthropic / OpenAI-Compatible 多模型 |
| F-05 | CLI 交互 | 终端交互式对话（Ink/React TUI） |
| F-06 | 配置系统 | 环境变量 + JSON 配置文件分层合并 |
| F-07 | 上下文压缩 | 接近 Token 上限时自动摘要压缩对话历史 |
| F-08 | 会话管理 | 会话持久化、恢复、导出 |

#### P1 — 应该有（核心增强）

| 编号 | 功能 | 描述 |
|------|------|------|
| F-09 | WebUI 本地服务 | 本地启动 HTTP 服务 + React 前端网页对话 |
| F-10 | 编译二进制 | `bun build --compile` 生成独立可执行文件 |
| F-11 | 权限系统 | 工具执行前的权限审批（允许/拒绝/询问） |
| F-12 | MCP 支持 | Model Context Protocol 客户端集成 |
| F-13 | 记忆系统 | 基于 MEMORY.md 的本地记忆 + 向量检索 |
| F-14 | 多 Agent | 子 Agent 派遣（Task 工具），支持前台/后台模式 |

#### P2 — 可以有（高级能力）

| 编号 | 功能 | 描述 |
|------|------|------|
| F-15 | 插件系统 | 第三方插件加载、注册工具/模型/Hook |
| F-16 | Skills 系统 | 可复用 Prompt 模板 + 脚本能力包 |
| F-17 | Todo 系统 | 持久化任务跟踪，模型可创建/更新 |
| F-18 | 快照系统 | 文件变更快照、Diff、回滚 |
| F-19 | 模型回退 | 主模型失败时自动切换备选模型 |
| F-20 | 语音模式 | 语音输入/输出（Web Speech API） |

#### P3 — 未来考虑

| 编号 | 功能 | 描述 |
|------|------|------|
| F-21 | 桌面应用 | Electron 桌面端封装 |
| F-22 | 团队协作 | 多用户共享会话、协作编辑 |
| F-23 | Agent 市场 | 社区共享 Agent 定义和工具插件 |
| F-24 | 评测系统 | Agent 质量评测框架 |

---

## 3. 技术选型及理由

### 3.1 技术栈总览

| 层级 | 技术 | 版本 | 选型理由 |
|------|------|------|---------|
| **语言** | TypeScript | 5.8+ | 类型安全、生态丰富、团队要求 |
| **运行时** | Bun | 1.3+ | 原生 TS 支持、极速安装、内置构建/测试、可编译二进制 |
| **包管理** | Bun Workspaces | - | Monorepo 原生支持，无需额外工具 |
| **前端框架** | React | 19+ | 生态成熟、组件丰富、团队熟悉 |
| **前端构建** | Vite | 6+ | 极速 HMR、轻量配置、与 Bun 兼容 |
| **TUI 框架** | Ink | 6+ | React for CLI，与前端共享组件逻辑 |
| **HTTP 服务** | Hono | 4+ | 轻量、极速、TypeScript 原生、中间件生态 |
| **校验** | Zod | 4+ | Schema 校验 + 类型推导一体化 |
| **数据库** | SQLite (bun:sqlite) | - | Bun 内置、零配置、本地持久化 |
| **MCP SDK** | @modelcontextprotocol/sdk | 1.29+ | 标准 Agent 互操作协议 |
| **Markdown 渲染** | marked + shiki | - | 语法高亮、代码块渲染 |
| **测试** | Bun test | - | 内置测试运行器，零配置 |

### 3.2 关键技术决策

#### 为什么选 Bun 而非 Node.js？

1. **编译二进制**：`bun build --compile` 直接生成独立可执行文件（`.cli`），无需用户安装运行时——这是 Hummingbird 验证过的核心能力
2. **原生 TS 支持**：无需 `tsc` 编译步骤，直接运行 `.ts` 文件
3. **极速安装**：`bun install` 比 `npm` 快 10-30 倍，改善开发体验
4. **内置 SQLite**：`bun:sqlite` 零配置本地数据库，无需额外依赖
5. **内置测试**：`bun test` 无需配置 Vitest/Jest

#### 为什么选 Hono 而非 Express？

1. **更轻量**：Hono 包体积远小于 Express，启动更快
2. **TypeScript 原生**：路由参数类型安全、中间件类型推导
3. **Bun 兼容**：Hono 对 Bun 有原生适配，性能最优
4. **足够用**：WebUI 后端只需 REST + SSE，不需要 Express 的庞大生态

#### 为什么选 Zod 而非 Effect Schema / TypeBox？

1. **生态最广**：Zod 是 TS 校验事实标准，社区资源最丰富
2. **学习曲线低**：API 直观，团队上手快
3. **工具集成好**：OpenAPI 生成、JSON Schema 转换等工具链成熟
4. **与 Hono 配合**：Hono 原生支持 Zod 校验中间件

#### 为什么不用 Effect 框架（opencode 的选择）？

Effect 是优秀的函数式编程框架，但：
1. **学习曲线陡峭**：Effect 的 Layer/Service/Stream 概念对团队是额外负担
2. **过度抽象**：对于 MVP 阶段，Effect 的复杂度收益不对等
3. **生态限制**：Effect 生态仍在发展中，第三方集成不如标准 TS
4. **决策**：保持标准 async/await + Zod，在需要时再渐进引入

---

## 4. 模块划分

### 4.1 Monorepo 包结构

```
FengAgentCli/
├── packages/
│   ├── core/              # 核心领域层（无 IO 依赖）
│   ├── agent/             # Agent 运行时（Loop、状态、会话）
│   ├── tools/             # 工具系统（注册、执行、权限）
│   ├── llm/               # LLM 抽象层（Provider、Route、Stream）
│   ├── context/           # 上下文管理（压缩、记忆、系统上下文）
│   ├── cli/               # CLI 终端交互（Ink TUI）
│   ├── server/            # HTTP API 服务（Hono + SSE）
│   ├── web-ui/            # WebUI 前端（React + Vite）
│   └── shared/            # 共享类型、工具函数、常量
├── docs/                  # 文档
├── scripts/               # 构建/开发脚本
├── package.json           # Workspace 根配置
├── tsconfig.json          # TS 配置
└── README.md
```

### 4.2 各模块职责

#### 4.2.1 `@fengagent/core` — 核心领域层

**职责**：定义所有核心数据类型和接口契约，不包含任何 IO 实现。

```
packages/core/src/
├── types.ts           # 消息类型：Message、Role、ContentBlock
├── tool.ts            # Tool 接口定义：ToolDefinition、ToolResult
├── agent.ts           # Agent 接口定义：AgentConfig、AgentInfo
├── session.ts         # Session 类型：SessionID、SessionState
├── event.ts           # 事件类型：AgentEvent 流定义
├── config.ts          # 配置类型：ConfigSchema、ConfigLayer
└── permission.ts      # 权限类型：Permission、PermissionResult
```

**设计原则**：
- 零运行时依赖（仅 Zod 用于类型校验）
- 所有类型可序列化（JSON 安全）
- 被 `agent`、`tools`、`llm`、`server` 等所有包依赖

#### 4.2.2 `@fengagent/agent` — Agent 运行时

**职责**：实现 Agent Loop 核心循环，管理会话状态和消息流转。

```
packages/agent/src/
├── loop.ts            # Agent Loop 主循环
├── agent.ts           # Agent 类：状态管理、事件发射
├── session.ts         # 会话管理：创建、恢复、持久化
├── streaming.ts       # 流式响应处理
├── steering.ts        # 消息注入：steering（运行中）+ followUp（结束后）
└── harness.ts         # 高级会话编排（多轮、恢复）
```

**Agent Loop 核心流程**（参考 opencode V2 + Hummingbird query.ts）：

```
while (needsContinuation) {
  1. 组装上下文（系统提示 + 历史 + 当前输入）
  2. 上下文压缩检查（接近上限则压缩）
  3. 调用 LLM（stream，逐 token 输出）
  4. 解析工具调用（如有）
  5. 执行工具（并行/串行，带权限检查）
  6. 将工具结果加入历史
  7. needsContinuation = 有工具调用 → true
}
```

#### 4.2.3 `@fengagent/tools` — 工具系统

**职责**：工具注册、定义、执行、权限管理。

```
packages/tools/src/
├── registry.ts        # 工具注册中心（注册/查询/过滤）
├── executor.ts        # 工具执行器（并行/串行调度）
├── permission.ts      # 权限检查（允许/拒绝/询问用户）
├── truncate.ts        # 输出截断（超长结果溢出到文件）
├── builtin/           # 内置工具
│   ├── file-read.ts
│   ├── file-write.ts
│   ├── file-edit.ts
│   ├── bash.ts
│   ├── glob.ts
│   ├── grep.ts
│   ├── web-fetch.ts
│   ├── web-search.ts
│   └── task.ts        # 多 Agent 子任务派遣
└── mcp/               # MCP 工具适配
    └── mcp-client.ts
```

**工具定义接口**（参考 Hummingbird Tool.ts + opencode tool.ts）：

```typescript
interface ToolDefinition<I = unknown, O = unknown> {
  name: string;                          // 工具名（字母+数字+下_-）
  description: string;                   // 给 LLM 的描述
  inputSchema: z.ZodType<I>;            // Zod 输入校验
  outputSchema?: z.ZodType<O>;          // Zod 输出校验
  
  execute(
    input: I,
    context: ToolContext
  ): Promise<ToolResult<O>>;
  
  // 安全属性
  isReadOnly?(input: I): boolean;        // 是否只读
  isDestructive?(input: I): boolean;     // 是否破坏性
  isConcurrencySafe?(input: I): boolean; // 是否可并行
  
  // 权限
  checkPermissions?(input: I, context: ToolContext): PermissionResult;
  
  // 渲染
  renderUse?(input: I): ReactNode;       // TUI/WebUI 中渲染调用
  renderResult?(result: O): ReactNode;   // TUI/WebUI 中渲染结果
}
```

#### 4.2.4 `@fengagent/llm` — LLM 抽象层

**职责**：Provider 无关的 LLM 调用抽象，支持流式输出。

```
packages/llm/src/
├── client.ts          # LLMClient：stream() / generate()
├── types.ts           # LLMRequest、LLMResponse、LLMEvent
├── route.ts           # Route 概念：Protocol + Endpoint + Auth
├── providers/         # Provider 实现
│   ├── anthropic.ts
│   ├── openai.ts
│   ├── openai-compatible.ts
│   ├── bedrock.ts
│   ├── google.ts
│   └── index.ts       # Provider 注册表
└── stream.ts          # 流式事件处理
```

**LLM 调用接口**（参考 opencode Route/Protocol + pi stream-fn）：

```typescript
interface LLMClient {
  // 流式调用，返回 AsyncGenerator
  stream(request: LLMRequest): AsyncGenerator<LLMEvent>;
  
  // 非流式调用（stream 的折叠）
  generate(request: LLMRequest): Promise<LLMResponse>;
}

interface LLMRequest {
  model: string;                        // 模型 ID
  system: string | ContentBlock[];      // 系统提示
  messages: Message[];                  // 对话历史
  tools?: ToolDefinition[];             // 可用工具
  maxTokens?: number;
  temperature?: number;
  // ... 其他生成参数
}

// 流式事件（参考 opencode LLMEvent）
type LLMEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; result: ToolResult }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "finish"; reason: FinishReason }
  | { type: "error"; error: LLMError };
```

#### 4.2.5 `@fengagent/context` — 上下文管理

**职责**：上下文窗口管理、对话压缩、记忆系统。

```
packages/context/src/
├── manager.ts         # 上下文管理器（组装 + 压缩触发）
├── compaction.ts      # 压缩引擎（摘要 + 保留近期）
├── token-counter.ts   # Token 估算（chars/4 启发式）
├── memory.ts          # 记忆系统（MEMORY.md + 向量检索）
├── system-context.ts  # 系统上下文源（AGENTS.md、日期、技能）
└── truncate.ts        # 工具输出截断
```

**压缩策略**（参考 opencode compaction + Hummingbird 多级管线）：

```
对话历史 → Token 估算 → 接近上限？
                          │
                     ┌────┴────┐
                     │ 是      │ 否
                     ▼         │
            选择分割点          │
            (head + recent)    │
                     │         │
            摘要 head 段        │
            (结构化模板)        │
                     │         │
            替换为摘要           │
            + recent 段 ───────┤
                     │         │
                     ▼         ▼
              压缩后历史 ← 正常历史
```

#### 4.2.6 `@fengagent/cli` — CLI 终端交互

**职责**：终端 UI、命令行参数解析、交互式对话。

```
packages/cli/src/
├── entry.ts           # CLI 入口（参数解析、模式路由）
├── tui/               # Ink TUI 组件
│   ├── app.tsx        # 主应用
│   ├── chat-view.tsx  # 对话视图
│   ├── tool-view.tsx  # 工具调用展示
│   ├── input.tsx      # 输入框
│   └── status-bar.tsx # 状态栏
├── commands/          # 命令（slash commands）
│   ├── session.ts     # /session 管理会话
│   ├── model.ts       # /model 切换模型
│   └── export.ts      # /export 导出
└── print-mode.ts      # 非交互模式（stdin → stdout）
```

#### 4.2.7 `@fengagent/server` — HTTP API 服务

**职责**：本地 HTTP 服务，为 WebUI 提供后端 API，SSE 流式推送。

```
packages/server/src/
├── server.ts          # Hono 应用创建、端口监听
├── routes/            # API 路由
│   ├── session.ts     # POST /api/sessions（创建）
│   ├── message.ts     # POST /api/sessions/:id/messages（发消息）
│   ├── stream.ts      # GET /api/sessions/:id/events（SSE）
│   ├── interrupt.ts   # POST /api/sessions/:id/interrupt
│   ├── model.ts       # GET /api/models
│   └── permission.ts  # POST /api/sessions/:id/permissions/:reqId
└── middleware/        # 中间件
    ├── cors.ts        # CORS
    ├── error.ts       # 错误处理
    └── auth.ts        # 可选认证
```

#### 4.2.8 `@fengagent/web-ui` — WebUI 前端

**职责**：浏览器端聊天界面，消费 server SSE API。

```
packages/web-ui/src/
├── app.tsx            # React 应用入口
├── pages/             # 页面
│   └── chat.tsx       # 聊天页面
├── components/        # 组件
│   ├── message-list.tsx
│   ├── message-input.tsx
│   ├── tool-call-card.tsx
│   ├── markdown-renderer.tsx
│   └── model-selector.tsx
├── hooks/             # React Hooks
│   ├── use-sse.ts     # SSE 事件流
│   └── use-session.ts # 会话管理
├── api/               # API 客户端
│   └── client.ts      # fetch 封装
└── styles/            # 样式（Tailwind）
```

### 4.3 包依赖关系

```
                    shared (类型、工具函数)
                       ↑
              ┌────────┼────────┐
              │        │        │
            core      │        │
              ↑        │        │
     ┌────┬───┴──┬────┘        │
     │    │      │              │
   llm  tools  context          │
     │    │      │              │
     └────┼──────┘              │
          │                     │
        agent                   │
          │                     │
    ┌─────┴──────┐              │
    │            │              │
  server       cli              │
    │            │              │
    └────────────┴──────────────┘
                 │
             web-ui (前端独立，通过 HTTP 消费 server)
```

**依赖规则**：
- `core` 不依赖任何其他包
- `shared` 不依赖任何其他包
- `agent` 依赖 `core`、`llm`、`tools`、`context`
- `server` 依赖 `agent`、`core`
- `cli` 依赖 `agent`、`core`
- `web-ui` 不依赖后端包，通过 HTTP API 通信
- **禁止循环依赖**

---

## 5. 各模块间接口定义

### 5.1 核心数据类型

```typescript
// === 消息类型 ===
type Role = "user" | "assistant" | "system";

interface Message {
  id: string;
  role: Role;
  content: ContentBlock[];
  createdAt: number;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool-use"; id: string; name: string; input: unknown }
  | { type: "tool-result"; toolUseId: string; content: string; isError?: boolean }
  | { type: "thinking"; text: string }
  | { type: "image"; source: { type: "base64"; mediaType: string; data: string } };

// === 会话类型 ===
interface Session {
  id: string;
  title: string;
  messages: Message[];
  model: string;
  createdAt: number;
  updatedAt: number;
  status: "idle" | "running" | "error";
  tokenCount: number;
}

// === Agent 事件流 ===
type AgentEvent =
  | { type: "session-start"; session: Session }
  | { type: "message-start"; messageId: string; role: Role }
  | { type: "text-delta"; messageId: string; text: string }
  | { type: "tool-call-start"; toolUseId: string; name: string; input: unknown }
  | { type: "tool-call-result"; toolUseId: string; result: ToolResult }
  | { type: "message-end"; messageId: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn-end"; reason: FinishReason }
  | { type: "error"; error: Error }
  | { type: "compaction-start" }
  | { type: "compaction-end"; summary: string }
  | { type: "session-end" };
```

### 5.2 模块间接口

#### Agent ↔ LLM

```typescript
// agent 调用 llm
interface LLMClient {
  stream(request: LLMRequest): AsyncGenerator<LLMEvent>;
}

// LLM 返回事件流
type LLMEvent = TextDelta | ThinkingDelta | ToolCall | Usage | Finish | Error;
```

#### Agent ↔ Tools

```typescript
// agent 调用工具
interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  materialize(permissions?: PermissionFilter): ToolDefinition[];
}

interface ToolExecutor {
  execute(
    tool: ToolDefinition,
    input: unknown,
    context: ToolContext
  ): Promise<ToolResult>;
}
```

#### Agent ↔ Context

```typescript
// agent 调用上下文管理
interface ContextManager {
  // 组装完整上下文（系统提示 + 历史）
  assemble(session: Session): Promise<AssembledContext>;
  
  // 检查是否需要压缩
  shouldCompact(context: AssembledContext): boolean;
  
  // 执行压缩
  compact(
    messages: Message[],
    options: CompactionOptions
  ): Promise<{ summary: string; recent: Message[] }>;
  
  // Token 估算
  estimateTokens(content: string | Message[]): number;
}
```

#### Server ↔ Agent

```typescript
// server 包装 agent，对外提供 HTTP API
interface ServerAPI {
  // 创建会话
  POST /api/sessions
    → { sessionId: string }
  
  // 发送消息（返回 SSE 流）
  POST /api/sessions/:id/messages
    body: { content: string; attachments?: string[] }
    → SSE stream of AgentEvent
  
  // 中断当前运行
  POST /api/sessions/:id/interrupt
    → { ok: boolean }
  
  // 权限响应
  POST /api/sessions/:id/permissions/:reqId
    body: { decision: "allow" | "deny" }
    → { ok: boolean }
  
  // 获取可用模型
  GET /api/models
    → { models: ModelInfo[] }
}
```

#### CLI / WebUI ↔ Server

```
CLI (Ink TUI) ──── 直接 import agent ──── Agent
                                              ↕
WebUI (React) ──── HTTP + SSE ───────────── Server ──── Agent
```

- **CLI 模式**：直接 `import { Agent } from "@fengagent/agent"`，进程内调用
- **WebUI 模式**：通过 `@fengagent/server` 的 HTTP API + SSE 流通信
- **共享逻辑**：`Agent` 类是唯一核心，CLI 和 Server 都是它的前端

---

## 6. 环境变量设计

### 6.1 模型配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `FENG_MODEL` | `claude-sonnet-4-20250514` | 默认模型 ID |
| `FENG_SMALL_MODEL` | `claude-haiku-3` | 小模型（压缩、摘要用） |
| `FENC_MAX_TOKENS` | `8192` | 最大输出 Token 数 |
| `FENG_TEMPERATURE` | `1.0` | 生成温度 |
| `FENG_PROVIDER` | `anthropic` | 默认 Provider |
| `FENG_FALLBACK_MODEL` | - | 主模型失败时的回退模型 |

### 6.2 API 密钥

| 环境变量 | 说明 |
|---------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `OPENAI_COMPATIBLE_API_KEY` | OpenAI 兼容 API 密钥 |
| `OPENAI_COMPATIBLE_BASE_URL` | OpenAI 兼容 API 地址 |
| `OPENAI_COMPATIBLE_MODEL` | OpenAI 兼容模型 ID |
| `GOOGLE_API_KEY` | Google Gemini API 密钥 |
| `AWS_BEDROCK_REGION` | AWS Bedrock 区域 |
| `AWS_ACCESS_KEY_ID` | AWS 密钥 ID |
| `AWS_SECRET_ACCESS_KEY` | AWS 密钥 |

### 6.3 上下文与压缩

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `FENG_CONTEXT_WINDOW` | `200000` | 上下文窗口大小（Token） |
| `FENG_COMPACT_THRESHOLD` | `0.85` | 压缩触发比例（占窗口的百分比） |
| `FENG_COMPACT_KEEP_TOKENS` | `8000` | 压缩时保留的近期 Token 数 |
| `FENG_COMPACT_BUFFER` | `20000` | 压缩缓冲区大小 |
| `FENG_DISABLE_COMPACT` | `false` | 禁用自动压缩 |
| `FENG_TOOL_OUTPUT_MAX_CHARS` | `2000` | 工具输出最大字符数 |

### 6.4 服务配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `FENG_SERVER_PORT` | `3000` | WebUI 后端服务端口 |
| `FENG_SERVER_HOST` | `127.0.0.1` | 服务绑定地址 |
| `FENG_WEB_UI_PORT` | `5173` | Vite 开发服务器端口（dev 模式） |
| `FENG_CORS_ORIGIN` | `*` | CORS 允许来源 |

### 6.5 工具与权限

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `FENG_AUTO_APPROVE_TOOLS` | `false` | 自动批准所有工具执行 |
| `FENG_ALLOWED_TOOLS` | `*` | 允许的工具列表（逗号分隔） |
| `FENG_DENIED_TOOLS` | - | 禁止的工具列表 |
| `FENG_BASH_TIMEOUT` | `120000` | Bash 命令超时（毫秒） |
| `FENG_MAX_TOOL_CONCURRENCY` | `10` | 工具最大并行数 |

### 6.6 高级配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `FENG_CONFIG_FILE` | `.fengagent/config.json` | 配置文件路径 |
| `FENG_DATA_DIR` | `~/.fengagent` | 数据存储目录 |
| `FENG_LOG_LEVEL` | `info` | 日志级别（debug/info/warn/error） |
| `FENG_LOG_DIR` | `~/.fengagent/logs` | 日志目录 |
| `FENG_MAX_TURNS` | `50` | 单次对话最大轮次 |
| `FENG_MCP_SERVERS` | - | MCP 服务器配置（JSON） |

### 6.7 配置优先级

从低到高（高优先级覆盖低优先级）：

1. **内置默认值**（代码中的 `DEFAULT_CONFIG`）
2. **全局配置**：`~/.fengagent/config.json`
3. **项目配置**：`./.fengagent/config.json`
4. **环境变量**：`FENG_*` 系列变量
5. **命令行参数**：`--model`、`--port` 等

---

## 7. 里程碑计划

### 7.1 整体里程碑

| 里程碑 | 时间估计 | 交付物 | 对应 Stage |
|--------|---------|--------|-----------|
| M0: 设计完成 | 1 天 | PRD + 架构文档 | Stage 1（当前） |
| M1: CLI MVP | 5-7 天 | 可用的 CLI 对话 + 工具 + 模型 | Stage 2 |
| M2: WebUI | 3-5 天 | 本地 WebUI 网页对话 | Stage 3 |
| M3: 高级能力 | 5-7 天 | 多 Agent + 记忆 + MCP + 权限 | Stage 4 |
| M4: 编译发布 | 2-3 天 | 独立二进制 + Demo 部署 | Stage 5 |

### 7.2 详细里程碑

#### M0: 设计完成（Stage 1 — 当前）

- [x] 调研 6 个参考项目架构
- [x] 输出 PRD 文档
- [x] 输出架构设计文档
- [x] 输出开发阶段拆分建议

#### M1: CLI MVP（Stage 2）

- [ ] 项目脚手架搭建（Bun workspace、TS 配置）
- [ ] `@fengagent/core` 类型定义
- [ ] `@fengagent/llm` Provider 集成（Anthropic + OpenAI）
- [ ] `@fengagent/tools` 内置工具（read/write/edit/bash/glob/grep）
- [ ] `@fengagent/context` 基础压缩
- [ ] `@fengagent/agent` Agent Loop 实现
- [ ] `@fengagent/cli` Ink TUI 交互
- [ ] 端到端测试：CLI 对话 + 工具调用

#### M2: WebUI（Stage 3）

- [ ] `@fengagent/server` Hono HTTP API + SSE
- [ ] `@fengagent/web-ui` React 聊天界面
- [ ] Markdown 渲染 + 代码高亮
- [ ] 工具调用可视化
- [ ] 模型选择器
- [ ] 会话管理 UI
- [ ] Demo 部署脚本

#### M3: 高级能力（Stage 4）

- [ ] 多 Agent 子任务派遣（task 工具）
- [ ] 记忆系统（MEMORY.md + 向量检索）
- [ ] MCP 客户端集成
- [ ] 权限审批系统
- [ ] 插件系统框架
- [ ] Skills 系统
- [ ] Todo 系统
- [ ] 模型回退机制

#### M4: 编译发布（Stage 5）

- [ ] `bun build --compile` 二进制编译
- [ ] 跨平台测试（Windows / macOS / Linux）
- [ ] README 完善
- [ ] Demo 网页部署
- [ ] npm 发布（可选）

---

## 8. 后续开发阶段拆分建议

### 8.1 Stage 拆分总览

```
Stage 1: PRD & 架构设计 ← 当前
    │
Stage 2: CLI MVP 核心
    ├── 2a: 项目脚手架 + core 类型 (1天)
    ├── 2b: LLM Provider 集成 (2天)
    ├── 2c: 工具系统 + 内置工具 (2天)
    ├── 2d: Agent Loop + 上下文压缩 (2天)
    └── 2e: CLI TUI 交互 (1天)
    │
Stage 3: WebUI 本地服务
    ├── 3a: HTTP Server + SSE (2天)
    ├── 3b: React 前端 + 聊天界面 (2天)
    └── 3c: 集成测试 + Demo (1天)
    │
Stage 4: 高级 Agent 能力
    ├── 4a: 多 Agent 子任务 (2天)
    ├── 4b: 记忆系统 (2天)
    ├── 4c: MCP 集成 + 权限系统 (2天)
    └── 4d: 插件 + Skills 系统 (2天)
    │
Stage 5: 编译发布
    ├── 5a: 二进制编译 + 跨平台测试 (1天)
    ├── 5b: 文档完善 + Demo 部署 (1天)
    └── 5c: npm 发布 (1天)
```

### 8.2 各 Stage 子任务详情

#### Stage 2: CLI MVP 核心（可并行拆分）

| 子任务 | 可并行？ | 依赖 | 建议分配 |
|--------|---------|------|---------|
| 2a: 项目脚手架 + core 类型 | 否（前置） | 无 | 1 人 |
| 2b: LLM Provider 集成 | 是（2a 后） | 2a | 1 人 |
| 2c: 工具系统 + 内置工具 | 是（2a 后） | 2a | 1 人 |
| 2d: Agent Loop + 上下文 | 否（需 2b+2c） | 2b, 2c | 1 人 |
| 2e: CLI TUI 交互 | 否（需 2d） | 2d | 1 人 |

**并行策略**：2a 完成后，2b 和 2c 可同时进行。2d 等 2b+2c 完成后开始。2e 最后。

#### Stage 3: WebUI 本地服务

| 子任务 | 可并行？ | 依赖 | 建议分配 |
|--------|---------|------|---------|
| 3a: HTTP Server + SSE | 是（Stage 2 后） | Stage 2 | 1 人 |
| 3b: React 前端 | 是（3a API 定义后） | 3a API | 1 人 |
| 3c: 集成测试 + Demo | 否（需 3a+3b） | 3a, 3b | 1 人 |

#### Stage 4: 高级 Agent 能力

| 子任务 | 可并行？ | 依赖 | 建议分配 |
|--------|---------|------|---------|
| 4a: 多 Agent 子任务 | 是 | Stage 2 | 1 人 |
| 4b: 记忆系统 | 是 | Stage 2 | 1 人 |
| 4c: MCP + 权限系统 | 是 | Stage 2 | 1 人 |
| 4d: 插件 + Skills | 是 | Stage 2 | 1 人 |

**并行策略**：4a/4b/4c/4d 完全并行，各自独立模块。

#### Stage 5: 编译发布

| 子任务 | 可并行？ | 依赖 | 建议分配 |
|--------|---------|------|---------|
| 5a: 二进制编译 | 是 | Stage 2-4 | 1 人 |
| 5b: 文档完善 | 是 | Stage 2-4 | 1 人 |
| 5c: npm 发布 | 否（需 5a+5b） | 5a, 5b | 1 人 |

### 8.3 Multica Issue 拆分建议

建议按以下方式创建 Multica 子 Issue：

```
Parent: AGE-4 (从零搭建FengAgentCli)
  ├── Stage 1: AGE-5 (PRD & 架构设计) ← 当前
  ├── Stage 2: CLI MVP 核心
  │   ├── 2a: 项目脚手架 + core 类型定义
  │   ├── 2b: LLM Provider 集成 (Anthropic + OpenAI)
  │   ├── 2c: 工具系统 + 内置工具
  │   ├── 2d: Agent Loop + 上下文压缩
  │   └── 2e: CLI TUI 交互界面
  ├── Stage 3: WebUI 本地服务
  │   ├── 3a: HTTP Server + SSE 流式推送
  │   ├── 3b: React WebUI 前端
  │   └── 3c: 集成测试 + Demo 部署
  ├── Stage 4: 高级 Agent 能力
  │   ├── 4a: 多 Agent 子任务派遣
  │   ├── 4b: 记忆系统
  │   ├── 4c: MCP 集成 + 权限系统
  │   └── 4d: 插件 + Skills 系统
  └── Stage 5: 编译发布
      ├── 5a: 二进制编译 + 跨平台测试
      ├── 5b: 文档完善 + Demo 部署
      └── 5c: npm 发布
```

**Stage 分组策略**：
- Stage 2 内部有串行依赖链（2a → 2b/2c 并行 → 2d → 2e），使用 `--stage 2` 分组，2a 设 `todo`，2b/2c/2d/2e 设 `backlog`
- Stage 3/4/5 各子任务并行度高，同 Stage 内可同时 `todo`
- 跨 Stage 串行：Stage 3/4 依赖 Stage 2，Stage 5 依赖 Stage 2-4

---

## 附录 A：参考项目调研摘要

### A.1 opencode（TypeScript/Bun + Effect）

- **架构亮点**：Effect 框架做 Service/Layer 架构；Route/Protocol 四轴抽象 LLM 调用（Protocol × Endpoint × Auth × Framing）；System Context 代数系统做可刷新的系统上下文源；持久化事件溯源的会话运行器
- **借鉴点**：LLM Route 抽象（简化版）、System Context 源概念、工具输出截断策略、会话快照
- **不采用**：Effect 框架（过于复杂）、事件溯源（MVP 不需要）

### A.2 Hummingbird（TypeScript/Bun + Express + React）

- **架构亮点**：cc-bridge（HTTP+SSE）+ free-code（Agent CLI）+ web-ui（React）三层分离；`bun build --compile` 生成独立二进制；WebSocket 做进程间通信；`.hummingbird/model-provider.json` 声明式模型配置；多级压缩管线（snip → microcompact → collapse → auto-compact）
- **借鉴点**：三层分离架构、bun 编译二进制、声明式模型配置、多级压缩管线
- **不采用**：WebSocket IPC（MVP 用进程内调用）、Pod 配置系统（过度工程）

### A.3 pi（TypeScript/Node）

- **架构亮点**：7 包 monorepo 边界清晰；40+ LLM Provider 统一 API；自扩展 Extension 系统（jiti 动态加载 TS 模块）；steering/follow-up 双队列消息注入；AgentMessage 抽象（声明合并扩展自定义消息类型）
- **借鉴点**：多 Provider 统一 API 设计、steering/follow-up 消息注入、AgentMessage 类型扩展
- **不采用**：jiti 动态加载（MVP 用静态导入）、分支摘要（复杂度不对等）

### A.4 codex（Rust）

- **架构亮点**：80+ crate 极致模块化；ThreadManager → CodexThread → Session 三层会话管理；多平台沙箱系统（bwrap/Windows）；权限配置文件系统；ACP 协议多 Agent；Rollout 记录回放
- **借鉴点**：多层会话管理概念、权限配置文件思路
- **不采用**：Rust 实现、沙箱系统（MVP 用权限审批代替）

### A.5 hermes-agent（Python）

- **架构亮点**：自注册工具注册表（AST 扫描自动发现）；Toolset 组合系统（命名工具组包含其他组）；Mixture-of-Agents（多模型咨询 → 聚合）；Kanban 多 Agent 协调；Gateway 多平台消息网关
- **借鉴点**：Toolset 组合概念、MoA 思路（未来考虑）
- **不采用**：Python 实现、Gateway 多平台消息（不在范围内）

### A.6 openclaw（TypeScript/pnpm）

- **架构亮点**：EventStream 事件流 Agent Loop（丰富事件协议）；150+ 扩展生态；ACP 协议子 Agent 生成；Context Engine 可插拔上下文引擎（thread_bootstrap 持久化线程）；Before/After 工具 Hook 系统
- **借鉴点**：EventStream 事件协议设计、可插拔上下文引擎、工具 Hook 系统
- **不采用**：150+ 扩展（MVP 只需核心）、Fleet 容器编排

---

## 附录 B：术语表

| 术语 | 说明 |
|------|------|
| Agent Loop | Agent 核心循环：输入 → LLM → 工具 → 输出 |
| Tool | LLM 可调用的函数（文件读写、Bash 等） |
| Provider | LLM 服务提供商（Anthropic、OpenAI 等） |
| Route | LLM 调用路由（Protocol + Endpoint + Auth） |
| Compaction | 对话历史压缩（摘要旧消息 + 保留近期） |
| Steering | 运行中注入消息（不中断当前循环） |
| FollowUp | Agent 停止后排队的后续消息 |
| MCP | Model Context Protocol，标准 Agent 互操作协议 |
| SSE | Server-Sent Events，服务器推送流 |
| TUI | Terminal User Interface，终端用户界面 |
| Ink | React for CLI，用 React 渲染终端界面 |
