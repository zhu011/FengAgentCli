# FengAgentCli

开源本地 AI Agent CLI 工具 — 在终端或浏览器中与 AI 对话，支持工具调用、会话持久化、上下文压缩、多 Agent 协作和权限审批。

## 特性

- **多模型支持** — Anthropic、OpenAI、OpenAI-Compatible、Google Gemini、AWS Bedrock
- **工具系统** — 文件读写、Bash 执行、Glob/Grep 搜索、Web 抓取、多 Agent 子任务派遣
- **上下文管理** — 自动压缩对话历史、Token 估算、系统上下文加载
- **记忆系统** — MEMORY.md 本地记忆 + 向量检索
- **多 Agent** — Task 工具派遣子 Agent，支持独立 Session 和角色定义
- **MCP 集成** — Model Context Protocol 客户端，自动发现外部工具
- **权限系统** — 工具执行前的交互式审批（CLI / WebUI）
- **插件系统** — 第三方插件加载，注册工具/Provider/Hook/命令
- **Skills 系统** — 可复用 Prompt 模板
- **WebUI** — React + Vite 本地网页对话，SSE 流式推送
- **编译二进制** — `bun build --compile` 生成独立可执行文件
- **Multica 兼容** — 原生支持 Multica 平台 Agent 管理

## 快速开始

### 环境要求

- [Bun](https://bun.sh/) >= 1.3.0
- LLM API Key（Anthropic / OpenAI / OpenAI-Compatible / Bedrock / Google）

### 安装

```bash
git clone https://github.com/zhu011/FengAgentCli.git
cd FengAgentCli
bun install
```

### 配置 API Key

选择一个 LLM 提供商，设置对应的环境变量：

```bash
# Anthropic（默认）
export FENG_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
export FENG_PROVIDER=openai
export OPENAI_API_KEY=sk-...

# OpenAI-Compatible（自定义端点）
export FENG_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_API_KEY=...
export OPENAI_COMPATIBLE_BASE_URL=https://your-endpoint/v1
```

### CLI 模式

```bash
# 交互式 TUI 界面
bun run packages/cli/src/entry.ts

# 非交互管道模式（stdin → stdout）
echo "解释这段代码" | bun run packages/cli/src/entry.ts

# 指定模型
bun run packages/cli/src/entry.ts --model claude-sonnet-4-20250514

# 恢复已有会话
bun run packages/cli/src/entry.ts --session <session-id>
```

### WebUI 模式（Demo）

```bash
# 一键启动（自动构建前端 + 启动服务 + 打开浏览器）
bash scripts/demo.sh          # Linux/macOS
powershell -ExecutionPolicy Bypass -File scripts/demo.ps1  # Windows

# 或手动启动
bun run serve                 # 启动后端 + 静态前端
# 浏览器访问 http://127.0.0.1:3000
```

### 开发模式

同时启动后端 server 和前端 dev server（支持热更新）：

```bash
bun run dev
# 后端 Server:  http://127.0.0.1:3000
# 前端 WebUI:   http://localhost:5180（Vite dev，自动代理 /api 到后端）
```

## 架构概览

```
packages/
├── core/       — 核心类型定义（Config, Session, AgentEvent, Tool, Permission）
├── shared/     — 共享工具函数和常量
├── llm/        — LLM 客户端抽象（Anthropic, OpenAI, Bedrock, Google）
├── tools/      — 内置工具 + MCP 集成 + 权限系统 + Hook 系统
├── context/    — 上下文管理（token 计数、压缩、记忆、系统上下文）
├── agent/      — Agent 运行时（AgentLoop, SessionStore, 子 Agent, 插件加载）
├── cli/        — CLI 入口（Ink TUI + 非交互 print 模式）
├── server/     — HTTP 服务（Hono + SSE 流式推送 + 权限交互）
└── web-ui/     — Web 前端（React + Vite + TailwindCSS）
```

详细架构设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，产品需求文档见 [docs/PRD.md](docs/PRD.md)。

## 环境变量配置

所有配置通过 `FENG_*` 环境变量设置，也可在 `~/.fengagent/config.json` 或 `./.fengagent/config.json` 中配置。

完整配置参考见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。

### 模型配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FENG_MODEL` | `claude-sonnet-4-20250514` | 主模型 ID |
| `FENG_SMALL_MODEL` | `claude-haiku-3` | 小模型（用于上下文压缩摘要） |
| `FENG_PROVIDER` | `anthropic` | LLM 提供商 |
| `FENG_MAX_TOKENS` | `8192` | 单次生成最大 token 数 |
| `FENG_TEMPERATURE` | `1.0` | 生成温度（0-2） |

### 上下文配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FENG_CONTEXT_WINDOW` | `200000` | 上下文窗口大小（token） |
| `FENG_COMPACT_THRESHOLD` | `0.85` | 压缩触发阈值（占上下文窗口比例） |
| `FENG_COMPACT_KEEP_TOKENS` | `8000` | 压缩后保留的近期 token 数 |
| `FENG_DISABLE_COMPACT` | `false` | 禁用上下文压缩 |

### 服务配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FENG_SERVER_PORT` | `3000` | HTTP 服务端口 |
| `FENG_SERVER_HOST` | `127.0.0.1` | HTTP 服务监听地址 |
| `FENG_CORS_ORIGIN` | `*` | CORS 允许来源 |

### 工具与权限配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FENG_AUTO_APPROVE_TOOLS` | `false` | 自动批准所有工具调用（跳过权限请求） |
| `FENG_ALLOWED_TOOLS` | `*` | 允许的工具列表（逗号分隔，`*` 表示全部） |
| `FENG_DENIED_TOOLS` | — | 禁止的工具列表（逗号分隔） |
| `FENG_BASH_TIMEOUT` | `120000` | bash 工具超时（毫秒） |
| `FENG_MAX_TOOL_CONCURRENCY` | `10` | 工具最大并发数 |
| `FENG_MAX_TURNS` | `50` | Agent 循环最大轮次 |

### 配置文件

除了环境变量，还支持 JSON 配置文件（优先级：环境变量 > 项目配置 > 全局配置 > 默认值）：

```bash
# 全局配置
~/.fengagent/config.json

# 项目配置
./.fengagent/config.json
```

示例：

```json
{
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "maxTokens": 8192,
  "autoApproveTools": false
}
```

细粒度权限规则（`.fengagent/permissions.json`）：

```json
{
  "rules": [
    { "tool": "bash", "action": "ask", "reason": "Shell commands require approval" },
    { "tool": "file-write", "action": "ask" },
    { "tool": "*", "action": "allow" }
  ],
  "cache": true
}
```

### MCP Server 配置

在 `.fengagent/mcp-servers.json` 中配置 MCP Server：

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  }
}
```

或通过环境变量 `FENG_MCP_SERVERS`（JSON 格式）。

## 开发指南

### Monorepo 结构

项目使用 Bun Workspaces 管理 monorepo，所有包在 `packages/` 目录下。

### 开发命令

```bash
# 安装依赖
bun install

