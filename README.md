# FengAgentCli

> 开源本地 AI Agent CLI 工具（`refactor/cordis-graph-architecture` 分支）— **Cordis 插件化** +
> **对话图（Graph Engineering）/可回溯** + **事件溯源（Event Sourcing）** 架构。
> 在终端或浏览器中与 AI 对话，支持工具调用、多 Agent 协作、上下文压缩、权限审批、对话节点溯源与回退重答。

![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-3178C6?logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-1.3+-000000?logo=bun&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-6366f1)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-a855f7)

📖 **[在线文档](https://zhu011.github.io/FengAgentCli/)** · 📦 **[Releases](https://github.com/zhu011/FengAgentCli/releases)** · 🐛 **[Issues](https://github.com/zhu011/FengAgentCli/issues)**

> **分支说明**：本 README 描述 `refactor/cordis-graph-architecture` 分支（Cordis 插件化 + 对话图/可回溯 +
> 事件溯源架构）。`main` 分支为老架构（Loop 直连），数据/配置与本分支完全隔离
> （本分支数据根 `.fengagent-cordis/`，见 [ARCHITECTURE-CORDIS.md §6](docs/ARCHITECTURE-CORDIS.md)）。

---

## 特性

| 图标 | 特性 | 说明 |
|:---:|------|------|
| 💬 | **智能对话** | 多轮上下文对话，SSE 流式输出，Markdown 渲染 |
| 🕸️ | **对话图（Graph）** | 每轮「提问→回答」沉淀为节点，可溯源、可分支、可回退（`/graph`） |
| ↩️ | **回退重答（Rollback）** | `/rollback` 回退到任意节点重答，旧分支保留可审计 |
| 🧩 | **Cordis 插件化** | 模型/工具/策略/存储/上下文/Loop/图全部为可插拔服务（`ctx.*`），换插件即换能力 |
| 📜 | **事件溯源** | 会话事实以 append-only 事件日志为准（`events/{sessionId}.jsonl`），可导出/导入/重建/跨机迁移 |
| 🤖 | **多 Agent** | Task 工具派遣子 Agent，独立 Session + 角色定义 |
| 🔧 | **工具调用** | 文件读写、Bash、Glob/Grep、Web 抓取、记忆、Skill |
| 🧪 | **实验沙箱** | 临时文件/临时代码在隔离沙箱执行（路径围栏 + 环境脱敏），`copy-out` 为唯一出口需审批 |
| 🌐 | **WebUI** | React + Vite 暗色科技风，3 套主题切换 + 对话图可视化面板 |
| 📦 | **上下文压缩** | 工具结果裁剪 + 结构化摘要 + 迭代更新 + 文件追踪 |
| 🧠 | **记忆系统** | MEMORY.md + 分类记忆 + TF-IDF 向量检索 |
| 📋 | **日志系统** | 运行日志 + 会话 JSONL + LLM Trace 三路落盘 |
| 📊 | **Agent 测评** | `bun run eval` 自动生成调用分析报告（工具成功率 / KV Cache 命中率 / 模型对比） |

<details>
<summary>更多特性</summary>

- **多模型支持** — Anthropic、OpenAI、OpenAI-Compatible（DeepSeek 等）、Google Gemini、AWS Bedrock
- **MCP 集成** — Model Context Protocol 客户端，自动发现外部工具
- **权限系统** — 工具执行前交互式审批（CLI 弹框 / WebUI SSE 推送）
- **插件系统** — Cordis 插件（`ctx.plugin(plugin, config)`），内置 `feng.model` / `feng.tools` /
  `feng.strategy` / `feng.context` / `feng.storage` / `feng.loop` / `feng.graph` / `feng.events` / `feng.rebuild`
- **Skills 系统** — 可复用 Prompt 模板，关键词触发
- **会话持久化** — 事件日志为准 + SQLite 读模型，跨重启恢复，`/restore` 可重建
- **/ 联想（命令补全）** — 输入 `/` 弹出补全列表（前缀过滤、↑↓ 选择、Tab/Enter 补全）
- **长对话滚动** — 内容超屏时切片渲染，`PgUp/PgDn` / 鼠标滚轮翻阅历史，`Home` 回顶、`End` 回底
- **KV Cache 统计** — WebUI 实时显示 📥 输入 / 📤 输出 / ⚡ 缓存命中 / 🎯 命中率 / 合计 tokens
- **Multica ACP** — 原生支持 Multica 平台 Agent 运行时集成（`fengagent acp`：分层加载配置注入 LLM 环境变量，禁用 AGENTS.md 注入防对话卡死）
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

### 全局安装（`npm install -g` / `bun install -g`）

安装后任意目录直接执行 `fengagent` 即可启动 TUI：

```bash
# 方式一：npm 全局安装（已发布 npm 包 / 本地打包产物）
npm install -g fengagent
npm install -g ./fengagent-0.1.0.tgz        # 本地打包产物（bun run pack）

# 方式二：bun 全局安装
bun install -g fengagent

# 方式三：bun link（本地开发，链接到本仓库）
bun link && bun link fengagent

# 安装后直接使用
fengagent                     # 启动 TUI 交互界面
fengagent --version           # 0.1.0
fengagent "帮我读 package.json"   # 参数/管道模式
fengagent acp                 # 启动 ACP 服务（Multica 运行时）
```

- 启动器（`bin/fengagent.js`）优先执行 `dist/` 下当前平台的**预编译二进制**（`bun run build:binary` 生成，无需 Bun/Node 运行时），否则退回 `bun run packages/cli/src/entry.ts` 源码直跑。
- 打包发布：`bun run pack`（自动编译当前平台二进制 → `npm pack`），产物 `fengagent-0.1.0.tgz`。

### 注册为 Multica 运行时（其他电脑也可被检测）

Multica 桌面端通过 `~/.multica/runtimes/*.json` 发现本机自定义运行时。全局安装后执行：

```bash
fengagent runtime install      # 写入 ~/.multica/runtimes/fengagent.json
fengagent runtime uninstall    # 移除注册
```

注册内容（自动生成）：

```json
{
  "provider": "fengagent",
  "displayName": "FengAgentCli",
  "launchHeader": "fengagent acp",
  "protocol": "acp",
  "command": "fengagent",
  "args": ["acp"],
  "version": "0.1.0",
  "capabilities": ["text", "tools", "streaming", "multi-agent", "mcp"],
  "workdir": "可选：检测到项目 .fengagent/config.json 时自动写入"
}
```

- `command` 自动解析：优先 PATH 上的全局 `fengagent`；否则回退当前可执行文件绝对路径（编译二进制 / node 启动器 / bun 源码）。
- 运行时的 API Key 配置：Multica 启动运行时时若当前工作目录没有 `.fengagent/config.json`，请通过
  Multica 运行时环境变量（`OPENAI_COMPATIBLE_API_KEY` / `OPENAI_COMPATIBLE_BASE_URL` / `OPENAI_COMPATIBLE_MODEL`）或
  本机全局配置 `~/.fengagent/config.json` 提供（配置分层见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)）。

