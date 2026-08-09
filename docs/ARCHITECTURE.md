# FengAgentCli 架构设计文档

> 版本：1.0  
> 日期：2026-08-09  
> 状态：草案

---

## 目录

1. [整体架构图](#1-整体架构图)
2. [核心模块依赖关系](#2-核心模块依赖关系)
3. [数据流设计](#3-数据流设计)
4. [扩展点设计](#4-扩展点设计)
5. [配置系统设计](#5-配置系统设计)
6. [关键技术方案](#6-关键技术方案)

---

## 1. 整体架构图

### 1.1 系统全景

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FengAgentCli 系统全景                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │   CLI TUI    │    │  Web Browser │    │   Multica Platform   │  │
│  │  (Ink/React) │    │   (React)    │    │     (Agent 管理)      │  │
│  └──────┬───────┘    └──────┬───────┘    └──────────┬───────────┘  │
│         │ 进程内调用          │ HTTP + SSE            │ CLI 交互       │
│         │                    │                       │               │
│         ▼                    ▼                       ▼               │
│  ┌─────────────┐    ┌────────────────┐     ┌─────────────────┐     │
│  │   Agent     │◄──►│   HTTP Server  │◄───►│   Agent         │     │
│  │  (直接引用)  │    │   (Hono + SSE) │     │  (直接引用)      │     │
│  └──────┬──────┘    └────────────────┘     └─────────────────┘     │
│         │                                                           │
│         │                                                           │
│  ┌──────┴──────────────────────────────────────────────────────┐   │
│  │                     Agent Runtime 核心                       │   │
│  │  ┌─────────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐  │   │
│  │  │ Agent Loop  │─►│ Context  │  │  Tools   │  │  LLM    │  │   │
│  │  │  (循环驱动)  │  │ Manager  │  │ Registry │  │ Client  │  │   │
│  │  └──────┬──────┘  └────┬─────┘  └────┬─────┘  └────┬────┘  │   │
│  │         │              │             │              │        │   │
│  │         ▼              ▼             ▼              ▼        │   │
│  │  ┌──────────┐   ┌───────────┐  ┌──────────┐  ┌─────────┐   │   │
│  │  │ Session  │   │Compaction │  │Executor  │  │Provider │   │   │
│  │  │ Storage  │   │ + Memory  │  │+Permission│  │Adapter  │   │   │
│  │  │ (SQLite) │   │           │  │          │  │         │   │   │
│  │  └──────────┘   └───────────┘  └──────────┘  └─────────┘   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                      Shared / Core                           │   │
│  │     类型定义  •  Zod Schema  •  工具函数  •  常量             │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 进程模型

```
模式 1: CLI 模式（单进程）
┌─────────────────────────────────────────┐
│              Bun 进程                    │
│  ┌───────┐  ┌───────┐  ┌─────────────┐ │
│  │ Ink   │─►│ Agent │─►│ LLM/Tools   │ │
│  │ TUI   │  │ Loop  │  │ (直接调用)   │ │
│  └───────┘  └───────┘  └─────────────┘ │
└─────────────────────────────────────────┘

模式 2: WebUI 模式（双进程 dev / 单进程 prod）
┌─────────────────────────────────────────┐
│           Bun 服务进程                   │
│  ┌──────────┐  ┌───────┐  ┌─────────┐  │
│  │ Hono     │─►│ Agent │─►│LLM/Tools│  │
│  │ Server   │  │ Loop  │  │         │  │
│  │ + SSE    │  │       │  │         │  │
│  │ + Static │  │       │  │         │  │
│  └────┬─────┘  └───────┘  └─────────┘  │
│       │ HTTP + SSE                       │
└───────┼─────────────────────────────────┘
        │
   ┌────▼─────┐
   │ Browser  │
   │ (React)  │
   └──────────┘

模式 3: 编译二进制模式（单进程）
┌─────────────────────────────────────────┐
│         fengagent (.cli 二进制)          │
│  Bun runtime + 所有代码（编译打包）       │
│  支持: CLI 模式 / serve 模式             │
└─────────────────────────────────────────┘
```

### 1.3 Monorepo 包结构

```
FengAgentCli/
├── packages/
│   ├── shared/          # 共享：类型、工具函数、常量
│   ├── core/            # 核心：接口定义、Zod Schema
│   ├── llm/             # LLM：Provider 抽象、流式调用
│   ├── tools/           # 工具：注册、执行、权限、内置工具
│   ├── context/         # 上下文：压缩、记忆、系统上下文
│   ├── agent/           # Agent：Loop、会话、状态管理
│   ├── server/          # 服务：Hono HTTP API + SSE
│   ├── cli/             # CLI：Ink TUI、命令行
│   └── web-ui/          # WebUI：React + Vite 前端
├── docs/                # 文档（PRD、架构、开发指南）
├── scripts/             # 构建、开发脚本
├── .fengagent/          # 项目级配置（可选）
├── package.json         # Workspace 根配置
├── tsconfig.json        # TS 配置（路径映射）
└── README.md
```

---

## 2. 核心模块依赖关系

### 2.1 包依赖图

```
                    ┌──────────┐
                    │  shared  │  ← 零依赖（类型、工具函数）
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
              ┌──────────┴──────────┐
              │                     │
         ┌────┴────┐          ┌────┴────┐
         │ server  │          │   cli   │  ← 各依赖 agent
         └─────────┘          └─────────┘
              │
         ┌────┴────┐
         │ web-ui  │  ← 独立前端，不依赖后端包（通过 HTTP 通信）
         └─────────┘
```

### 2.2 依赖规则

| 包 | 可依赖 | 禁止依赖 |
|---|--------|---------|
| `shared` | 无 | 所有其他包 |
| `core` | `shared` | `llm`、`tools`、`context`、`agent`、`server`、`cli`、`web-ui` |
| `llm` | `core`、`shared` | `tools`、`context`、`agent`、`server`、`cli`、`web-ui` |
| `tools` | `core`、`shared` | `llm`、`context`、`agent`、`server`、`cli`、`web-ui` |
| `context` | `core`、`shared` | `llm`、`tools`、`agent`、`server`、`cli`、`web-ui` |
| `agent` | `core`、`shared`、`llm`、`tools`、`context` | `server`、`cli`、`web-ui` |
| `server` | `agent`、`core`、`shared` | `cli`、`web-ui` |
| `cli` | `agent`、`core`、`shared` | `server`、`web-ui` |
| `web-ui` | 无（独立前端） | 所有后端包 |

### 2.3 模块内部依赖

#### Agent 模块内部

```
agent/
├── loop.ts ◄──── 核心循环
│   ├── 调用 ──► llm/client.ts (stream)
│   ├── 调用 ──► tools/executor.ts (execute)
│   ├── 调用 ──► context/manager.ts (assemble, compact)
│   └── 管理 ──► session.ts (持久化)
│
├── agent.ts ◄──── Agent 类（状态 + 事件）
│   ├── 持有 ──► loop.ts
│   ├── 持有 ──► steering.ts (消息队列)
│   └── 发射 ──► AgentEvent 事件流
│
├── session.ts ◄──── 会话管理
│   ├── 持久化 ──► SQLite (bun:sqlite)
│   └── 恢复 ──► 从 DB 加载历史消息
│
└── streaming.ts ◄──── 流式处理
    └── 转换 ──► LLMEvent → AgentEvent
```

#### Tools 模块内部

```
tools/
├── registry.ts ◄──── 注册中心
│   ├── register(tool) ──► 存入 Map
│   ├── get(name) ──► 查询
│   └── materialize(perms) ──► 过滤 + 返回定义列表
│
├── executor.ts ◄──── 执行器
│   ├── 分组 ──► 并行安全 vs 串行
│   ├── 权限 ──► permission.ts 检查
│   ├── 执行 ──► tool.execute(input, ctx)
│   └── 截断 ──► truncate.ts 限制输出
│
├── permission.ts ◄──── 权限系统
│   ├── 自动批准检查
│   ├── 询问用户（通过回调）
│   └── 缓存决策
│
└── builtin/ ◄──── 内置工具
    ├── file-read.ts
    ├── file-write.ts
    ├── file-edit.ts
    ├── bash.ts
    ├── glob.ts
    ├── grep.ts
    ├── web-fetch.ts
    ├── web-search.ts
    └── task.ts (多 Agent)
```

#### LLM 模块内部

```
llm/
├── client.ts ◄──── LLMClient 接口
│   ├── stream(request) ──► AsyncGenerator<LLMEvent>
│   └── generate(request) ──► Promise<LLMResponse>
│
├── route.ts ◄──── 路由抽象
│   ├── Protocol: anthropic-messages | openai-chat | openai-compatible
│   ├── Endpoint: baseURL + path
│   └── Auth: API Key / OAuth / Bearer
│
├── providers/ ◄──── Provider 实现
│   ├── anthropic.ts  ──► Anthropic Messages API
│   ├── openai.ts     ──► OpenAI Chat Completions API
│   ├── openai-compatible.ts ──► 通用 OpenAI 兼容 API
│   ├── google.ts     ──► Google Gemini API
│   ├── bedrock.ts    ──► AWS Bedrock API
│   └── index.ts      ──► Provider 注册表
│
└── stream.ts ◄──── 流式解析
    ├── SSE 帧解析
    ├── 事件解码 (provider-specific → LLMEvent)
    └── 错误处理 + 重试
```

---

## 3. 数据流设计

### 3.1 核心数据流：用户输入 → 响应输出

```
用户输入 "帮我读取 package.json"
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. 输入处理                                                  │
│    ├── CLI: Ink TextInput → onSubmit(text)                  │
│    └── WebUI: React Input → POST /api/sessions/:id/messages │
│    结果: { role: "user", content: [{ type: "text", text }] }│
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Agent Loop 入口                                          │
│    agent.prompt(text)                                       │
│    ├── 创建 user Message                                    │
│    ├── 持久化到 Session                                      │
│    └── 进入 loop()                                           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. 上下文组装                                                │
│    contextManager.assemble(session)                         │
│    ├── 加载系统提示 (AGENTS.md, 日期, 技能)                  │
│    ├── 加载对话历史 (从 SQLite)                              │
│    ├── 检查 Token 数量                                       │
│    └── 如果超阈值 → compact() 压缩                           │
│    结果: { system, messages, tokenCount }                   │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. 工具准备                                                  │
│    toolRegistry.materialize(permissions)                    │
│    ├── 收集所有已注册工具                                    │
│    ├── 过滤被禁用的工具                                      │
│    └── 转换为 LLM 可理解的 ToolDefinition[]                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. LLM 调用（流式）                                          │
│    llmClient.stream({                                       │
│      model, system, messages, tools, maxTokens, ...         │
│    })                                                       │
│    │                                                        │
│    ├── 事件: text-delta  ──► 实时输出到 TUI/WebUI           │
│    ├── 事件: thinking-delta ──► 思考过程（可选展示）         │
│    ├── 事件: tool-call   ──► 解析工具调用                    │
│    ├── 事件: usage       ──► 记录 Token 消耗                │
│    └── 事件: finish      ──► 本轮结束                        │
│    │                                                        │
│    ▼ (如果有 tool-call 事件)                                 │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. 工具执行                                                  │
│    toolExecutor.execute(toolCalls)                          │
│    ├── 分组: 并行安全工具 vs 串行工具                        │
│    ├── 权限检查: 自动批准 / 询问用户                         │
│    ├── 执行: tool.execute(input, context)                   │
│    ├── 截断: 超长结果溢出到文件                              │
│    └── 返回: ToolResult[]                                   │
│    │                                                        │
│    ├── 工具: file-read("package.json")                      │
│    │   └── 读取文件内容 → ToolResult { content: "..." }     │
│    │                                                        │
│    └── 结果注入到消息历史                                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. 循环判断                                                  │
│    if (有工具调用 && 未达最大轮次)                           │
│      → needsContinuation = true → 回到步骤 3                 │
│    else                                                     │
│      → needsContinuation = false → 退出循环                 │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 8. 输出交付                                                  │
│    CLI:  Ink 渲染 Markdown + 代码高亮                       │
│    WebUI: SSE 推送 → React 渲染                             │
│    └── 持久化完整响应到 Session                              │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 流式事件序列

```
时间轴 ──────────────────────────────────────────────────────►

用户发送消息
    │
    ▼
[session-start] ──► [message-start (user)]
    │
    ▼
[message-start (assistant)]
    │
    ├─► [text-delta "我"] ─► [text-delta "来"] ─► [text-delta "读取"]
    │        │                  │                   │
    │        ▼                  ▼                   ▼
    │     TUI/WebUI 实时渲染流式文本
    │
    ├─► [tool-call-start (file-read, {path:"package.json"})]
    │        │
    │        ▼
    │     权限检查 ──► [permission-request]
    │        │
    │        ▼ (用户批准)
    │     [tool-call-result (content: "{...}")]
    │        │
    │        ▼
    │     TUI/WebUI 渲染工具调用卡片
    │
    ├─► [text-delta "这是 package.json 的内容..."]
    │
    ├─► [usage (input: 1200, output: 350)]
    │
    ▼
[message-end (assistant)]
    │
    ▼
[turn-end (reason: "end_turn")]
    │
    ▼
[session-end] (如果会话结束)
```

### 3.3 上下文压缩数据流

```
对话历史: [msg1, msg2, msg3, ..., msg50, msg51, msg52]
                                                        │
                                                        ▼
                                              Token 估算
                                                        │
                                         ┌──────────────┴──────────────┐
                                         │                             │
                                    超阈值?                         未超阈值
                                         │                             │
                                         ▼                             │
                                   选择分割点                          │
                                   keepTokens = 8000                   │
                                         │                             │
                              ┌──────────┴──────────┐                  │
                              │                     │                  │
                           head 段               recent 段             │
                        [msg1..msg44]        [msg45..msg52]            │
                              │                     │                  │
                              ▼                     │                  │
                        摘要生成                     │                  │
                        (LLM 调用)                  │                  │
                              │                     │                  │
                              ▼                     │                  │
                        结构化摘要                  │                  │
                        {                          │                  │
                          目标,                     │                  │
                          完成的工作,                │                  │
                          当前状态,                  │                  │
                          下一步,                    │                  │
                          相关文件                   │                  │
                        }                          │                  │
                              │                     │                  │
                              └────────┬────────────┘                  │
                                       │                               │
                                       ▼                               │
                              压缩后历史                               │
                              [summary_msg, msg45..msg52]              │
                                       │                               │
                                       └───────────────────────────────┘
                                       │
                                       ▼
                              传递给 LLM 调用
```

### 3.4 多 Agent 数据流

```
用户: "帮我重构 auth 模块并添加测试"
    │
    ▼
Agent (主)
    │
    ├── 分析任务，决定派遣子 Agent
    │
    ├── Tool Call: task({
    │     description: "重构 auth 模块",
    │     prompt: "将 auth 模块重构为...",
    │     subagent_type: "coder"
    │   })
    │
    │   ┌─────────────────────────────────────────┐
    │   │  子 Agent (coder)                        │
    │   │  ├── 独立 Session（继承工具/权限）        │
    │   │  ├── 独立上下文（不共享主 Agent 历史）    │
    │   │  ├── 执行: 读取文件 → 编辑 → 验证        │
    │   │  └── 返回: <task_result>...</task_result>│
    │   └─────────────────────────────────────────┘
    │
    ├── 接收子 Agent 结果
    │
    ├── Tool Call: task({
    │     description: "添加 auth 测试",
    │     prompt: "为重构后的 auth 模块添加测试...",
    │     subagent_type: "coder"
    │   })
    │
    │   ┌─────────────────────────────────────────┐
    │   │  子 Agent (coder)                        │
    │   │  └── 返回: <task_result>测试已添加</...> │
    │   └─────────────────────────────────────────┘
    │
    ├── 汇总两个子 Agent 的结果
    │
    ▼
输出: "已完成重构和测试，变更如下..."
```

---

## 4. 扩展点设计

### 4.1 扩展点总览

```
┌─────────────────────────────────────────────────────┐
│                  扩展点架构                           │
├─────────────────────────────────────────────────────┤
│                                                     │
│  1. 模型扩展 (LLM Provider)                          │
│     └── 实现 LLMClient 接口 + 注册到 ProviderRegistry│
│                                                     │
│  2. 工具扩展 (Tool)                                  │
│     └── 实现 ToolDefinition 接口 + 注册到 ToolRegistry│
│                                                     │
│  3. Agent 扩展 (Agent Definition)                    │
│     └── Markdown + frontmatter 定义 Agent 角色       │
│                                                     │
│  4. 插件扩展 (Plugin)                                │
│     └── 导出 Plugin 接口，注册多个扩展点              │
│                                                     │
│  5. Hook 扩展 (生命周期钩子)                          │
│     └── 注册 PreToolUse / PostToolUse / PreCompact  │
│                                                     │
│  6. MCP 扩展 (外部工具服务器)                         │
│     └── 配置 MCP Server，自动发现工具                 │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 4.2 添加新模型 Provider

```typescript
// 1. 实现 LLMClient 接口
// packages/llm/providers/my-provider.ts

import { LLMClient, LLMRequest, LLMEvent } from "@fengagent/core";

export class MyProviderClient implements LLMClient {
  constructor(private apiKey: string, private baseUrl: string) {}

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    // 1. 将 LLMRequest 转换为 Provider 特有的请求格式
    const providerRequest = this.convertRequest(request);

    // 2. 发起 HTTP 请求（SSE 流）
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(providerRequest),
    });

    // 3. 解析 SSE 流，转换为统一的 LLMEvent
    for await (const chunk of this.parseSSEStream(response.body!)) {
      yield this.convertEvent(chunk);
    }
  }

  private convertRequest(req: LLMRequest): unknown { /* ... */ }
  private convertEvent(chunk: unknown): LLMEvent { /* ... */ }
  private async *parseSSEStream(body: ReadableStream) { /* ... */ }
}

// 2. 注册 Provider
// packages/llm/providers/index.ts

import { MyProviderClient } from "./my-provider";

export const providerRegistry = {
  anthropic: (config) => new AnthropicClient(config),
  openai: (config) => new OpenAIClient(config),
  "my-provider": (config) => new MyProviderClient(config.apiKey, config.baseUrl),
};

// 3. 通过环境变量使用
// FENG_PROVIDER=my-provider
// MY_PROVIDER_API_KEY=xxx
// MY_PROVIDER_BASE_URL=https://api.example.com
```

### 4.3 添加新工具

```typescript
// 1. 实现 ToolDefinition 接口
// packages/tools/builtin/my-tool.ts

import { ToolDefinition } from "@fengagent/core";
import { z } from "zod";

export const myTool: ToolDefinition<{ query: string }, { result: string }> = {
  name: "search-docs",
  description: "搜索项目文档中的内容",
  inputSchema: z.object({
    query: z.string().describe("搜索关键词"),
  }),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async execute(input, context) {
    const results = await searchInDocs(input.query, context.workdir);
    return {
      content: results.map(r => r.text).join("\n"),
      metadata: { count: results.length },
    };
  },

  renderUse: (input) => `搜索文档: "${input.query}"`,
};

// 2. 注册到工具注册表
// packages/tools/builtin/index.ts

import { myTool } from "./my-tool";
import { registry } from "../registry";

registry.register(myTool);

// 3. 工具自动出现在 LLM 的可用工具列表中
```

### 4.4 添加新 Agent

```markdown
<!-- .fengagent/agents/code-reviewer.md -->
---
name: code-reviewer
description: 代码审查专家，擅长发现 bug 和改进建议
model: claude-sonnet-4-20250514
tools:
  - file-read
  - grep
  - glob
max_turns: 20
---

你是一个代码审查专家。你的职责：

1. 阅读代码并识别潜在 bug
2. 检查代码风格和最佳实践
3. 提出改进建议
4. 验证逻辑正确性

审查时请关注：
- 边界条件处理
- 错误处理完整性
- 类型安全
- 性能问题
```

```typescript
// Agent 定义在启动时自动加载 .fengagent/agents/*.md
// 使用 frontmatter 解析配置，body 作为系统提示

// 通过 task 工具派遣
// task({ description: "审查 auth 模块", prompt: "...", subagent_type: "code-reviewer" })
```

### 4.5 插件系统（Stage 4）

```typescript
// 插件接口设计（参考 opencode plugin + pi extension）

interface FengPlugin {
  name: string;
  version: string;

  // 初始化
  init?(context: PluginContext): Promise<void>;

  // 注册扩展点
  registerTools?(registry: ToolRegistry): void;
  registerProviders?(registry: ProviderRegistry): void;
  registerHooks?(registry: HookRegistry): void;
  registerCommands?(registry: CommandRegistry): void;
}

interface PluginContext {
  config: Config;
  workdir: string;
  logger: Logger;
}

// 插件加载
// .fengagent/plugins/my-plugin/index.ts

import { FengPlugin } from "@fengagent/core";

export default class MyPlugin implements FengPlugin {
  name = "my-plugin";
  version = "1.0.0";

  async init(ctx: PluginContext) {
    // 初始化逻辑
  }

  registerTools(registry: ToolRegistry) {
    registry.register(myCustomTool);
  }

  registerHooks(registry: HookRegistry) {
    registry.register("pre-tool-use", (toolName, input) => {
      console.log(`工具 ${toolName} 即将执行`);
      return { allowed: true };
    });
  }
}
```

### 4.6 Hook 系统（Stage 4）

```typescript
// 生命周期 Hook 注册

interface HookRegistry {
  // 工具执行前（可阻止）
  register(event: "pre-tool-use", handler: PreToolUseHook): void;

  // 工具执行后（可修改结果）
  register(event: "post-tool-use", handler: PostToolUseHook): void;

  // 压缩前（可修改压缩策略）
  register(event: "pre-compact", handler: PreCompactHook): void;

  // 压缩后（可修改摘要）
  register(event: "post-compact", handler: PostCompactHook): void;

  // 会话开始
  register(event: "session-start", handler: SessionStartHook): void;

  // 轮次结束
  register(event: "turn-end", handler: TurnEndHook): void;
}

type PreToolUseHook = (
  toolName: string,
  input: unknown,
  context: HookContext
) => Promise<{ allowed: boolean; reason?: string }>;

type PostToolUseHook = (
  toolName: string,
  input: unknown,
  result: ToolResult,
  context: HookContext
) => Promise<ToolResult>; // 可修改结果
```

---

## 5. 配置系统设计

### 5.1 配置分层架构

```
配置优先级（从低到高）:

┌────────────────────────────────────────────┐
│ 1. 内置默认值 (DEFAULT_CONFIG)              │  ← 代码中定义
│    model: "claude-sonnet-4-20250514"       │
│    maxTokens: 8192                          │
│    contextWindow: 200000                    │
│    ...                                      │
└────────────────────┬───────────────────────┘
                     │ 覆盖
┌────────────────────┴───────────────────────┐
│ 2. 全局配置 (~/.fengagent/config.json)      │  ← 用户级
│    { "model": "gpt-4o", "maxTokens": 4096 }│
└────────────────────┬───────────────────────┘
                     │ 覆盖
┌────────────────────┴───────────────────────┐
│ 3. 项目配置 (./.fengagent/config.json)      │  ← 项目级
│    { "model": "claude-opus-4" }            │
└────────────────────┬───────────────────────┘
                     │ 覆盖
┌────────────────────┴───────────────────────┐
│ 4. 环境变量 (FENG_*)                        │  ← 运行时
│    FENG_MODEL=claude-3-haiku               │
│    FENG_SERVER_PORT=8080                    │
└────────────────────┬───────────────────────┘
                     │ 覆盖
┌────────────────────┴───────────────────────┐
│ 5. 命令行参数 (--model, --port)             │  ← 最高优先级
│    fengagent --model gpt-4o --port 3000    │
└────────────────────────────────────────────┘
```

### 5.2 配置 Schema

```typescript
// packages/core/src/config.ts

import { z } from "zod";

export const ConfigSchema = z.object({
  // 模型配置
  model: z.string().default("claude-sonnet-4-20250514"),
  smallModel: z.string().default("claude-haiku-3"),
  provider: z.string().default("anthropic"),
  fallbackModel: z.string().optional(),
  maxTokens: z.number().default(8192),
  temperature: z.number().default(1.0),

  // 上下文配置
  contextWindow: z.number().default(200000),
  compactThreshold: z.number().default(0.85),
  compactKeepTokens: z.number().default(8000),
  compactBuffer: z.number().default(20000),
  disableCompact: z.boolean().default(false),
  toolOutputMaxChars: z.number().default(2000),

  // 服务配置
  serverPort: z.number().default(3000),
  serverHost: z.string().default("127.0.0.1"),
  corsOrigin: z.string().default("*"),

  // 工具配置
  autoApproveTools: z.boolean().default(false),
  allowedTools: z.string().default("*"),
  deniedTools: z.string().optional(),
  bashTimeout: z.number().default(120000),
  maxToolConcurrency: z.number().default(10),

  // 运行配置
  maxTurns: z.number().default(50),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  dataDir: z.string().default("~/.fengagent"),
});

export type Config = z.infer<typeof ConfigSchema>;
```

### 5.3 配置加载流程

```typescript
// packages/agent/src/config-loader.ts

export async function loadConfig(
  cliArgs: Partial<Config>
): Promise<Config> {
  // 1. 内置默认值
  let config = ConfigSchema.parse({});

  // 2. 全局配置
  const globalConfig = await readJsonFile("~/.fengagent/config.json");
  config = { ...config, ...globalConfig };

  // 3. 项目配置（向上查找）
  const projectConfig = await findAndReadConfig(".fengagent/config.json");
  config = { ...config, ...projectConfig };

  // 4. 环境变量
  config = applyEnvVars(config, process.env);

  // 5. 命令行参数
  config = { ...config, ...cliArgs };

  // 最终校验
  return ConfigSchema.parse(config);
}

function applyEnvVars(config: Config, env: Record<string, string>): Config {
  return {
    ...config,
    model: env.FENG_MODEL ?? config.model,
    provider: env.FENG_PROVIDER ?? config.provider,
    maxTokens: env.FENG_MAX_TOKENS ? parseInt(env.FENG_MAX_TOKENS) : config.maxTokens,
    contextWindow: env.FENG_CONTEXT_WINDOW
      ? parseInt(env.FENG_CONTEXT_WINDOW) : config.contextWindow,
    serverPort: env.FENG_SERVER_PORT
      ? parseInt(env.FENG_SERVER_PORT) : config.serverPort,
    // ... 其他环境变量映射
  };
}
```

### 5.4 配置文件示例

```jsonc
// ~/.fengagent/config.json
{
  // 默认模型
  "model": "claude-sonnet-4-20250514",

  // 小模型（压缩/摘要用）
  "smallModel": "claude-haiku-3",

  // 上下文窗口
  "contextWindow": 200000,
  "compactThreshold": 0.85,
  "compactKeepTokens": 8000,

  // 工具权限
  "autoApproveTools": false,
  "allowedTools": "*",
  "bashTimeout": 120000,

  // 日志
  "logLevel": "info"
}
```

```jsonc
// ./.fengagent/config.json (项目级)
{
  // 项目使用更大的上下文
  "contextWindow": 200000,

  // 项目允许的工具
  "allowedTools": "file-read,file-write,file-edit,bash,glob,grep",

  // 项目自定义 Agent
  // .fengagent/agents/ 下的 .md 文件自动加载
}
```

---

## 6. 关键技术方案

### 6.1 Agent Loop 实现

```typescript
// packages/agent/src/loop.ts

export class AgentLoop {
  constructor(
    private llmClient: LLMClient,
    private toolRegistry: ToolRegistry,
    private toolExecutor: ToolExecutor,
    private contextManager: ContextManager,
    private config: Config,
  ) {}

  async *run(session: Session): AsyncGenerator<AgentEvent> {
    let needsContinuation = true;
    let step = 0;

    while (needsContinuation && step < this.config.maxTurns) {
      step++;

      // 1. 组装上下文
      const context = await this.contextManager.assemble(session);

      // 2. 检查并执行压缩
      if (this.contextManager.shouldCompact(context)) {
        yield { type: "compaction-start" };
        const compacted = await this.contextManager.compact(
          session.messages,
          { keepTokens: this.config.compactKeepTokens }
        );
        session.messages = [
          { role: "system", content: [{ type: "text", text: compacted.summary }] },
          ...compacted.recent,
        ];
        yield { type: "compaction-end", summary: compacted.summary };
      }

      // 3. 准备工具
      const tools = this.toolRegistry.materialize();
      // 最后一轮禁用工具
      const toolChoice = step >= this.config.maxTurns ? "none" : undefined;

      // 4. 调用 LLM
      const assistantMessage: ContentBlock[] = [];
      const toolCalls: ToolCall[] = [];

      yield { type: "message-start", messageId: generateId(), role: "assistant" };

      for await (const event of this.llmClient.stream({
        model: session.model,
        system: context.system,
        messages: context.messages,
        tools: toolChoice === "none" ? undefined : tools,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      })) {
        switch (event.type) {
          case "text-delta":
            assistantMessage.push({ type: "text", text: event.text });
            yield { type: "text-delta", messageId: "", text: event.text };
            break;

          case "tool-call":
            toolCalls.push({
              id: event.id,
              name: event.name,
              input: event.input,
            });
            yield {
              type: "tool-call-start",
              toolUseId: event.id,
              name: event.name,
              input: event.input,
            };
            break;

          case "usage":
            yield { type: "usage", ...event };
            break;

          case "finish":
            break;

          case "error":
            yield { type: "error", error: event.error };
            return;
        }
      }

      yield { type: "message-end", messageId: "" };

      // 5. 执行工具
      if (toolCalls.length > 0) {
        const results = await this.toolExecutor.executeBatch(toolCalls, session);
        for (const result of results) {
          yield {
            type: "tool-call-result",
            toolUseId: result.toolUseId,
            result,
          };
        }

        // 将工具结果加入历史
        session.messages.push(
          { role: "assistant", content: assistantMessage },
          ...results.map(r => ({
            role: "user" as const,
            content: [{
              type: "tool-result" as const,
              toolUseId: r.toolUseId,
              content: r.content,
              isError: r.isError,
            }],
          }))
        );

        needsContinuation = true;
      } else {
        // 无工具调用，结束循环
        session.messages.push({
          role: "assistant",
          content: assistantMessage,
        });
        needsContinuation = false;
      }

      yield {
        type: "turn-end",
        reason: needsContinuation ? "tool_use" : "end_turn",
      };
    }
  }
}
```

### 6.2 流式输出方案

#### CLI 模式（进程内）

```
Agent Loop ──► AsyncGenerator<AgentEvent>
                    │
                    ▼
              Ink TUI Component
              ├── useAgentEvent() Hook
              ├── 实时更新消息列表
              └── 渲染工具调用卡片
```

#### WebUI 模式（HTTP + SSE）

```
Browser (React)
    │
    ├── POST /api/sessions/:id/messages { content }
    │        │
    │        ▼
    │    Server (Hono)
    │    ├── agent.prompt(content)
    │    └── 设置 SSE 响应头
    │
    ├── GET /api/sessions/:id/events (SSE 连接)
    │        │
    │        ▼
    │    Server 推送 AgentEvent
    │    ├── event: text-delta
    │    │   data: {"text":"..."}
    │    ├── event: tool-call-start
    │    │   data: {"name":"...","input":{...}}
    │    └── event: turn-end
    │        data: {"reason":"end_turn"}
    │
    ▼
React useSSE() Hook
    ├── 解析 SSE 事件
    ├── 更新消息状态
    └── 渲染 UI
```

```typescript
// packages/server/src/routes/stream.ts

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

app.post("/api/sessions/:id/messages", async (c) => {
  const sessionId = c.req.param("id");
  const { content } = await c.req.json();

  const session = sessionManager.get(sessionId);
  const agent = agentManager.get(sessionId);

  return streamSSE(c, async (stream) => {
    const eventStream = agent.prompt(content);

    for await (const event of eventStream) {
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      });
    }
  });
});
```

### 6.3 会话持久化方案

```typescript
// packages/agent/src/session.ts

import { Database } from "bun:sqlite";

export class SessionStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        model TEXT,
        status TEXT,
        token_count INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        role TEXT,
        content TEXT,  -- JSON serialized ContentBlock[]
        created_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at);
    `);
  }

  saveSession(session: Session): void {
    this.db.query(`
      INSERT OR REPLACE INTO sessions
      (id, title, model, status, token_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.title, session.model,
      session.status, session.tokenCount,
      session.createdAt, session.updatedAt
    );
  }

  saveMessage(sessionId: string, message: Message): void {
    this.db.query(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      message.id, sessionId, message.role,
      JSON.stringify(message.content),
      message.createdAt
    );
  }

  loadSession(sessionId: string): Session | null {
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId);
    if (!row) return null;

    const messages = this.db.query(
      "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at"
    ).all(sessionId);

    return {
      ...row,
      messages: messages.map(m => ({
        ...m,
        content: JSON.parse(m.content),
      })),
    };
  }

  listSessions(): SessionMeta[] {
    return this.db.query(
      "SELECT id, title, model, status, created_at, updated_at FROM sessions ORDER BY updated_at DESC"
    ).all();
  }
}
```

### 6.4 编译二进制方案

```typescript
// scripts/build.ts

import { $ } from "bun";

// 编译独立二进制
await $`bun build ./packages/cli/src/entry.ts \
  --compile \
  --target=bun \
  --outfile=./dist/fengagent \
  --minify \
  --define process.env.FENG_VERSION=${VERSION} \
  --define process.env.FENG_BUILD_TIME=${Date.now()}`;

// 跨平台编译
const targets = [
  { target: "bun-windows-x64", outfile: "dist/fengagent-win-x64.exe" },
  { target: "bun-linux-x64", outfile: "dist/fengagent-linux-x64" },
  { target: "bun-darwin-arm64", outfile: "dist/fengagent-darwin-arm64" },
];

for (const { target, outfile } of targets) {
  await $`bun build ./packages/cli/src/entry.ts \
    --compile \
    --target=${target} \
    --outfile=${outfile} \
    --minify`;
}
```

```typescript
// packages/cli/src/entry.ts

// 编译后的入口点
// 支持: fengagent (CLI 模式) / fengagent serve (WebUI 模式)

const args = process.argv.slice(2);
const command = args[0];

if (command === "serve" || command === "server") {
  // 启动 WebUI 服务
  const { startServer } = await import("@fengagent/server");
  await startServer();
} else {
  // 默认 CLI 模式
  const { startCLI } = await import("./tui/app");
  await startCLI();
}
```

### 6.5 权限审批方案

```
工具执行请求
    │
    ▼
检查 autoApproveTools 配置
    │
    ├── true ──► 直接执行
    │
    ├── false
    │   │
    │   ▼
    │   检查工具是否在 allowedTools 列表
    │   │
    │   ├── 在列表中 ──► 直接执行
    │   │
    │   ├── 不在列表中
    │   │   │
    │   │   ▼
    │   │   询问用户
    │   │   │
    │   │   ├── CLI: Ink 渲染确认对话框
    │   │   │       └── 用户按 y/n
    │   │   │
    │   │   ├── WebUI: 推送 permission-request SSE 事件
    │   │   │       └── 用户点击 Allow/Deny
    │   │   │       └── POST /api/sessions/:id/permissions/:reqId
    │   │   │
    │   │   ▼
    │   │   用户决策
    │   │   ├── allow ──► 执行工具
    │   │   └── deny  ──► 返回 "权限被拒绝"
    │   │
    │   └── 在 deniedTools 列表中 ──► 直接拒绝
    │
    ▼
执行工具或返回拒绝
```

### 6.6 上下文压缩实现

```typescript
// packages/context/src/compaction.ts

const SUMMARY_TEMPLATE = `请总结以下对话历史，保留关键信息：

## 目标
{用户的主要目标和意图}

## 已完成的工作
{列出已完成的操作和结果}

## 当前状态
{当前进展和阻塞项}

## 下一步
{接下来需要做什么}

## 相关文件
{涉及的关键文件路径}

---

以下是需要总结的对话历史：
{conversation_history}
`;

export async function compact(
  messages: Message[],
  options: CompactionOptions,
  llmClient: LLMClient,
): Promise<{ summary: string; recent: Message[] }> {
  // 1. 估算总 Token
  const totalTokens = estimateTokens(messages);

  // 2. 选择分割点
  const cutPoint = findCutPoint(messages, options.keepTokens);

  // 3. 分割
  const head = messages.slice(0, cutPoint);
  const recent = messages.slice(cutPoint);

  // 4. 生成摘要
  const summaryPrompt = SUMMARY_TEMPLATE.replace(
    "{conversation_history}",
    head.map(m => `${m.role}: ${m.content.map(c => c.text ?? "").join("")}`).join("\n")
  );

  const response = await llmClient.generate({
    model: options.smallModel,
    system: "你是一个对话摘要助手。请简洁准确地总结对话历史。",
    messages: [{ role: "user", content: [{ type: "text", text: summaryPrompt }] }],
    maxTokens: 2000,
  });

  const summary = response.content
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("");

  // 5. 返回摘要 + 近期消息
  return { summary, recent };
}

function findCutPoint(messages: Message[], keepTokens: number): number {
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    tokens += estimateTokens(messages[i]);
    if (tokens >= keepTokens) {
      return i + 1;
    }
  }
  return 0;
}
```

---

## 附录：设计决策记录

### ADR-001: 选择 AsyncGenerator 而非 EventEmitter

**决策**：Agent Loop 和 LLM 调用使用 `AsyncGenerator<AgentEvent>` 而非 EventEmitter。

**理由**：
- 天然支持背压（消费者控制节奏）
- 更好的类型安全（TypeScript 原生支持）
- 更易组合（可以 `for await...of` 消费）
- 参考 pi/openclaw 的 EventStream 设计

**影响**：所有流式接口都基于 AsyncGenerator。

### ADR-002: 选择 SQLite 而非 JSON 文件做持久化

**决策**：会话持久化使用 SQLite（`bun:sqlite`）而非 JSON 文件。

**理由**：
- Bun 内置 SQLite 支持，零额外依赖
- 支持索引查询，会话列表/搜索性能好
- 并发安全（WAL 模式）
- 参考 opencode 的 SQLite + Drizzle 方案

**影响**：数据存储层抽象为 `SessionStore` 接口，未来可替换为其他后端。

### ADR-003: CLI 和 Server 共享 Agent 核心

**决策**：CLI 和 HTTP Server 都直接引用 `@fengagent/agent`，而非 Server 包装 CLI。

**理由**：
- Agent 核心是纯逻辑，不绑定 IO 模式
- CLI 进程内调用性能最优（无 HTTP 开销）
- Server 为 WebUI 提供 HTTP 接口
- 参考 Hummingbird 的 free-code（CLI 直引 Agent）模式

**影响**：Agent 必须同时支持进程内调用和 HTTP 封装。

### ADR-004: 不使用 Effect 框架

**决策**：使用标准 async/await + Zod，不引入 Effect 框架。

**理由**：
- 学习曲线低，团队上手快
- MVP 阶段复杂度收益不对等
- 标准 TS 生态更广，第三方集成更容易
- 未来如需更复杂的服务组合可渐进引入

**影响**：手动管理依赖注入和错误处理，代码量略多但更直观。