# 类型检查
bun run typecheck

# 运行测试
bun test

# 启动开发环境（server + web-ui 并行）
bun run dev

# 构建前端
bun run build:web-ui

# 编译二进制
bun run build:binary

# 清理构建产物
bun run clean
```

### 包构建与测试

每个包可单独测试：

```bash
# 测试单个包
bun test packages/core
bun test packages/agent
bun test packages/tools
bun test packages/llm
bun test packages/context
bun test packages/server

# 运行特定测试文件
bun test packages/agent/src/__tests__/loop.test.ts
```

### 代码规范

- TypeScript 严格模式
- 使用 `import type` 区分类型导入
- 文件命名：`kebab-case.ts` / `PascalCase.tsx`
- 函数命名：`camelCase`
- 常量命名：`UPPER_SNAKE_CASE`
- 每个公开函数/类应有 JSDoc 注释
- 测试文件放在 `__tests__/` 目录下

详细开发指南见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)，各包接口说明见 [docs/MODULES.md](docs/MODULES.md)，扩展指南见 [docs/EXTENDING.md](docs/EXTENDING.md)。

## 运行日志

FengAgentCli 内置分级日志系统（`@fengagent/shared/logger`），server 和 CLI 共用，自动落盘到本地文件。

### 日志配置

| 配置 | 说明 |
|------|------|
| `FENG_LOG_LEVEL` | 日志级别：`debug` / `info`（默认）/ `warn` / `error` |

### 日志文件

所有日志文件位于 `.fengagent/logs/` 目录：

| 文件 | 格式 | 内容 |
|------|------|------|
| `fengagent-{date}.log` | 文本 | 运行日志（时间戳+模块+函数名+消息） |
| `sessions-{date}.jsonl` | JSONL | 会话消息日志（每条消息一行，含 sessionId/role/content/model/toolCalls） |
| `llm-trace-{date}.jsonl` | JSONL | LLM 请求/回复轨迹（供 eval 模块分析） |

### 会话持久化

| 存储 | 路径 | 说明 |
|------|------|------|
| SQLite（主存储） | `.fengagent/sessions.db` | 会话+消息持久化，跨重启恢复 |
| JSONL（可见副本） | `.fengagent/logs/sessions-{date}.jsonl` | 人工查看/迁移/分析用 |

### 记忆系统

| 类型 | 路径 | 说明 |
|------|------|------|
| MEMORY.md | `MEMORY.md` 或 `.fengagent/memory/MEMORY.md` | 主记忆文件（注入系统提示） |
| 分类记忆 | `.fengagent/memory/*.md` | 按分类存储的记忆文件 |
| 向量记忆 | `.fengagent/memory/vector-store.json` | TF-IDF 向量化记忆（持久化到 JSON） |

### 上下文压缩

压缩在接近上下文窗口阈值时自动触发，算法优化点：

- **工具结果裁剪**：超过阈值的旧工具结果替换为占位符（非 LLM 操作，减少 token）
- **分割点优化**：不在 tool-result 消息边界切割（防止孤儿 tool-call）
- **结构化摘要**：目标 / 约束 / 进展 / 关键决策 / 下一步 / 关键上下文 / 相关文件
- **迭代更新**：有前次摘要时传入更新而非从头生成
- **文件操作追踪**：从消息中提取已读/已改文件，附加到摘要

### 同时输出

示例日志行：
```
[2026-08-13T15:04:33.013Z] [INFO] [server] [sendMessage] entry method=POST, path=/sessions/xxx/messages
[2026-08-13T15:04:33.018Z] [INFO] [agent-loop] [run] LLM call start model=deepseek-v4-pro, messageCount=3
[2026-08-13T15:05:03.761Z] [INFO] [agent-loop] [run] turn end reason=end_turn, step=1
```

### 覆盖模块

| 模块 | 覆盖点 |
|------|--------|
| server | 请求入口、会话 CRUD、SSE 事件、interrupt、权限响应 |
| session-manager | 会话创建、sendMessage 全链路、interrupt、权限请求 |
| agent-loop | 循环启动、LLM 调用、工具调用/结果、轮次结束、错误 |
| tool-executor | 工具执行、权限决策、执行结果（含耗时） |
| permission | autoApproveTools 分支、允许/拒绝/询问决策 |
| cli | CLI 启动、配置加载、serve 模式 |

## Agent 测评模块

FengAgentCli 内置 Agent 测评模块，自动记录 LLM 请求/回复轨迹并生成分析报告。

### LLM Trace 日志

每次 LLM 调用自动记录到 `.fengagent/logs/llm-trace-{date}.jsonl`（JSONL 格式），包含：
- 时间戳、会话 ID、模型名
- 完整请求（messages、tools、参数）和完整回复（text、tool_calls、token 用量）
- 耗时、完成原因、是否为工具调用轮
- 不记录 API key

### 运行测评

```bash
# 分析今天的日志
bun run eval

# 分析指定日期
bun run eval --date=2026-08-13

# 分析所有日志
bun run eval --all

# 分析指定文件
bun run eval --file=.fengagent/logs/llm-trace-2026-08-13.jsonl
```

### 报告内容

报告输出到 `.fengagent/logs/eval-report-{date}.md`，覆盖：
- LLM 调用次数、总耗时、平均耗时
- Token 用量分布（输入/输出）
- 工具调用率、工具使用分布
- 完成原因分布（end_turn / tool_use）
- 错误率、错误详情
- 每个会话的完整轨迹
- 优化建议（工具描述、提示词、模型选择）

## Docker 部署

```bash
# 构建镜像
docker build -t fengagent .

# 运行容器
docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e FENG_PROVIDER=anthropic \
  fengagent

# 访问 http://localhost:3000
```

## 贡献指南

1. Fork 项目并创建特性分支
2. 确保代码通过 `bun run typecheck` 和 `bun test`
3. 新功能需包含测试用例
4. 提交 PR 时描述清楚变更内容和动机
5. 遵循现有代码风格和命名约定

## License

MIT