### 配置 Provider（`/provider` 命令）

在 CLI 交互模式中可用 `/provider` 命令查看或切换 LLM Provider（Anthropic / OpenAI / OpenAI-Compatible / Google），配置写入**分支级** `.fengagent-cordis/config.json`，**无需改环境变量、无需重启**即可生效：

```bash
# 查看当前 Provider（apiKey 自动打码，只显示前 4 位）
/provider show

# 用参数直接配置（openai-compatible 适合 DeepSeek 等兼容端点）
/provider set openai-compatible --api-key sk-xxx --base-url https://api.deepseek.com --model deepseek-v4-pro

# 不带参数时逐项提示输入（apiKey 输入不回显）
/provider set openai-compatible
```

- **持久化**：写入 `./.fengagent-cordis/config.json`（分支级，与现有配置 deepMerge 合并；main 的 `.fengagent/config.json` 只读回退，两分支互不干扰），下次启动自动加载；
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

# 切换模型（持久化到 .fengagent-cordis/config.json，热加载生效，后续对话真实走新模型）
/model deepseek-reasoner
```

- **真实生效**：切换后更新 `config.model`（openai-compatible 同时写 `openaiCompatibleModel`），重建并热替换 LLM Client，同时更新当前会话 `session.model`——Agent Loop 每次请求都以 `session.model` 作为请求模型；
- **持久化**：写入 `./.fengagent-cordis/config.json`（分支级，不影响 main），重启后自动加载；
- **离线兜底**：`/model list` 拉取失败或未配置 baseUrl 时，自动回退到常见模型目录并注明。

### TUI 界面

CLI 交互模式（Ink TUI）借鉴 opencode / kimi-code / claude-code 的设计语言做了统一美化
（近黑分层背景 + 暖橙/语义色强调，保留「雾蓝」品牌色 `#7DA1DE`）：

