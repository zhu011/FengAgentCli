# 更新日志

FengAgentCli 的所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，项目遵循[语义化版本](https://semver.org/spec/v2.0.0.html)。

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
