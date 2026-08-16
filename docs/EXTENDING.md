# 扩展指南（refactor/cordis-graph-architecture）

> 本文档适用于 `refactor/cordis-graph-architecture` 分支。本分支的扩展以 **Cordis 插件**为
> 一等公民：模型/工具/策略/存储/上下文/Loop/图/事件全部是 `ctx.*` 服务，换插件即换能力。
> 旧的直接注册方式（`createAgent` / `registerBuiltinTools`）仍然可用（经适配器薄包裹），
> 但**推荐走 Cordis 插件**。

## 添加新模型 Provider

### 步骤

1. 在 `packages/llm/src/providers/` 下创建 Provider 文件
2. 实现 `LLMClient` 接口
3. 在 `packages/llm/src/providers/index.ts` 注册（`createProvider`）
4. 通过 `FENG_PROVIDER` 环境变量使用（`ctx.model` / `feng.model` 插件经 `createClient` 装配）

> 在 Cordis 分支上，`ctx.model`（`feng.model` 插件）调用 `createClient` 创建 LLM Client，
> 并支持 `ReloadableLLMClient` 热切换（`/provider`、`/model` 命令底座）。
> 新 Provider 注册后即可在 `/provider set <type>` 中使用。

### 示例

```typescript
// packages/llm/src/providers/my-provider.ts

import type { LLMClient, LLMRequest, LLMResponse } from "../client.ts";
import type { LLMEvent } from "../types.ts";

export class MyProviderClient implements LLMClient {
  constructor(private apiKey: string, private baseUrl: string) {}

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    // 1. 将 LLMRequest 转换为 Provider 特有的请求格式
    const body = this.convertRequest(request);

    // 2. 发起 HTTP 请求（SSE 流）
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    // 3. 解析 SSE 流，转换为统一的 LLMEvent
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += value;
      while (true) {
        const idx = buffer.indexOf("\n\n");
        if (idx === -1) break;

        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const event = this.convertEvent(chunk);
        if (event) yield event;
      }
    }
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    // 非流式调用：收集 stream 事件后折叠
    const events: LLMEvent[] = [];
    for await (const event of this.stream(request)) {
      events.push(event);
    }
    // 转换为 LLMResponse
    return this.eventsToResponse(events);
  }

  private convertRequest(req: LLMRequest): unknown { /* ... */ }
  private convertEvent(chunk: string): LLMEvent | null { /* ... */ }
  private eventsToResponse(events: LLMEvent[]): LLMResponse { /* ... */ }
}
```

### 注册

```typescript
// packages/llm/src/providers/index.ts

import { MyProviderClient } from "./my-provider.ts";

export function createProvider(config: Config): LLMClient {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicClient(config);
    case "openai":
      return new OpenAIClient(config);
    case "my-provider":
      return new MyProviderClient(
        process.env.MY_PROVIDER_API_KEY!,
        process.env.MY_PROVIDER_BASE_URL!,
      );
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
```

### 使用

```bash
export FENG_PROVIDER=my-provider
export MY_PROVIDER_API_KEY=xxx
export MY_PROVIDER_BASE_URL=https://api.example.com
```

---

## 添加新工具

### 步骤（Cordis 分支推荐：插件注册）

1. 在 `packages/tools/src/builtin/` 下创建工具文件（或直接写在用户插件里）
2. 实现 `ToolDefinition` 接口
3. 在 `packages/tools/src/builtin/index.ts` 注册（`registerBuiltinTools`），
   或经 Cordis 插件 `ctx.tools` 注册（见「添加插件」）
4. 工具自动出现在 LLM 的可用工具列表中

### 示例

```typescript
// packages/tools/src/builtin/search-docs.ts

import { z } from "zod";
import type { ToolDefinition, ToolResult, ToolContext } from "@fengagent/core";

export const searchDocsTool: ToolDefinition<
  { query: string },
  { content: string; metadata: { count: number } }
> = {
  name: "search-docs",
  description: "搜索项目文档中的内容。输入搜索关键词，返回匹配的文档片段。",

  inputSchema: z.object({
    query: z.string().describe("搜索关键词"),
  }),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ action: "allow" }),

  async execute(input, context: ToolContext) {
    const results = await searchInDocs(input.query, context.workdir);

    return {
      content: results.map((r) => r.text).join("\n---\n"),
      metadata: { count: results.length },
    };
  },
};
```

