# 开发指南

## 开发环境搭建

### 前置要求

- [Bun](https://bun.sh/) >= 1.3.0
- [Git](https://git-scm.com/)
- LLM API Key（用于测试 Agent 功能）

### 初始化

```bash
git clone https://github.com/zhu011/FengAgentCli.git
cd FengAgentCli
bun install
```

### 验证安装

```bash
# 类型检查通过
bun run typecheck

# 测试全部通过
bun test
```

## Monorepo 结构

项目使用 Bun Workspaces 管理 monorepo。根 `package.json` 定义了 `workspaces: ["packages/*"]`，每个子包有自己的 `package.json`。

### 包一览

| 包 | 路径 | 职责 |
|---|------|------|
| `@fengagent/shared` | `packages/shared/` | 工具函数、常量 |
| `@fengagent/core` | `packages/core/` | 核心类型定义、配置 Schema |
| `@fengagent/llm` | `packages/llm/` | LLM Provider 抽象 |
| `@fengagent/tools` | `packages/tools/` | 工具系统、内置工具、MCP、权限、Hook |
| `@fengagent/context` | `packages/context/` | 上下文管理、压缩、记忆 |
| `@fengagent/agent` | `packages/agent/` | Agent Loop、SessionStore、子 Agent |
| `@fengagent/cli` | `packages/cli/` | CLI 入口、Ink TUI |
| `@fengagent/server` | `packages/server/` | HTTP API、SSE |
| `@fengagent/web-ui` | `packages/web-ui/` | React 前端 |

### 包间依赖规则

```
shared ← 零依赖
  ↑
core ← 仅依赖 shared
  ↑
llm / tools / context ← 各依赖 core
  ↑
agent ← 依赖 llm + tools + context + core
  ↑
server / cli ← 各依赖 agent
web-ui ← 独立（HTTP 通信）
```

**禁止循环依赖。** 每个包的 `package.json` 中 `dependencies` 只能引用 `@fengagent/*` 包或第三方依赖。

### 路径映射

根 `tsconfig.json` 配置了路径映射：

```json
{
  "compilerOptions": {
    "paths": {
      "@fengagent/core": ["packages/core/src"],
      "@fengagent/shared": ["packages/shared/src"],
      "@fengagent/llm": ["packages/llm/src"],
      ...
    }
  }
}
```

导入时使用包名（不是相对路径）：

```typescript
import { type Message } from "@fengagent/core";
import { generateId } from "@fengagent/shared";
```

## 开发命令

### 全项目命令

| 命令 | 说明 |
|------|------|
| `bun install` | 安装所有依赖 |
| `bun run typecheck` | TypeScript 类型检查（`tsc --noEmit`） |
| `bun test` | 运行所有测试 |
| `bun run dev` | 启动开发环境（server:3000 + web-ui:5180 并行） |
| `bun run dev:server` | 仅启动后端 server |
| `bun run dev:web-ui` | 仅启动前端 Vite dev server |
| `bun run serve` | 生产模式启动（后端 + 静态前端） |
| `bun run build:web-ui` | 构建前端到 `packages/web-ui/dist/` |
| `bun run build:binary` | 编译独立二进制到 `dist/` |
| `bun run clean` | 清理所有构建产物 |

### 单包测试

```bash
bun test packages/core
bun test packages/agent
bun test packages/tools
bun test packages/llm
bun test packages/context
bun test packages/server
```

### 运行特定测试

```bash
bun test packages/agent/src/__tests__/loop.test.ts
bun test --filter "Agent Loop"
```

## 代码规范

### TypeScript 配置

项目使用 TypeScript strict 模式，启用了所有严格检查：

- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noImplicitReturns: true`
- `forceConsistentCasingInFileNames: true`

### 命名约定

| 类型 | 约定 | 示例 |
|------|------|------|
| 文件（源码） | `kebab-case.ts` | `file-read.ts`, `session-manager.ts` |
| 文件（组件） | `PascalCase.tsx` | `MessageList.tsx`, `ChatPage.tsx` |
| 文件（测试） | `*.test.ts` | `loop.test.ts`, `registry.test.ts` |
| 函数 | `camelCase` | `createSession()`, `sendMessage()` |
| 类/接口 | `PascalCase` | `AgentLoop`, `ToolRegistry` |
| 常量 | `UPPER_SNAKE_CASE` | `MAX_TOKENS`, `DEFAULT_MODEL` |
| 环境变量 | `FENG_*` | `FENG_MODEL`, `FENG_SERVER_PORT` |
| 类型导入 | `import type` | `import type { Message } from ...` |

### 注释规范

- 每个公开函数/类/接口应有 JSDoc 注释
- 注释使用中文（与 PRD/架构文档保持一致）
- 复杂逻辑应有行内注释说明

```typescript
/**
 * 发送消息并返回 AgentEvent 流。
 *
 * @param sessionId - 会话 ID
 * @param text - 用户消息
 * @param model - 可选模型覆盖
 * @returns AgentEvent 异步生成器
 */
async *sendMessage(sessionId: string, text: string, model?: string): AsyncGenerator<AgentEvent> {
```

### 测试规范

- 测试文件放在 `__tests__/` 目录下
- 使用 `describe` + `test` 结构
- 测试名使用中文描述
- Mock LLM 响应使用 `MockLLMClient`
- 每个公开函数至少有一个测试用例

```typescript
describe("ToolRegistry", () => {
  test("注册工具后可通过名称获取", () => {
    const registry = new ToolRegistry();
    registry.register(fileReadTool);
    expect(registry.get("file-read")).toBeDefined();
  });
});
```

## 开发流程

### 添加新功能

1. 确认功能归属的包
2. 在对应包的 `src/` 下创建文件
3. 实现功能，遵循包内已有代码风格
4. 在 `__tests__/` 下编写测试
5. 运行 `bun test <包路径>` 验证
6. 运行 `bun run typecheck` 确认无类型错误
7. 更新相关文档

### 调试

```bash
# 启动开发环境，支持热更新
bun run dev

# 启动后端 server 并查看日志
bun run dev:server

# 运行单个测试并查看详细输出
bun test packages/agent/src/__tests__/loop.test.ts --verbose
```

### 提交前检查

```bash
# 1. 类型检查
bun run typecheck

# 2. 全部测试通过
bun test

# 3. 无未使用的导入和变量（tsc 已配置）
```

## 构建与部署

### 前端构建

```bash
bun run build:web-ui
# 产物在 packages/web-ui/dist/
```

### 二进制编译

```bash
bun run build:binary
# 产物在 dist/fengagent（或 fengagent.exe）
```

跨平台编译目标：
- `bun-windows-x64`
- `bun-linux-x64`
- `bun-darwin-arm64`

### Docker 部署

```bash
docker build -t fengagent .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... fengagent
```

### Demo 部署

```bash
# Linux/macOS
bash scripts/demo.sh

# Windows
powershell -ExecutionPolicy Bypass -File scripts/demo.ps1
```

Demo 脚本自动完成：检查 API Key → 构建前端 → 启动服务 → 打开浏览器。
