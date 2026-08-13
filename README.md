# FengAgentCli

> 开源本地 AI Agent CLI 工具 — 在终端或浏览器中与 AI 对话，支持工具调用、多 Agent 协作、上下文压缩与权限审批。

![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-3178C6?logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-1.3+-000000?logo=bun&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-6366f1)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-a855f7)

📖 **[在线文档](docs/site/index.html)** · 📦 **[Releases](https://github.com/zhu011/FengAgentCli/releases)** · 🐛 **[Issues](https://github.com/zhu011/FengAgentCli/issues)**

---

## 特性

| 图标 | 特性 | 说明 |
|:---:|------|------|
| 💬 | **智能对话** | 多轮上下文对话，SSE 流式输出，Markdown 渲染 |
| 🤖 | **多 Agent** | Task 工具派遣子 Agent，独立 Session + 角色定义 |
| 🔧 | **工具调用** | 文件读写、Bash、Glob/Grep、Web 抓取、记忆、Skill |
| 🌐 | **WebUI** | React + Vite 暗色科技风，3 套主题切换 |
| 📦 | **上下文压缩** | 工具结果裁剪 + 结构化摘要 + 迭代更新 + 文件追踪 |
| 🧠 | **记忆系统** | MEMORY.md + 分类记忆 + TF-IDF 向量检索 |
| 📋 | **日志系统** | 运行日志 + 会话 JSONL + LLM Trace 三路落盘 |
| 📊 | **Agent 测评** | `bun run eval` 自动生成调用分析报告 |

<details>
<summary>更多特性</summary>

- **多模型支持** — Anthropic、OpenAI、OpenAI-Compatible（DeepSeek 等）、Google Gemini、AWS Bedrock
- **MCP 集成** — Model Context Protocol 客户端，自动发现外部工具
- **权限系统** — 工具执行前交互式审批（CLI 弹框 / WebUI SSE 推送）
- **插件系统** — 第三方插件加载，注册工具 / Provider / Hook / 命令
- **Skills 系统** — 可复用 Prompt 模板，关键词触发
- **会话持久化** — SQLite 主存储 + JSONL 可见副本，跨重启恢复
- **Multica ACP** — 原生支持 Multica 平台 Agent 运行时集成
- **编译二进制** — `bun build --compile` 生成独立可执行文件
</details>

## 快速开始

### 环境要求

- [Bun](https://bun.sh/) >= 1.3.0
- LLM API Key（Anthropic / OpenAI / OpenAI-Compatible / Google / Bedrock）

### 安装

```bash
git clone https://github.com/zhu011/FengAgentCli.git
cd FengAgentCli
bun install
```

### 配置 API Key

```bash
# Anthropic（默认）
export FENG_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
export FENG_PROVIDER=openai
export OPENAI_API_KEY=sk-...

# OpenAI-Compatible（DeepSeek 等）
export FENG_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_API_KEY=...
export OPENAI_COMPATIBLE_BASE_URL=https://your-endpoint/v1
```

### 运行

```bash
# CLI 交互模式（Ink TUI）
bun run packages/cli/src/entry.ts

# 管道模式（stdin → stdout）
echo "解释这段代码" | bun run packages/cli/src/entry.ts

# WebUI 模式
bun run serve                    # 访问 http://127.0.0.1:3000

# 开发模式（server + web-ui 热更新）
bun run dev                      # 后端 :3000 · 前端 :5180

# 一键 Demo（自动构建 + 启动 + 打开浏览器）
bash scripts/demo.sh             # Linux/macOS
powershell -ExecutionPolicy Bypass -File scripts/demo.ps1  # Windows
```

## 项目结构

```
packages/
├── core/       — 核心类型定义（Config, Session, AgentEvent, Tool, Permission）
├── shared/     — 共享工具函数、常量、日志
├── llm/        — LLM 客户端（Anthropic, OpenAI, Bedrock, Google）
├── tools/      — 内置工具 + MCP 集成 + 权限系统 + Hook
├── context/    — 上下文管理（压缩、记忆、系统上下文）
├── agent/      — Agent 运行时（Loop, SessionStore, 子 Agent, 插件）
├── cli/        — CLI 入口（Ink TUI + print 模式）
├── server/     — HTTP 服务（Hono + SSE + 权限交互）
├── eval/       — Agent 测评模块（LLM Trace 分析报告）
└── web-ui/     — Web 前端（React + Vite + TailwindCSS）
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FENG_MODEL` | `claude-sonnet-4-20250514` | 主模型 ID |
| `FENG_PROVIDER` | `anthropic` | LLM 提供商 |
| `FENG_MAX_TOKENS` | `8192` | 单次生成最大 token 数 |
| `FENG_TEMPERATURE` | `1.0` | 生成温度（0–2） |
| `FENG_CONTEXT_WINDOW` | `200000` | 上下文窗口大小（token） |
| `FENG_COMPACT_THRESHOLD` | `0.85` | 压缩触发阈值 |
| `FENG_AUTO_APPROVE_TOOLS` | `false` | 自动批准工具调用 |
| `FENG_SERVER_PORT` | `3000` | HTTP 服务端口 |
| `FENG_SERVER_HOST` | `127.0.0.1` | 服务监听地址 |
| `FENG_LOG_LEVEL` | `info` | 日志级别（debug/info/warn/error） |
| `FENG_MAX_TURNS` | `50` | Agent 循环最大轮次 |

完整配置参考：[docs/CONFIGURATION.md](docs/CONFIGURATION.md)

## 开发命令

```bash
bun install              # 安装依赖
bun run typecheck        # TypeScript 类型检查
bun test                 # 运行所有测试
bun run dev              # 启动开发环境
bun run build:web-ui     # 构建前端
bun run build:binary     # 编译二进制
bun run eval             # 运行 Agent 测评
bun run clean            # 清理构建产物
```

## 文档

| 文档 | 说明 |
|------|------|
| [在线文档站](docs/site/index.html) | 交互式文档（暗色主题） |
| [架构设计](docs/ARCHITECTURE.md) | 系统架构与模块设计 |
| [配置参考](docs/CONFIGURATION.md) | 环境变量、配置文件、权限规则 |
| [开发指南](docs/DEVELOPMENT.md) | 本地开发、测试、构建流程 |
| [模块接口](docs/MODULES.md) | 各包 API 接口说明 |
| [扩展指南](docs/EXTENDING.md) | 添加 Provider / 工具 / 插件 / Agent |
| [产品需求](docs/PRD.md) | 产品需求文档 |

## Docker

```bash
docker build -t fengagent .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... -e FENG_PROVIDER=anthropic fengagent
```

## 贡献

1. Fork 项目并创建特性分支
2. 确保 `bun run typecheck` 和 `bun test` 通过
3. 新功能需包含测试用例
4. 提交 PR 时描述清楚变更内容和动机

## License

[MIT](LICENSE)