### 注册

```typescript
// packages/tools/src/builtin/index.ts

import { searchDocsTool } from "./search-docs.ts";

export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  // ...
  registry.register(searchDocsTool); // 新工具
}
```

### 工具安全属性

| 属性 | 说明 | 影响 |
|------|------|------|
| `isReadOnly()` | 是否只读 | 只读工具可并行执行 |
| `isDestructive()` | 是否破坏性 | 破坏性工具需要权限审批 |
| `isConcurrencySafe()` | 是否可并行 | 不可并行的工具串行执行 |
| `checkPermissions()` | 权限检查 | 返回 allow / deny / ask |

---

## 添加新 Agent

### 步骤

1. 在 `.fengagent/agents/` 下创建 `.md` 文件
2. 使用 frontmatter 配置 Agent 属性
3. body 作为系统提示

### 示例

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

### 通过 Task 工具使用

主 Agent 可通过 `task` 工具派遣子 Agent：

```typescript
// 主 Agent 调用 task 工具
task({
  description: "审查 auth 模块",
  prompt: "请审查 src/auth/ 目录下的代码",
  subagent_type: "code-reviewer",
});
```

子 Agent 会创建独立 Session，使用指定的 Agent 定义（系统提示 + 工具集 + 模型），执行完成后返回 `<task_result>` 给主 Agent。

---

## 添加插件（Cordis 插件模型）

本分支的插件是 **Cordis 插件**：函数/类/对象三种形态，通过 `ctx.plugin(plugin, config)` 装载；
插件声明 `inject` 依赖的服务，依赖就绪后才 start（声明式装配，顺序无关）。

### 内置插件

| 插件 id | 服务 | 说明 |
|---------|------|------|
| `feng.model` | `ctx.model` | LLM 调用、provider/model 热切换 |
| `feng.tools` | `ctx.tools` | 工具注册 / 查询 / 物化 / 执行 |
| `feng.strategy` | `ctx.strategy` | 压缩 / 工具选择 / 回退策略 |
| `feng.context` | `ctx.context` | 上下文组装 / 压缩 / 记忆 |
| `feng.storage` | `ctx.storage` | 会话持久化 + 图存储（双写） |
| `feng.loop` | `ctx.loop` | Agent Loop 插件 |
| `feng.graph` | `ctx.graph` | 对话图（节点/溯源/回退） |
| `feng.events` | `ctx.eventLog` | 事件溯源服务 |
| `feng.rebuild` | `ctx.rebuild` | 以事件为准重建读模型 |

### 示例：用户插件（模块路径装载）

```typescript
// .fengagent/plugins/my-plugin.ts
import type { Context } from "@fengagent/cordis";

export default function myPlugin(ctx: Context, config: { greeting?: string }) {
  // 依赖注入：声明需要 ctx.tools / ctx.graph，就绪后才执行
  ctx.inject(["tools", "graph"], () => {
    // 注册一个自定义工具到 ctx.tools
    ctx.tools.register({
      name: "my-tool",
      description: "自定义工具",
      inputSchema: /* zod schema */,
      async execute(input) {
        return { content: `Processed: ${input.input}` };
      },
    });
  });
}
```

### 装配（createRuntime 配置里加载）

```ts
// packages/cli/src/create-runtime-agent.ts（或你自己的入口）
const runtime = createRuntime({
  workdir: ".",
  plugins: [
    { id: "feng.model", config: { provider, model, createClient } },
    { id: "feng.tools", config: { tools: [/* 内置工具 */] } },
    { id: "feng.strategy", config: { contextWindow, compactThreshold } },
    { id: "feng.context", config: { manager } },
    { id: "feng.storage", config: { dbPath, graphPath } },
    { id: "feng.graph" },
    { id: "feng.loop", config: { config: { maxTurns, maxTokens, temperature }, workdir } },
    // 用户插件：id 为模块路径，动态 import
    { id: "./.fengagent/plugins/my-plugin.ts", config: { greeting: "hi" } },
  ],
});
await runtime.start();
```

