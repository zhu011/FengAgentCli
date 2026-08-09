
# FengAgentCli 项目开发规范

## 技术栈

- **语言**: TypeScript 5.8+（strict 模式）
- **运行时**: Bun 1.3+
- **包管理**: Bun Workspaces（monorepo）
- **测试**: `bun test`（内置测试运行器）
- **前端**: React 19+ / Vite 6+ / TailwindCSS 4+
- **后端**: Hono 4+

## 项目结构

```
packages/
├── core/       — 核心类型定义（零运行时依赖）
├── shared/     — 共享工具函数和常量
├── llm/        — LLM 客户端抽象（Anthropic, OpenAI, Bedrock, Google）
├── tools/      — 工具系统 + 内置工具 + MCP + 权限 + Hook
├── context/    — 上下文管理（压缩、记忆、系统上下文）
├── agent/      — Agent 运行时（Loop, SessionStore, 子 Agent, 插件）
├── cli/        — CLI 入口（Ink TUI + print 模式）
├── server/     — HTTP 服务（Hono + SSE）
└── web-ui/     — Web 前端（React + Vite）
```

## 构建与测试命令

```bash
# 全项目
bun install              # 安装依赖
bun run typecheck        # TypeScript 类型检查
bun test                 # 运行所有测试
bun run dev              # 启动开发环境（server + web-ui 并行）
bun run build:web-ui     # 构建前端
bun run build:binary     # 编译二进制
bun run clean            # 清理构建产物

# 单包测试
bun test packages/core
bun test packages/agent
bun test packages/tools
bun test packages/llm
bun test packages/context
bun test packages/server
```

## 包依赖规则

- `core` / `shared` — 零外部包依赖
- `llm` / `tools` / `context` — 仅依赖 `core` / `shared`
- `agent` — 依赖 `core` / `shared` / `llm` / `tools` / `context`
- `server` — 依赖 `agent` / `core` / `shared`
- `cli` — 依赖 `agent` / `core` / `shared`
- `web-ui` — 独立前端，不依赖后端包（通过 HTTP API 通信）
- **禁止循环依赖**

## 代码风格约定

- TypeScript strict 模式，启用所有检查
- 使用 `import type` 区分类型导入
- 文件命名：`kebab-case.ts`（源码）/ `PascalCase.tsx`（组件）/ `*.test.ts`（测试）
- 函数命名：`camelCase`
- 常量命名：`UPPER_SNAKE_CASE`
- 类/接口命名：`PascalCase`
- 每个公开函数/类应有 JSDoc 注释
- 测试文件放在 `__tests__/` 目录下，使用 `describe` + `test` 结构
- 环境变量统一以 `FENG_` 前缀

## 环境变量

模型配置：`FENG_MODEL`、`FENG_PROVIDER`、`FENG_MAX_TOKENS`、`FENG_TEMPERATURE`
上下文配置：`FENG_CONTEXT_WINDOW`、`FENG_COMPACT_THRESHOLD`、`FENG_DISABLE_COMPACT`
服务配置：`FENG_SERVER_PORT`、`FENG_SERVER_HOST`、`FENG_CORS_ORIGIN`
工具权限：`FENG_AUTO_APPROVE_TOOLS`、`FENG_ALLOWED_TOOLS`、`FENG_DENIED_TOOLS`

完整配置参考：`docs/CONFIGURATION.md`

## 扩展点

- 添加新模型 Provider：实现 `LLMClient` 接口 → 注册到 Provider 注册表（`packages/llm/src/providers/`）
- 添加新工具：实现 `ToolDefinition` 接口 → 注册到 `ToolRegistry`（`packages/tools/src/builtin/`）
- 添加新 Agent：在 `.fengagent/agents/*.md` 创建定义文件
- 添加插件：在 `.fengagent/plugins/` 创建插件目录，导出 `FengPlugin` 类
- 添加 Skill：在 `.fengagent/skills/*.md` 创建 Skill 定义

详细扩展指南：`docs/EXTENDING.md`
