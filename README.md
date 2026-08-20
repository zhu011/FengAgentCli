# FengAgentCli

> 开源本地 AI Agent CLI 工具 — 在终端或浏览器中与 AI 对话，支持工具调用、多 Agent 协作、上下文压缩与权限审批。

![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-3178C6?logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-1.3+-000000?logo=bun&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-6366f1)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-a855f7)

📖 **[在线文档](https://zhu011.github.io/FengAgentCli/)** · 👶 **[新手手册（main 分支保姆级）](docs/GUIDE.md)** · 📦 **[Releases](https://github.com/zhu011/FengAgentCli/releases)** · 🐛 **[Issues](https://github.com/zhu011/FengAgentCli/issues)**

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
- **实验沙箱** — 隔离执行环境（`sandbox` 工具），实验性文件/命令不落宿主，`copy-out` 唯一出口需审批
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

### 配置 Provider（`/provider` 命令）

在 CLI 交互模式中可用 `/provider` 命令查看或切换 LLM Provider（Anthropic / OpenAI / OpenAI-Compatible / Google），配置写入项目级 `.fengagent/config.json`，**无需改环境变量、无需重启**即可生效：

```bash
# 查看当前 Provider（apiKey 自动打码，只显示前 4 位）
/provider show

# 用参数直接配置（openai-compatible 适合 DeepSeek 等兼容端点）
/provider set openai-compatible --api-key sk-xxx --base-url https://api.deepseek.com --model deepseek-v4-pro

# 不带参数时逐项提示输入（apiKey 输入不回显）
/provider set openai-compatible
```

- **持久化**：写入 `./.fengagent/config.json`（项目级，与现有配置 deepMerge 合并），下次启动自动加载；
- **立即生效**：配置后自动重建 LLM Client 并热替换到当前 Agent，下一条消息即走新 Provider；
- **安全**：apiKey 只显示前 4 位 + `****`，输入时不回显，不写入运行日志 / llm-trace。

支持的 type：`anthropic` / `openai` / `openai-compatible` / `google`。

### 切换模型（`/model` 命令）

在 CLI 交互模式中用 `/model` 查看 / 切换当前 Provider 的模型，**持久化并立即生效**（走 `config.model` + `ReloadableLLMClient` 热替换链路，与 `/provider` 一致，Agent Loop 无需重启）：

```bash
# 列出当前 Provider 实际可用/已配置的模型
# - openai-compatible：自动拉取 {baseUrl}/models 真实目录（如 DeepSeek）
# - 其他 Provider：显示常用真实模型 ID，并标注当前模型
/model list

# 切换模型（持久化到 .fengagent/config.json，热加载生效，后续对话真实走新模型）
/model deepseek-reasoner
```

- **真实生效**：切换后更新 `config.model`（openai-compatible 同时写 `openaiCompatibleModel`），重建并热替换 LLM Client，同时更新当前会话 `session.model`——Agent Loop 每次请求都以 `session.model` 作为请求模型；
- **持久化**：写入 `./.fengagent/config.json`，重启后自动加载；
- **离线兜底**：`/model list` 拉取失败或未配置 baseUrl 时，自动回退到常见模型目录并注明。

### TUI 界面

CLI 交互模式（Ink TUI）借鉴 opencode / kimi-code / claude-code 的设计语言做了统一美化（保留 dsh-TUI 的雾蓝品牌色）：

- **主题色板**：近黑分层背景 + 暖橙/语义色，代码块与行内代码**语法高亮**；
- **标题卡片**：品牌雾蓝色调欢迎卡片 / 顶部标题条；
- **消息列表**：用户 / 助手语义色标签、细点线分隔；长对话**切片渲染**（只渲染可视窗口内的消息，超屏不再撑破布局），支持 `PgUp/PgDn`、鼠标滚轮、`Home` 回顶、`End` 回底并自动恢复贴底；
- **状态栏**：独立一行**分段 token 进度条** + 精确百分比（保留 1 位小数、极小值显示 `<0.1%`、token 计数 > 0 时至少填充 1 格、≥85% 转警告色）+ `model · tokens · session` 中点分隔信息 + 动态运行指示；
- **动态图标**：AI「思考中 / 执行工具中」显示逐帧循环动画（星形/月亮/跑马灯帧序列，`SpinnerGlyph` + `useFrameTicker`），宠物 emoji 轮播；
- **工具卡片**：语义状态图标（✓/✗/⏳）+ 状态色边框；
- **权限对话框**：琥珀色警告框，`[y] 允许 [n] 拒绝 [Esc] 取消`。

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
| [在线文档站](https://zhu011.github.io/FengAgentCli/) | 交互式文档（暗色主题） |
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
