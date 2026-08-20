# 开发指南（refactor/cordis-graph-architecture）

> 本文档适用于 `refactor/cordis-graph-architecture` 分支（Cordis 插件化 + 对话图/可回溯 +
> 事件溯源架构）。架构总览见 [ARCHITECTURE.md](./ARCHITECTURE.md)，
> 重构设计细节见 [ARCHITECTURE-CORDIS.md](./ARCHITECTURE-CORDIS.md)。

## 开发环境搭建

### 前置要求

- [Bun](https://bun.sh/) >= 1.3.0
- [Git](https://git-scm.com/)
- LLM API Key（用于测试 Agent 功能）

### 初始化

```bash
git clone https://github.com/zhu011/FengAgentCli.git
cd FengAgentCli
git checkout refactor/cordis-graph-architecture   # 切到新分支
bun install
```

### 验证安装

```bash
# 类型检查通过
bun run typecheck

# 测试全部通过
bun test
```

> 提示：本分支运行时数据落在 `.fengagent-cordis/`（数据根，见 ARCHITECTURE.md §7.2），
> 与 main 的 `.fengagent/` 完全隔离，两分支同机运行互不干扰。

## Monorepo 结构

项目使用 Bun Workspaces 管理 monorepo。根 `package.json` 定义了 `workspaces: ["packages/*"]`，每个子包有自己的 `package.json`。

### 包一览

| 包 | 路径 | 职责 |
|---|------|------|
| `@fengagent/shared` | `packages/shared/` | 工具函数、常量、数据根解析（resolveDataRoot） |
| `@fengagent/core` | `packages/core/` | 核心类型定义、配置 Schema |
| `@fengagent/llm` | `packages/llm/` | LLM Provider 抽象、ReloadableLLMClient |
| `@fengagent/tools` | `packages/tools/` | 工具系统、内置工具、MCP、权限、Hook |
| `@fengagent/context` | `packages/context/` | 上下文管理、压缩、记忆 |
| `@fengagent/agent` | `packages/agent/` | Agent Loop、SessionStore、子 Agent |
| `@fengagent/cordis` | `packages/cordis/` | ★ Cordis 集成层：插件域 + 服务 + 适配器 + createRuntime |
| `@fengagent/graph` | `packages/graph/` | ★ 对话图机制：节点/溯源/回退（零运行时依赖） |
| `@fengagent/events` | `packages/events/` | ★ 事件溯源：EventStore/投影/双写/导出导入/重建/迁移 |
| `@fengagent/cli` | `packages/cli/` | CLI 入口、Ink TUI、createRuntimeAgent 装配 |
| `@fengagent/server` | `packages/server/` | HTTP API、SSE、/graph /rollback 端点 |
| `@fengagent/eval` | `packages/eval/` | Agent 测评模块（LLM Trace 分析） |
| `@fengagent/web-ui` | `packages/web-ui/` | React 前端（含对话图面板） |

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
graph ← 零运行时依赖；events ← 依赖 shared + agent
cordis ← vendored cordis + 依赖各既有实现包
  ↑
server / cli ← 各依赖 agent + cordis（+ graph / events）
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
| `bun run eval` | 运行 Agent 测评（分析 LLM Trace 日志） |
| `bun run scripts/events-migrate.ts …` | 事件溯源 CLI（list / verify / export / import / rebuild） |
| `bun run clean` | 清理所有构建产物 |

### 单包测试

```bash
bun test packages/core
bun test packages/agent
bun test packages/tools
bun test packages/llm
bun test packages/context
bun test packages/cordis      # Cordis 运行时集成测试
bun test packages/graph       # 对话图机制测试
bun test packages/events      # 事件溯源测试（含迁移 e2e）
bun test packages/cli
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

# 4. 事件对账（如改动 events / storage）
bun run scripts/events-migrate.ts verify
```

## 本分支特有开发要点

- **新功能先想清楚落在哪个域**：模型/工具/策略/存储/上下文/Loop/图/事件 —— 尽量以 Cordis
  插件（`ctx.*` 服务）表达，而不是直接改 Agent 类（见 ARCHITECTURE.md §3）；
- **对话可溯源是默认行为**：改对话流程时保持「每回合沉淀 graph 节点 + 落事件」；
- **改动 events 事件类型**：必须同步 `packages/events/src/registry.ts` 注册表 +
  `types.ts` 类型 + `projection.ts` 投影，并跑 `bun test packages/events`（含对账/迁移 e2e）；
- **数据根隔离**：新分支只写 `.fengagent-cordis/`，main 的 `.fengagent/` 只读导入源，
  绝不写回；新增持久化路径一律走 `resolveDataRoot`；
- **双写对账**：任何会话写路径改动后跑 `verify` 保证事件投影 === SQLite 读模型。

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

指定平台：`bun run build:binary -- --target=bun-linux-x64`；只编当前平台：`bun run build:binary -- --target=auto`。

### 打包与全局安装

```bash
bun run pack        # 编译当前平台二进制 + npm pack，产物 fengagent-0.1.0.tgz
npm install -g ./fengagent-0.1.0.tgz   # 全局安装，任意目录直接 `fengagent`
```

全局启动入口为 `bin/fengagent.js`（npm bin），优先执行 `dist/` 下当前平台预编译二进制，否则退回 bun 源码直跑。
`fengagent runtime install` / `uninstall` 注册 / 移除 Multica 本地运行时（`~/.multica/runtimes/fengagent.json`）。

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
