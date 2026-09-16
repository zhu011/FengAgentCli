# 更新日志

FengAgentCli 的所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，项目遵循[语义化版本](https://semver.org/spec/v2.0.0.html)。

## [Unreleased] — ACP 续聊：session/resume 跨进程恢复（Multica 第二次对话失败）

### 修复

- **Multica 里「首次对话正常、第二次对话报错」** — 守护进程**每个任务都 spawn 一个新的 `fengagent acp` 子进程**，第二轮对话不是「同进程里的第二次 prompt」，而是新进程只带上一轮的 `sessionId` 回来：`initialize → session/resume{sessionId} → session/prompt`。此前桥未实现该方法，直接回 `-32601 "Method not found"`，宿主侧报 `hermes session/resume failed: session/resume: "Method not found" (code=-32601)`：
  - `session/resume` 与 `session/load` 落地（`packages/server/src/acp-stdio.ts`）：参数取 ACP `ResumeSessionRequest`（`cwd` / `sessionId` / `mcpServers`），返回形状对标 `ResumeSessionResponse`（baseline 桥只回 `sessionId`）；**未命中落盘记录时用宿主给的同一个 id 建空会话兜底**，保证这一轮 prompt 仍能跑完而不是整轮失败；
  - `initialize` 声明 `agentCapabilities.sessionCapabilities.resume`，与同族 `dsh-acp` / opencode 对齐；
  - **会话落盘补齐**：ACP 装配（`packages/cli/src/acp-mode.ts`）把同一份 `SessionStore`（数据根 `FENG_DATA_DIR` > 配置 `dataDir` > `<workdir>/.fengagent-cordis`，与 serve / cordis 一致）同时交给 `session/new`、`session/resume` 与 `Agent` —— 只建会话行、不写消息的「半截修复」会让续聊成功但失忆；
  - `session/new` 也走同一份会话库，`session/prompt` 追加的消息在下一轮进程可读，上下文真正延续。

### 测试

- `packages/server/src/__tests__/acp-stdio.test.ts`：新增续聊用例（resume 命中返回同一 `sessionId` 且后续 prompt 正常结算、未命中同 id 兜底、缺 `sessionId` 报 `-32602`、`session/load` 同语义、能力声明）。
- `packages/server/src/__tests__/acp-resume-persistence.test.ts`：用真实 `SessionStore` 钉住「新会话落盘 → 下个进程按 id 读回 → 续聊命中同一会话」的契约，并对比「会话库未接上」时退化为同 id 空会话（失忆）的差异。

### 文档

- `docs/MODULES.md`：ACP（stdio）方法表补 `session/resume` / `session/load`。

## [Unreleased] — ACP 走 stdio JSON-RPC（Multica 运行时握手/建会话）

### 修复

- **Multica 里「准备会话」一直不启动 / 报「hermes initialize failed: hermes process exited」** — Multica 守护进程把本地运行时当**子进程**拉起，走 stdin/stdout 上的 ACP（Agent Client Protocol）JSON-RPC；此前 `fengagent acp` 只监听 HTTP + SSE 且从不读 stdin，握手无从完成，宿主只能看到子进程退出：
  - `fengagent acp` 默认改为 **stdio JSON-RPC**：`initialize` / `authenticate` / `session/new` / `session/prompt` / `session/cancel`（`session/set_model` 容错支持），方法名、字段形状、JSON-RPC 错误码与措辞严格对标同族 `dsh-acp`（`packages/server/src/acp-stdio.ts`）；
  - **stdout 成为协议专用通道**：`console` 与 `process.stdout` 在进程启动早期即改道 stderr，协议帧经模块加载时捕获的原始 stdout 写出——任何非协议字节都会破坏 NDJSON 握手（`redirectConsoleToStderr`）；
  - 助手文本按 `session/update` 的 `agent_message_chunk` **流式**推送，思考/工具调用/用量分别推 `agent_thought_chunk` / `tool_call` / `tool_call_update` / `usage_update`；
  - **凭据缺失不再让进程退出**：改为 `session/new` 返回带可执行修复步骤的 JSON-RPC 错误，宿主可原样透出真正原因（HTTP 模式仍直接退出）；
  - `session/new` 使用宿主给的 `cwd` 作为会话工作目录（权限配置按该目录解析）；
  - 旧 HTTP + SSE 传输保留在 `fengagent acp --acp-http`（供 WebUI / 人工调试）；
  - ACP 模式装配抽到 `packages/cli/src/acp-mode.ts`（配置分层加载 → 凭据解析 → 工具/权限/上下文 → Agent 工厂 → 传输），`entry.ts` 只做路由。

### 测试

- `packages/server/src/__tests__/acp-stdio.test.ts`（20 项）：握手能力声明与协议版本、错误码/措辞、`session/new` 的 cwd 与（非空）mcpServers 容忍、完整一轮的事件形状与 `stopReason`、通知先于响应、取消结算 `cancelled`、错误事件以 `-32603` 拒绝、并发 prompt 拒绝、协议通道纯净性、stdin 关闭后不再写帧。

### 文档

- `README.md` / `docs/CONFIGURATION.md`：`fengagent acp` 两种传输的用途与切换方式，`FENG_ACP_PORT` 归属 HTTP 模式。

## [Unreleased] — 渲染进程多工作目录凭据修复（Multica 运行时启动失败）

### 修复

- **空工作目录下运行时启动失败（「hermes initialize failed: hermes process exited」）** — Multica 每次对话都会在**全新的空工作目录**（`task-<id>/workdir`）里拉起 `fengagent acp`，cwd 下既没有 `.fengagent/config.json` 也没有 `.fengagent-cordis/config.json`，凭据解析失败导致进程在初始化阶段退出，宿主只看到「运行时出错，没能完成回复」：
  - `loadConfig` 新增**显式配置层** `FENG_CONFIG_FILE`（最高文件层，不依赖工作目录）；
  - 新增 `promoteCredentialsToGlobal()`：把项目级 Provider 凭据**补齐**到全局配置 `~/.fengagent/config.json`（只补缺失键，不覆盖已有值；工作目录相关键不参与提升）；
  - `fengagent runtime install` 现在会顺带完成上述补齐（`--no-global-config` 可跳过），并打印补齐结果；
  - `acp` 启动期凭据缺失不再静默退出：stderr 与日志输出「查了哪些位置 + 三种修复方式」（`packages/core/src/config.ts`、`packages/cli/src/runtime-install.ts`、`packages/cli/src/entry.ts`）。

### 测试

- `packages/core/src/__tests__/config-portable.test.ts`：显式配置层优先级 / 凭据提取 / Provider 凭据完备性 / 全局补齐语义（16 项）；
- `packages/cli/src/__tests__/runtime-install.test.ts`：项目凭据读取与补齐、opt-out、不覆盖已有值（7 项）。

### 文档

- `docs/CONFIGURATION.md`：配置优先级新增显式配置层，新增「多工作目录下的凭据可见性」；
- `README.md`：全局安装一节补充 `fengagent runtime install` 与凭据补齐说明。

## [Unreleased] — 真后台并发（会话间并行 Loop + 事件按会话路由）+ 多 Agent 并行提速

### 新功能

- **真后台并发（AGE-29 #1 重做）** — 会话 A 生成中切换到 / 新建会话 B，A 的 Loop **在后台继续运行**，切换不再中止：
  - `SessionManager` 持有 run pump + 每会话订阅者 + `runEventLogs` 回放缓冲；`POST /:id/messages` **先订阅后启动**，SSE 事件按会话路由——A 的事件不会写入 B（`packages/server/src/session-manager.ts`、`routes/sessions.ts`）；
  - `GET /:id/events` 纯订阅通道：断线重连 / 页面刷新自动回放仍在运行的会话（缓冲续播 + 心跳），run 结束广播 + finally 清理；
  - （WebUI）per-session 视图状态切片（messages / isStreaming / 计时锚点 / 权限 / lastError）+ 侧边栏运行指示点；attach/rejoin 自动重订阅仍在运行的会话，`turn-stream` 渲染层发送与 attach 走同一套路径；「按 Esc 中断」只中断**当前会话**（`packages/web-ui/src/hooks/use-session.ts`、`lib/turn-stream.ts`）。
- **researcher 子 Agent 只读可并行** — `task` 工具 `isConcurrencySafe` 按子 Agent 类型判定：researcher（只读）可与同轮其它工具调用并行执行，多 Agent 协作提速（`packages/tools/src/builtin/task.ts`）。

### 修复

- **中断后会话回落 idle（R2）+ rejoin 回放按 messageId 去重（R1）** — 中断路径也复位运行状态并持久化已完成轮次；断线重连回放与实时事件交叠不再重复渲染（`packages/server/src/create-runtime-agent.ts`、`packages/web-ui/src/lib/turn-stream.ts`）；
- **计时锚点提升到 hook 层（WebUI）** — 「已用时长」不再因 view 切换重启。

### 测试

- `packages/server/src/__tests__/session-concurrency.test.ts`：并行 Loop / 事件按会话路由（零串扰）/ 同会话 busy 拒绝 / 中断只作用当前会话 / rejoin 回放去重（5/5）；
- `packages/web-ui/src/lib/__tests__/turn-stream.test.ts`：回放去重（R1）。

### 文档

- README「WebUI」/ `docs/GUIDE-CORDIS.md` §11：多会话后台并发（互不干扰、消息隔离）用法。

## [Unreleased] — 对话图节点级「回退并重答」闭环 + 工具入参人工改参重试（human-in-the-loop）

### 新功能

- **图节点回退补齐全链路（refactor/cordis）** — 确认现有对话图回退为**单节点粒度**（`RuntimeAgent.rollback`，非整会话）；补齐 WebUI 闭环：
  - 对话图面板活跃节点（**user / assistant / tool**）均可点「**回退并重答**」：经新增 `POST /api/sessions/:id/rollback-retry`（SSE 流）回退截断后**自动重新回答**，新回答挂在分支点下，旧分支作废灰显保留可溯源（与 CLI `/rollback <节点id>` 语义一致；此前 WebUI 仅截断、需手动重发）；
  - `SessionManager.rollbackRetrySession`：复用 `RuntimeAgent.rollbackAndRetry` + 权限桥接 + 并发防护/中断（`packages/server/src/session-manager.ts`、`routes/sessions.ts`）；
  - WebUI `use-session.ts` 抽出 sendMessage / rollbackRetry 共用的事件渲染（`handleTurnEvent`），`session-start` 首帧重建回退后的消息列表。
- **工具入参错误的人为干预（human-in-the-loop 改参重试）**：
  - 权限审批卡片**入参 JSON 可编辑**：修改后点「以修改参数执行」= `allow` + 修改后入参（`PermissionResult` 新增 `{ decision: "allow"; input }`），工具以**修改后的参数**执行；不改参数直接 Allow = 原参数放行；Deny 不变（`packages/core/src/permission.ts`、`packages/web-ui/src/pages/chat.tsx`）；
  - executor 支持改参执行：`ask` 放行携带入参时重新校验并以新参数执行；**入参校验失败**时（仅当权限策略会 ask，如破坏性工具 / ask 规则）把校验错误作为审批原因推给用户改参——autoApprove / 只读自动放行场景保持原行为不打扰（`packages/tools/src/executor.ts`）；
  - 执行结果带 `userCorrectedInput` 标记 → loop 把**实际执行入参**同步进 `tool-call-result` 事件与会话历史 tool-use 块（可溯源，卡片标注「✏️ 已改参」）；
  - WebUI 检查器新增**权限轮询**：工具 ask（含入参校验失败）时审批卡片实时出现（此前卡片从不展示）；
  - **修复运行时工具执行旁路**：refactor 分支 RuntimeAgent 经 `ctx.loop` 的工具执行此前直调 `ctx.tools.execute`（绕过入参校验/权限/hooks，与 main 行为不一致）；现 LOOP 插件支持注入真实 executor，生产装配（`createRuntimeAgent`）已接通——权限审批/校验/hooks 恢复生效（`packages/cordis/src/adapters/loop.ts`、`services.ts`、`packages/server/src/create-runtime-agent.ts`）。

### 测试

- `packages/tools/src/__tests__/hitl-retry.test.ts`：ask 改参执行（新参数执行 / 仍校验失败不二次询问 / deny）、入参校验失败按权限策略决定是否打扰用户（9 断言场景）
- `packages/agent/src/__tests__/loop.test.ts`：tool-call-result 携带实际入参 + 历史 tool-use 块同步；无改参标记不改写
- `packages/server/src/__tests__/integration.test.ts`：destructive 工具 → 权限请求 → 用户改参后批准 → 工具以修改后参数执行（端到端）
- `packages/server/src/__tests__/graph-endpoints.test.ts`：`POST /:id/rollback-retry` SSE 回退重答端点

### 文档

- `docs/GUIDE-CORDIS.md` §10/§11：WebUI「回退并重答」闭环 + 权限审批改参卡片用法
- `docs/MODULES.md`、`docs/ARCHITECTURE-CORDIS.md`：新端点 `/rollback-retry`、`rollbackRetrySession`、权限 allow+input、executor 注入说明

## [Unreleased] — task 缺参兜底 + 终止后工具卡片不再转圈（AGE-29 后续）

### 修复

- **task 工具缺参/空值兜底（推荐问题路径仍报 `subagent_type` 缺失，会话 277e9047 复现）** — AGE-29 的别名归一化只覆盖误拼键名（`subagentType` 等），模型**完全缺参或传空值**时仍返回错误并触发失败重试。现在缺参时按任务内容关键词**保守推断**（研究类 → `researcher`，编码类 → `coder`），推断不出回退通用 `default`；`task` 工具永不因缺参失败，推断/兜底来源写入结果备注与 `metadata.subagentTypeSource`，主 Agent 可自纠正（`packages/tools/src/builtin/task.ts`）
- **loop 终止/出错后工具卡片「转圈」不消失（WebUI）** — 根因：loop 事件顺序是 `message-end` 之后才发 `tool-call-result`，前端 `currentMessageId` 已被置空导致结果永远匹配不到工具项。修复：① 用 `toolUseId → 消息` 映射关联工具结果（正常流与失败流都能正确落到卡片状态）；② loop 终止/出错/中断/超时（`turn-end`/`session-end`/`finally`/`interrupt`）统一把仍 `running` 的工具项复位为 `failed`，不再永久转圈；③ 会话重载时跨消息关联工具结果并正确区分成功/失败（`packages/web-ui/src/hooks/use-session.ts`）

### 测试

- `task.test.ts`：缺参/空值/空白兜底为 `default`、研究/编码关键词推断、显式优先于推断、execute 缺参不再报错且携带兜底备注

## [Unreleased] — 多 Agent 协作死循环修复 + 回放兜底（AGE-29）

### 修复

- **多 Agent 协作死循环（AGE-29 现场：25 轮 / 48 次 task 调用全部失败）** — `task` 工具输入 schema 兼容模型常见的参数名误拼（`subagentType` / `agentType` / `type` / `agent` / `subagent` / `kind` / `name`），归一化到规范键 `subagent_type`；值仍与可用 Agent 类型（default / coder / researcher）运行时校验，缺失时返回可自纠正的明确错误（`packages/tools/src/builtin/task.ts`）
- **Agent Loop 死循环防护** — 连续 3 轮工具调用全部失败（模型陷入失败重试循环）时自动抛出错误并终止，不再空耗到 maxTurns（`packages/agent/src/loop.ts`）
- **同会话并发发送防护** — 会话已有运行中任务时拒绝再次启动 Loop，防止双开/重复提交造成用户消息重复入历史与调用链错乱（`packages/server/src/session-manager.ts`）
- **中断会话回放兜底** — ① `RuntimeAgent.prompt` 每个 `turn-end` 增量持久化消息，服务被杀/对话中断时已完成的轮次不丢失；② `buildMessageSummaries` 在会话消息不完整时从 trace 日志补齐缺失的助手轮次，消息选择器仍可定位每一轮调用链/评测（`packages/server/src/create-runtime-agent.ts`、`packages/server/src/routes/observability.ts`）

### 测试

- `task.test.ts`：camelCase/别名归一化、缺失类型明确报错
- `loop.test.ts`：连续工具失败防护触发 / 成功轮重置计数
- `session-manager.test.ts`：并发发送拒绝（阻塞 LLM 门控）
- `observability.test.ts`：中断会话消息选择器 trace 补齐
- `subagent-runner.test.ts`：AGE-29 回归 E2E——模型误用 camelCase 也能完成「拆解 → 派子 Agent → 汇总」

### 文档

- README「多 Agent 协作」小节 + 中断会话回放说明；docs/EVALUATION.md §2.6 中断会话回放兜底

## [Unreleased] — 界面体验优化 Round 4（思考可视化 + 去 AI 味动效）

### 新功能（思考过程可视化）

- **思考内容流式展示（WebUI）** — 思考过程以「💭 深度思考」面板**实时流式显示**，支持点击**展开 / 折叠**（流式期间自动展开一次，之后交还用户控制；折叠后仍显示「N 字」摘要与流式指示），替代原先只有「思考中…」占位、无任何内容的空转状态（`packages/web-ui/src/components/message-list.tsx`、`index.css`）
- **思考内容流式展示（TUI）** — `thinking-delta` 事件实时累积为流式思考文本（💭 缩进斜体），有思考内容时不再只显示动画宠物；历史消息的 thinking 块照常渲染（`packages/cli/src/tui/app.tsx`、`chat-view.tsx`）
- **思考链路打通（核心）** — 三层修复让思考 token 完整流回前端：
  1. `openai-compatible` / `openai` provider 解析 `delta.reasoning_content`（DeepSeek reasoner 风格）→ `thinking-delta` 事件（此前被丢弃）；`generate()` 非流式响应保留 `reasoning_content` 为 thinking 块
  2. `AgentEvent` 新增 `thinking-delta` 类型（`packages/core/src/event.ts`），`llmEventToAgentEvents` 转发思考增量（此前静默丢弃，`packages/agent/src/streaming.ts`）
  3. WebUI `use-session` 累积思考增量到消息 `thinking` 字段，会话重载时从 thinking 块提取（此前历史思考内容完全不显示）
- **排查结论（沙箱链路）** — 沙箱（`@fengagent/tools` 的 Sandbox）是「隔离执行实验性代码」的工具，**不在** SSE 流式链路上，未丢失思考 token；「一直停在深度思考」的根因是上述应用层丢弃 `reasoning_content` / `thinking-delta`，已修复

### 优化（去 AI 味 + 动态互动）

- **WebUI 轻量动态互动** — 主题切换平滑过渡、顶栏按钮 hover 上浮/点击回弹、齿轮图标旋转、侧边栏会话卡 hover 轻移、助手头像流式脉冲、消息气泡/工具卡 hover 柔光、Composer 发送按钮渐变位移、欢迎 Hero 图标缓动悬浮、特性标签错峰入场、流式光标柔和闪烁；全部动效遵循 `prefers-reduced-motion` 降级（`packages/web-ui/src/index.css`）
- **文档站动态互动 + 侧栏高亮修复** — ① 修复小节点击不高亮的 bug：点击立即高亮（不再依赖 scroll spy）、scroll spy 覆盖全部小节标题（h3）、小节高亮时父级分组同步高亮、修正「安装」等 data-target 指向；② 轻量动效：Hero 上浮入场、导航悬停轻移 + 图标微弹、代码块/表格 hover 细边框高亮、链接下划线滑入（`docs/site/index.html`）

### 测试

- 新增 `streaming.test.ts`（agent）：thinking-delta 实时转发 + 增量累积不丢流
- 新增 `mock.test.ts` 用例：openai-compatible 解析 `reasoning_content`（流式 + 非流式）
- 全量 794 pass / 1 fail（既有沙箱 bash 工具环境性失败，与 R1–R3 相同）

## [Unreleased] — 界面设计优化 Round 3（最终轮·精细打磨）

### 优化（WebUI）

- **代码块复制按钮增强** — Markdown 代码块 hover / 键盘 focus 显示「Copy / ✓ Copied」，无 `navigator.clipboard` 时自动回退 `execCommand` 复制（`packages/web-ui/src/components/markdown-renderer.tsx`）
- **侧边栏会话搜索框** — 顶部搜索框按标题实时过滤（无匹配时提示「无匹配会话」，可一键清空）；会话行 hover / focus 显示重命名与删除按钮（`packages/web-ui/src/components/session-sidebar.tsx`）
- **欢迎卡片 hover 微动画** — 建议卡片 hover 上浮 + scale + 品牌 glow，图标微弹（`packages/web-ui/src/index.css`）
- **建议卡片点击交互** — 点击卡片将问题**填入输入框**待编辑后发送（DeepSeek 式），附微提示「点击卡片将问题填入输入框，确认后按 Enter 发送」
- **生成中指示器增强** — 增加**已用时长**（1s 起计）+ **「按 Esc 中断」**提示；全局 Esc 可中断流式生成（重命名输入框内的 Esc 不拦截），与 Stop 按钮联动（`packages/web-ui/src/pages/chat.tsx`、`message-list.tsx`）
- **空会话引导** — 新会话未发消息时显示轻量引导（图标 + 建议问题 chips 一键发送）
- **设置下拉可达性** — Esc 关闭（焦点回齿轮按钮）、点击外部关闭、打开自动聚焦首项、focus-visible 轮廓

### 优化（TUI）

- **填充气泡非 Windows 终端验证** — 确认 Ink 在 FORCE_COLOR 下输出 24-bit 背景序列（`\x1b[48;2;r;g;b`），Linux/macOS/mintty/Windows Terminal 等 truecolor 终端按背景填充渲染；新增**超长消息帧**验证多行换行后的背景边界与右对齐（`packages/cli/src/scripts/shoot-tui.tsx`、`scripts/render-tui.py`）

### 文档

- **在线文档站新增「界面预览」** — `docs/site/index.html` 新增截图画廊（WebUI 欢迎页 / 对话流 / 生成中指示器 / 代码块复制 / 会话搜索 / 空会话引导 / TUI 欢迎 / 对话流 / 超长消息），截图全部同步为 Round 3 实拍
- **README 截图画廊与使用指南** — 更新为 R3 截图，WebUI 使用指南补充搜索 / Esc 中断 / 复制按钮 / 空会话引导说明

## [Unreleased] — 界面设计优化 Round 2

### 优化（WebUI）

- **顶栏设置下拉** — 齿轮 ⚙ 菜单：三套主题（深空/日光/赛博）直接选择并显示主题名（替代 32px 单按钮循环切换），附带消息检查器 / 对话图面板开关（`packages/web-ui/src/pages/chat.tsx`）
- **顶栏会话标题** — 显示当前会话标题，双击行内编辑重命名（Enter 保存 / Esc 取消）
- **侧边栏会话双击重命名** — 会话卡片双击（或铅笔按钮）进入行内编辑，Enter / 失焦保存、Esc 取消（`packages/web-ui/src/components/session-sidebar.tsx`）
- **欢迎卡片文案贴合 Agent 场景** — 「让 Agent 分析项目代码」「多 Agent 协作完成任务」「用沙箱试跑实验性代码」「写一个 CLI 工具」
- **消息生成中动画指示器** — 发送消息后、首条助手消息出现前的空窗期，消息流底部显示豆包式彩色光点 +「正在生成…」（`packages/web-ui/src/components/message-list.tsx`）
- **对话图面板三套主题自适应** — Graph Panel 颜色由硬编码 hex 改为 CSS 变量，深空/日光/赛博配色协调（refactor 分支，`packages/web-ui/src/components/graph-panel.tsx`）
- **重命名 API** — `PATCH /api/sessions/:id`（Server + SessionManager + Agent + SessionStore，SQLite 持久化；refactor 分支经 DualWriteSessionStore 双写事件日志 `session/title`）

### 优化（TUI）

- **用户消息气泡增强** — 在圆角边框基础上补品牌色 dim 背景填充（`backgroundColor: theme.userBubbleBg`），与切片渲染行数估算精确对齐（回归测试通过）
- **版本号统一 v0.2.0** — TUI 欢迎卡徽标 / 顶栏版本、WebUI 侧边栏底部、README tgz 文件名、在线文档站 hero 徽标与 CHANGELOG [0.2.0] 对齐

### 文档

- **README 全局安装显眼化** — 「⭐ 全局安装（一条命令启动 TUI）」：`npm install -g fengagent` → 任意目录 `fengagent` 直接进 TUI，附「无需克隆仓库」提示
- **在线文档站** — WebUI 功能描述同步（设置下拉 / 双击重命名 / 生成中动画 / 三主题图面板），hero 徽标 v0.2.0
- **截图画廊更新** — README / 文档站截图替换为 Round 2 新 UI 截图（`screenshots/r2-*.png`）

## [Unreleased] — 界面设计优化 Round 1

### 优化（WebUI）

- **欢迎页重构** — 参考 DeepSeek / 豆包 / 通义千问：居中 Hero（渐变图标 + 标题 + 副标题）+ 4 张建议卡片（点击即发起对话）+ 特性标签；去掉旧版居中欢迎卡
- **对话流重排** — 居中窄栏（768px），助手消息带头像（品牌渐变圆标），用户消息右对齐圆角气泡；系统消息置灰卡片
- **Composer 输入区** — 圆角卡片容器（focus 光环），发送按钮渐变胶囊，Stop 按钮红色
- **侧边栏** — 品牌 Logo + 名称 + 副标题，会话按「今天 / 昨天 / 近 7 天 / 更早」日期分组，底部版本信息栏；主题切换移入顶栏
- **顶栏** — 品牌字标 + 模型选择 + 检查器 / 对话图开关 + 主题切换

### 优化（TUI）

- **用户消息气泡** — 右对齐圆角边框气泡（`theme.userBubbleBg/Border`），与长对话切片渲染行数精确对齐（回归测试通过）
- **欢迎卡片** — 加宽 + 版本徽标（`v0.1.0` 反白 chip）+ 副标题行 + 命令提示补充 `/provider`

### 文档 / 主页

- **README 重构** — 突出项目介绍 / 快速开始 / 使用指南，移除「借鉴 opencode 等」参考描述与 bug 修复叙事，新增截图画廊
- **GUIDE-CORDIS** — 顶部新增「FengAgentCli 是什么」+「三分钟上手」
- **截图脚本** — `scripts/shoot-webui.ts`（mock LLM + 真实 server + CDP 截图）、`packages/cli/src/scripts/shoot-tui.tsx` + `scripts/render-tui.py`（ANSI 帧渲染 PNG），供后续轮次复用

## [0.2.0] - 2026-08-20

### 修复

- **长对话布局** — 内容超屏撑破布局导致图标 / 后续问答 / token 百分比消失；改为**切片渲染**（只渲染可视窗口内的消息，边界按行裁剪），支持 `PgUp/PgDn`、鼠标滚轮、`Home` 回顶、`End` 回底并自动恢复贴底（`packages/cli/src/tui/chat-view.tsx`）
- **对话卡死** — AGENTS.md（Multica 运行时指令）被注入系统提示，Agent 对简单问题也触发工具调用循环；CLI / ACP 路径默认 `loadAgentsMd: false` 禁用注入（`e268f8a` + `f448383` 回归测试）
- **ACP 运行时报错** — `FENG_PROVIDER=openai-compatible` 时报 `OPENAI_COMPATIBLE_API_KEY is required`；ACP 路径改为与 TUI 一致的分层配置加载（默认值 → 全局 → 项目 → 分支 → 环境变量）并经 `buildEnvForLLM` 注入 LLM 环境变量（`255c408`）
- **token 进度条** — 大上下文窗口下百分比被 `Math.round` 压成 0%；保留 1 位小数、极小值显示 `<0.1%`、token 计数 > 0 时进度条至少填充 1 格（`0b7ac95`）；token 计数修正为累加 `inputTokens + outputTokens`（`7b8d41c`）

### 新增

- **实验沙箱** — `Sandbox` 类 + 内置 `sandbox` 工具（run / write / read / delete / list / copy-in / copy-out / status），路径围栏、环境脱敏、超时强杀，`copy-out` 为唯一出口需权限审批（详见 `docs/SANDBOX.md`）
- **TUI 主题优化** — 借鉴 opencode / kimi-code / claude-code 的新色板（近黑分层背景 + 暖橙/语义色，保留雾蓝品牌色）、代码语法高亮、状态栏重构（分段进度条独立一行 + 精确百分比）
- **全局安装 + Multica 运行时检测** — `fengagent runtime install` / `uninstall` 注册 / 移除 `~/.multica/runtimes/fengagent.json`，全局安装后其他电脑的 Multica 桌面端可检测到 FengAgentCli 运行时

### 重构（refactor/cordis-graph-architecture 分支）

- **Cordis 插件化** — 模型 / 工具 / 策略 / 存储 / 上下文 / Loop / 图全部为可插拔 `ctx.*` 服务；**对话图**（/graph、/rollback 可溯源可回退）、**事件溯源**（append-only 事件日志、投影、双写对账、导出/导入/重建/跨机迁移），详见 `docs/ARCHITECTURE-CORDIS.md`（分支级数据根 `.fengagent-cordis/`，与 main 隔离）

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
