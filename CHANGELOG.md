# Changelog

All notable changes to FengAgentCli will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-09

### Added

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

### Known Limitations

- 向量检索记忆使用本地 TF-IDF（未来可接入 embeddings API）
- 插件加载使用动态 import（需要 Bun 运行时）
- WebUI 不支持文件上传（未来添加）