> 插件生命周期：load → start（依赖满足后）→ effect / dispose（逆序卸载）。
> 换插件即换能力：把 `feng.loop` 换成 Graph 编排器、把 `feng.strategy` 换成
> LLM-as-judge 回退策略，其余插件不受影响。

### 扩展点：对话图回退策略

实现 `RollbackStrategy` 接口（`packages/graph/src/types.ts`）：
`shouldRollback(signal)` / `chooseTarget(node)`，替换 `feng.strategy` 的默认
`DefaultRollbackStrategy`，即可把回退策略换成 LLM-as-judge 自动评估。

### 扩展点：事件类型注册

在 `packages/events/src/registry.ts` 用 `registerEventType(type, validator)` 注册新事件类型，
并同步 `types.ts` 类型 + `projection.ts` 投影（含对账/迁移测试）。

---

## 添加 Skill

## 添加 Skill

### 步骤

1. 在 `.fengagent/skills/` 下创建 `.md` 文件
2. 使用 frontmatter 配置 Skill 元数据
3. body 作为可复用 Prompt 模板

### 示例

```markdown
<!-- .fengagent/skills/code-review.md -->
---
name: code-review
description: 代码审查技能 — 提供结构化的代码审查流程
trigger: review|审查|code review
---

你正在进行代码审查。请按以下步骤进行：

1. **理解上下文**：阅读相关文件，理解代码的用途和依赖
2. **检查正确性**：验证逻辑、边界条件、错误处理
3. **评估可维护性**：命名、注释、代码结构
4. **安全性检查**：输入验证、权限、敏感信息
5. **性能评估**：算法复杂度、资源使用

输出格式：
- 发现的问题（按严重程度排序）
- 改进建议
- 总体评价
```

### 通过 Skill 工具使用

Agent 可通过 `skill` 工具加载 Skill：

```typescript
skill({ name: "code-review" });
// → 加载 Skill 的 Prompt 模板并注入到上下文
```

### 内置 Skills

| Skill | 描述 |
|-------|------|
| `code-review` | 代码审查流程 |
| `debug` | 调试辅助 |
| `refactor` | 重构建议 |
| `test` | 测试编写 |

---

## 添加 Hook

### 可用 Hook

| Hook | 触发时机 | 返回值影响 |
|------|----------|-----------|
| `pre-tool-use` | 工具执行前 | `{ allowed: boolean, reason?: string }` — 可阻止执行 |
| `post-tool-use` | 工具执行后 | `ToolResult` — 可修改结果 |
| `pre-compact` | 上下文压缩前 | 可修改压缩策略 |
| `post-compact` | 上下文压缩后 | 可修改摘要 |
| `session-start` | 会话开始 | 无 |
| `turn-end` | 轮次结束 | 无 |

### 注册 Hook

通过插件注册（推荐）或直接调用 `HookRegistry`：

```typescript
// 直接注册
const hookRegistry = agent.getHookRegistry();

hookRegistry.register("pre-tool-use", async (toolName, input, context) => {
  if (toolName === "bash" && typeof input.command === "string") {
    if (input.command.includes("rm -rf")) {
      return { allowed: false, reason: "Dangerous command blocked" };
    }
  }
  return { allowed: true };
});
```

---

## 添加 MCP Server

### 配置

在 `.fengagent/mcp-servers.json` 中添加 MCP Server 配置：

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    }
  }
}
```

### 工具命名

MCP 工具自动注册到 `ToolRegistry`，名称格式为 `mcp__<server>__<tool>`。

例如 MCP Server `filesystem` 提供的工具 `read_file`，注册为 `mcp__filesystem__read_file`。

### 传输方式

| 传输 | 说明 |
|------|------|
| stdio | 子进程标准输入输出（默认，推荐） |
| SSE | HTTP SSE 连接（远程 MCP Server） |
