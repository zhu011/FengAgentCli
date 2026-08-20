# 更新日志

FengAgentCli 的所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，项目遵循[语义化版本](https://semver.org/spec/v2.0.0.html)。

## [Unreleased] — 界面设计优化 Round 2

### 优化（WebUI）

- **顶栏设置下拉** — 齿轮 ⚙ 菜单：三套主题（深空/日光/赛博）直接选择并显示主题名（替代 32px 单按钮循环切换），附带消息检查器开关（`packages/web-ui/src/pages/chat.tsx`）
- **顶栏会话标题** — 显示当前会话标题，双击行内编辑重命名（Enter 保存 / Esc 取消）
- **侧边栏会话双击重命名** — 会话卡片双击（或铅笔按钮）进入行内编辑，Enter / 失焦保存、Esc 取消（`packages/web-ui/src/components/session-sidebar.tsx`）
- **欢迎卡片文案贴合 Agent 场景** — 「让 Agent 分析项目代码」「多 Agent 协作完成任务」「用沙箱试跑实验性代码」「写一个 CLI 工具」
- **消息生成中动画指示器** — 发送消息后、首条助手消息出现前的空窗期，消息流底部显示豆包式彩色光点 +「正在生成…」（`packages/web-ui/src/components/message-list.tsx`）
- **重命名 API** — `PATCH /api/sessions/:id`（Server + SessionManager + Agent + SessionStore，SQLite 持久化）

### 优化（TUI）

- **用户消息气泡增强** — 在圆角边框基础上补品牌色 dim 背景填充（Ink Text 整块背景 + 手绘边框字符，与切片渲染行数估算精确对齐，回归测试通过）
- **版本号统一 v0.2.0** — TUI 欢迎卡徽标 / 顶栏版本、WebUI 侧边栏底部、README tgz 文件名、在线文档站 hero 徽标与 CHANGELOG [0.2.0] 对齐

### 文档

- **README 全局安装显眼化** — 「⭐ 全局安装（一条命令启动 TUI）」：`npm install -g fengagent` → 任意目录 `fengagent` 直接进 TUI，附「无需克隆仓库」提示
- **在线文档站** — WebUI 功能描述同步（设置下拉 / 双击重命名 / 生成中动画）
- **截图画廊更新** — README / 文档站截图替换为 Round 2 新 UI 截图（`screenshots/r2-*.png`）

## [Unreleased] — 界面设计优化 Round 1

### 优化（WebUI）

- **欢迎页重构** — 参考 DeepSeek / 豆包 / 通义千问：居中 Hero（渐变图标 + 标题 + 副标题）+ 4 张建议卡片（点击即发起对话）+ 特性标签
- **对话流重排** — 居中窄栏（768px），助手消息带头像（品牌渐变圆标），用户消息右对齐圆角气泡；系统消息置灰卡片
- **Composer 输入区** — 圆角卡片容器（focus 光环），发送按钮渐变胶囊，Stop 按钮红色
- **侧边栏** — 品牌 Logo + 名称 + 副标题，会话按「今天 / 昨天 / 近 7 天 / 更早」日期分组，底部版本信息栏；主题切换移入顶栏
- **顶栏** — 品牌字标 + 模型选择 + 检查器开关 + 主题切换

### 优化（TUI）

- **用户消息气泡** — 右对齐圆角边框气泡，与长对话切片渲染行数精确对齐（回归测试通过）
- **欢迎卡片** — 加宽 + 版本徽标（`v0.1.0` 反白 chip）+ 副标题行 + 命令提示补充 `/provider`

### 文档 / 主页

- **README 重构** — 突出项目介绍 / 快速开始 / 使用指南，移除「借鉴 opencode 等」参考描述与 bug 修复叙事，新增截图画廊
- **GUIDE** — 顶部新增「FengAgentCli 是什么」+「三分钟上手」

## [0.2.0] - 2026-08-20

### 修复

- **长对话布局** — 内容超屏撑破布局导致图标 / 后续问答 / token 百分比消失；改为**切片渲染**（只渲染可视窗口内的消息，边界按行裁剪），支持 `PgUp/PgDn`、鼠标滚轮、`Home` 回顶、`End` 回底并自动恢复贴底（`packages/cli/src/tui/chat-view.tsx`）
- **对话卡死** — AGENTS.md（Multica 运行时指令）被注入系统提示，Agent 对简单问题也触发工具调用循环；CLI / ACP 路径默认 `loadAgentsMd: false` 禁用注入（`packages/cli/src/create-agent.ts`、`entry.ts`）
- **ACP 运行时报错** — `FENG_PROVIDER=openai-compatible` 时报 `OPENAI_COMPATIBLE_API_KEY is required`；ACP 路径改为与 TUI 一致的分层配置加载（默认值 → 全局 → 项目 → 分支 → 环境变量）并经 `buildEnvForLLM` 注入 LLM 环境变量
- **token 进度条** — 大上下文窗口下百分比被 `Math.round` 压成 0%；保留 1 位小数、极小值显示 `<0.1%`、token 计数 > 0 时进度条至少填充 1 格；token 计数修正为累加 `inputTokens + outputTokens`（`packages/cli/src/tui/status-bar.tsx`）

### 新增

- **实验沙箱** — `Sandbox` 类 + 内置 `sandbox` 工具（run / write / read / delete / list / copy-in / copy-out / status），路径围栏、环境脱敏、超时强杀，`copy-out` 为唯一出口需权限审批（详见 `docs/SANDBOX.md`）
- **TUI 主题优化** — 借鉴 opencode / kimi-code / claude-code 的新色板（近黑分层背景 + 暖橙/语义色，保留雾蓝品牌色）、代码语法高亮、状态栏重构（分段进度条独立一行 + 精确百分比）

## [0.1.0] - 2026-08-09

### 新增

- **Agent Loop** — 多轮对话循环：用户输入 → LLM 调用 → 工具执行 → 响应输出
- **流式输出** — LLM 响应实时流式输出（SSE）
- **工具系统** — 内置工具：file-read、file-write、file-edit、bash、glob、grep
- **多模型支持** — Anthropic、OpenAI、OpenAI-Compatible、Google Gemini、AWS Bedrock
- **CLI 交互** — 终端交互式对话（Ink TUI）+ 非交互管道模式
- **配置系统** — 环境变量 + JSON 配置文件分层合并（FENG_* 前缀）
- **上下文压缩** — 接近 Token 上限时自动摘要压缩对话历史
- **会话管理** — SQLite 会话持久化、恢复、导出
- **WebUI 本地服务** — Hono HTTP API + SSE 流式推送 + React 前端
- **多 Agent** — Task 工具派遣子 Agent，独立 Session，Agent 定义系统（.fengagent/agents/*.md）
- **MCP 集成** — Model Context Protocol 客户端，自动发现外部工具
- **权限系统** — 工具执行前交互式审批（CLI 弹框 / WebUI SSE 推送）
- **Hook 系统** — pre-tool-use / post-tool-use / pre-compact / post-compact 生命周期钩子
- **记忆系统** — MEMORY.md 本地记忆 + 向量检索
- **插件系统** — 第三方插件加载（.fengagent/plugins/）
- **Skills 系统** — 可复用 Prompt 模板（.fengagent/skills/*.md）
- **编译二进制** — bun build --compile 生成独立可执行文件（Win/Linux/macOS）
- **Docker 部署** — 多阶段构建 Dockerfile
- **完整文档** — README、PRD、架构设计、开发指南、模块文档、配置参考、扩展指南

### 已知限制

- 向量检索记忆使用本地 TF-IDF（未来可接入 embeddings API）
- 插件加载使用动态 import（需要 Bun 运行时）
- WebUI 不支持文件上传（未来添加）
