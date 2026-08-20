# FengAgentCli 小白保姆级操作手册（main 分支）

> **本手册适用于 `main` 分支（稳定版）。** 本分支所有数据与配置都放在项目根目录的 **`.fengagent/`** 下。
>
> ⚠️ **分支隔离说明**：新分支 `refactor/cordis-graph-architecture`（数据目录 `.fengagent-cordis/`）的
> **对话图 `/graph`、回退 `/rollback`、事件溯源** 等新能力**不在本手册范围**，请勿在 main 分支上使用这些命令。
> 需要新能力的同学请看新分支文档：`docs/GUIDE-CORDIS.md`（或切到该分支查看）。
>
> 手册目标：**照着复制命令就能跑通**。每个功能都给「能照抄的命令 + 预期输出」。

---

## FengAgentCli 是什么？

FengAgentCli 是一个**开源本地 AI Agent 对话平台**：在终端（TUI）或浏览器（WebUI）中与 AI 对话，
支持工具调用、多 Agent 协作、上下文压缩、权限审批、记忆系统与实验沙箱。

核心亮点：

| 亮点 | 一句话说明 |
|------|-----------|
| 💬 双端对话 | 终端 TUI 与浏览器 WebUI 同享一套 Agent 能力 |
| 🔧 工具调用 | 文件读写、Bash、搜索、记忆、Skill、MCP |
| 🧠 记忆与压缩 | 长对话记忆 + 上下文自动压缩 |
| 🧪 实验沙箱 | 临时代码在隔离沙箱执行，安全可控 |
| 📊 Agent 测评 | `bun run eval` 输出工具成功率 / KV Cache 命中率报告 |

**三分钟上手**：

```bash
git clone https://github.com/zhu011/FengAgentCli.git
cd FengAgentCli
bun install
export FENG_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_API_KEY=sk-xxx
export OPENAI_COMPATIBLE_BASE_URL=https://api.deepseek.com
bun run packages/cli/src/entry.ts        # 进入 TUI，直接开始对话
```

> 💡 对话中可用 `/provider set openai-compatible` 直接配置，无需改环境变量。

---

## 目录

