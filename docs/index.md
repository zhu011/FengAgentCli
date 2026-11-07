---
layout: home

hero:
  name: FengAgentCli
  text: 开源本地 AI Agent 对话平台
  tagline: 终端或浏览器中与 AI 对话 · 工具调用 · 对话图可回溯 · 多 Agent 团队协作 · 插件市场
  actions:
    - theme: brand
      text: 快速开始
      link: /QUICKSTART
    - theme: alt
      text: 操作手册（保姆级）
      link: /GUIDE-CORDIS
    - theme: alt
      text: GitHub
      link: https://github.com/zhu011/FengAgentCli

features:
  - icon: 💬
    title: 智能对话
    details: 多轮上下文对话，SSE 流式输出，思考过程可视化，Markdown 渲染与代码高亮；TUI 与 WebUI 双端。
  - icon: 🕸️
    title: 对话图与回退重答
    details: 每轮「提问→回答」沉淀为节点，可溯源、可分支；/rollback 回退到任意节点重答，旧分支完整保留。
  - icon: 👥
    title: 团队协作
    details: 本机 ACP Agent（kimi / dsh / claude…）注册为团队成员，聊天流派单，任务七态台账与流式输出。
  - icon: 🗣️
    title: 多 Agent 群聊
    details: 把多个 Agent 拉进一个团队讨论，你随时插话；聊到可收口时「拍板」一键收敛定格结论。
  - icon: 🧲
    title: 插件市场
    details: Settings「市场」页浏览 / 搜索 4000+ 社区策展插件，一键 npm 安装，A/B/C 三档兼容徽标。
  - icon: 🧩
    title: WebUI 插件扩展面
    details: fengagent.webui 协议——插件向前端注册 slot（导航 / 设置 / 会话侧栏），装上即渲染。
  - icon: ⚙️
    title: Settings 热切换
    details: 网页里配 Provider / 模型 / API Key，保存即热切换，下一轮对话生效，无需重启宿主。
  - icon: 🔧
    title: 工具调用与沙箱
    details: 文件读写、Bash、Glob/Grep、Web 抓取、记忆、Skill；实验代码在隔离沙箱执行，安全可控。
  - icon: 📡
    title: 观测与调用链
    details: trace 全量落盘，WebUI 四层调用链树（会话→消息→LLM 调用→工具调用）+ 指标图表与模型对比。
  - icon: 🧪
    title: 评测与自优化
    details: bun run eval 自动生成工具成功率 / KV Cache 报告；--judge 全链路评测产出可执行调优建议。
  - icon: 🧠
    title: 记忆系统
    details: MEMORY.md + 分类记忆 + 向量检索，跨会话记住项目上下文。
  - icon: 📜
    title: 事件溯源
    details: 会话以 append-only 事件日志为准，可导出 / 导入 / 重建 / 跨机迁移。
---