- **标题卡片**：品牌雾蓝色调欢迎卡片 / 顶部标题条；
- **消息列表**：用户 / 助手语义色标签、细点线分隔、品牌色代码块与行内代码、**代码语法高亮**（关键字/字符串/数字/函数/变量/运算符分色）；
- **长对话滚动**：内容超屏时**切片渲染**（只渲染可视窗口内的消息，边界消息按行裁剪），`PgUp` / `PgDn` 翻阅历史、**鼠标滚轮**滚动、`Home` 回顶、`End` 回底并自动恢复贴底；
- **状态栏**：上下文占用**分段进度条**独立一行（token > 0 时至少填充 1 格，百分比保留 1 位小数如 `0.2%` / `12.4%`，极小值显示 `<0.1%`，≥85% 转警告色）+ `model · tokens · session` 中点分隔信息 + 动态运行指示；
- **动态图标**：AI「思考中 / 执行工具中」显示逐帧循环动画（星形/月亮/跑马灯帧序列，`SpinnerGlyph` + `useFrameTicker`），宠物 emoji 轮播；
- **工具卡片**：语义状态图标（✓/✗/⏳）+ 状态色边框；
- **权限对话框**：琥珀色警告框，`[y] 允许 [n] 拒绝 [Esc] 取消`。

> 提示：CLI / ACP 路径默认**不注入 AGENTS.md** 到系统提示（`loadAgentsMd: false`），避免项目指令被 Agent 当作工具调用依据、形成循环导致对话卡死。

## 项目结构

```
packages/
├── core/       — 核心类型定义（Config, Session, AgentEvent, Tool, Permission）
├── shared/     — 共享工具函数、常量、日志、数据根解析（resolveDataRoot）
├── llm/        — LLM 客户端（Anthropic, OpenAI, Bedrock, Google）+ ReloadableLLMClient
├── tools/      — 内置工具 + MCP 集成 + 权限系统 + Hook
├── context/    — 上下文管理（压缩、记忆、系统上下文）
├── agent/      — Agent 运行时（Loop, SessionStore, 子 Agent）
├── cordis/     — Cordis 集成层：插件域类型 + 服务实现 + 适配器 + 配置驱动运行时（vendored @deepseek-ai/cordis）
├── graph/      — Graph Engineering 机制：对话即节点 / 可溯源 / 可回退（零运行时依赖）
├── events/     — 事件溯源：EventStore（append-only 事件日志）+ 投影 + 双写 + 导出/导入/重建/迁移
├── cli/        — CLI 入口（Ink TUI + print 模式，经 createRuntimeAgent 装配）
├── server/     — HTTP 服务（Hono + SSE + 权限交互 + /graph /rollback 端点）
├── eval/       — Agent 测评模块（LLM Trace 分析报告）
└── web-ui/     — Web 前端（React + Vite + TailwindCSS + 对话图面板）
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
| `FENG_DATA_DIR` | `.fengagent-cordis` | 数据根（会话/事件/图/日志/记忆/配置；main 遗留数据仅作只读导入源） |
| `FENG_MAIN_DATA_DIR` | — | 显式指定 main 遗留数据根（导入源） |

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
bun run scripts/events-migrate.ts verify   # 事件链校验 + 双写对账
bun run clean            # 清理构建产物
```

## 文档

| 文档 | 说明 |
|------|------|
| [在线文档站](https://zhu011.github.io/FengAgentCli/) | 交互式文档（暗色主题；在线站点对应 `main` 分支稳定版，本分支（Cordis）文档以本仓库 `docs/` 为准） |
| [小白保姆级操作手册](docs/GUIDE-CORDIS.md) | **新手推荐**：从安装到 /graph /rollback /provider /model /compact /clear /联想、事件溯源、分支隔离、测评、KV Cache 统计，每个功能都有可照抄命令 + 预期输出 |
| [架构设计（本分支）](docs/ARCHITECTURE.md) | 本分支（refactor/cordis-graph-architecture）系统架构：Cordis 插件化 + 对话图/可回溯 + 事件溯源 + 模块设计 |
| [Cordis 架构设计细节](docs/ARCHITECTURE-CORDIS.md) | 重构设计文档：插件域、Graph 机制、事件溯源、迁移路线、分支隔离（§6）、数据根隔离（§6.1） |
| [配置参考](docs/CONFIGURATION.md) | 环境变量、配置文件（含分支级 `.fengagent-cordis/config.json`）、权限规则 |
| [开发指南](docs/DEVELOPMENT.md) | 本地开发、测试、构建流程（含新包 cordis/graph/events） |
| [模块接口](docs/MODULES.md) | 各包 API 接口说明（含 cordis/events/graph） |
| [扩展指南](docs/EXTENDING.md) | 添加 Provider / 工具 / 插件（Cordis 插件模型）/ Agent / Skill / Hook / MCP |
| [实验沙箱](docs/SANDBOX.md) | `sandbox` 工具动作表、安全模型（路径围栏 / 环境脱敏 / 超时强杀 / 显式数据流通）、TypeScript 编程接口、设计取舍 |
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