1. [名词速览](#1-名词速览)
2. [环境准备（安装 Bun）](#2-环境准备安装-bun)
3. [拉取代码（main 分支）](#3-拉取代码main-分支)
4. [安装依赖](#4-安装依赖)
5. [配置模型（环境变量 / /provider 命令）](#5-配置模型环境变量--provider-命令)
6. [启动 CLI 开始对话](#6-启动-cli-开始对话)
7. [斜杠命令速查表](#7-斜杠命令速查表)
8. [/ 联想（命令补全）](#8--联想命令补全)
9. [上下文管理（自动压缩 / /compact / /clear / /restore）](#9-上下文管理自动压缩--compact--clear--restore)
10. [记忆系统](#10-记忆系统)
11. [Skill 系统（提示词模板）](#11-skill-系统提示词模板)
12. [多 Agent 与工具调用](#12-多-agent-与工具调用)
13. [WebUI 网页对话](#13-webui-网页对话)
14. [Token 与 KV Cache 统计](#14-token-与-kv-cache-统计)
15. [测评模块 bun run eval](#15-测评模块-bun-run-eval)
16. [数据目录 .fengagent/ 说明](#16-数据目录-fengagent-说明)
17. [和 cordis 新分支的关系（隔离）](#17-和-cordis-新分支的关系隔离)
18. [常见问题 FAQ](#18-常见问题-faq)
19. [相关文档](#19-相关文档)

---

## 1. 名词速览

| 名词 | 含义 |
|---|---|
| **数据目录** | main 分支所有运行时数据（会话、日志、记忆、配置）的落盘位置：**项目根 `.fengagent/`** |
| **会话（Session）** | 一次对话的完整记录，存于 `.fengagent/sessions.db`（SQLite） |
| **上下文** | 当前对话喂给模型的消息历史，过长会自动压缩 |
| **压缩（Compact）** | 上下文接近上限时自动摘要压缩，也可手动 `/compact` |
| **记忆（Memory）** | 跨会话沉淀的长期记忆，存于 `.fengagent/memory/vector-store.json` |
| **Skill** | 可复用的提示词模板，放在 `.fengagent/skills/*.md`，按关键词触发 |
| **Provider** | LLM 提供商（Anthropic / OpenAI / OpenAI-Compatible / Google / Bedrock） |
| **KV Cache** | 厂商对重复前缀 token 的缓存（如 DeepSeek 的 `prompt_cache_hit_tokens`），命中越多越省钱 |

---

## 2. 环境准备（安装 Bun）

FengAgentCli 用 [Bun](https://bun.sh/) 运行，要求 **Bun >= 1.3.0**。

**Windows（PowerShell）：**

```powershell
# 用官方安装脚本安装 Bun（一路回车即可）
powershell -c "irm bun.sh/install.ps1 | iex"

# 验证
bun --version
# 预期输出（版本号 ≥ 1.3）:
# 1.3.14
```

**macOS / Linux：**

```bash
curl -fsSL https://bun.sh/install | bash
bun --version
```

> 旧版本升级：`bun upgrade`。

---

## 3. 拉取代码（main 分支）

```bash
git clone https://github.com/zhu011/FengAgentCli.git
cd FengAgentCli
# 默认就在 main 分支；确认一下
git branch --show-current
# 预期输出:
# main
```

> 提示：不需要切换分支。默认的 `main` 就是本手册要讲的分支。

---

## 4. 安装依赖

```bash
bun install
```

预期输出：结尾出现类似 `checked N packages` 或 `done`，没有红色 error。国内网络慢可多试一次，或配置镜像：

```bash
bun install --registry https://registry.npmmirror.com
```

安装完成后自检（可选，2 分钟内出结果）：

```bash
bun run typecheck   # TypeScript 类型检查，无 error 即通过
bun test            # 运行全部测试，全绿
```

---

## 5. 配置模型（环境变量 / /provider 命令）

两种方式**二选一**即可，推荐方式 B（不用重启、不用改环境变量）。

### 方式 A：环境变量（PowerShell / bash）

以 DeepSeek（OpenAI 兼容）为例：

**PowerShell：**

```powershell
$env:FENG_PROVIDER = "openai-compatible"
$env:OPENAI_COMPATIBLE_API_KEY = "sk-你的key"
$env:OPENAI_COMPATIBLE_BASE_URL = "https://api.deepseek.com"
$env:OPENAI_COMPATIBLE_MODEL = "deepseek-chat"
```

**bash：**

```bash
export FENG_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_API_KEY=sk-你的key
export OPENAI_COMPATIBLE_BASE_URL=https://api.deepseek.com
export OPENAI_COMPATIBLE_MODEL=deepseek-chat
```

其他厂商对应的变量见 [CONFIGURATION.md](./CONFIGURATION.md)（Anthropic / OpenAI / Google / AWS Bedrock 都有）。

### 方式 B：CLI 里用 `/provider` 命令（推荐，免重启免改环境变量）

先随便起一个 CLI（见第 6 节），在对话界面输入：

```
/provider set openai-compatible --api-key sk-你的key --base-url https://api.deepseek.com --model deepseek-chat
```

预期输出：

```
✅ Provider 已配置: openai-compatible (OpenAI-Compatible)
  apiKey:   sk-13****  (已保存，不回显明文)
  baseUrl:  https://api.deepseek.com
  model:    deepseek-chat
  config:   .fengagent/config.json  (已持久化，重启后自动加载)
  ✓ 已热加载生效 — 直接发消息即可使用新 Provider
```

要点：

- 不带参数时逐项提示输入：`/provider set openai-compatible`，apiKey 输入时**不回显**（显示 `*`）；
- 配置写入**本分支** `.fengagent/config.json`（不影响新分支的 `.fengagent-cordis/config.json`），重启自动加载；
- 立即生效：配置完直接发消息就走新 Provider，无需重启。

查看当前配置：

```
/provider show
```

预期输出（apiKey 只显示前 4 位）：

```
当前 Provider 配置:
  provider: openai-compatible (OpenAI-Compatible)
  baseUrl:  https://api.deepseek.com
  model:    deepseek-chat
  apiKey:   sk-13****  (来源: 环境变量)

提示: /provider set <type> 可修改配置；apiKey 不回显明文。
```

---

## 6. 启动 CLI 开始对话

在项目根目录执行：

```bash
bun run packages/cli/src/entry.ts
```

预期输出：进入全屏 TUI 界面，顶部出现品牌标题卡片（FengAgentCli v0.2.0），下方是消息区、输入行和状态栏（token 进度条 + 模型 · tokens · 会话）。

直接输入文字回车即发送，例如：

```
你好，请介绍一下这个项目
```

AI 回答时状态栏会显示动态图标动画；回答完成后消息区出现 Markdown 渲染结果。

**非交互（管道）模式** —— 不想进界面，问一句就退出：

```bash
echo "解释这段代码" | bun run packages/cli/src/entry.ts
```

**带参数启动**：

```bash
bun run packages/cli/src/entry.ts --model deepseek-chat            # 指定模型
bun run packages/cli/src/entry.ts --session <会话id>                # 恢复历史会话
bun run packages/cli/src/entry.ts --print "一句话问题"               # 强制非交互
```

---

## 7. 斜杠命令速查表

在 CLI 对话界面输入 `/help` 可随时查看：

```
可用命令:

基础:
  /help                    — 显示帮助
  /exit                    — 退出程序
  /quit                    — 退出程序

上下文:
  /clear [context]         — 清屏（/clear context 清空上下文）
  /compact                 — 手动压缩上下文
  /restore                 — 从存储恢复会话历史

会话:
  /session new|list|switch — 会话管理

模型:
  /model <id>|list         — 模型切换
  /provider show|set <type> [--api-key ..] [--base-url ..] [--model ..] — 查看/配置 Provider

导出:
  /export [file]           — 导出会话为 Markdown

工具:
  /tool list               — 工具列表

直接输入文本并按 Enter 发送消息。
输入 / 可查看命令补全列表。
```

逐个说明（全部命令都只属于 main 分支，数据写入 `.fengagent/`）：

| 命令 | 作用 | 示例 / 预期输出要点 |
|---|---|---|
| `/session new 标题` | 新建会话 | `已新建会话: 标题 (xxxx1234)` |
| `/session list` | 列出会话 | 每行 `id 标题 [模型] 时间 ← 当前` |
| `/session switch <id>` | 切换会话 | `已切换到会话: … 消息数: N` |
| `/model list` | 列出当前 Provider 可用模型 | openai-compatible 会拉取真实 `/models` 目录，当前模型标注 `← 当前` |
| `/model <id>` | 切换模型（持久化+热加载） | 见下 |
| `/compact` | 手动压缩上下文 | 显示压缩摘要结果（内容多时有效） |
| `/clear context` | 清空当前会话上下文 | `已清空当前会话上下文…使用 /restore 恢复` |
| `/clear` | 仅清屏 | 界面刷新，会话保留 |
| `/restore` | 从 SQLite 恢复会话历史 | `已恢复会话历史: N 条消息` |
| `/export 文件名.md` | 导出会话为 Markdown | `已导出 N 条消息到: 文件名.md` |
| `/tool list` | 查看已注册工具 | `已注册工具 (N): bash, file-read, …` |
| `/exit` | 退出 | `再见！` |

`/model` 切换示例（在 CLI 内输入）：

```
/model deepseek-reasoner
```

预期输出：

```
✅ 已切换模型: deepseek-chat → deepseek-reasoner
  config: .fengagent/config.json  (已持久化，重启后自动加载)
  ✓ 已热加载生效 — 后续对话将使用新模型
```

---

## 8. / 联想（命令补全）

在 CLI 对话界面输入 `/`（或 `/` + 前缀），输入框正上方会弹出**命令补全列表**：

- 按前缀过滤：输入 `/m` 只显示 `/model`、`/model list` 等匹配命令（也按描述匹配）；
- `↑` `↓` 选择，`Tab` 或 `Enter` 补全到输入框，`Esc` 关闭列表；
- 命令多时列表可滚动，顶部/底部有 `↑ 还有 N 个命令` / `↓ 还有 N 个命令` 提示；
- 底部提示行：`↑↓选择 · Tab补全 · Esc关闭 · Enter提交`。

> 注：补全列表来自集中维护的命令元数据表（`packages/cli/src/commands.ts` 的 `COMMANDS`），
> 新命令加进表后自动出现在 `/` 联想里。

---

## 9. 上下文管理（自动压缩 / /compact / /clear / /restore）

FengAgentCli 的上下文管理分三层，全自动为主，小白不用操心：

### 9.1 自动压缩（默认开启）

当对话接近上下文窗口上限时，系统自动把中段历史**摘要压缩**（结构化摘要 + 工具结果裁剪），
保留近期对话。相关环境变量：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `FENG_CONTEXT_WINDOW` | `200000` | 上下文窗口大小（token） |
| `FENG_COMPACT_THRESHOLD` | `0.85` | 达到窗口 85% 时触发自动压缩 |
| `FENG_COMPACT_KEEP_TOKENS` | `8000` | 压缩后保留的近期 token 数 |
| `FENG_DISABLE_COMPACT` | `false` | 设为 `true` 关闭自动压缩 |

### 9.2 手动压缩 / 清空 / 恢复

对话中随时手动操作：

```
/compact          # 立即压缩一次上下文
/clear context    # 清空当前会话上下文（会话 ID 保留）
/clear            # 只清屏，不动上下文
/restore          # 从 .fengagent/sessions.db 恢复会话历史
```

预期输出示例：

```
已压缩上下文: 保留最近 8000 tokens，压缩前 156000 → 压缩后 9200 tokens
已清空当前会话上下文（会话 ID 保留），使用 /restore 可恢复
已恢复会话历史: 42 条消息
```

### 9.3 会话持久化

- 每次对话的完整记录写入 `.fengagent/sessions.db`（SQLite），重启后 `/session switch` 或 `/restore` 即可找回；
- 会话 JSONL 可见副本与 LLM Trace 日志见第 16 节数据目录表。

---

## 10. 记忆系统

记忆是**跨会话**的长期信息（项目偏好、用户习惯、技术决策），存于 `.fengagent/memory/`。

Agent 在对话中会自动使用三个记忆工具：

| 工具 | 作用 |
|---|---|
| `memory-save` | 保存一条记忆（分类：project / user / technical / custom） |
| `memory-search` | 向量检索相关记忆（TF-IDF） |
| `memory-list` | 列出所有记忆条目 |

你也可以直接对 AI 说「记住 XXX」/「以后都用 YYY 方式」来触发保存。

记忆文件位置：

```
.fengagent/memory/vector-store.json   # 向量记忆库
.fengagent/memory/MEMORY.md           # 人可读的记忆汇总
```

> 想清空记忆：删除 `.fengagent/memory/` 目录后重启即可（操作前确认）。

---

## 11. Skill 系统（提示词模板）

Skill = 一个 Markdown 文件，把一段高质量提示词存成模板，AI 按关键词自动套用。

### 11.1 自带 Skill

仓库已自带 4 个示例 Skill（在 `.fengagent/skills/`）：

```
.fengagent/skills/code-review.md   # 代码评审
.fengagent/skills/debug.md         # 调试排查
.fengagent/skills/refactor.md      # 代码重构
.fengagent/skills/test.md          # 编写测试
```

对话时提到相关关键词（如「帮我 code review」），AI 会自动加载对应 Skill 模板。

### 11.2 新建自己的 Skill

在 `.fengagent/skills/` 下新建一个 `.md` 文件，格式：

```markdown
---
name: my-skill
description: 我的自定义技能
trigger: 关键词1, 关键词2
---

# 技能提示词模板

当用户提到触发词时，请按照以下要求执行：
1. ...
2. ...
```

- `name`：技能名（必须）
- `description`：技能描述（必须）
- `trigger`：触发关键词，逗号分隔（可选；不写则按 description 语义触发）
- 正文：要注入给 AI 的提示词模板

保存后重启 CLI 即可生效，无需改代码。

---

## 12. 多 Agent 与工具调用

### 12.1 工具列表

对话中输入：

```
/tool list
```

预期输出：

```
已注册工具 (10): bash, file-read, file-write, file-edit, glob, grep, memory-save, memory-search, memory-list, skill, task
```

AI 会根据任务自动选用工具（读写文件、跑命令、搜代码、查网页等），工具执行结果会流式展示在 TUI/WebUI 中。

### 12.2 权限审批

默认对敏感工具（如 `bash`）会先弹权限确认框（CLI 弹窗 / WebUI 推送），点允许才执行。
可用环境变量调节：

| 环境变量 | 说明 |
|---|---|
| `FENG_AUTO_APPROVE_TOOLS` | 自动放行的工具白名单（如 `file-read,glob`） |
| `FENG_ALLOWED_TOOLS` | 只允许这些工具 |
| `FENG_DENIED_TOOLS` | 禁止这些工具 |

权限规则文件：`.fengagent/permissions.json`（详见 [CONFIGURATION.md](./CONFIGURATION.md)）。

### 12.3 多 Agent（子 Agent 派遣）

`task` 工具可以把子任务派给独立子 Agent（独立 Session + 角色），适合并行处理大任务。
角色定义放在 `.fengagent/agents/*.md`，仓库自带：

```
.fengagent/agents/default.md      # 默认角色
.fengagent/agents/coder.md        # 编码专家
.fengagent/agents/researcher.md   # 调研专家
```

### 12.4 MCP 外部工具

通过 `.fengagent/mcp-servers.json` 配置 MCP Server，自动发现外部工具（详见 [EXTENDING.md](./EXTENDING.md)）。

---

## 13. WebUI 网页对话

### 方式一：直接跑服务（推荐小白）

```bash
bun run serve
```

预期输出（日志中出现监听地址）：

```
[server] listening on http://127.0.0.1:3000
```

浏览器打开 **http://127.0.0.1:3000** 即可对话。

> 注意：`bun run serve` 服务的是 `web-ui/dist` 构建产物。首次运行如提示找不到静态文件，
> 先执行 `bun run build:web-ui` 再 `bun run serve`。

### 方式二：开发模式（前后端热更新）

```bash
bun run dev
```

- 后端 Server：http://127.0.0.1:3000
- 前端 Vite：http://localhost:5180（自动代理 /api 到后端，改前端代码即时生效）

### 一键 Demo（自动构建 + 启动 + 打开浏览器）

```bash
# Windows
powershell -ExecutionPolicy Bypass -File scripts/demo.ps1
# Linux/macOS
bash scripts/demo.sh
```

### WebUI 里能做什么

- **对话**：左侧会话列表（新建/切换/删除），中间消息区（Markdown 渲染、流式输出），底部输入框；
- **Token 统计栏**：消息区下方实时显示「📥 输入 / 📤 输出 / ⚡ 缓存命中 / 🎯 命中率 / 合计 tokens」（见第 14 节）；
- **主题切换**：右上角切换 3 套主题。

---

## 14. Token 与 KV Cache 统计

每次 LLM 调用都会在响应里带回用量：输入 token、输出 token，以及 **KV Cache 读取/创建 token**
（DeepSeek 等厂商会返回 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`）。

**WebUI 展示**：消息区下方的统计栏实时累计本会话的用量：

```
📥 输入 573,875    📤 输出 5,904    ⚡ 缓存命中 491,648    🎯 命中率 86%    合计 579,779 tokens
```

- 命中率 = 缓存读取 token / (缓存读取 + 非缓存输入) × 100%；
- 缓存命中多说明长上下文复用得好，**省成本**（缓存读取比新计算便宜很多）；
- 数据来源是 LLM 返回的 `usage` 字段，科学可溯源（WebUI 经 SSE 的 `usage` 事件累计）。

**CLI / 日志**：每次请求的完整 usage 也会写入 `.fengagent/logs/llm-trace-{date}.jsonl`
（LLM Trace 日志），供第 15 节测评模块分析。

---

## 15. 测评模块 bun run eval

测评模块读取 LLM Trace 日志（`.fengagent/logs/llm-trace-{date}.jsonl`），自动分析
**工具调用成功率、任务完成率、错误率、Token 用量、KV Cache 命中率、模型对比**，输出 Markdown 报告。

```bash
# 分析今天的日志
bun run eval

# 分析指定日期
bun run eval --date=2026-08-16

# 分析全部日志
bun run eval --all

# 分析指定文件
bun run eval --file=.fengagent/logs/llm-trace-2026-08-16.jsonl
```

预期输出（以真实数据为例）：

```
分析日志: D:\...\.fengagent\logs\llm-trace-2026-08-16.jsonl

============================================================
FengAgentCli Agent 测评报告
============================================================
日志文件: ...\llm-trace-2026-08-16.jsonl
会话数: 5
LLM 调用: 20
总耗时: 89.64s
平均耗时: 4482ms
输入 Token: 573875 (avg 28694)
输出 Token: 5904 (avg 295)
工具调用: 15 (75%)
错误: 0 (0%)

KV Cache:
  读取 Token: 491648
  创建 Token: 82227
  命中率: 86%

工具使用分布:
  bash: 26

完成原因:
  end_turn: 5
  tool_use: 15

报告已保存: D:\...\.fengagent\logs\eval-report-2026-08-16.md
============================================================
```

报告同时保存为 Markdown：`.fengagent/logs/eval-report-{date}.md`，包含
**模型准确率对比表**（每个模型的总调用、工具成功率、任务完成率、错误率、平均耗时、平均输入/输出、Cache 读取与命中率），
可用于不同模型/不同提示词版本的横向对比，优化工具描述与系统提示词。

---

## 16. 数据目录 .fengagent/ 说明

main 分支**所有**运行时数据都在项目根的 `.fengagent/` 目录（全局用户级备份在 `~/.fengagent/`）：

| 路径 | 内容 |
|---|---|
| `.fengagent/config.json` | 配置（`/model`、`/provider` 等命令写入，重启自动加载） |
| `.fengagent/sessions.db` | 会话主存储（SQLite） |
| `.fengagent/logs/` | 运行日志 `fengagent-{date}.log` + 会话 JSONL + LLM Trace `llm-trace-{date}.jsonl` + 测评报告 |
| `.fengagent/memory/` | 记忆（`vector-store.json` + `MEMORY.md`） |
| `.fengagent/agents/` | 子 Agent 角色定义（`default.md` / `coder.md` / `researcher.md`） |
| `.fengagent/skills/` | Skill 提示词模板（`code-review.md` / `debug.md` / `refactor.md` / `test.md`） |
| `.fengagent/plugins/` | 第三方插件 |
| `.fengagent/permissions.json` | 工具权限规则 |
| `.fengagent/mcp-servers.json` | MCP Server 配置 |

> 想清空全部数据（会话/日志/记忆）：退出程序后删除 `.fengagent/` 下对应子目录即可（操作前确认）。

---

## 17. 和 cordis 新分支的关系（隔离）

| 对比项 | main 分支（本手册） | refactor/cordis-graph-architecture 分支 |
|---|---|---|
| 数据目录 | `.fengagent/` | `.fengagent-cordis/` |
| 对话图 `/graph` | ❌ 无 | ✅ 有 |
| 回退重答 `/rollback` | ❌ 无 | ✅ 有 |
| 事件溯源（导出/导入/重建/迁移） | ❌ 无 | ✅ 有 |
| 对话 / 记忆 / 压缩 / skill / `/model` / `/provider` / 测评 / kvCache | ✅ 有 | ✅ 有（兼容） |

- 两个分支数据目录**完全隔离**，同机切换分支互不干扰；
- 在 main 分支上**不要**使用 `/graph`、`/rollback` 等命令（会提示命令不存在）；
- 想体验对话图 / 回退 / 事件溯源的新能力，切到新分支并按它的手册操作：

```bash
git checkout refactor/cordis-graph-architecture
# 然后看 docs/GUIDE-CORDIS.md
```

---

## 18. 常见问题 FAQ

**Q1：`bun run packages/cli/src/entry.ts` 报 `Failed to initialize agent: ... API_KEY`？**
没配模型。按第 5 节方式 A 设置环境变量，或方式 B 在 CLI 里 `/provider set`。
若 `createAgent is not defined` 之类的报错：`bun install` 没成功或依赖版本不匹配，重跑安装。

**Q2：对话没有反应 / 一直转圈？**
先看 `.fengagent/logs/fengagent-{date}.log` 和 `llm-trace-{date}.jsonl` 有没有新记录；
多半是 API Key / Base URL 配置问题（`/provider show` 检查），或网络不通。

**Q3：上下文太大变慢 / 太贵？**
让自动压缩生效（默认开启），或手动 `/compact`；WebUI 看统计栏的「缓存命中」是否高，
缓存命中率高说明复用好、省钱。

**Q4：如何恢复被 `/clear context` 清空的会话？**
`/clear context` 只清内存上下文（消息历史），会话 ID 保留；输入 `/restore` 从 SQLite 恢复历史。
WebUI 端切换会话即可重新加载。

**Q5：`bun run serve` 打开页面空白？**
先 `bun run build:web-ui` 构建前端产物再启动；或直接用 `bun run dev`。

**Q6：怎么换模型？**
CLI 里 `/model list` 看可选模型，`/model <id>` 切换；或在 `.fengagent/config.json` 改 `model` 字段。

**Q7：找不到 `/graph`、`/rollback` 命令？**
那是新分支 `refactor/cordis-graph-architecture` 的功能，main 分支没有。切分支后按 `docs/GUIDE-CORDIS.md` 操作。

---

## 19. 相关文档

| 文档 | 内容 |
|---|---|
| [在线文档站](https://zhu011.github.io/FengAgentCli/) | 交互式文档（main 分支状态） |
| [GUIDE-CORDIS.md](./GUIDE-CORDIS.md)（新分支） | cordis 分支保姆级手册（对话图/回退/事件溯源） |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构设计 |
| [CONFIGURATION.md](./CONFIGURATION.md) | 环境变量、配置文件、权限规则 |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | 本地开发、测试、构建 |
| [EXTENDING.md](./EXTENDING.md) | 添加 Provider / 工具 / 插件 / Agent |
| [MODULES.md](./MODULES.md) | 各包 API 接口 |
